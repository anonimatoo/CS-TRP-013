import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { firstKey, fixture, password } from './fixture.mjs';

test('Diagnóstico, recuperação e limites de reenvio do checkout hospedado', async t => {
  const app = await fixture();
  t.after(app.close);
  let cookie;
  let csrf;
  async function request(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(app.origin + '/api' + path, { method, headers: {
      ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
      ...(body ? { Origin: app.origin, 'Content-Type': 'application/json' } : {})
    }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    const text = JSON.stringify(data);
    for (const privateValue of [firstKey, 'comprador@example.com', '52998224725', 'Comprador Exemplo', 'raw-private-payload']) {
      assert.ok(!text.includes(privateValue), 'Dado privado exposto pela API');
    }
    return { response, data };
  }
  const login = await request('/admin/login', { password });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  csrf = login.data.csrf;
  const added = await request('/admin/gateway/test/add', { secret: firstKey });
  assert.equal(added.data.checkoutCreationVerifiedAt, null);
  assert.equal(added.data.authenticated, true);
  assert.equal(added.data.checkoutReadable, true);
  assert.equal((await request('/admin/gateway/test/activate', { confirmed: true })).response.status, 200);
  const product = await request('/admin/product', {
    name: 'PC Gamer', description: 'Computador gamer personalizado.', image: '/images/pc-gamer.webp',
    price: 'R$ 2.999,99', maxInstallments: 6, enabled: true, operation: 'auth_and_capture', environment: 'test'
  }, 'PUT');
  assert.equal(product.response.status, 200);
  const { data: shop } = await request('/checkout');
  const input = () => ({
    id: randomUUID(), version: shop.version, gatewayVersion: shop.gatewayVersion, installments: 3,
    buyer: { name: 'Comprador Exemplo', email: 'comprador@example.com', cpf: '52998224725', phone: '11900000000',
      cep: '01001000', street: 'Praça da Sé', number: '1', complement: '', neighborhood: 'Sé', city: 'São Paulo',
      state: 'SP', country: 'BR' }
  });
  const clearLimit = () => app.db.query('DELETE FROM cs_trp_013_v2.rate_limits');
  const submit = async order => {
    await clearLimit();
    const { response, data } = await request('/orders', order);
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };

  await t.test('HTTP 200 e 201 com os campos do exemplo oficial e validade de 30 minutos', async () => {
    for (const http of [200, 201]) {
      app.remote.respondToCreation = ({ link, persist }) => {
        if (http === 200) {
          link.expires_at = new Date(Date.parse(link.created_at) + 25 * 60000).toISOString();
          delete link.expires_in;
          link.url = 'https://checkout.pagar.me/' + link.id;
        }
        persist();
        return Response.json(link, { status: http });
      };
      const order = await submit(input());
      assert.equal(order.status, 'pending');
      assert.equal(order.http, http);
      assert.match(order.checkoutUrl, /^https:\/\/(checkout|payment-link)\.pagar\.me\//);
      assert.equal(order.reconciliation, 'checkout_found');
      const { data: details } = await request('/admin/orders/' + order.id);
      const link = app.remote.links.get(details.row.checkout_provider_id);
      assert.equal(Date.parse(order.checkoutExpiresAt) - Date.parse(link.created_at), (http === 200 ? 25 : 30) * 60000);
      assert.equal(details.row.checkout_http, http);
      assert.equal(details.row.has_checkout_url, true);
      assert.ok(!('checkout_url' in details.row));
      assert.ok((await request('/admin/gateway/test')).data.checkoutCreationVerifiedAt);
    }
  });

  await t.test('Resposta resumida é completada em GET pelo identificador remoto', async () => {
    app.remote.respondToCreation = ({ link, persist }) => {
      persist();
      return Response.json({ id: link.id, url: link.url, status: link.status }, { status: 201 });
    };
    const order = await submit(input());
    assert.equal(order.status, 'pending');
    assert.equal(order.http, 201);
    const { data: details } = await request('/admin/orders/' + order.id);
    assert.equal(details.row.checkout_http, 201);
    assert.ok(app.remote.calls.some(call => call.route === '/paymentlinks/' + details.row.checkout_provider_id && call.method === 'GET'));
  });

  for (const [category, body] of [
    ['checkout_response_invalid_shape', () => []],
    ['checkout_id_invalid', link => ({ ...link, id: 'oops' })],
    ['checkout_id_invalid', ({ id, ...link }) => link],
    ['checkout_url_missing', ({ url, ...link }) => link],
    ['checkout_url_invalid', link => ({ ...link, url: 'https://payment-link.pagar.me.example/' + link.id })],
    ['checkout_url_invalid', link => ({ ...link, url: 'https://checkout.pagar.me:444/' + link.id })],
    ['checkout_amount_mismatch', link => ({ ...link, cart_settings: { total_cost: 1 } })],
    ['checkout_reference_mismatch', link => ({ ...link, name: 'Outra referência' })],
    ['checkout_reference_mismatch', link => ({ ...link, order_code: randomUUID() })],
    ['checkout_date_invalid', link => ({ ...link, created_at: '2026-02-31T19:00:00Z' })],
    ['checkout_incomplete', ({ cart_settings, ...link }) => link],
    ['checkout_installments_mismatch', link => ({
      ...link, payment_settings: { credit_card_settings: { installments: [{ number: 3, total: 1 }] } }
    })]
  ]) {
    await t.test('HTTP 200 mantém diagnóstico ' + category, async () => {
      app.remote.respondToCreation = ({ link }) => {
        const data = body(link);
        // When detail is queried, return the same incomplete response.
        app.remote.links.set(link.id, data);
        return Response.json(data);
      };
      const result = await submit(input());
      assert.equal(result.status, 'communication_error');
      assert.equal(result.http, 200);
      assert.equal(result.checkoutError, category);
      assert.equal(result.checkoutUrl, null);
      assert.equal(result.newPurchaseAllowed, false);
    });
  }

  for (const [http, category, rejected] of [
    [400, 'provider_validation', true], [401, 'provider_authentication', true], [403, 'provider_permission', true],
    [422, 'provider_validation', true], [429, 'provider_rate_limit', false], [500, 'provider_unavailable', false],
    [503, 'provider_unavailable', false]
  ]) {
    await t.test('HTTP ' + http + ' mantém estado e diagnóstico', async () => {
      app.remote.respondToCreation = () => Response.json({ message: 'raw-private-payload', errors: { customer: ['Invalid'] } }, { status: http });
      const order = await submit(input());
      assert.equal(order.status, rejected ? 'request_failed' : 'communication_error');
      assert.equal(order.checkoutError, category);
      assert.equal(order.http, http);
      assert.equal(order.newPurchaseAllowed, rejected);
      const { data: current } = await request('/admin/gateway/test');
      assert.equal(current.checkoutHttp, http);
      assert.equal(current.checkoutError, category);
      assert.equal(current.checkoutReadable, true);
    });
  }

  await t.test('HTTP 200 sem JSON é persistido como falha de formato', async () => {
    app.remote.respondToCreation = () => new Response('<html>raw-private-payload</html>');
    const order = await submit(input());
    assert.equal(order.status, 'communication_error');
    assert.equal(order.http, 200);
    assert.equal(order.checkoutError, 'provider_non_json');
    assert.equal(order.checkoutUrl, null);
  });

  await t.test('Erro de transporte sem link continua pendente, inclusive após reenvio e consulta', async () => {
    const form = input();
    app.remote.respondToCreation = () => { throw new TypeError('fixture transport', { cause: { code: 'ECONNREFUSED' } }); };
    const order = await submit(form);
    assert.equal(order.checkoutError, 'provider_connection');
    assert.equal(order.http, null);
    const before = app.remote.linkPosts;
    const same = await submit(form);
    assert.equal(same.id, order.id);
    assert.equal(same.reconciliation, 'pending');
    assert.equal(same.checkoutUrl, null);
    assert.equal(same.http, null);
    assert.equal(app.remote.linkPosts, before);
    const { data: details } = await request('/admin/orders/' + order.id);
    assert.equal(details.row.reconciliation_http, 200);
    assert.equal(details.row.checkout_http, null);
    assert.equal(details.row.reconciliation_state, 'pending');
  });

  await t.test('Recupera o link Stone do pedido com HTTP 201 e URL rejeitada', async () => {
    const form = input();
    app.remote.respondToCreation = ({ link, persist }) => {
      link.url = 'https://payment-link.stone.com.br/' + link.id;
      persist();
      return Response.json({ ...link, url: 'https://payment-link.stone.com.br.example/' + link.id }, { status: 201 });
    };
    const unresolved = await submit(form);
    assert.equal(unresolved.status, 'communication_error');
    assert.equal(unresolved.http, 201);
    assert.equal(unresolved.checkoutError, 'checkout_url_invalid');
    assert.equal(unresolved.checkoutUrl, null);

    const before = app.remote.linkPosts;
    const { data: recovered } = await request('/orders/' + form.id);
    assert.equal(recovered.id, form.id);
    assert.equal(recovered.status, 'pending');
    assert.equal(new URL(recovered.checkoutUrl).hostname, 'payment-link.stone.com.br');
    const { data: details } = await request('/admin/orders/' + form.id);
    assert.equal(details.row.checkout_http, 201);
    assert.equal(details.row.has_checkout_url, true);
    assert.equal(app.remote.linkPosts, before);
  });

  async function createRejectedStone(form) {
    app.remote.respondToCreation = ({ link, persist }) => {
      link.url = 'https://payment-link.stone.com.br/' + link.id;
      persist();
      return Response.json({ ...link, url: 'https://payment-link.stone.com.br:444/' + link.id + '?token=raw-private-payload' }, { status: 201 });
    };
    const order = await submit(form);
    assert.equal(order.status, 'communication_error');
    assert.equal(order.http, 201);
    assert.equal(order.checkoutError, 'checkout_url_invalid');
    assert.equal(order.checkoutUrl, null);
    return [...app.remote.links.values()].find(link => app.remote.linkCodes.get(link.id) === form.id);
  }

  await t.test('HTTP 201 e GET de pedidos HTTP 200 incompatível recuperam o mesmo link pelo ID', async () => {
    const form = input();
    const link = await createRejectedStone(form);
    const { data: failed } = await request('/admin/orders/' + form.id);
    assert.equal(failed.row.checkout_provider_id, link.id);
    assert.equal(failed.row.checkout_diagnostic.operation, 'POST /paymentlinks');
    assert.equal(failed.row.checkout_diagnostic.check, 'url_nondefault_port');
    assert.equal(failed.row.checkout_diagnostic.hostname, 'payment-link.stone.com.br');
    assert.equal(failed.row.checkout_diagnostic.body.fields.url, 'string');

    app.remote.orderLookup = () => Response.json({ data: { 'raw-private-payload': 'comprador@example.com' }, message: firstKey });
    try {
      const posts = app.remote.linkPosts;
      const from = app.remote.calls.length;
      const result = await submit(form);
      assert.equal(result.checkoutUrl, link.url);
      assert.equal(result.reconciliation, 'checkout_found_order_unverified');
      assert.equal(result.newPurchaseAllowed, false);
      assert.equal(app.remote.linkPosts, posts);
      assert.deepEqual(app.remote.calls.slice(from).map(call => [call.method, call.route]),
        [['GET', '/orders'], ['GET', '/paymentlinks/' + link.id]]);
      const { data: details } = await request('/admin/orders/' + form.id);
      assert.equal(details.row.checkout_http, 201);
      assert.equal(details.row.reconciliation_http, 200);
      assert.equal(details.row.reconciliation_error, 'orders_list_invalid_shape');
      assert.equal(details.row.provider_order, null);
      assert.equal(details.row.provider_charge, null);
      assert.equal(details.row.reconciliation_diagnostics[0].operation, 'GET /orders');
      assert.equal(details.row.reconciliation_diagnostics[0].check, 'orders_data_array');
      assert.deepEqual(details.row.reconciliation_diagnostics[0].data, { fields: {}, fieldCount: 1, type: 'object' });
      assert.equal((await request('/orders/' + form.id)).data.reconciliation_diagnostics, undefined);
    } finally { app.remote.orderLookup = null; }
  });

  await t.test('Pedido legado sem ID atravessa paginação e confirma link existente por GET de detalhe', async () => {
    const form = input();
    const link = await createRejectedStone(form);
    await app.db.query(`UPDATE cs_trp_013_v2.orders SET checkout_provider_id=NULL,
      reconciliation_error='provider_invalid_json',reconciliation_http=200 WHERE id=$1`, [form.id]);
    app.remote.orderLookup = () => Response.json({ data: null });
    const pages = [];
    app.remote.checkoutLookup = query => {
      assert.equal(query.get('name'), link.name);
      assert.equal(query.get('per_page'), '30');
      const page = query.get('page');
      pages.push(page);
      return page === '1'
        ? Response.json({ payment_links: [], paging: { next: 'https://example.invalid/' } })
        : Response.json({ payment_links: [{ id: link.id, name: link.name }], paging: { next: null } });
    };
    app.remote.checkoutDetails = id => {
      assert.equal(id, link.id);
      return Response.json({ data: link });
    };
    try {
      const posts = app.remote.linkPosts;
      const { data: recovered } = await request('/orders/' + form.id);
      assert.equal(recovered.checkoutUrl, link.url);
      assert.equal(recovered.reconciliation, 'checkout_found_order_unverified');
      assert.deepEqual(pages, ['1','2']);
      assert.equal(app.remote.linkPosts, posts);
      const { data: details } = await request('/admin/orders/' + form.id);
      assert.equal(details.row.checkout_provider_id, link.id);
    } finally {
      app.remote.orderLookup = null;
      app.remote.checkoutLookup = null;
      app.remote.checkoutDetails = null;
    }
  });

  await t.test('Registra os dois endpoints quando GET de pedidos e de links são incompatíveis', async () => {
    const form = input();
    await createRejectedStone(form);
    await app.db.query('UPDATE cs_trp_013_v2.orders SET checkout_provider_id=NULL WHERE id=$1', [form.id]);
    app.remote.orderLookup = () => Response.json({ data: null });
    app.remote.checkoutLookup = () => Response.json({ errors: ['raw-private-payload'] });
    try {
      const posts = app.remote.linkPosts;
      const { data: receipt } = await request('/orders/' + form.id);
      assert.equal(receipt.reconciliation, 'pending');
      assert.equal(receipt.checkoutUrl, null);
      assert.equal(receipt.newPurchaseAllowed, false);
      const { data: details } = await request('/admin/orders/' + form.id);
      assert.equal(details.row.checkout_http, 201);
      assert.equal(details.row.reconciliation_http, 200);
      assert.equal(details.row.reconciliation_error, 'checkout_list_invalid_shape');
      assert.deepEqual(details.row.reconciliation_diagnostics.map(diagnostic => [diagnostic.operation, diagnostic.check, diagnostic.http]),
        [['GET /orders','orders_data_array',200],['GET /paymentlinks','paymentlinks_collection',200]]);
      assert.equal(app.remote.linkPosts, posts);
    } finally {
      app.remote.orderLookup = null;
      app.remote.checkoutLookup = null;
    }
  });

  await t.test('Falha no detalhe preserva o ID e diferencia formato do checkout e consultas', async () => {
    const form = input();
    const link = await createRejectedStone(form);
    app.remote.orderLookup = () => Response.json({ data: false });
    app.remote.checkoutDetails = () => Response.json({ ...link, cart_settings: { total_cost: 'raw-private-payload' } });
    try {
      const { data: receipt } = await request('/orders/' + form.id);
      assert.equal(receipt.checkoutUrl, null);
      assert.equal(receipt.newPurchaseAllowed, false);
      const { data: details } = await request('/admin/orders/' + form.id);
      assert.equal(details.row.checkout_provider_id, link.id);
      assert.equal(details.row.reconciliation_error, 'checkout_response_invalid_shape');
      assert.equal(details.row.reconciliation_diagnostics[1].operation, 'GET /paymentlinks/{id}');
      assert.equal(details.row.reconciliation_diagnostics[1].check, 'checkout_cart_total');
      assert.deepEqual(details.row.reconciliation_diagnostics[1].cart.fields, { total_cost: 'string' });
    } finally {
      app.remote.orderLookup = null;
      app.remote.checkoutDetails = null;
    }
  });

  await t.test('Consulta de pedidos incompatível mantém link usado, expirado ou sem limite comprovado em conciliação', async () => {
    app.remote.orderLookup = () => Response.json({ data: null });
    try {
      for (const fields of [{ total_sessions: 1 }, { status: 'expired' }, { max_sessions: 0 }]) {
        const form = input();
        const link = await createRejectedStone(form);
        Object.assign(link, fields);
        const posts = app.remote.linkPosts;
        const { data: receipt } = await request('/orders/' + form.id);
        assert.equal(receipt.reconciliation, 'pending');
        assert.equal(receipt.checkoutUrl, null);
        assert.equal(receipt.newPurchaseAllowed, false);
        assert.equal(app.remote.linkPosts, posts);
      }
    } finally { app.remote.orderLookup = null; }
  });

  await t.test('Evidência de pedido em resposta incompatível impede exibir o link existente', async () => {
    const form = input();
    const link = await createRejectedStone(form);
    app.remote.orderLookup = () => Response.json({ items: [{ code: form.id, id: 'or_AlreadyExists' }] });
    try {
      const { data: receipt } = await request('/orders/' + form.id);
      assert.equal(receipt.reconciliation, 'pending');
      assert.equal(receipt.checkoutUrl, null);
      assert.equal(receipt.newPurchaseAllowed, false);
      const { data: details } = await request('/admin/orders/' + form.id);
      assert.equal(details.row.checkout_provider_id, link.id);
      assert.equal(details.row.reconciliation_diagnostics[0].matchingOrderEvidence, true);
    } finally { app.remote.orderLookup = null; }
  });

  await t.test('Link em página adicional gera ambiguidade quando existe mais de uma referência correspondente', async () => {
    const form = input();
    const link = await createRejectedStone(form);
    await app.db.query('UPDATE cs_trp_013_v2.orders SET checkout_provider_id=NULL WHERE id=$1', [form.id]);
    app.remote.checkoutLookup = query => query.get('page') === '1'
      ? Response.json({ data: [{ id: link.id, name: link.name }], paging: { next: 'page-2' } })
      : Response.json({ data: [{ id: 'pl_ConflictingReference', name: link.name }], paging: { next: null } });
    try {
      const { data: receipt } = await request('/orders/' + form.id);
      assert.equal(receipt.checkoutUrl, null);
      assert.equal(receipt.newPurchaseAllowed, false);
      const { data: details } = await request('/admin/orders/' + form.id);
      assert.equal(details.row.checkout_provider_id, null);
      assert.equal(details.row.reconciliation_error, 'checkout_reference_ambiguous');
    } finally { app.remote.checkoutLookup = null; }
  });

  await t.test('Recupera o checkout existente e conserva o erro original da criação', async () => {
    app.remote.nextLinkFault = 'timeout';
    const form = input();
    const order = await submit(form);
    assert.equal(order.checkoutError, 'provider_timeout');
    const before = app.remote.linkPosts;
    const { data: recovered } = await request('/orders/' + order.id);
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.reconciliation, 'checkout_found');
    assert.ok(recovered.checkoutUrl);
    assert.equal(recovered.checkoutError, 'provider_timeout');
    assert.equal(app.remote.linkPosts, before);
    const { data: details } = await request('/admin/orders/' + order.id);
    assert.equal(details.row.checkout_http, null);
    assert.equal(details.row.reconciliation_http, 200);
  });

  await t.test('Concilia um pedido pago quando o checkout já gerou uma cobrança', async () => {
    app.remote.nextLinkFault = 'timeout';
    const form = input();
    const unresolved = await submit(form);
    const providerOrder = app.remote.complete(form.id);
    const before = app.remote.linkPosts;
    const { data: paid } = await request('/orders/' + unresolved.id);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.reconciliation, 'order_found');
    assert.equal(paid.checkoutUrl, null);
    assert.equal(app.remote.linkPosts, before);
    const { data: details } = await request('/admin/orders/' + unresolved.id);
    assert.equal(details.row.provider_order, providerOrder.id);
    assert.equal(details.row.provider_charge, providerOrder.charges[0].id);
  });

  await t.test('Checkout expirado só libera nova compra após confirmar zero sessões e nenhum pedido', async () => {
    const order = await submit(input());
    const link = app.remote.links.get(new URL(order.checkoutUrl).pathname.slice(1));
    await app.db.query("UPDATE cs_trp_013_v2.orders SET checkout_expires_at=now()-interval '1 minute' WHERE id=$1", [order.id]);
    link.status = 'expired';
    link.total_sessions = 1;
    const { data: uncertain } = await request('/orders/' + order.id);
    assert.equal(uncertain.checkoutUrl, null);
    assert.equal(uncertain.reconciliation, 'pending');
    assert.equal(uncertain.newPurchaseAllowed, false);
    await app.db.query('UPDATE cs_trp_013_v2.orders SET checkout_synced_at=NULL WHERE id=$1', [order.id]);
    link.total_sessions = 0;
    const { data: expired } = await request('/orders/' + order.id);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.checkoutUrl, null);
    assert.equal(expired.newPurchaseAllowed, true);
  });

  await t.test('Pedido legado abandonado segue conciliável e nunca reenvia o POST', async () => {
    const form = input();
    await app.db.query(`INSERT INTO cs_trp_013_v2.orders
      (id, environment, price_version, amount, installments, product_name, status, hosted_checkout, created_at)
      VALUES($1,'test',$2,$3,3,'PC Gamer','processing',true,now()-interval '1 minute')`,
    [form.id, shop.version, shop.amount]);
    app.remote.checkoutLookup = () => Response.json({ unexpected: true });
    try {
      const before = app.remote.linkPosts;
      const order = await submit(form);
      assert.equal(order.status, 'communication_error');
      assert.equal(order.newPurchaseAllowed, false);
      assert.equal(app.remote.linkPosts, before);
      const { data: details } = await request('/admin/orders/' + order.id);
      assert.equal(details.row.reconciliation_error, 'checkout_list_invalid_shape');
      assert.equal(details.row.reconciliation_diagnostics[0].operation, 'GET /paymentlinks');
    } finally { app.remote.checkoutLookup = null; }
  });

  await t.test('Sessão expirada bloqueia diagnóstico administrativo sem alterar credenciais', async () => {
    const { rows: [before] } = await app.db.query("SELECT secret FROM cs_trp_013_v2.gateway WHERE environment='test'");
    await app.db.query("UPDATE cs_trp_013_v2.sessions SET expires_at=now()-interval '1 minute'");
    assert.equal((await request('/admin/gateway/test')).response.status, 401);
    assert.equal((await request('/admin/gateway/test/disconnect', { confirmed: true })).response.status, 401);
    const { rows: [after] } = await app.db.query("SELECT secret FROM cs_trp_013_v2.gateway WHERE environment='test'");
    assert.equal(after.secret, before.secret);
  });
});
