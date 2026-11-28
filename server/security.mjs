import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { one } from './db.mjs';

export class HttpError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const secretToken = () => randomBytes(32).toString('base64url');
const hash = (text) => createHash('sha256').update(String(text)).digest();
export const equalSecret = (left, right) => timingSafeEqual(hash(left), hash(right));

export function configFromEnv(env = process.env) {
  const password = env.ADMIN_PASSWORD ?? '';
  const sessionSecret = env.SESSION_SECRET ?? '';
  const encryptionKey = Buffer.from(env.ENCRYPTION_KEY ?? '', 'base64');
  const webhookSecret = env.WEBHOOK_SECRET ?? '';
  const production = env.NODE_ENV === 'production' || env.VERCEL === '1';
  const origin = new URL(env.APP_ORIGIN || (production ? '' : 'http://localhost:5173'));
  const min = Number(env.MIN_PRICE_CENTS || 100);
  const max = Number(env.MAX_PRICE_CENTS || 2147483647);
  if (password.length < 12 || sessionSecret.length < 32 || encryptionKey.length !== 32 ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(webhookSecret)) {
    throw new Error('Configure ADMIN_PASSWORD (12+), SESSION_SECRET (32+), ENCRYPTION_KEY (32 bytes em Base64) e WEBHOOK_SECRET.');
  }
  if (production && origin.protocol !== 'https:') throw new Error('APP_ORIGIN precisa usar HTTPS em produção.');
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max || max > 2147483647) {
    throw new Error('Limites de valor inválidos.');
  }
  const smtpPort = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error('SMTP_PORT inválida.');
  if (env.CRON_SECRET && env.CRON_SECRET.length < 32) throw new Error('CRON_SECRET precisa ter pelo menos 32 caracteres.');
  const merchantDebitApprovals = JSON.parse(env.PAGARME_MERCHANT_DEBIT_APPROVALS || '{}');
  return { password, sessionSecret, encryptionKey, webhookSecret, origin: origin.origin, production, min, max,
    allowLive: env.ALLOW_LIVE_PAYMENTS === 'true',
    debitApproval: { test: env.PAGARME_DEBIT_APPROVAL_TEST, live: env.PAGARME_DEBIT_APPROVAL_LIVE },
    merchantDebitApprovals,
    notifications: { enabled: env.EMAIL_REPORT_ENABLED === 'true', onCapture: env.EMAIL_REPORT_ON_CAPTURE === 'true',
      suggestedRecipient: env.EMAIL_REPORT_RECIPIENT || '', cronSecret: env.CRON_SECRET || '',
      smtp: { host: env.SMTP_HOST || '', port: smtpPort, secure: env.SMTP_SECURE === 'true',
        user: env.SMTP_USER || '', password: env.SMTP_PASSWORD || '', sender: env.EMAIL_FROM || '' } } };
}

export function encrypt(key, data, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const payload = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), payload].map(part => part.toString('base64url')).join('.');
}

export function decrypt(key, value, context) {
  const [iv, tag, payload] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
}

export function makeSecurity(db, config) {
  const cookie = config.production ? '__Host-cs013' : 'cs013';
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/' };
  const identify = value => createHmac('sha256', config.sessionSecret).update(value).digest('hex');

  function origin(req, _res, next) {
    if (req.get('origin') !== config.origin) throw new HttpError(403, 'Origem da solicitação inválida.');
    if (!req.is('application/json')) throw new HttpError(415, 'Envie a solicitação em JSON.');
    next();
  }

  function limit(bucket, max, seconds, global = false) {
    return async (req, _res, next) => {
      const id = identify(bucket + ':' + (global ? 'global' : req.ip));
      const row = await one(db, `INSERT INTO cs_trp_013_v2.rate_limits AS r (id,window_end,attempts)
        VALUES ($1,now()+make_interval(secs => $2),1)
        ON CONFLICT (id) DO UPDATE SET
        attempts = CASE WHEN r.window_end <= now() THEN 1 ELSE r.attempts + 1 END,
        window_end = CASE WHEN r.window_end <= now() THEN excluded.window_end ELSE r.window_end END
        RETURNING attempts`, [id, seconds]);
      if (row.attempts > max) throw new HttpError(429, 'Limite de tentativas atingido. Tente novamente mais tarde.');
      next();
    };
  }

  async function active(req, _res, next) {
    const token = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookie + '='))?.slice(cookie.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'Entre com a senha administrativa.');
    const id = identify(token);
    const current = await one(db, 'SELECT id,csrf FROM cs_trp_013_v2.sessions WHERE id=$1 AND expires_at>now()', [id]);
    if (!current) throw new HttpError(401, 'Sessão encerrada. Entre novamente.');
    req.admin = current;
    next();
  }

  function csrf(req, _res, next) {
    if (!equalSecret(req.get('x-csrf-token'), req.admin.csrf)) throw new HttpError(403, 'Validação de sessão inválida.');
    next();
  }

  async function login(req, res) {
    if (typeof req.body?.password !== 'string' || !equalSecret(req.body.password, config.password)) {
      throw new HttpError(401, 'Senha administrativa incorreta.');
    }
    const token = secretToken();
    const csrfToken = secretToken();
    await db.query("INSERT INTO cs_trp_013_v2.sessions VALUES ($1,$2,now()+interval '4 hours')", [identify(token), csrfToken]);
    res.cookie(cookie, token, { ...cookieOptions, maxAge: 14400000 }).json({ csrf: csrfToken });
  }

  async function logout(req, res) {
    await db.query('DELETE FROM cs_trp_013_v2.sessions WHERE id=$1', [req.admin.id]);
    res.clearCookie(cookie, cookieOptions).json({ ok: true });
  }

  return { origin, limit, active, csrf, login, logout };
}
