import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, one } from './db.mjs';
import { HttpError } from './security.mjs';

export const defaultMerchant = '00000000-0000-4000-8000-000000000001';
export const merchantId = z.uuid().transform(value => value.toLowerCase());
export const merchantWebhookSecret = (master, id, environment) =>
  createHmac('sha256', master).update('pagarme:' + id + ':' + environment).digest('base64url');

export async function merchantRow(db, input, { allowQuarantine = false } = {}) {
  const parsed = merchantId.safeParse(input === undefined ? defaultMerchant : input);
  if (!parsed.success) throw new HttpError(422, 'Identificador de lojista inválido.');
  const row = await one(db, 'SELECT id,name,quarantined FROM cs_trp_013_v2.merchants WHERE id=$1', [parsed.data]);
  if (!row || (row.quarantined && !allowQuarantine)) throw new HttpError(404, 'Lojista indisponível.');
  return row;
}

export async function addMerchant(db, input) {
  const parsed = z.object({ name: z.string().trim().min(1).max(100) }).strict().safeParse(input);
  if (!parsed.success) throw new HttpError(422, 'Informe o nome comercial do lojista.');
  return db.tx(client => insertMerchant(client, parsed.data.name));
}

export async function insertMerchant(client, name) {
  const id = randomUUID();
  const row = await one(client, `INSERT INTO cs_trp_013_v2.merchants(id,name) VALUES ($1,$2)
    RETURNING id,name,quarantined`, [id, name]);
  await client.query(`INSERT INTO cs_trp_013_v2.gateway(merchant_id,environment) VALUES ($1,'test'),($1,'live')`, [id]);
  await client.query(`INSERT INTO cs_trp_013_v2.product(merchant_id,id,name,description,image)
    VALUES ($1,1,'PC Gamer','Computador gamer personalizado','/images/pc-gamer.webp')`, [id]);
  await audit(client, 'merchant.add', {}, id);
  return row;
}
