import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { defaultMerchant, merchantWebhookSecret } from '../server/merchants.mjs';
import { gatewaySecret } from '../server/gateway.mjs';
import { account, firstKey, fixture, hookSecret, liveKey, otherAccount, otherKey, otherLiveKey, password, secondKey } from './fixture.mjs';

const cronSecret = 'cron-secret-exclusivamente-do-fixture-013';
const recipient = 'relatorios@example.test';
const smtpPassword = 'smtp-password-exclusivamente-do-fixture';
const publicA = 'pk_test_fixture_first_account';
const publicB = 'pk_test_fixture_other_account';
const buyer = { name: 'Comprador Exemplo', cpf: '52998224725', email: 'comprador@example.com', phone: '11900000000',
  cep: '01001000', street: 'Praça da Sé', number: '1', complement: '', neighborhood: 'Sé',
  city: 'São Paulo', state: 'SP', country: 'BR' };

test('Isolamento multi-lojista e relatórios com Pagar.me e SMTP simulados', async t => {
  const delivered = [];
  let failures = 0;
  const app = await fixture({ postgresUrl: process.env.CS013_TEST_POSTGRES_URL, allowLive: true, configOverrides: {
    EMAIL_REPORT_ENABLED: 'true', EMAIL_REPORT_ON_CAPTURE: 'true', EMAIL_REPORT_RECIPIENT: 'sugestao@example.test',
    SMTP_HOST: 'smtp.example.test', SMTP_USER: 'smtp-fixture', SMTP_PASSWORD: smtpPassword,
    EMAIL_FROM: 'remetente@example.test', CRON_SECRET: cronSecret
  }, mailTransport: settings => ({
    async sendMail(mail) {
      assert.equal(settings.host, 'smtp.example.test');
      if (failures > 0) {
        failures--;
        throw Object.assign(new Error('untrusted SMTP response: ' + settings.password), { responseCode: 421 });
      }
      delivered.push(mail);
      return { accepted: [mail.to] };
    }
  }) });
  t.after(app.close);
  let cookie;
  let csrf;
  async function request(path, { method = 'GET', body, merchant, authorization, auth = true } = {}) {
    const endpoint = new URL('/api' + path, app.origin);
    if (merchant) endpoint.searchParams.set('lojista', merchant);
    const headers = {
      ...(auth && cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
      ...(body ? { Origin: app.origin, 'Content-Type': 'application/json' } : {}),
      ...(authorization ? { Authorization: authorization } : {})
    };
    const response = await fetch(endpoint, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (response.headers.get('content-type')?.includes('application/json')) {
      const json = await response.json();
      for (const value of [firstKey, secondKey, liveKey, otherKey, otherLiveKey, smtpPassword]) {
        assert.ok(!JSON.stringify(json).includes(value));
      }
      return { response, json };
    }
    return { response, data: Buffer.from(await response.arrayBuffer()) };
  }
  const post = (path, body = {}, merchant) => request(path, { method: 'POST', body, merchant });
  const put = (path, body, merchant) => request(path, { method: 'PUT', body, merchant });
  const get = (path, merchant) => request(path, { merchant });
  const gateway = (merchant, env, action, body) => post('/admin/gateway/' + env + '/' + action, body, merchant);
  const runCron = () => request('/jobs/notifications', { authorization: 'Bearer ' + cronSecret, auth: false });
  const permission = (merchant, authorized, recipients = [recipient]) => put('/admin/notifications/settings', {
    authorized, recipients, enabled: true, confirmed: authorized
  }, merchant);
  async function shop(merchant, environment, name = 'Produto configurado') {
    assert.equal((await put('/admin/product', { name, description: 'Produto de teste', image: '/images/pc-gamer.webp',
      price: '123,45', maxInstallments: 4, enabled: true, environment, operation: 'auth_and_capture' }, merchant)).response.status, 200);
    return (await get('/checkout', merchant)).json;
  }
  const input = (shop, token = 'token_approved') => ({
    id: randomUUID(), merchantId: shop.merchantId, version: shop.version, gatewayVersion: shop.gatewayVersion,
    buyer, method: 'credit_card', cardToken: token, installments: 2, authentication: { status: 'Y', transactionId: randomUUID() }
  });
  const { response: login, json } = await post('/admin/login', { password });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = json.csrf;
  let second;
  let shopA;
  let shopB;
  let pending;
  let liveA;
  let liveB;
  async function activate(merchant, environment, key, publicKey, expectedAccount) {
    const result = await gateway(merchant, environment, 'add', { secret: key, publicKey });
    assert.equal(result.response.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.account, expectedAccount);
    assert.equal((await gateway(merchant, environment, 'test')).json.connected, true);
    assert.equal((await gateway(merchant, environment, 'activate', { confirmed: true })).json.enabled, true);
  }

  await t.test('duas contas verificadas e escopos independentes, com SK cifrada', async () => {
    assert.equal((await request('/admin/merchants', { auth: false })).response.status, 401);
    await activate(defaultMerchant, 'test', firstKey, publicA, account);
    shopA = await shop(defaultMerchant, 'test', 'Produto A');
    pending = (await post('/orders', input(shopA, 'token_pending'), defaultMerchant)).json;
    assert.equal(pending.status, 'pending');
    const created = await post('/admin/merchants', { name: 'Lojista B' });
    assert.equal(created.response.status, 201);
    second = created.json.id;
    assert.notEqual(second, defaultMerchant);
    assert.equal((await gateway(second, 'test', 'add', { secret: secondKey, publicKey: publicB })).response.status, 409);
    await activate(second, 'test', otherKey, publicB, otherAccount);
    shopB = await shop(second, 'test', 'Produto B');
    assert.equal(shopB.publicKey, publicB);
    assert.equal((await get('/checkout')).json.publicKey, publicA);
    assert.equal((await get('/admin/gateway/live', second)).json.hasKey, false);
    const raw = await app.db.query('SELECT * FROM cs_trp_013_v2.gateway WHERE merchant_id=$1 AND environment=$2', [second, 'test']);
    assert.notEqual(raw.rows[0].secret, otherKey);
    assert.equal(gatewaySecret(app.config, raw.rows[0]), otherKey);
    assert.throws(() => gatewaySecret(app.config, { ...raw.rows[0], merchant_id: defaultMerchant }));
    assert.equal((await get('/checkout', '00000000-0000-4000-8000-000000000002')).response.status, 404);
    assert.equal((await gateway('00000000-0000-4000-8000-000000000002', 'test', 'add', { secret: firstKey })).response.status, 409);
  });

  await t.test('pedidos, extratos, webhooks e operações bloqueiam referências de outro lojista', async () => {
    const b = (await post('/orders', input(shopB), second)).json;
    assert.equal(b.status, 'paid');
    assert.equal((await get('/orders/' + b.id)).response.status, 404);
    assert.equal((await get('/admin/orders/' + pending.id, second)).response.status, 404);
    assert.equal((await post('/admin/orders/' + pending.id + '/refresh', {}, second)).response.status, 404);
    assert.equal((await post('/checkout/3ds', { method: 'credit_card', version: shopA.version,
      gatewayVersion: shopA.gatewayVersion, merchantId: defaultMerchant }, second)).response.status, 409);
    assert.equal((await post('/orders', input(shopA), second)).response.status, 409);
    assert.equal((await post('/orders', { ...input(shopB), id: pending.id }, second)).response.status, 409);
    const detail = (await get('/admin/orders/' + b.id, second)).json;
    assert.equal(detail.events[0].merchant_id, second);
    assert.deepEqual((await get('/admin/transactions/test', second)).json.rows.map(row => row.id), [b.id]);
    assert.deepEqual((await get('/admin/transactions/test')).json.rows.map(row => row.id), [pending.id]);
    const conflicting = gateway(second, 'test', 'replace', { secret: firstKey, publicKey: publicA });
    assert.equal((await conflicting).response.status, 422);
    assert.equal((await gateway(defaultMerchant, 'test', 'replace', { secret: secondKey, publicKey: publicA })).response.status, 200);
    assert.equal((await post('/admin/orders/' + pending.id + '/refresh')).json.status, 'pending');
    assert.equal(app.remote.calls.at(-1).key, secondKey);
    assert.equal((await get('/admin/gateway/test', second)).json.account, otherAccount);
  });

  await t.test('consentimento, cron protegido, XLSX e captura verificada por webhook', async () => {
    assert.equal((await get('/jobs/notifications')).response.status, 404);
    await activate(defaultMerchant, 'live', liveKey, 'pk_first_live_fixture', account);
    await activate(second, 'live', otherLiveKey, 'pk_other_live_fixture', otherAccount);
    liveA = await shop(defaultMerchant, 'live', '=2+2');
    liveB = await shop(second, 'live', 'Produto B no ambiente simulado');
    assert.equal((await put('/admin/notifications/settings', {
      authorized: true, enabled: true, recipients: [recipient], confirmed: false
    }, defaultMerchant)).response.status, 422);
    assert.equal((await permission(defaultMerchant, true)).json.authorized, true);
    const denied = await post('/admin/notifications/test', { recipient }, second);
    assert.equal(denied.response.status, 409);
    assert.equal((await post('/admin/notifications/test', { recipient }, defaultMerchant)).response.status, 200);
    assert.equal(delivered[0].attachments, undefined);
    delivered.length = 0;

    const items = await Promise.all([
      post('/orders', input(liveA, 'token_declined'), defaultMerchant),
      post('/orders', input(liveB), second),
      post('/orders', input(liveA, 'token_pending'), defaultMerchant)
    ]);
    assert.deepEqual(items.map(item => item.json.status), ['declined','paid','pending']);
    assert.equal((await get('/admin/notifications')).json.length, 0);
    const awaiting = items[2].json;
    const remoteOrder = [...app.remote.orders.values()].find(order => order.code === awaiting.id);
    remoteOrder.status = 'paid';
    Object.assign(remoteOrder.charges[0], { status: 'paid', paid_amount: remoteOrder.amount, updated_at: new Date().toISOString() });
    remoteOrder.charges[0].last_transaction.status = 'captured';
    const event = { id: 'hook_ReportsFixture', type: 'order.paid', account: { id: account }, data: { id: remoteOrder.id, code: awaiting.id } };
    app.remote.hooks.set(event.id, event);
    const endpoint = (merchant, env) => '/hooks/pagarme/' + merchant + '/' + env + '/' + merchantWebhookSecret(hookSecret, merchant, env);
    assert.equal((await post(endpoint(second, 'live'), event)).response.status, 204);
    assert.equal((await post(endpoint(defaultMerchant, 'test'), event)).response.status, 204);
    assert.equal((await get('/admin/notifications')).json.length, 0);
    const spoofed = { ...event, data: { ...event.data, id: 'or_IncorrectReference' } };
    assert.equal((await post(endpoint(defaultMerchant, 'live'), spoofed)).response.status, 403);
    assert.equal((await post(endpoint(defaultMerchant, 'live'), event)).response.status, 204);
    assert.equal((await post(endpoint(defaultMerchant, 'live'), event)).response.status, 204);
    assert.equal((await post('/admin/orders/' + awaiting.id + '/refresh')).json.status, 'paid');
    assert.equal((await get('/admin/notifications')).json.length, 1);
    assert.equal(delivered.length, 0);
    await Promise.all([runCron(), runCron()]);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].to, recipient);
    assert.match(delivered[0].subject, /123,45/);
    assert.equal(delivered[0].attachments.length, 1);
    const attachment = delivered[0].attachments[0];
    assert.match(attachment.filename, /^CS-TRP-013_PAGAMENTO_\d{4}-\d\d-\d\d_tran_Direct\d+\.xlsx$/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(attachment.content);
    const sheet = book.getWorksheet('Relatório financeiro');
    assert.equal(sheet.getCell('C2').value, account);
    assert.equal(sheet.getCell('D2').value, awaiting.id);
    assert.equal(sheet.getCell('G2').value, '=2+2');
    assert.equal(sheet.getCell('G2').type, ExcelJS.ValueType.String);
    assert.equal(sheet.getCell('H2').value, 123.45);
    assert.equal(sheet.getCell('H3').value, 123.45);
    assert.equal(sheet.getCell('J2').value, 'Visa');
    assert.equal(sheet.getCell('L2').value, .99);
    assert.equal(sheet.getCell('M2').value, 122.46);
    assert.equal(sheet.autoFilter, 'A1:P2');
    const extracted = JSON.stringify(sheet.getSheetValues());
    for (const privateValue of [liveKey, publicA, buyer.cpf, buyer.email, smtpPassword, '4000100511112003', '"789"']) {
      assert.ok(!extracted.includes(privateValue));
    }
    const sent = (await get('/admin/notifications?status=sent')).json;
    assert.deepEqual(sent.map(row => row.order_id), [awaiting.id]);
    const savedAttachment = '/admin/notifications/' + sent[0].id + '/xlsx';
    assert.equal((await get(savedAttachment, second)).response.status, 404);
    const storedReport = await get(savedAttachment);
    assert.match(storedReport.response.headers.get('content-type'), /spreadsheetml/);
    assert.equal((await get('/admin/notifications', second)).json.length, 0);
    const totals = (await get('/admin/financial-report?consolidated=true&environment=live&status=paid&period=week')).json;
    assert.equal(totals.captured, 1);
    assert.equal(totals.gross, 12345);
    const xlsx = await get('/admin/financial-report?format=xlsx&environment=live', second);
    assert.match(xlsx.response.headers.get('content-type'), /spreadsheetml/);
    await book.xlsx.load(xlsx.data);
    assert.equal(book.getWorksheet('Relatório financeiro').getCell('A2').value, 'Lojista B');
  });

  await t.test('fila persistente, falhas SMTP, revogação, reenvio e não duplicação', async () => {
    const existingDeliveryCount = delivered.length;
    const queued = await post('/orders', input(liveA), defaultMerchant);
    assert.equal(queued.json.status, 'paid');
    failures = 1;
    assert.equal((await runCron()).json.processed, 1);
    let [retryable] = (await get('/admin/notifications?status=pending')).json;
    assert.equal(retryable.attempts, 1);
    assert.equal(retryable.last_error, 'smtp_421');
    assert.equal((await get('/orders/' + queued.json.id)).json.status, 'paid');
    assert.equal((await runCron()).json.processed, 0);
    app.restart();
    await app.db.query('UPDATE cs_trp_013_v2.notification_outbox SET next_attempt_at=now() WHERE id=$1', [retryable.id]);
    await runCron();
    assert.equal(delivered.length, existingDeliveryCount + 1);
    assert.equal((await runCron()).json.processed, 0);

    const uncertain = await post('/orders', input(liveA), defaultMerchant);
    const [reserved] = (await get('/admin/notifications?status=pending')).json;
    await app.db.query(`UPDATE cs_trp_013_v2.notification_outbox SET status='processing',attempts=1,claim_id=$1,
      lease_until=now()-interval '5 seconds', dispatch_started=true WHERE id=$2`, [randomUUID(), reserved.id]);
    app.restart();
    assert.equal((await runCron()).json.processed, 0);
    const [failed] = (await get('/admin/notifications?status=failed')).json;
    assert.equal(failed.last_error, 'delivery_uncertain');
    assert.equal((await post('/admin/notifications/' + failed.id + '/retry', { confirmed: true })).response.status, 409);
    assert.equal((await post('/admin/notifications/' + failed.id + '/retry', { confirmed: true }, second)).response.status, 404);
    assert.equal((await post('/admin/notifications/' + failed.id + '/retry', { confirmed: true, checkedDelivery: true })).response.status, 200);
    const [authorizedRetry] = (await get('/admin/notifications?status=pending')).json;
    assert.equal(authorizedRetry.order_id, uncertain.json.id);

    assert.equal((await permission(defaultMerchant, false)).json.authorized, false);
    assert.equal((await runCron()).json.processed, 0);
    assert.equal(delivered.length, existingDeliveryCount + 1);
    const revoked = (await get('/admin/notifications?status=failed')).json.find(row => row.id === authorizedRetry.id);
    assert.equal(revoked.last_error, 'sharing_revoked');
    assert.equal((await post('/admin/notifications/' + revoked.id + '/retry', { confirmed: true })).response.status, 409);
    assert.equal((await get('/admin/financial-report?consolidated=true&environment=live')).json.orders, 0);
    assert.equal((await get('/admin/notifications/settings')).json.suggestedRecipient, 'sugestao@example.test');
  });

  await t.test('autorização financeira sem captura não envia e cada destinatário autorizado recebe uma vez', async () => {
    const secondRecipient = 'controle@example.test';
    await permission(defaultMerchant, true, [recipient, secondRecipient, recipient.toUpperCase()]);
    const name = 'Produto com captura manual';
    const updated = await put('/admin/product', { name, description: 'Produto de teste', image: '/images/pc-gamer.webp',
      price: '123,45', maxInstallments: 4, enabled: true, environment: 'live', operation: 'auth_only' }, defaultMerchant);
    assert.equal(updated.response.status, 200);
    const configuration = (await get('/checkout')).json;
    const authorized = (await post('/orders', input(configuration), defaultMerchant)).json;
    assert.equal(authorized.status, 'authorized');
    assert.equal((await get('/admin/notifications?status=pending')).json.length, 0);
    assert.equal((await post('/admin/orders/' + authorized.id + '/capture', { confirmed: true })).json.status, 'paid');
    const pending = (await get('/admin/notifications?status=pending')).json;
    assert.deepEqual(pending.map(row => row.recipient).sort(), [secondRecipient, recipient].sort());
    const before = delivered.length;
    await Promise.all([runCron(), runCron()]);
    assert.deepEqual(delivered.slice(before).map(mail => mail.to).sort(), [secondRecipient, recipient].sort());
    assert.equal((await runCron()).json.processed, 0);
  });

  await t.test('a configuração SMTP é cifrada e o sandbox nunca entra na fila', async () => {
    const configured = await put('/admin/notifications/smtp', {
      user: 'user-fixture-update', sender: 'novo-remetente@example.test', password: smtpPassword
    });
    assert.equal(configured.json.configured, true);
    assert.equal(configured.json.sender, 'novo-remetente@example.test');
    const { rows: [raw] } = await app.db.query('SELECT secret FROM cs_trp_013_v2.mail_settings');
    assert.notEqual(raw.secret, smtpPassword);
    assert.equal((await permission(defaultMerchant, true)).response.status, 200);
    const sandbox = await shop(defaultMerchant, 'test');
    assert.equal((await post('/orders', input(sandbox), defaultMerchant)).json.status, 'paid');
    assert.equal((await get('/admin/notifications?status=pending')).json.length, 0);
    const audit = (await app.db.query(`SELECT merchant_id,action,details FROM cs_trp_013_v2.audit
      WHERE action LIKE 'reports.%'`)).rows;
    assert.ok(audit.some(row => row.action === 'reports.sharing' && row.merchant_id === defaultMerchant && row.details.authorized === false));
    assert.ok(audit.some(row => row.action === 'reports.smtp_config'));
    assert.ok(!JSON.stringify(audit).includes(smtpPassword));
  });
});
