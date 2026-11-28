import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { defaultMerchant, merchantWebhookSecret } from '../server/merchants.mjs';
import { makeTelegram, telegramBot } from '../server/telegram.mjs';
import { account, fixture, hookSecret, liveKey, otherLiveKey, password, secondLiveKey } from './fixture.mjs';

const token = '123456:synthetic_telegram_token_fixture';
const chatId = '-1001234567890';
const cronSecret = 'cron-exclusivamente-local-telegram-monitor';
const buyer = {
  name: 'Comprador Confidencial', cpf: '52998224725', email: 'comprador@example.com', phone: '11900000000',
  cep: '01001000', street: 'Praça da Sé', number: '1', complement: '', neighborhood: 'Sé',
  city: 'São Paulo', state: 'SP', country: 'BR'
};

test('Telegram Monitor por HTTP, com Pagar.me, Telegram e cron simulados', async t => {
  const delivered = [];
  let nextFailure = null;
  const app = await fixture({
    allowLive: true,
    configOverrides: { TELEGRAM_NOTIFICATIONS_ENABLED: 'true', CRON_SECRET: cronSecret },
    telegramFetch: async (url, options) => {
      assert.match(url, /^https:\/\/api\.telegram\.org\/bot/);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const method = new URL(url).pathname.split('/').at(-1);
      const body = JSON.parse(options.body);
      if (nextFailure) {
        const fail = nextFailure;
        nextFailure = null;
        return fail();
      }
      if (method === 'getMe') return Response.json({ ok: true, result: { is_bot: true } });
      if (method === 'getChat') return Response.json({ ok: true, result: { id: Number(body.chat_id) } });
      assert.equal(method, 'sendMessage');
      delivered.push(body);
      return Response.json({ ok: true, result: { message_id: delivered.length, chat: { id: Number(body.chat_id) } } });
    }
  });
  t.after(app.close);
  let cookie, csrf;
  async function request(path, { method = 'GET', body, merchant, credential = true, authorization } = {}) {
    const url = new URL('/api' + path, app.origin);
    if (merchant) url.searchParams.set('lojista', merchant);
    const b = await fetch(url, { method, headers: {
      ...(body !== undefined ? { Origin: app.origin, 'Content-Type': 'application/json' } : {}),
      ...(cookie && credential ? { Cookie: cookie, ...(credential === 'no-csrf' ? {} : { 'X-CSRF-Token': csrf }) } : {}),
      ...(authorization ? { Authorization: authorization } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = b.status === 204 ? null : await b.json();
    assert.ok(!JSON.stringify(result).includes(token));
    assert.ok(!JSON.stringify(result).includes(chatId));
    return { status: b.status, result, cookie: b.headers.get('set-cookie') };
  }
  const post = (path, body = {}, merchant) => request(path, { method: 'POST', body, merchant });
  const put = (path, body, merchant) => request(path, { method: 'PUT', body, merchant });
  const inspect = async merchant => (await request('/admin/telegram', { merchant })).result;
  const tick = () => request('/jobs/notifications', { authorization: 'Bearer ' + cronSecret });
  const release = () => app.db.query('UPDATE cs_trp_013_v2.telegram_config SET next_dispatch_at=now()');
  const consent = (merchant, authorized = true) => put('/admin/telegram/authorization', { authorized, confirmed: true }, merchant);
  async function activate(merchant, key, publicKey) {
    const route = '/admin/gateway/live/';
    assert.equal((await post(route + 'add', { secret: key, publicKey }, merchant)).status, 200);
    assert.equal((await post(route + 'activate', { confirmed: true }, merchant)).status, 200);
    assert.equal((await put('/admin/product', { name: 'Produto', description: 'Teste local', image: '/images/pc-gamer.webp',
      price: '1.500,00', maxInstallments: 4, enabled: true, environment: 'live', operation: 'auth_and_capture' }, merchant)).status, 200);
  }
  async function order(merchant, cardToken, installments = 1) {
    const shop = (await request('/checkout', { merchant })).result;
    const { result, status } = await post('/orders', {
      id: randomUUID(), merchantId: shop.merchantId, version: shop.version, gatewayVersion: shop.gatewayVersion,
      buyer, method: 'credit_card', cardToken, installments, authentication: { status: 'Y', transactionId: randomUUID() }
    }, merchant);
    assert.equal(status, 200, JSON.stringify(result));
    return result;
  }

  assert.equal((await request('/admin/telegram')).status, 401);
  assert.equal((await request('/jobs/notifications')).status, 404);
  const login = await post('/admin/login', { password });
  cookie = login.cookie.split(';')[0];
  csrf = login.result.csrf;
  assert.equal((await request('/admin/telegram/configuration', {
    method: 'PUT', credential: 'no-csrf', body: { token, chatId }
  })).status, 403);
  assert.equal((await put('/admin/telegram/configuration', { token, chatId: 'abc' })).status, 422);
  assert.equal((await put('/admin/telegram/configuration', { token, chatId })).status, 200);
  const saved = (await app.db.query('SELECT secret FROM cs_trp_013_v2.telegram_config')).rows[0].secret;
  assert.ok(saved && !saved.includes(token) && !saved.includes(chatId));
  assert.equal((await post('/admin/telegram/connection')).status, 200);
  assert.equal((await post('/admin/telegram/test-message')).status, 200);
  assert.match(delivered.pop().text, /Notificação de teste/);
  await release();
  const second = (await post('/admin/merchants', { name: 'Loja B' })).result.id;
  await activate(defaultMerchant, liveKey, 'pk_live_telegram_a');
  await activate(second, otherLiveKey, 'pk_live_telegram_b');
  assert.equal((await put('/admin/telegram/authorization', { authorized: true, confirmed: false })).status, 422);
  assert.equal((await consent(defaultMerchant)).status, 200);
  assert.equal((await order(defaultMerchant, 'token_declined')).status, 'declined');
  const pending = await order(defaultMerchant, 'token_pending', 2);
  assert.equal(pending.status, 'pending');
  assert.equal((await order(second, 'token_approved')).status, 'paid');
  assert.equal((await tick()).result.telegram.processed, 0);
  assert.equal(delivered.length, 0);

  const remote = [...app.remote.orders.values()].find(o => o.code === pending.id);
  remote.status = 'paid';
  const charge = remote.charges[0];
  Object.assign(charge, { status: 'paid', paid_amount: remote.amount, paid_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  charge.last_transaction.status = 'captured';
  const event = { id: 'hook_TelegramPaid123', type: 'order.paid', account: { id: account }, data: { id: remote.id, code: pending.id } };
  const hook = '/hooks/pagarme/' + defaultMerchant + '/live/';
  const endpoint = hook + merchantWebhookSecret(hookSecret, defaultMerchant, 'live');
  assert.equal((await post(hook + 'wrong-secret', event)).status, 404);
  assert.equal((await post(endpoint, event)).status, 502);
  assert.equal((await tick()).result.telegram.processed, 0);
  app.remote.hooks.set(event.id, event);
  assert.equal((await post('/admin/gateway/live/replace', { secret: secondLiveKey, publicKey: 'pk_live_telegram_a' })).status, 200);
  assert.equal((await post(endpoint, event)).status, 204);
  assert.equal((await post(endpoint, event)).status, 204);
  assert.ok(app.remote.calls.some(call => call.route === '/hooks/' + event.id && call.key === secondLiveKey));

  await Promise.all([tick(), tick()]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].chat_id, Number(chatId));
  assert.deepEqual(delivered[0].link_preview_options, { is_disabled: true });
  assert.match(delivered[0].text, /PAGAMENTO APROVADO[\s\S]*Lojista original[\s\S]*1\.500,00[\s\S]*Cartão de crédito[\s\S]*2x/);
  assert.doesNotMatch(delivered[0].text, /Comprador Confidencial|52998224725|comprador@example|4000100511112003|789\b/);
  assert.equal((await inspect()).totals.sent, 1);
  assert.deepEqual((await inspect(second)).history, []);

  assert.equal((await consent(second)).status, 200);
  await order(second, 'token_approved');
  await release();
  nextFailure = () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 90 }, description: token }, { status: 429 });
  assert.equal((await tick()).result.telegram.processed, 1);
  let history = (await inspect(second)).history;
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'pending');
  assert.equal(history[0].last_error, 'rate_limited');
  const cooldown = (await app.db.query('SELECT next_dispatch_at FROM cs_trp_013_v2.telegram_config')).rows[0].next_dispatch_at;
  assert.ok(cooldown > new Date(Date.now() + 85_000));
  assert.equal((await tick()).result.telegram.processed, 0);
  await release();
  await app.db.query('UPDATE cs_trp_013_v2.telegram_outbox SET next_attempt_at=now() WHERE id=$1', [history[0].id]);
  assert.equal((await put('/admin/telegram/activation', { enabled: false })).status, 200);
  assert.equal((await tick()).result.telegram.processed, 0);
  assert.equal((await put('/admin/telegram/activation', { enabled: true })).status, 200);
  assert.equal((await tick()).result.telegram.processed, 1);
  assert.match(delivered.at(-1).text, /Loja B/);
  assert.equal((await inspect(second)).history[0].attempts, 2);
  assert.equal((await inspect()).totals.sent, 1);

  await order(second, 'token_approved');
  await release();
  nextFailure = () => { throw new Error('Resposta perdida: ' + token); };
  assert.equal((await tick()).result.telegram.processed, 1);
  history = (await inspect(second)).history;
  assert.equal(history[0].last_error, 'delivery_uncertain');
  assert.equal(history[0].status, 'failed');
  await order(second, 'token_approved');
  assert.equal((await tick()).result.telegram.processed, 0);
  assert.equal((await consent(second, false)).status, 200);
  await release();
  assert.equal((await tick()).result.telegram.processed, 1);
  assert.equal((await inspect(second)).history[0].last_error, 'authorization_revoked');
  assert.equal(delivered.length, 2);

  const envMonitor = makeTelegram(app.db, { ...app.config, telegram: { enabled: true, token, chatId: '-12345678' } });
  assert.equal((await envMonitor.overview(defaultMerchant)).source, 'environment');
  assert.equal((await envMonitor.overview(defaultMerchant)).authorized, false);
  await assert.rejects(envMonitor.configure({ token, chatId }), error => error.status === 409);
});

test('Telegram Bot API distingue credenciais inválidas, falhas seguras e resultado ambíguo', async () => {
  const reject = (code, result) => telegramBot(async () => Response.json(result, { status: code }));
  const credentials = { token, chatId };
  await assert.rejects(reject(401, { ok: false, error_code: 401, description: token })(credentials, 'getMe', {}),
    { message: 'invalid_token' });
  await assert.rejects(reject(400, { ok: false, error_code: 400, description: chatId })(credentials, 'getChat', {}),
    { message: 'chat_unavailable' });
  await assert.rejects(telegramBot(async () => {
    throw new Error('Network', { cause: { code: 'ECONNREFUSED' } });
  })(credentials, 'sendMessage', {}), { message: 'connection_failed', retryAfter: 60 });
  await assert.rejects(reject(502, {})(credentials, 'sendMessage', {}), { message: 'delivery_uncertain' });
});
