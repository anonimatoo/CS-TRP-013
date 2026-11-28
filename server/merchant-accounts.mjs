import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { insertMerchant } from './merchants.mjs';
import { one } from './db.mjs';
import { HttpError } from './security.mjs';

const derive = promisify(scrypt);
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const loginSchema = z.object({ email, password: z.string().min(12).max(128) }).strict();
const registration = loginSchema.extend({ name: z.string().trim().min(1).max(100) });

const hashPassword = (password, salt) =>
  derive(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 });

export async function registerMerchant(db, input) {
  const value = registration.safeParse(input).data;
  if (!value) throw new HttpError(422, 'Informe nome comercial, e-mail e senha de 12 a 128 caracteres.');
  const salt = randomBytes(16);
  const digest = await hashPassword(value.password, salt);
  try {
    return await db.tx(async client => {
      const merchant = await insertMerchant(client, value.name);
      await client.query(`INSERT INTO cs_trp_013_v2.merchant_accounts(merchant_id,email,password_hash)
        VALUES ($1,$2,$3)`, [merchant.id, value.email, salt.toString('hex') + ':' + digest.toString('hex')]);
      return merchant;
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'merchant_accounts_email_key') {
      throw new HttpError(409, 'Este e-mail já está cadastrado.');
    }
    throw error;
  }
}

export async function authenticateMerchant(db, input) {
  const value = loginSchema.safeParse(input).data;
  if (!value) throw new HttpError(401, 'E-mail ou senha incorretos.');
  const row = await one(db, `SELECT a.merchant_id,a.password_hash FROM cs_trp_013_v2.merchant_accounts a
    JOIN cs_trp_013_v2.merchants m ON m.id=a.merchant_id AND NOT m.quarantined WHERE a.email=$1`, [value.email]);
  const [salt, digest] = row?.password_hash.split(':') ?? ['0'.repeat(32), '0'.repeat(128)];
  const actual = await hashPassword(value.password, Buffer.from(salt, 'hex'));
  if (!timingSafeEqual(actual, Buffer.from(digest, 'hex')) || !row) throw new HttpError(401, 'E-mail ou senha incorretos.');
  return row.merchant_id;
}
