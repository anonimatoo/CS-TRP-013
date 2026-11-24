import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../scripts/db.mjs';
import { encrypt, decrypt } from '../server/security.mjs';
import { firstKey } from './fixture.mjs';

test('Migração 003 mantém checkout, preço e credencial protegida de uma base 002', async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  const adapter = client => ({
    query: (sql, args) => !args && sql.startsWith('ALTER TABLE') ? client.exec(sql) : client.query(sql, args)
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
  const sealed = encrypt(key, firstKey, 'test:null');
  const url = 'https://payment-link.pagar.me/pl_ExistingLink';
  await pg.query("UPDATE cs_trp_013_v2.gateway SET secret=$1,last_ok=true,enabled=true WHERE environment='test'", [sealed]);
  await pg.query('INSERT INTO cs_trp_013_v2.prices(version,amount) VALUES(2,20000)');
  await pg.query(`INSERT INTO cs_trp_013_v2.orders
    (id,environment,price_version,amount,installments,product_name,status,hosted_checkout,checkout_provider_id,checkout_url,
      checkout_expires_at,http_status) VALUES($1,'test',2,20000,1,'PC Gamer','pending',true,'pl_ExistingLink',$2,now(),201)`, [id, url]);
  await migrate(db);
  await migrate(db);

  const { rows: [order] } = await pg.query('SELECT * FROM cs_trp_013_v2.orders WHERE id=$1', [id]);
  assert.equal(order.checkout_provider_id, 'pl_ExistingLink');
  assert.equal(order.checkout_url, url);
  assert.equal(order.http_status, 201);
  assert.equal(order.checkout_http, null);
  assert.equal(order.amount, 20000);
  const { rows: [gateway] } = await pg.query("SELECT * FROM cs_trp_013_v2.gateway WHERE environment='test'");
  assert.equal(gateway.secret, sealed);
  assert.equal(decrypt(key, gateway.secret, 'test:null'), firstKey);
  assert.equal(gateway.enabled, true);
  assert.equal(gateway.checkout_creation_verified_at, null);
});
