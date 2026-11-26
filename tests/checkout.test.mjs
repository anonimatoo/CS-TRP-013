import { defaultMerchant } from '../server/merchants.mjs';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import test from 'node:test';
import { digits, parseBrl, validCpf } from '../shared/validation.mjs';
import { decrypt, encrypt } from '../server/security.mjs';
import { account, firstKey, fixture, hookSecret, liveKey, password, secondKey, wrongKey } from './fixture.mjs';

test('CPF, moeda brasileira e centavos exatos', () => {
  assert.equal(validCpf('529.982.247-25'), true);
  assert.equal(validCpf('111.111.111-11'), false);
  assert.equal(validCpf('529.982.247-26'), false);
  assert.equal(digits('(11) 90000-0000'), '11900000000');
  assert.equal(parseBrl('R$ 2.999,99'), 299999);
  assert.equal(parseBrl('60,5'), 6050);
  assert.equal(parseBrl('30.50'), null);
  assert.equal(parseBrl('-10,00'), null);
  assert.equal(parseBrl('1e6'), null);
});

test('AES-256-GCM com IV aleatório, autenticação e vínculo com conta/ambiente', () => {
  const key = randomBytes(32);
  const left = encrypt(key, firstKey, 'test:' + account);
  const right = encrypt(key, firstKey, 'test:' + account);
  assert.notEqual(left, right);
  assert.equal(decrypt(key, left, 'test:' + account), firstKey);
  assert.throws(() => decrypt(key, left, 'live:' + account));
  assert.throws(() => decrypt(randomBytes(32), left, 'test:' + account));
});

test('API e persistência PostgreSQL local ao longo de todo o fluxo administrativo e comercial', async t => {
  const app = await fixture();
  t.after(app.close);
  let cookie = '';
  let csrf = '';
  async function req(path, { method = 'GET', body, auth = true, token = true, from = app.origin } = {}) {
    const result = await fetch(app.origin + '/api' + path, { method, headers: {
      ...(auth && cookie ? { Cookie: cookie } : {}),
      ...(auth && csrf && token ? { 'X-CSRF-Token': csrf } : {}),
      ...(method !== 'GET' ? { Origin: from, 'Content-Type': 'application/json' } : {})
    }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await result.text();
    for (const secret of [firstKey,secondKey,liveKey,wrongKey,password]) assert.ok(!text.includes(secret));
    return { status: result.status, headers: result.headers, json: result.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null, text };
  }
  const post = (path, body = {}, extra) => req(path, { method: 'POST', body, ...extra });
  const keyAction = (action, body) => post('/admin/gateway/test/' + action, body);
  let gatewayVersion;
  const publicKey = 'pk_test_fixture123';
  const authentication = { status: 'Y', transactionId: randomUUID() };
  const input = version => ({
    id: randomUUID(), version, gatewayVersion, installments: 3, method: 'credit_card', cardToken: 'token_approved', authentication,
    buyer: { name: 'Comprador Teste', cpf: '52998224725', email: 'teste@example.com', phone: '11900000000',
      cep: '01001000', street: 'Praça da Sé', number: '1', complement: '', neighborhood: 'Sé', city: 'São Paulo', state: 'SP', country: 'BR' }
  });
  const product = { name: 'PC Gamer', description: 'Computador gamer personalizado.', image: '/images/pc-gamer.webp',
    price: 'R$ 2.999,99', maxInstallments: 6, enabled: true, operation: 'auth_and_capture', environment: 'test' };
  const updateProduct = value => req('/admin/product', { method: 'PUT', body: value });

  await t.test('autenticação, antiforça bruta e CSRF', async () => {
    assert.equal((await req('/admin/gateway/test')).status, 401);
    assert.equal((await post('/admin/gateway/test/add', { secret: firstKey })).status, 401);
    assert.equal((await post('/admin/login', { password: 'errada' })).status, 401);
    assert.equal((await post('/admin/login', { password }, { from: 'https://origem.example' })).status, 403);
    const valid = await post('/admin/login', { password });
    assert.equal(valid.status, 200);
    const issued = valid.headers.get('set-cookie');
    assert.match(issued, /HttpOnly/i);
    assert.match(issued, /SameSite=Strict/i);
    cookie = issued.split(';')[0];
    csrf = valid.json.csrf;
    assert.equal((await post('/admin/gateway/test/add', { secret: firstKey }, { token: false })).status, 403);
    assert.equal((await req('/admin/session')).json.csrf, csrf);
  });

  await t.test('ViaCEP com sucesso, erro de entrada, CEP inexistente e indisponibilidade', async () => {
    assert.equal((await req('/cep/01001000')).json.city, 'São Paulo');
    assert.equal((await req('/cep/0100')).status, 422);
    assert.equal((await req('/cep/99999999')).status, 404);
    assert.equal((await req('/cep/11111111')).status, 503);
  });

  let version;
  await t.test('cadastro, autenticação do gateway, configuração comercial e ativação', async () => {
    assert.equal((await req('/checkout')).json.amount, null);
    assert.equal((await keyAction('activate', { confirmed: true })).status, 409);
    const productionInSandbox = await keyAction('add', { secret: liveKey });
    assert.equal(productionInSandbox.status, 422);
    assert.match(productionInSandbox.json.message, /SK.*Produção/);
    const sandboxInProduction = await post('/admin/gateway/live/add', { secret: firstKey });
    assert.equal(sandboxInProduction.status, 422);
    assert.match(sandboxInProduction.json.message, /SK.*Sandbox/);
    assert.equal(app.remote.calls.length, 0);
    assert.equal((await post('/admin/gateway/live/add', { secret: liveKey })).json.enabled, false);
    const productionActivation = await post('/admin/gateway/live/activate', { confirmed: true });
    assert.equal(productionActivation.status, 409);
    assert.match(productionActivation.json.message, /ALLOW_LIVE_PAYMENTS=true/);
    assert.equal((await req('/admin/gateway/live')).json.activationBlock, productionActivation.json.message);
    assert.equal((await keyAction('add', { secret: 'sk_invalid' })).status, 422);
    assert.equal((await keyAction('add', { secret: wrongKey })).json.http, 401);
    const savedKey = (await keyAction('add', { secret: firstKey, publicKey })).json;
    assert.equal(savedKey.hasKey, true);
    assert.equal(savedKey.publicKey, publicKey);
    assert.equal(savedKey.account, account);
    assert.equal(savedKey.enabled, false);
    assert.equal((await req('/checkout')).json.ready, false);
    const raw = await app.db.query('SELECT secret FROM cs_trp_013_v2.gateway WHERE environment=$1 AND merchant_id=$2', ['test', defaultMerchant]);
    assert.notEqual(raw.rows[0].secret, firstKey);
    assert.equal((await keyAction('test')).json.http, 200);
    assert.equal(app.remote.linkPosts, 0);
    assert.equal((await req('/admin/gateway/test')).json.checkoutCreationVerifiedAt, null);
    assert.equal((await keyAction('activate', { confirmed: false })).status, 422);
    assert.equal((await keyAction('activate', { confirmed: true })).json.enabled, true);
    assert.equal((await updateProduct({ ...product, price: '1.50' })).status, 422);
    const saved = await updateProduct(product);
    version = saved.json.version;
    assert.equal(saved.json.amount, 299999);
    const checkout = (await req('/checkout')).json;
    assert.equal(checkout.ready, true);
    gatewayVersion = checkout.gatewayVersion;
  });

  let paid;
  let declined;
  await t.test('idempotência, preço autorizado, aprovação e recusa do fixture', async () => {
    const good = input(version);
    assert.equal((await post('/orders', { ...good, price: 1 })).status, 422);
    assert.equal((await post('/orders', { ...good, version: version - 1 })).status, 409);
    assert.equal((await post('/orders', { ...good, installments: 20 })).status, 422);
    const [a,b] = await Promise.all([post('/orders', good), post('/orders', good)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(app.remote.linkPosts, 0);
    const posts = app.remote.calls.filter(call => call.method === 'POST' && call.route === '/orders');
    assert.equal(posts.length, 1);
    const [sent] = posts;
    assert.equal(sent.idempotency, good.id);
    assert.equal(sent.body.code, good.id);
    assert.equal(sent.body.items[0].amount, 299999);
    assert.equal(sent.body.payments[0].credit_card.installments, 3);
    assert.equal(sent.body.payments[0].credit_card.authentication.threed_secure.transaction_id, authentication.transactionId);
    assert.equal(sent.body.customer.document, good.buyer.cpf);
    paid = (await req('/orders/' + good.id)).json;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.amount, 299999);
    assert.equal(paid.checkoutUrl, null);
    declined = (await post('/orders', { ...input(version), cardToken: 'token_declined' })).json;
    assert.equal(declined.status, 'declined');
    assert.equal(declined.refusalCode, '0051');
    assert.ok(!('refusalReason' in declined));
    assert.equal((await req('/admin/orders/' + declined.id)).json.row.refusal_reason, 'Recusa do fixture local');
  });

  await t.test('conciliação de falha ambígua, webhook autenticado e deduplicado', async () => {
    const uncertain = input(version);
    app.remote.orderTimeout = true;
    assert.equal((await post('/orders', uncertain)).json.status, 'communication_error');
    const before = app.remote.calls.filter(call => call.method === 'POST').length;
    assert.equal((await post('/orders', uncertain)).json.status, 'paid');
    assert.equal(app.remote.calls.filter(call => call.method === 'POST').length, before);
    const reference = [...app.remote.orders.values()].find(order => order.code === uncertain.id);
    const event = { id: 'hook_DemoHook001', account: { id: account }, type: 'order.paid', data: { id: reference.id, code: reference.code } };
    assert.equal((await post('/hooks/pagarme/invalido', event)).status, 404);
    assert.equal((await post('/hooks/pagarme/' + hookSecret, event)).status, 502);
    const noMatch = { ...event, data: { id: 'or_AnotherOrder', code: reference.code } };
    app.remote.hooks.set(event.id, noMatch);
    assert.equal((await post('/hooks/pagarme/' + hookSecret, event)).status, 403);
    app.remote.hooks.set(event.id, event);
    assert.equal((await post('/hooks/pagarme/' + hookSecret, event)).status, 204);
    assert.equal((await post('/hooks/pagarme/' + hookSecret, event)).status, 204);
    assert.equal((await req('/orders/' + uncertain.id)).json.status, 'paid');
    assert.equal((await app.db.query('SELECT id FROM cs_trp_013_v2.webhook_events')).rows.length, 1);
  });

  await t.test('substituição com rollback, chave nova em operação, captura e estorno', async () => {
    const before = (await app.db.query('SELECT secret FROM cs_trp_013_v2.gateway WHERE environment=$1 AND merchant_id=$2', ['test', defaultMerchant])).rows[0].secret;
    assert.equal((await keyAction('replace', { secret: wrongKey })).status, 422);
    assert.equal((await app.db.query('SELECT secret FROM cs_trp_013_v2.gateway WHERE environment=$1 AND merchant_id=$2', ['test', defaultMerchant])).rows[0].secret, before);
    const rotated = await keyAction('replace', { secret: secondKey, publicKey });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.json.enabled, true);
    assert.equal((await post('/orders', input(version))).json.safeToRetry, true);
    gatewayVersion = (await req('/checkout')).json.gatewayVersion;
    const saved = await updateProduct({ ...product, operation: 'auth_only' });
    version = saved.json.version;
    const manual = (await post('/orders', input(version))).json;
    assert.equal(manual.status, 'authorized');
    assert.equal(app.remote.calls.at(-1).key, secondKey);
    assert.equal(app.remote.calls.at(-1).body.payments[0].credit_card.operation_type, 'auth_only');
    assert.equal((await req('/orders/' + manual.id)).json.status, 'authorized');
    assert.equal((await post('/admin/orders/' + manual.id + '/capture', { confirmed: true })).json.status, 'paid');
    assert.equal((await post('/admin/orders/' + manual.id + '/cancel', { confirmed: true })).json.status, 'refunded');
    assert.equal((await req('/admin/summary/test')).json.declined, 1);
    assert.ok((await req('/admin/report/test')).text.includes(paid.id));
  });

  await t.test('débito confirmado, à vista, 3DS obrigatório e desafio cancelado', async () => {
    const debit = () => ({ ...input(version), method: 'debit_card', installments: 1 });
    assert.equal((await post('/orders', debit())).status, 409);
    const settings = { publicKey, creditEnabled: true, creditRequires3ds: true, debitEnabled: true,
      debitRequires3ds: true, debitAuthorizationReference: 'invalid' };
    assert.equal((await keyAction('cards', settings)).status, 422);
    const approved = await keyAction('cards', { ...settings, debitAuthorizationReference: 'sandbox-approved-reference' });
    assert.equal(approved.status, 200);
    const checkout = (await req('/checkout')).json;
    assert.equal(checkout.methods.debit_card, true);
    gatewayVersion = checkout.gatewayVersion;
    assert.equal((await post('/checkout/3ds', { method: 'debit_card', version, gatewayVersion })).json.token, 'fixture-3ds-token');
    await app.db.query('DELETE FROM cs_trp_013_v2.rate_limits');
    assert.equal((await post('/orders', { ...debit(), installments: 2 })).status, 422);
    assert.equal((await post('/orders', { ...debit(), authentication: undefined })).status, 422);
    const before = app.remote.calls.length;
    const canceled = (await post('/orders', { ...debit(), cardToken: undefined, authentication: { status: 'canceled' } })).json;
    assert.equal(canceled.status, 'authentication_incomplete');
    assert.equal(app.remote.calls.length, before);
    const confirmed = (await post('/orders', debit())).json;
    assert.equal(confirmed.status, 'paid');
    const sent = app.remote.calls.at(-1).body.payments[0];
    assert.equal(sent.payment_method, 'debit_card');
    assert.equal(sent.debit_card.installments, undefined);
    const { row, events } = (await req('/admin/orders/' + confirmed.id)).json;
    assert.equal(row.payment_method, 'debit_card');
    assert.equal(row.authorized_amount, 299999);
    assert.equal(row.provider_transaction, events[0].provider_id);
    assert.equal(events[0].authentication_status, 'Y');
    assert.equal(app.remote.linkPosts, 0);
  });

  await t.test('desativação, consulta histórica, desconexão, sessão encerrada e limite de login', async () => {
    assert.equal((await keyAction('disable')).json.enabled, false);
    assert.equal((await req('/checkout')).json.ready, false);
    assert.equal((await post('/orders', input(version))).status, 503);
    assert.equal((await post('/admin/orders/' + paid.id + '/refresh')).json.status, 'paid');
    assert.equal((await keyAction('disconnect')).status, 422);
    assert.equal((await keyAction('disconnect', { confirmed: true })).json.hasKey, false);
    assert.equal((await req('/admin/orders/' + paid.id)).json.row.status, 'paid');
    assert.equal((await post('/admin/logout')).status, 200);
    assert.equal((await req('/admin/session')).status, 401);
    for (let index = 0; index < 8; index++) assert.equal((await post('/admin/login', { password: 'errada' })).status, 401);
    assert.equal((await post('/admin/login', { password })).status, 429);
  });
});

test('checkout em produção exige ativação e usa pedidos oficiais', async t => {
  const origin = 'https://checkout.example';
  const app = await fixture({ originOverride: origin, allowLive: true });
  t.after(app.close);
  let cookie;
  let csrf;
  async function request(path, body, method = 'POST') {
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(app.origin + '/api' + path, { method, headers, body: body && JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.ok, true, json.message);
    if (!cookie) cookie = response.headers.get('set-cookie').split(';')[0];
    return json;
  }
  csrf = (await request('/admin/login', { password })).csrf;
  const saved = await request('/admin/gateway/live/add', { secret: liveKey, publicKey: 'pk_fixture123' });
  assert.equal(saved.activationBlock, null);
  assert.equal(saved.connected, true);
  await request('/admin/product', {
    name: 'PC Gamer', description: 'Computador gamer personalizado.', image: '/images/pc-gamer.webp',
    price: '10,10', maxInstallments: 1, enabled: true, operation: 'auth_and_capture', environment: 'live'
  }, 'PUT');
  assert.equal((await request('/checkout', undefined, 'GET')).ready, false);
  assert.equal(app.remote.linkPosts, 0);
  await request('/admin/gateway/live/activate', { confirmed: true });
  const checkout = await request('/checkout', undefined, 'GET');
  assert.equal(checkout.ready, true);
  assert.equal(app.remote.linkPosts, 0);
  const order = {
    id: randomUUID(), version: checkout.version, gatewayVersion: checkout.gatewayVersion, installments: 1,
    method: 'credit_card', cardToken: 'token_approved', authentication: { status: 'Y', transactionId: randomUUID() },
    buyer: { name: 'Comprador Teste', cpf: '52998224725', email: 'teste@example.com', phone: '11900000000',
      cep: '01001000', street: 'Praça da Sé', number: '1', complement: '', neighborhood: 'Sé', city: 'São Paulo', state: 'SP', country: 'BR' }
  };
  const result = await request('/orders', order);
  assert.equal(result.status, 'paid');
  assert.equal(result.http, 201);
  assert.equal(result.checkoutUrl, null);
  const sent = app.remote.calls.filter(call => call.method === 'POST');
  assert.deepEqual(sent.map(call => call.route), ['/orders']);
  assert.equal(sent[0].hostname, 'api.pagar.me');
  assert.equal(sent[0].body.code, order.id);
  const persisted = JSON.stringify((await app.db.query('SELECT * FROM cs_trp_013_v2.orders')).rows);
  assert.ok(!persisted.includes('52998224725') && !persisted.includes('teste@example.com'));
});
