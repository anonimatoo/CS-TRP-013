import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runDebitSandbox } from '../scripts/debit-sandbox.mjs';
import { defaultMerchant } from '../server/merchants.mjs';
import { makePagarme } from '../server/pagarme.mjs';
import { account, firstKey, fixture, liveKey, otherAccount, otherKey, password } from './fixture.mjs';

test('Diagnóstico HTTP por lojista, com titularidade, permissões e histórico de débito', async t => {
  const app = await fixture();
  t.after(app.close);
  let cookie, csrf;
  async function post(path, body = {}, merchant, authenticated = true, withCsrf = true) {
    const url = new URL('/api/admin/' + path, app.origin);
    if (merchant) url.searchParams.set('lojista', merchant);
    const response = await fetch(url, {
      method: 'POST', headers: {
        Origin: app.origin, 'Content-Type': 'application/json',
        ...(authenticated && cookie ? { Cookie: cookie } : {}),
        ...(withCsrf && csrf ? { 'X-CSRF-Token': csrf } : {})
      }, body: JSON.stringify(body)
    });
    return { response, json: await response.json() };
  }
  const path = 'gateway/test/debit-diagnostics';
  assert.equal((await post(path, {}, undefined, false)).response.status, 401);
  const login = await post('login', { password });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  csrf = login.json.csrf;
  assert.equal((await post(path, {}, undefined, true, false)).response.status, 403);
  assert.equal((await post(path)).json.credentialEnvironment, null);
  assert.equal((await post('gateway/test/add', { secret: firstKey })).response.status, 200);
  assert.equal((await post('gateway/live/add', { secret: liveKey })).response.status, 200);
  const { json: merchant } = await post('merchants', { name: 'Segundo lojista' });
  assert.equal((await post('gateway/test/add', { secret: otherKey }, merchant.id)).response.status, 200);

  app.remote.diagnosticCharges = id => Response.json({ data: [
    { id: 'ch_Credit123', payment_method: 'credit_card' },
    { id: id === account ? 'ch_DebitFirst' : 'ch_DebitOther', payment_method: 'debit_card', status: 'paid',
      created_at: '2026-04-01T18:00:00Z', customer: { document: 'internal-data-secret' },
      last_transaction: { id: 'tran_Debit123', status: 'captured', acquirer_name: 'stone', card: { cvv: '987' } } }
  ] });
  const before = app.remote.calls.length;
  const first = await post(path);
  assert.equal(first.response.status, 200);
  assert.equal(first.json.account.id, account);
  assert.equal(first.json.account.source, 'webhook');
  assert.equal(first.json.account.model, null);
  assert.equal(first.json.credentialEnvironment, 'test');
  assert.equal(first.json.commercialStatus, 'unknown');
  assert.deepEqual(first.json.checks.charges, { permission: 'confirmed', http: 200, category: null });
  assert.equal(first.json.checks.threeDS.permission, 'confirmed');
  assert.deepEqual(first.json.history.records.map(({ id, mode, acquirer }) => ({ id, mode, acquirer })),
    [{ id: 'ch_DebitFirst', mode: 'unknown', acquirer: 'stone' }]);
  assert.doesNotMatch(JSON.stringify(first.json), /987|internal-data-secret|fixture-3ds-token|sk_test_/);

  const second = await post(path, {}, merchant.id);
  assert.equal(second.json.account.id, otherAccount);
  assert.deepEqual(second.json.history.records.map(record => record.id), ['ch_DebitOther']);
  assert.ok(second.json.blocks.some(block => block.includes('autorização comercial')));
  await app.db.query("UPDATE cs_trp_013_v2.gateway SET mode='psp' WHERE merchant_id=$1 AND environment='test'", [merchant.id]);
  const psp = (await post(path, {}, merchant.id)).json;
  assert.equal(psp.account.model, 'PSP');
  assert.ok(psp.blocks.some(block => block.includes('conta PSP')));

  await app.db.query('INSERT INTO cs_trp_013_v2.prices (merchant_id,version,amount) VALUES ($1,1,1000)', [defaultMerchant]);
  await app.db.query(`INSERT INTO cs_trp_013_v2.orders
    (id,merchant_id,environment,account,price_version,amount,installments,product_name,status,
     payment_method,provider_charge,provider_transaction,authentication_status)
    VALUES ($1,$2,'test',$3,1,1000,1,'Teste','paid','debit_card','ch_DebitFirst','tran_Debit123','Y')`,
  [randomUUID(), defaultMerchant, account]);
  assert.equal((await post(path)).json.history.records[0].mode, 'authenticated');
  await app.db.query("UPDATE cs_trp_013_v2.orders SET authentication_status=NULL WHERE provider_charge='ch_DebitFirst'");
  assert.equal((await post(path)).json.history.records[0].mode, 'pinless');
  await app.db.query("UPDATE cs_trp_013_v2.orders SET provider_transaction='tran_Other123' WHERE provider_charge='ch_DebitFirst'");
  assert.equal((await post(path)).json.history.records[0].mode, 'unknown');

  app.remote.diagnosticHooks = () => Response.json({ data: [{ account: { id: otherAccount } }] });
  const conflict = (await post(path)).json;
  assert.equal(conflict.account.source, 'conflict');
  assert.equal(conflict.history.state, 'account_conflict');
  assert.deepEqual(conflict.history.records, []);

  app.remote.diagnosticHooks = () => Response.json({}, { status: 403 });
  app.remote.diagnosticCharges = () => Response.json({}, { status: 429 });
  app.remote.diagnostic3dsHttp = 401;
  const live = (await post('gateway/live/debit-diagnostics')).json;
  assert.equal(live.credentialEnvironment, 'live');
  assert.equal(live.account.source, 'linked');
  assert.equal(live.checks.hooks.permission, 'denied');
  assert.equal(live.checks.charges.permission, 'unknown');
  assert.equal(live.checks.charges.http, 429);
  assert.equal(live.checks.threeDS.permission, 'denied');
  assert.ok(live.blocks.some(block => block.includes('ALLOW_LIVE_PAYMENTS')));
  assert.ok(live.blocks.some(block => block.includes('emissão de token 3DS')));
  assert.ok(app.remote.calls.slice(before).every(call => call.method === 'GET'));
});

test('Executor Sandbox valida a chave antes de escrever e usa apenas os cartões oficiais', async () => {
  const calls = [];
  const pagarme = makePagarme(async (url, options) => {
    const input = JSON.parse(options.body);
    const payment = input.payments[0];
    calls.push({ url, options, payment });
    const approved = payment.debit_card.card.number === '4000000000000010';
    return Response.json({
      id: 'or_Simulator123',
      charges: [{ id: 'ch_Simulator123', payment_method: 'debit_card', status: approved ? 'paid' : 'failed' }]
    }, { status: 200 });
  });
  for (const key of [undefined, '', liveKey, ' ' + firstKey]) {
    await assert.rejects(runDebitSandbox(key, pagarme), /PAGARME_DEBIT_SANDBOX_KEY/);
  }
  assert.equal(calls.length, 0);
  const results = await runDebitSandbox(firstKey, pagarme);
  assert.deepEqual(results.map(result => result.status), ['paid', 'declined']);
  assert.deepEqual(calls.map(call => call.payment.debit_card.card.number), ['4000000000000010', '4000000000000028']);
  for (const { url, options, payment } of calls) {
    assert.equal(url, 'https://api.pagar.me/core/v5/orders');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(Buffer.from(options.headers.Authorization.slice(6), 'base64').toString(), firstKey + ':');
    assert.equal(payment.payment_method, 'debit_card');
  }
  assert.notEqual(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
});
