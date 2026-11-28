import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, one } from './db.mjs';
import { decrypt, encrypt, HttpError } from './security.mjs';

const settingsTable = 'cs_trp_013_v2.telegram_config';
const consentTable = 'cs_trp_013_v2.telegram_authorizations';
const outbox = 'cs_trp_013_v2.telegram_outbox';
const credentialContext = 'cs-trp-013:telegram';
const maxAttempts = 6;
const credentialSchema = z.object({
  token: z.string().trim().regex(/^\d{1,20}:[A-Za-z0-9_-]{20,100}$/),
  chatId: z.string().trim().regex(/^-?[1-9]\d{0,15}$/).refine(id => Number.isSafeInteger(Number(id)))
}).strict();
const permissionSchema = z.object({ authorized: z.boolean(), confirmed: z.boolean() }).strict();
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });
const time = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium', timeZone: 'America/Sao_Paulo' });

class TelegramError extends Error {
  constructor(code, retryAfter = null) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function telegramBot(fetcher = fetch) {
  return async (credentials, method, body) => {
    let response;
    try {
      response = await fetcher('https://api.telegram.org/bot' + credentials.token + '/' + method, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    } catch (error) {
      if (['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code)) {
        throw new TelegramError('connection_failed', 60);
      }
      throw new TelegramError('delivery_uncertain');
    }
    const answer = await response.json().catch(() => null);
    if (response.ok && answer?.ok === true) {
      if (method === 'getMe' && answer.result?.is_bot === true) return;
      if (method === 'getChat' && String(answer.result?.id) === credentials.chatId) return;
      if (method === 'sendMessage' && Number.isSafeInteger(answer.result?.message_id) &&
          String(answer.result.chat?.id) === credentials.chatId) return;
      throw new TelegramError('delivery_uncertain');
    }
    const code = answer?.ok === false ? answer.error_code : response.status;
    if (code === 429) {
      const after = answer?.parameters?.retry_after;
      throw new TelegramError('rate_limited', Number.isSafeInteger(after) && after > 0 ? Math.min(after, 2147483647) : 60);
    }
    if (code === 401 || code === 404) throw new TelegramError('invalid_token');
    if (code === 400 || code === 403) throw new TelegramError('chat_unavailable');
    if (answer?.ok === false && Number.isInteger(code) && code >= 500) throw new TelegramError('telegram_unavailable', 60);
    throw new TelegramError('delivery_uncertain');
  };
}

const descriptions = {
  invalid_token: 'O Telegram recusou o token do bot.',
  chat_unavailable: 'O Telegram recusou o chat. Confira o ID, a participação e a permissão de envio do bot.',
  rate_limited: 'O Telegram limitou as solicitações. Aguarde antes de repetir.',
  connection_failed: 'Falha ao estabelecer conexão com o Telegram.',
  telegram_unavailable: 'O Telegram respondeu com uma falha temporária.',
  delivery_uncertain: 'O Telegram não confirmou a entrega. Confira o chat antes de repetir.'
};

function formatPayment(item) {
  const { method, installments, at } = item.telegram_payment;
  const methodLabel = { credit_card: 'Cartão de crédito', debit_card: 'Cartão de débito' }[method];
  const instant = at ? new Date(at) : null;
  const store = item.name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim();
  return [
    '✅ PAGAMENTO APROVADO', '🏪 Loja: ' + store, '💰 Valor: ' + money.format(item.actual_paid / 100),
    '💳 Método: ' + (methodLabel ?? 'Não informado pelo gateway'),
    '📊 Parcelas: ' + (installments ? installments + 'x' : 'Não informadas pelo gateway'),
    '🏦 Gateway: Pagar.me', '🧾 Transação: ' + item.transaction_id,
    '📅 Data: ' + (instant ? date.format(instant) : 'Não informada pelo gateway'),
    '🕐 Horário: ' + (instant ? time.format(instant) : 'Não informado pelo gateway'),
    '🟢 Status: PAGO', '🔔 CS TRP 013 — TELEGRAM MONITOR'
  ].join('\n\n');
}

export function makeTelegram(db, config, fetcher) {
  const env = config.telegram ?? {};
  const fromEnv = Boolean(env.token || env.chatId);
  const call = telegramBot(fetcher);
  const settings = (client = db, lock = false) =>
    one(client, 'SELECT * FROM ' + settingsTable + ' WHERE id=1' + (lock ? ' FOR UPDATE' : ''));
  const checkConfig = row => {
    try {
      const raw = fromEnv ? { token: env.token, chatId: env.chatId } :
        row.secret ? JSON.parse(decrypt(config.encryptionKey, row.secret, credentialContext)) : null;
      return credentialSchema.safeParse(raw).data ?? null;
    } catch { return null; }
  };
  const destination = credentials => createHmac('sha256', config.encryptionKey)
    .update(credentialContext + ':chat:' + credentials.chatId).digest('hex');

  async function overview(merchant) {
    const row = await settings();
    const credentials = checkConfig(row);
    const [consent, totals, history] = await Promise.all([
      one(db, `SELECT destination,authorized_at,revoked_at FROM ${consentTable} WHERE merchant_id=$1`, [merchant]),
      one(db, `SELECT count(*) FILTER (WHERE status='sent')::int AS sent,
        count(*) FILTER (WHERE status='failed')::int AS failed FROM ${outbox} WHERE merchant_id=$1`, [merchant]),
      db.query(`SELECT id,transaction_id,status,attempts,last_error,created_at,sent_at FROM ${outbox}
        WHERE merchant_id=$1 ORDER BY created_at DESC,id LIMIT 100`, [merchant])
    ]);
    return {
      configured: Boolean(credentials), source: fromEnv ? 'environment' : 'panel', systemEnabled: Boolean(env.enabled),
      enabled: row.enabled, active: Boolean(env.enabled && row.enabled && credentials && config.notifications?.cronSecret),
      schedulerConfigured: Boolean(config.notifications?.cronSecret),
      authorized: Boolean(credentials && consent && !consent.revoked_at && consent.destination === destination(credentials)),
      authorizedAt: consent?.authorized_at ?? null, revokedAt: consent?.revoked_at ?? null,
      totals, history: history.rows
    };
  }

  async function configure(body) {
    if (fromEnv) throw new HttpError(409, 'Atualize as credenciais nas variáveis da Vercel.');
    const credentials = credentialSchema.safeParse(body).data;
    if (!credentials) throw new HttpError(422, 'Informe um token de bot e um Chat ID numérico válidos.');
    await db.tx(async client => {
      await client.query(`UPDATE ${settingsTable} SET secret=$1 WHERE id=1`,
        [encrypt(config.encryptionKey, JSON.stringify(credentials), credentialContext)]);
      await audit(client, 'telegram.configuration_saved');
    });
    return { saved: true };
  }

  async function toggle(enabled) {
    await db.tx(async client => {
      const row = await settings(client, true);
      if (enabled && (!env.enabled || !checkConfig(row) || !config.notifications?.cronSecret)) {
        throw new HttpError(409, 'Configure as credenciais, TELEGRAM_NOTIFICATIONS_ENABLED e CRON_SECRET para ativar.');
      }
      await client.query(`UPDATE ${settingsTable} SET enabled=$1 WHERE id=1`, [enabled]);
      await audit(client, 'telegram.enabled', { enabled });
    });
    return { enabled };
  }

  async function authorize(merchant, body) {
    const value = permissionSchema.safeParse(body).data;
    if (!value || !value.confirmed) throw new HttpError(422, 'Confirme a decisão do lojista.');
    await db.tx(async client => {
      const credentials = checkConfig(await settings(client, true));
      if (value.authorized && !credentials) throw new HttpError(409, 'Configure o destino central antes de registrar a autorização.');
      if (value.authorized) {
        await client.query(`INSERT INTO ${consentTable} AS prior (merchant_id,authorization_id,destination,authorized_at)
          VALUES ($1,$2,$3,now()) ON CONFLICT (merchant_id) DO UPDATE
          SET authorization_id=excluded.authorization_id,destination=excluded.destination,authorized_at=now(),revoked_at=NULL
          WHERE prior.revoked_at IS NOT NULL OR prior.destination<>excluded.destination`,
        [merchant, randomUUID(), destination(credentials)]);
      } else {
        await client.query(`UPDATE ${consentTable} SET revoked_at=now() WHERE merchant_id=$1 AND revoked_at IS NULL`, [merchant]);
      }
      await audit(client, 'telegram.authorization', { authorized: value.authorized }, merchant);
    });
    return { authorized: value.authorized };
  }

  async function test(send) {
    const error = await db.tx(async client => {
      const row = await settings(client, true);
      const credentials = checkConfig(row);
      if (!credentials) throw new HttpError(409, 'Configure o token e o Chat ID do Telegram.');
      if (row.next_dispatch_at > new Date() || await one(client,
        `SELECT id FROM ${outbox} WHERE status='processing' AND lease_until>=now() LIMIT 1`)) throw new HttpError(429, 'Aguarde o intervalo de envio do Telegram.');
      let failure;
      try {
        if (send) await call(credentials, 'sendMessage', { chat_id: Number(credentials.chatId), link_preview_options: { is_disabled: true },
          text: '🔔 CS TRP 013 — TELEGRAM MONITOR\n\nNotificação de teste. Nenhum pagamento ou dado de cliente foi enviado.' });
        else {
          await call(credentials, 'getMe', {});
          await call(credentials, 'getChat', { chat_id: Number(credentials.chatId) });
        }
      } catch (err) { failure = err; }
      if (send || failure?.retryAfter) await delayDispatch(client, failure?.retryAfter);
      if (!failure) await audit(client, send ? 'telegram.test_sent' : 'telegram.connection_verified');
      return failure;
    });
    if (error) throw new HttpError(error.code === 'rate_limited' ? 429 : 502,
      descriptions[error.code] ?? 'O Telegram não confirmou a solicitação.');
    return send ? { sent: true } : { connected: true };
  }

  async function delayDispatch(client, after = null) {
    await client.query(`UPDATE ${settingsTable} SET next_dispatch_at=GREATEST(next_dispatch_at,
      clock_timestamp()+make_interval(secs=>$1)) WHERE id=1`, [Math.max(3.1, after ?? 0)]);
  }

  async function claim() {
    return db.tx(async client => {
      const row = await settings(client, true);
      const credentials = checkConfig(row);
      if (!row.enabled || !credentials) return null;
      await client.query(`UPDATE ${outbox} SET status='failed',lease_until=NULL,last_error='delivery_uncertain'
        WHERE status='processing' AND lease_until<now()`);
      const { rows } = await client.query(`SELECT o.id,o.merchant_id,o.provider_transaction,a.authorization_id
        FROM ${consentTable} a JOIN cs_trp_013_v2.orders o ON o.merchant_id=a.merchant_id
        JOIN cs_trp_013_v2.merchants m ON m.id=o.merchant_id AND NOT m.quarantined
        WHERE a.destination=$1 AND a.revoked_at IS NULL AND o.environment='live' AND o.account IS NOT NULL
          AND o.telegram_payment IS NOT NULL AND o.status IN ('paid','captured')
          AND o.confirmed_at>=a.authorized_at
          AND COALESCE((o.telegram_payment->>'at')::timestamptz,o.confirmed_at)>=a.authorized_at AND o.actual_paid=o.amount AND o.actual_paid>0
          AND o.provider_transaction ~ '^tran_[A-Za-z0-9]{4,100}$'
          AND NOT EXISTS (SELECT 1 FROM ${outbox} q WHERE q.merchant_id=o.merchant_id AND q.environment='live'
            AND (q.order_id=o.id OR q.transaction_id=o.provider_transaction))
        ORDER BY o.confirmed_at,o.id LIMIT 100`, [destination(credentials)]);
      for (const item of rows) await client.query(`INSERT INTO ${outbox}
        (id,merchant_id,environment,order_id,transaction_id,authorization_id)
        VALUES ($1,$2,'live',$3,$4,$5) ON CONFLICT DO NOTHING`,
      [randomUUID(), item.merchant_id, item.id, item.provider_transaction, item.authorization_id]);
      if (row.next_dispatch_at > new Date()) return null;
      const item = await one(client, `UPDATE ${outbox} SET status='processing',attempts=attempts+1,
        lease_until=now()+interval '2 minutes'
        WHERE id=(SELECT id FROM ${outbox} WHERE status='pending' AND next_attempt_at<=now()
          AND NOT EXISTS (SELECT 1 FROM ${outbox} WHERE status='processing')
          ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`);
      return item;
    });
  }

  async function process() {
    if (!env.enabled || !config.notifications?.cronSecret) return { processed: 0 };
    const item = await claim();
    if (!item) return { processed: 0 };
    await db.tx(async client => {
      const row = await settings(client, true);
      const credentials = checkConfig(row);
      const data = await one(client, `SELECT q.*,m.name,m.quarantined,a.authorization_id AS current_authorization,
        a.destination,a.revoked_at,o.telegram_payment,o.actual_paid,o.amount,o.status AS payment_status,
        o.provider_transaction FROM ${outbox} q JOIN cs_trp_013_v2.orders o
          ON (o.merchant_id,o.environment,o.id)=(q.merchant_id,q.environment,q.order_id)
        JOIN cs_trp_013_v2.merchants m ON m.id=q.merchant_id
        LEFT JOIN ${consentTable} a ON a.merchant_id=q.merchant_id
        WHERE q.id=$1 AND q.status='processing' AND q.lease_until>=now() FOR UPDATE OF q`, [item.id]);
      if (!data) return;
      if (!row.enabled || !credentials) {
        await client.query(`UPDATE ${outbox} SET status='pending',attempts=attempts-1,lease_until=NULL WHERE id=$1`, [item.id]);
        return;
      }
      let failure;
      if (data.quarantined || data.revoked_at || data.current_authorization !== data.authorization_id ||
          data.destination !== destination(credentials)) failure = new TelegramError('authorization_revoked');
      else if (!['paid','captured'].includes(data.payment_status) || data.actual_paid !== data.amount ||
          data.provider_transaction !== data.transaction_id) failure = new TelegramError('payment_not_confirmed');
      else {
        try { await call(credentials, 'sendMessage', { chat_id: Number(credentials.chatId), link_preview_options: { is_disabled: true }, text: formatPayment(data) }); }
        catch (error) { failure = error instanceof TelegramError ? error : new TelegramError('delivery_uncertain'); }
        await delayDispatch(client, failure?.retryAfter);
      }
      const delay = failure?.retryAfter ? Math.max(failure.retryAfter, 60 * 2 ** (data.attempts - 1)) : 0;
      const status = !failure ? 'sent' : delay && data.attempts < maxAttempts ? 'pending' : 'failed';
      await client.query(`UPDATE ${outbox} SET status=$2,last_error=$3,lease_until=NULL,
        sent_at=CASE WHEN $2='sent' THEN now() END,next_attempt_at=now()+make_interval(secs=>$4) WHERE id=$1`,
      [item.id, status, failure?.code ?? null, delay]);
    });
    return { processed: 1 };
  }

  return { overview, configure, toggle, authorize, test, process };
}
