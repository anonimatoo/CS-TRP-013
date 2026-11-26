import { defaultMerchant } from '../server/merchants.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { account, firstKey, fixture } from './fixture.mjs';
import { encrypt } from '../server/security.mjs';

test('Pedidos hospedados anteriores continuam conciliáveis sem criar novos links', async t => {
  const app = await fixture();
  t.after(app.close);
  const id = randomUUID();
  const linkId = 'pl_LegacyOrder';
  await app.db.query(`UPDATE cs_trp_013_v2.gateway SET account=$1,secret=$2 WHERE environment='test' AND merchant_id=$3`,
    [account, encrypt(Buffer.alloc(32, 17), firstKey, 'test:' + account), defaultMerchant]);
  await app.db.query('INSERT INTO cs_trp_013_v2.prices(version,amount,merchant_id) VALUES(2,299999,$1)', [defaultMerchant]);
  await app.db.query(`INSERT INTO cs_trp_013_v2.orders
    (id,environment,account,price_version,amount,installments,product_name,status,hosted_checkout,payment_method,checkout_provider_id,merchant_id)
    VALUES($1,'test',$2,2,299999,1,'PC Gamer','communication_error',true,'credit_card',$3,$4)`, [id, account, linkId, defaultMerchant]);
  app.remote.links.set(linkId, {
    id: linkId, name: 'CS TRP 013 ' + id, type: 'order', status: 'active',
    url: 'https://payment-link.stone.com.br/' + linkId,
    created_at: new Date().toISOString(), expires_in: 30,
    max_sessions: 1, max_paid_sessions: 1, total_sessions: 0, total_paid_sessions: 0,
    cart_settings: { total_cost: 299999 },
    payment_settings: { accepted_payment_methods: ['credit_card'],
      credit_card_settings: { installments: [{ number: 1, total: 299999 }] } }
  });
  app.remote.linkCodes.set(linkId, id);
  const get = async () => (await fetch(app.origin + '/api/orders/' + id)).json();
  const recovered = await get();
  assert.equal(recovered.checkoutUrl, 'https://payment-link.stone.com.br/' + linkId);
  app.remote.complete(id);
  await app.db.query('UPDATE cs_trp_013_v2.orders SET checkout_synced_at=NULL WHERE id=$1', [id]);
  const paid = await get();
  assert.equal(paid.status, 'paid');
  assert.equal(paid.checkoutUrl, null);
  assert.equal(app.remote.calls.some(call => call.method === 'POST'), false);
});
