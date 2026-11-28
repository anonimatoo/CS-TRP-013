import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture, firstKey, secondKey, otherKey, liveKey, otherAccount } from './fixture.mjs';
import { gatewaySecret } from '../server/gateway.mjs';
import { makePagarme } from '../server/pagarme.mjs';

const credentials = { email: 'a@lojistas.example', password: 'senha-individual-do-lojista-a' };

test('Contas individuais, isolamento, links V5 e diagnóstico em IPv4/IPv6', async t => {
  const app = await fixture({
    listenHost: '::',
    configOverrides: { PAGARME_STATIC_EGRESS_IPS: '192.0.2.10,2001:db8::10' },
    ipFetch: async (url, options) => {
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(url.includes('api6.') ? '2001:db8::10\n' : '192.0.2.10\n');
    }
  });
  t.after(app.close);

  async function call(path, { session, method = 'GET', body, ipv6 = false, noCsrf = false } = {}) {
    const origin = ipv6 ? app.origin.replace('127.0.0.1', '[::1]') : app.origin;
    const response = await fetch(origin + '/api' + path, { method, redirect: 'manual', headers: {
      ...(session ? { Cookie: session.cookie } : {}),
      ...(session && !noCsrf ? { 'X-CSRF-Token': session.csrf } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: app.origin } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
    for (const value of [firstKey, otherKey, secondKey, credentials.password]) assert.ok(!JSON.stringify(json).includes(value));
    return { status: response.status, json, headers: response.headers };
  }
  const post = (path, body, session) => call(path, { method: 'POST', body, session });
  const sessionFor = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.json.csrf });
  const get = (route, session) => call('/admin' + route, { session });
  assert.equal((await get('/links/test')).status, 401);

  const a = sessionFor(await post('/merchant/register', { ...credentials, name: 'Loja A' }));
  const b = sessionFor(await post('/merchant/register', { email: 'b@lojistas.example', password: 'senha-individual-do-lojista-b', name: 'Loja B' }));
  assert.equal((await post('/merchant/register', { ...credentials, email: credentials.email.toUpperCase(), name: 'Duplicado' })).status, 409);
  assert.equal((await post('/merchant/login', { ...credentials, password: 'senha-incorreta-suficiente' })).status, 401);
  const resumed = sessionFor(await post('/merchant/login', { ...credentials, email: credentials.email.toUpperCase() }));
  const list = await call('/admin/merchants', { session: resumed, ipv6: true });
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  const storeA = list.json[0].id;
  const storeB = (await get('/merchants', b)).json[0].id;
  assert.notEqual(storeA, storeB);
  assert.equal((await call('/admin/session', { session: a, ipv6: true })).json.platform, false);
  const dbAuth = await app.db.query('SELECT password_hash FROM cs_trp_013_v2.merchant_accounts WHERE merchant_id=$1', [storeA]);
  assert.match(dbAuth.rows[0].password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.equal((await get('/gateway/test?lojista=' + storeB, a)).status, 403);
  assert.equal((await get('/financial-report?consolidated=true', a)).status, 403);
  assert.equal((await get('/notifications/smtp', a)).status, 403);
  assert.equal((await post('/admin/telegram/test-message', {}, a)).status, 403);
  assert.equal((await post('/admin/merchants', { name: 'Loja indevida' }, a)).status, 403);

  const add = (session, secret, env = 'test') => post('/admin/gateway/' + env + '/add', { secret }, session);
  const activate = (session, env = 'test') => post('/admin/gateway/' + env + '/activate', { confirmed: true }, session);
  assert.equal((await add(a, firstKey)).status, 200);
  assert.equal((await add(b, firstKey)).status, 409);
  app.remote.networkDiagnostic = route => route === '/hooks' ? Response.json({ data: [] }) : null;
  assert.equal((await add(b, otherKey)).status, 200);
  assert.equal((await activate(b)).status, 409);
  const proof = { id: 'hook_SaasAccountProof', account: { id: otherAccount } };
  app.remote.hooks.set(proof.id, proof);
  assert.equal((await post('/admin/gateway/test/verify-account', { eventId: proof.id }, a)).status, 502);
  assert.equal((await post('/admin/gateway/test/verify-account', { eventId: proof.id }, b)).json.account, otherAccount);
  app.remote.networkDiagnostic = null;
  assert.equal((await activate(a)).status, 200);
  assert.equal((await activate(b)).status, 200);
  assert.equal((await add(a, liveKey, 'live')).status, 200);
  assert.equal((await activate(a, 'live')).status, 409);

  const input = { id: randomUUID(), name: 'Pedido de teste', price: '150,00', installments: 2 };
  assert.equal((await call('/admin/links/test', { session: a, method: 'POST', body: input, noCsrf: true })).status, 403);
  assert.equal((await post('/admin/links/live', input, a)).status, 409);
  const attempts = await Promise.all([post('/admin/links/test', input, a), post('/admin/links/test', input, a)]);
  assert.ok(attempts.every(response => response.status === 200));
  const first = attempts.find(response => response.json.checkoutUrl).json;
  assert.equal(first.amount, 15000);
  assert.equal(first.checkoutUrl, '/api/pay/' + storeA + '/' + input.id);
  assert.equal((await post('/admin/links/test', { ...input, price: '151,00' }, a)).status, 409);
  assert.equal((await post('/admin/links/test', input, b)).status, 409);
  const second = await post('/admin/links/test', { ...input, id: randomUUID() }, b);
  assert.equal(second.status, 200);
  assert.notEqual(second.json.checkoutUrl, first.checkoutUrl);
  const calls = app.remote.calls.filter(entry => entry.method === 'POST' && entry.route === '/paymentlinks');
  assert.deepEqual(calls.map(entry => entry.key), [firstKey, otherKey]);
  assert.ok(calls.every(entry => entry.hostname === 'sdx-api.pagar.me' && entry.body.cart_settings.items[0].amount === 15000 &&
    !entry.body.customer_settings && !entry.body.split_settings));
  assert.equal((await call('/pay/' + storeB + '/' + first.id)).status, 404);
  const redirect = await call(first.checkoutUrl.slice(4));
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get('location'), /^https:\/\/payment-link\.pagar\.me\//);
  assert.equal((await get('/orders/' + first.id, b)).status, 404);
  assert.equal((await get('/report/test?lojista=' + storeB, a)).status, 403);
  const delayed = { ...input, id: randomUUID(), name: 'Link com resposta perdida' };
  app.remote.nextLinkFault = 'timeout';
  const lost = await post('/admin/links/test', delayed, b);
  assert.equal(lost.json.status, 'communication_error');
  const reconciled = await post('/admin/links/test/' + delayed.id + '/refresh', {}, b);
  assert.ok(reconciled.json.checkoutUrl);
  assert.equal(app.remote.calls.filter(entry => entry.method === 'POST' && entry.idempotency === delayed.id).length, 1);
  assert.deepEqual((await get('/links/test', a)).json.map(link => link.id), [first.id]);

  app.remote.complete(first.id);
  const settled = await post('/admin/links/test/' + first.id + '/refresh', {}, a);
  assert.equal(settled.json.status, 'paid');
  assert.equal((await call(first.checkoutUrl.slice(4))).status, 404);
  assert.equal((await post('/admin/gateway/test/replace', { secret: secondKey }, a)).status, 200);
  const stored = (await app.db.query(`SELECT * FROM cs_trp_013_v2.gateway WHERE merchant_id=$1 AND environment='test'`, [storeA])).rows[0];
  assert.notEqual(stored.secret, secondKey);
  assert.equal(gatewaySecret(app.config, stored), secondKey);
  assert.throws(() => gatewaySecret(app.config, { ...stored, merchant_id: storeB }));

  app.remote.networkDiagnostic = route => {
    if (route === '/orders') return Response.json({ message: 'Invalid API key' }, { status: 401 });
    if (route === '/charges') return Response.json({ message: 'Access forbidden' }, { status: 403 });
    if (route === '/hooks') return Response.json({}, { status: 503 });
    if (route === '/paymentlinks') return Response.json({ message: 'IP address not authorized: 192.0.2.10' }, { status: 403 });
  };
  const diagnosis = (await post('/admin/gateway/test/connectivity', {}, a)).json;
  assert.deepEqual(diagnosis.observed, { ipv4: '192.0.2.10', ipv6: '2001:db8::10' });
  assert.deepEqual(diagnosis.configuredStaticIPs, ['192.0.2.10', '2001:db8::10']);
  assert.deepEqual(Object.values(diagnosis.checks).map(check => check.category),
    ['provider_authentication','provider_permission','provider_unavailable','provider_ip_allowlist']);
  assert.equal((await post('/admin/gateway/test/disconnect', { confirmed: true }, a)).status, 200);
  assert.equal((await get('/gateway/test', a)).json.hasKey, false);
  assert.equal((await get('/gateway/test', b)).json.hasKey, true);
  assert.equal((await post('/admin/logout', {}, a)).status, 200);
  assert.equal((await get('/links/test', a)).status, 401);
});

test('O provedor distingue timeout e HTTP de bloqueio de IP explicitamente identificado sem expor o corpo', async () => {
  const messages = [
    [401, 'IP address not allowed', 'provider_ip_allowlist'],
    [403, 'IP de origem não autorizado', 'provider_ip_allowlist'],
    [403, 'This access is not allowed', 'provider_permission']
  ];
  for (const [status, message, category] of messages) {
    const api = makePagarme(async () => Response.json({ message }, { status }));
    await assert.rejects(api(firstKey, '/paymentlinks'), error => error.http === status &&
      error.category === category && !JSON.stringify(error).includes(message));
  }
  const api = makePagarme(async () => { throw new DOMException('timeout', 'TimeoutError'); });
  await assert.rejects(api(firstKey, '/paymentlinks'), { category: 'provider_timeout', http: null });
});
