import { defaultMerchant } from '../server/merchants.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../scripts/db.mjs';
import { encrypt, decrypt } from '../server/security.mjs';
import { firstKey } from './fixture.mjs';

test('Migrações 003 a 007 mantêm checkout, preço e credencial protegida de uma base 002', async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  const adapter = client => ({
    query: (sql, args) => !args && /^(ALTER TABLE|CREATE TABLE)/.test(sql) && sql.includes(';') ? client.exec(sql) : client.query(sql, args)
  });
  const db = { ...adapter(pg), tx: work => pg.transaction(client => work(adapter(client))) };
  for (const filename of ['001_init.sql', '002_hosted_checkout.sql']) {
    const sql = await readFile(new URL('../database/migrations/' + filename, import.meta.url), 'utf8');
    await pg.exec(sql);
    await pg.exec(`CREATE TABLE IF NOT EXISTS cs_trp_013_v2.migrations
      (filename text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await pg.query('INSERT INTO cs_trp_013_v2.migrations(filename,digest) VALUES($1,$2)',
      [filename, createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')]);
  }
  const id = randomUUID();
  const key = Buffer.alloc(32, 19);
  const sealed = encrypt(key, firstKey, 'test:acc_VerifiedFixture');
  const url = 'https://payment-link.pagar.me/pl_ExistingLink';
  await pg.query("UPDATE cs_trp_013_v2.gateway SET secret=$1,last_ok=true,enabled=true WHERE environment='test'", [sealed]);
  await pg.query('INSERT INTO cs_trp_013_v2.prices(version,amount) VALUES(2,20000)');
  await pg.query(`INSERT INTO cs_trp_013_v2.orders
    (id,environment,price_version,amount,installments,product_name,status,hosted_checkout,checkout_provider_id,checkout_url,
      checkout_expires_at,http_status) VALUES($1,'test',2,20000,1,'PC Gamer','pending',true,'pl_ExistingLink',$2,now(),201)`, [id, url]);
  await pg.query(`INSERT INTO cs_trp_013_v2.transactions(order_id,status) VALUES($1,'pending')`, [id]);
  await pg.query(`INSERT INTO cs_trp_013_v2.webhook_events(id,type,order_id) VALUES('hook_Migrated','order.pending',$1)`, [id]);
  const knownId = randomUUID();
  await pg.query("UPDATE cs_trp_013_v2.gateway SET account='acc_VerifiedFixture' WHERE environment='test'");
  await pg.query(`INSERT INTO cs_trp_013_v2.orders(id,environment,account,price_version,amount,installments,product_name,status)
    VALUES($1,'test','acc_VerifiedFixture',2,20000,1,'PC Gamer','pending')`, [knownId]);
  await migrate(db);
  await migrate(db);

  const { rows: [order] } = await pg.query('SELECT * FROM cs_trp_013_v2.orders WHERE id=$1', [id]);
  assert.equal(order.checkout_provider_id, 'pl_ExistingLink');
  assert.equal(order.checkout_url, url);
  assert.equal(order.http_status, 201);
  assert.equal(order.checkout_http, null);
  assert.equal(order.checkout_diagnostic, null);
  assert.equal(order.reconciliation_diagnostics, null);
  assert.equal(order.amount, 20000);
  assert.equal(order.payment_method, 'credit_card');
  const { rows: [gateway] } = await pg.query("SELECT * FROM cs_trp_013_v2.gateway WHERE environment='test' AND merchant_id=$1", [defaultMerchant]);
  assert.equal((await pg.query('SELECT merchant_id FROM cs_trp_013_v2.orders WHERE id=$1', [knownId])).rows[0].merchant_id, defaultMerchant);
  assert.notEqual(order.merchant_id, defaultMerchant);
  assert.equal((await pg.query('SELECT merchant_id FROM cs_trp_013_v2.transactions WHERE order_id=$1', [id])).rows[0].merchant_id, order.merchant_id);
  assert.equal((await pg.query('SELECT merchant_id FROM cs_trp_013_v2.webhook_events WHERE order_id=$1', [id])).rows[0].merchant_id, order.merchant_id);
  assert.equal((await pg.query('SELECT quarantined FROM cs_trp_013_v2.merchants WHERE id=$1', [order.merchant_id])).rows[0].quarantined, true);
  assert.equal(gateway.secret, sealed);
  assert.equal(decrypt(key, gateway.secret, 'test:acc_VerifiedFixture'), firstKey);
  assert.equal(gateway.enabled, true);
  assert.equal(gateway.debit_enabled, false);
  assert.equal(gateway.checkout_creation_verified_at, null);
});
