import assert from 'node:assert/strict';
import test from 'node:test';
import { firstKey, liveKey } from './fixture.mjs';
import { hostedCheckoutUrl, makePagarme, ProviderError } from '../server/pagarme.mjs';
import { makePool } from '../server/db.mjs';

const reject = (promise, category, http = null) => assert.rejects(promise, error =>
  error instanceof ProviderError && error.category === category && error.http === http &&
  !Object.hasOwn(error, 'cause') && !Object.hasOwn(error, 'providerMessage'));

test('Aceita somente os hosts oficiais de checkout em HTTPS', () => {
  const path = '/pl_DemoCheckout';
  for (const host of ['checkout.pagar.me', 'payment-link.pagar.me', 'payment-link.stone.com.br']) {
    const url = 'https://' + host + path;
    assert.equal(hostedCheckoutUrl(url), url);
  }
  for (const origin of [
    'http://payment-link.stone.com.br', 'https://payment-link.stone.com.br:444',
    'https://usuario@payment-link.stone.com.br', 'https://payment-link.stone.com.br.example',
    'https://payment-link.stone.com.br@externo.example', 'https://outro.stone.com.br'
  ]) assert.equal(hostedCheckoutUrl(origin + path), null);
});

test('Basic Auth, URLs oficiais por operação, User-Agent, corpo e idempotência', async () => {
  const calls = [];
  const client = makePagarme(async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data: [] });
  });
  await client(firstKey, '/paymentlinks', { method: 'POST', body: { type: 'order' }, idempotency: 'pedido' });
  await client(firstKey, '/orders?size=1');
  await client(firstKey, '/hooks/hook_fixture');
  await client(liveKey, '/paymentlinks/pl_fixture');
  assert.deepEqual(calls.map(({ url }) => new URL(url).hostname),
    ['sdx-api.pagar.me', 'api.pagar.me', 'api.pagar.me', 'api.pagar.me']);
  const { headers, redirect, signal, body } = calls[0].options;
  assert.equal(Buffer.from(headers.Authorization.slice(6), 'base64').toString(), firstKey + ':');
  assert.equal(headers['Idempotency-Key'], 'pedido');
  assert.equal(headers['User-Agent'], 'pagarme-skill-generated/1.0');
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(redirect, 'manual');
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(body), { type: 'order' });
  assert.equal(calls[1].options.headers['Idempotency-Key'], undefined);
});

for (const [http, category] of [
  [302, 'provider_redirect'], [400, 'provider_validation'], [401, 'provider_authentication'],
  [403, 'provider_permission'], [409, 'provider_conflict'], [422, 'provider_validation'],
  [429, 'provider_rate_limit'], [500, 'provider_unavailable'], [503, 'provider_unavailable']
]) {
  test('Preserva e classifica HTTP ' + http + ' sem expor o corpo', async () => {
    const client = makePagarme(async () => new Response('<html>' + firstKey + '</html>', { status: http }));
    await reject(client(firstKey, '/paymentlinks'), category, http);
  });
}

for (const [code, category] of [
  ['ENOTFOUND', 'provider_dns'], ['ECONNRESET', 'provider_connection'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'provider_tls'], ['UND_ERR_CONNECT_TIMEOUT', 'provider_timeout']
]) {
  test('Classifica erro de transporte ' + code + ' sem HTTP', async () => {
    const client = makePagarme(async () => { throw new TypeError('fetch failed', { cause: { code } }); });
    await reject(client(firstKey, '/paymentlinks'), category);
  });
}

test('O prazo cancela o transporte e preserva HTTP se os cabeçalhos já chegaram', async () => {
  const hold = signal => new Promise((_, rejectFailure) => {
    const timer = setTimeout(() => rejectFailure(new Error('O sinal não cancelou.')), 1000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      rejectFailure(signal.reason);
    }, { once: true });
  });
  const connect = makePagarme((_url, { signal }) => hold(signal), { timeout: 15 });
  const download = makePagarme(async (_url, { signal }) =>
    ({ status: 200, ok: true, json: () => hold(signal) }), { timeout: 15 });
  await reject(connect(firstKey, '/paymentlinks'), 'provider_timeout');
  await reject(download(firstKey, '/paymentlinks'), 'provider_timeout', 200);
});

test('Resposta não JSON após HTTP 200 mantém o HTTP no diagnóstico', async () => {
  const client = makePagarme(async () => new Response('<html>' + firstKey + '</html>'));
  await reject(client(firstKey, '/paymentlinks'), 'provider_non_json', 200);
});

test('Neon valida certificado e hostname nas URLs antigas e mantém channel binding', async t => {
  for (const prior of ['require','prefer','verify-ca','verify-full']) {
    const pool = makePool('postgresql://user:pass@neon.example/test?channel_binding=require&sslmode=' + prior);
    t.after(() => pool.end());
    const url = new URL(pool.options.connectionString);
    assert.equal(url.searchParams.get('sslmode'), 'verify-full');
    assert.equal(url.searchParams.get('channel_binding'), 'require');
    assert.equal(pool.options.enableChannelBinding, true);
    const client = new pool.Client(pool.options);
    assert.ok(client.ssl);
    assert.notEqual(client.ssl.rejectUnauthorized, false);
    assert.equal(client.ssl.checkServerIdentity, undefined);
  }
});
