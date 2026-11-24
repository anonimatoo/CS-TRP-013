import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import test from 'node:test';
import { digits, luhn, parseBrl, validCpf } from '../shared/validation.mjs';
import { decrypt, encrypt } from '../server/security.mjs';
import { account, firstKey, fixture, hookSecret, password, publicKey, secondKey, wrongKey } from './fixture.mjs';

test('CPF, moeda brasileira, centavos exatos e Luhn', () => {
  assert.equal(validCpf('529.982.247-25'), true);
  assert.equal(validCpf('111.111.111-11'), false);
  assert.equal(validCpf('529.982.247-26'), false);
  assert.equal(digits('(11) 90000-0000'), '11900000000');
  assert.equal(parseBrl('R$ 2.999,99'), 299999);
  assert.equal(parseBrl('60,5'), 6050);
  assert.equal(parseBrl('30.50'), null);
  assert.equal(parseBrl('-10,00'), null);
  assert.equal(parseBrl('1e6'), null);
  assert.equal(luhn('4000000000000010'), true);
  assert.equal(luhn('4000000000000011'), false);
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
    for (const secret of [firstKey,secondKey,wrongKey,password]) assert.ok(!text.includes(secret));
    return { status: result.status, headers: result.headers, json: result.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null, text };
  }
  const post = (path, body = {}, extra) => req(path, { method: 'POST', body, ...extra });
  const keyAction = (action, body) => post('/admin/gateway/test/' + action, body);
  let gatewayVersion;
  const input = (version, token = 'token_ApprovedTest') => ({
    id: randomUUID(), version, gatewayVersion, token, installments: 3,
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
    assert.equal((await keyAction('add', { secret: 'sk_invalid' })).status, 422);
    assert.equal((await keyAction('add', { secret: wrongKey })).json.http, 401);
    const savedKey = (await keyAction('add', { secret: firstKey })).json;
    assert.equal(savedKey.hasKey, true);
    assert.equal(savedKey.checkoutConfigured, false);
    assert.equal(savedKey.publicKey, null);
    assert.equal(savedKey.account, null);
    assert.equal((await keyAction('activate', { confirmed: true })).status, 409);
    assert.equal((await req('/checkout')).json.ready, false);
    const raw = await app.db.query('SELECT secret FROM cs_trp_013_v2.gateway WHERE environment=$1', ['test']);
    assert.notEqual(raw.rows[0].secret, firstKey);
    assert.equal((await keyAction('test')).json.http, 200);
    assert.equal(app.remote.chargePosts, 0);
    const separate = { publicKey, account, mode: 'gateway' };
    assert.equal((await keyAction('configure', { ...separate, publicKey: 'pk_wrong_environment' })).status, 422);
    assert.equal((await keyAction('configure', separate)).json.checkoutConfigured, true);
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
    paid = (await req('/orders/' + good.id)).json;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.amount, 299999);
    assert.equal(app.remote.chargePosts, 1);
    const sent = app.remote.calls.find(call => call.method === 'POST' && call.route === '/orders');
    assert.equal(sent.idempotency, good.id);
    assert.equal(sent.body.items[0].amount, 299999);
    assert.deepEqual(Object.keys(sent.body.payments[0].credit_card.card), ['billing_address']);
    declined = (await post('/orders', input(version, 'token_DeclinedTest'))).json;
    assert.equal(declined.status, 'declined');
    assert.equal(declined.refusalCode, '0051');
    assert.ok(!('refusalReason' in declined));
    assert.equal((await req('/admin/orders/' + declined.id)).json.row.refusal_reason, 'Recusa do fixture local');
  });

  await t.test('conciliação de falha ambígua, webhook autenticado e deduplicado', async () => {
    const uncertain = input(version, 'token_UncertainTest');
    assert.equal((await post('/orders', uncertain)).json.status, 'communication_error');
    const before = app.remote.chargePosts;
    assert.equal((await post('/orders', uncertain)).json.status, 'communication_error');
    assert.equal(app.remote.chargePosts, before);
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
    const before = (await app.db.query('SELECT secret FROM cs_trp_013_v2.gateway WHERE environment=$1', ['test'])).rows[0].secret;
    assert.equal((await keyAction('replace', { secret: wrongKey })).status, 422);
    assert.equal((await app.db.query('SELECT secret FROM cs_trp_013_v2.gateway WHERE environment=$1', ['test'])).rows[0].secret, before);
    const rotated = await keyAction('replace', { secret: secondKey });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.json.publicKey, publicKey);
    assert.equal(rotated.json.account, account);
    assert.equal(rotated.json.mode, 'gateway');
    assert.equal(rotated.json.enabled, true);
    assert.equal((await post('/orders', input(version))).json.safeToRetry, true);
    gatewayVersion = (await req('/checkout')).json.gatewayVersion;
    const saved = await updateProduct({ ...product, operation: 'auth_only' });
    version = saved.json.version;
    const manual = (await post('/orders', input(version))).json;
    assert.equal(manual.status, 'authorized');
    assert.equal(app.remote.calls.at(-1).key, secondKey);
    assert.equal((await post('/admin/orders/' + manual.id + '/capture', { confirmed: true })).json.status, 'paid');
    assert.equal((await post('/admin/orders/' + manual.id + '/cancel', { confirmed: true })).json.status, 'refunded');
    assert.equal((await req('/admin/summary/test')).json.declined, 1);
    assert.ok((await req('/admin/report/test')).text.includes(paid.id));
  });

  await t.test('desativação, consulta histórica, desconexão, sessão encerrada e limite de login', async () => {
    assert.equal((await keyAction('disable')).json.enabled, false);
    assert.equal((await req('/checkout')).json.publicKey, null);
    assert.equal((await post('/orders', input(version))).status, 503);
    assert.equal((await post('/admin/orders/' + paid.id + '/refresh')).json.status, 'paid');
    assert.equal((await keyAction('disconnect')).status, 422);
    assert.equal((await keyAction('disconnect', { confirmed: true })).json.hasKey, false);
    assert.equal((await req('/admin/orders/' + paid.id)).json.row.account, account);
    assert.equal((await post('/admin/logout')).status, 200);
    assert.equal((await req('/admin/session')).status, 401);
    for (let index = 0; index < 6; index++) assert.equal((await post('/admin/login', { password: 'errada' })).status, 401);
    assert.equal((await post('/admin/login', { password })).status, 429);
  });
});

test('PSP usa o token para criar cartão e envia apenas card_id no pedido', async t => {
  const app = await fixture();
  t.after(app.close);
  let cookie;
  let csrf;
  async function request(path, body, method = 'POST') {
    const headers = { Origin: app.origin, 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(app.origin + '/api' + path, { method, headers, body: body && JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.ok, true, json.message);
    if (!cookie) cookie = response.headers.get('set-cookie').split(';')[0];
    return json;
  }
  csrf = (await request('/admin/login', { password })).csrf;
  app.remote.hooks.set('hook_PspAccount', { account: { id: account } });
  const staged = await request('/admin/gateway/test/add', { secret: firstKey });
  assert.equal(staged.account, account);
  assert.equal(staged.checkoutConfigured, false);
  await request('/admin/gateway/test/configure', { publicKey, account, mode: 'psp' });
  await request('/admin/gateway/test/activate', { confirmed: true });
  await request('/admin/product', {
    name: 'PC Gamer', description: 'Computador gamer personalizado.', image: '/images/pc-gamer.webp',
    price: '10,10', maxInstallments: 1, enabled: true, operation: 'auth_and_capture', environment: 'test'
  }, 'PUT');
  const checkout = await request('/checkout', undefined, 'GET');
  const result = await request('/orders', {
    id: randomUUID(), version: checkout.version, gatewayVersion: checkout.gatewayVersion, token: 'token_PspLocalDemo', installments: 1,
    buyer: { name: 'Comprador Teste', cpf: '52998224725', email: 'teste@example.com', phone: '11900000000',
      cep: '01001000', street: 'Praça da Sé', number: '1', complement: '', neighborhood: 'Sé', city: 'São Paulo', state: 'SP', country: 'BR' }
  });
  assert.equal(result.status, 'paid');
  const typed = app.remote.calls.filter(call => call.method === 'POST');
  assert.deepEqual(typed.map(call => call.route), ['/customers','/customers/cus_DemoCustomer/cards','/orders']);
  assert.equal(typed[1].body.token, 'token_PspLocalDemo');
  assert.equal(typed[2].body.customer_id, 'cus_DemoCustomer');
  assert.deepEqual(typed[2].body.payments[0].credit_card, { card_id: 'card_DemoCard', installments: 1, operation_type: 'auth_and_capture' });
  const persisted = JSON.stringify((await app.db.query('SELECT * FROM cs_trp_013_v2.orders')).rows);
  assert.ok(!persisted.includes('card_DemoCard') && !persisted.includes('token_PspLocalDemo') && !persisted.includes('52998224725'));
});
