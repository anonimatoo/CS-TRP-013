import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { audit, one } from './db.mjs';
import { decrypt, encrypt, HttpError } from './security.mjs';
import { captureMessage, financialRow, workbook } from './reports.mjs';

const maxAttempts = 6;
const settingsTable = 'cs_trp_013_v2.report_settings';
const queue = 'cs_trp_013_v2.notification_outbox';
const email = z.email().max(254).transform(value => value.toLowerCase());
const active = config => config.notifications?.enabled && config.notifications.onCapture;
const mailContext = 'cs-trp-013:smtp';
const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function enqueueCapture(client, config, row, snapshot) {
  if (!active(config) || row.environment !== 'live' || !snapshot.captured || !snapshot.transactionId ||
      snapshot.paid !== row.amount || !['paid','captured'].includes(row.status)) return;
  const settings = await one(client, `SELECT enabled,authorized,recipients FROM ${settingsTable}
    WHERE merchant_id=$1 FOR SHARE`, [row.merchant_id]);
  if (!settings?.enabled || !settings.authorized) return;
  const merchant = await one(client, 'SELECT name FROM cs_trp_013_v2.merchants WHERE id=$1 AND NOT quarantined', [row.merchant_id]);
  if (!merchant) return;
  const payload = JSON.stringify(financialRow(row, merchant.name));
  for (const recipient of settings.recipients) {
    await client.query(`INSERT INTO ${queue}(id,merchant_id,environment,order_id,transaction_id,recipient,snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (merchant_id,environment,transaction_id,recipient) DO NOTHING`,
    [randomUUID(), row.merchant_id, row.environment, row.id, snapshot.transactionId, recipient, payload]);
  }
}

function smtpTransport(settings) {
  return nodemailer.createTransport({
    host: settings.host, port: settings.port, secure: settings.secure, requireTLS: !settings.secure,
    auth: { user: settings.user, pass: settings.password }, tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 3500, greetingTimeout: 3500, socketTimeout: 5000,
    disableFileAccess: true, disableUrlAccess: true,
    logger: false, debug: false
  });
}

function deliveryFailure(error) {
  const code = error?.responseCode;
  // A negative SMTP reply or a refused connection proves the message was not accepted.
  if (Number.isInteger(code) && code >= 400 && code < 600) {
    return { reason: 'smtp_' + code, retry: code < 500 };
  }
  if (['ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(error?.code) ||
      (error?.code === 'ETIMEDOUT' && ['CONNECT_TIMEOUT','GREETING_TIMEOUT'].includes(error.timeoutType))) {
    return { reason: 'smtp_connection', retry: true };
  }
  return { reason: 'delivery_uncertain', retry: false };
}

function valid(schema, input, message) {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(422, message);
  return result.data;
}

export function makeNotifications(db, config, transport = smtpTransport) {
  const env = config.notifications?.smtp ?? {};
  async function settings(merchant) {
    const row = await one(db, `SELECT enabled,authorized,recipients,authorized_at,updated_at FROM ${settingsTable}
      WHERE merchant_id=$1`, [merchant]);
    const suggested = email.safeParse(config.notifications?.suggestedRecipient ?? '').data;
    return { ...(row ?? { enabled: false, authorized: false, recipients: [] }), suggestedRecipient: suggested ?? '',
      systemEnabled: Boolean(active(config)) };
  }

  async function configure(merchant, input) {
    const value = valid(z.object({
      enabled: z.boolean(), authorized: z.boolean(), recipients: z.array(email).max(5), confirmed: z.boolean()
    }).strict(), input, 'Confira os destinatários e a autorização.');
    const recipients = [...new Set(value.recipients)];
    if (value.authorized && (!value.confirmed || recipients.length === 0)) {
      throw new HttpError(422, 'Confirme a autorização do lojista para os destinatários informados.');
    }
    await db.tx(async client => {
      await client.query(`INSERT INTO ${settingsTable}(merchant_id,enabled,authorized,recipients,authorized_at)
        VALUES($1,$2,$3,$4,CASE WHEN $3 THEN now() END)
        ON CONFLICT (merchant_id) DO UPDATE SET enabled=excluded.enabled,authorized=excluded.authorized,
          recipients=excluded.recipients,authorized_at=excluded.authorized_at,updated_at=now()`,
      [merchant, value.enabled, value.authorized, recipients]);
      await client.query(`UPDATE ${queue} SET status='failed',
        last_error=CASE WHEN status='processing' AND dispatch_started THEN 'delivery_uncertain' ELSE 'sharing_revoked' END,
        claim_id=NULL,lease_until=NULL WHERE merchant_id=$1 AND status IN ('pending','processing') AND (NOT $2 OR NOT recipient=ANY($3::text[]))`,
      [merchant, value.authorized && value.enabled, recipients]);
      await audit(client, 'reports.sharing', { enabled: value.enabled, authorized: value.authorized, recipients }, merchant);
    });
    return settings(merchant);
  }

  async function smtp(connection = db) {
    const row = await one(connection, 'SELECT username,sender,secret FROM cs_trp_013_v2.mail_settings WHERE id=1');
    return row ? { ...env, user: row.username, sender: row.sender,
      password: decrypt(config.encryptionKey, row.secret, mailContext) } : env;
  }

  async function smtpInfo() {
    const connection = await smtp();
    return { host: connection.host, port: connection.port, secure: Boolean(connection.secure),
      configured: Boolean(connection.host && connection.user && connection.password && connection.sender),
      sender: connection.sender ?? '' };
  }

  async function configureSmtp(input) {
    const value = valid(z.object({
      user: z.string().trim().min(1).max(254).regex(/^[^\x00-\x1f\x7f]+$/),
      sender: email, password: z.string().min(1).max(1024)
    }).strict(), input, 'Confira o usuário, a senha SMTP e o remetente.');
    if (!env.host) throw new HttpError(409, 'Configure SMTP_HOST no servidor.');
    await db.tx(async client => {
      await client.query(`INSERT INTO cs_trp_013_v2.mail_settings(id,username,sender,secret)
        VALUES(1,$1,$2,$3) ON CONFLICT (id) DO UPDATE SET username=excluded.username,
          sender=excluded.sender,secret=excluded.secret,updated_at=now()`,
      [value.user, value.sender, encrypt(config.encryptionKey, value.password, mailContext)]);
      await audit(client, 'reports.smtp_config', { sender: value.sender });
    });
    return smtpInfo();
  }

  async function send(mail, connection = db) {
    const settings = await smtp(connection);
    if (!settings.host || !settings.user || !settings.password || !settings.sender) {
      const error = new Error('SMTP indisponível');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    const sender = transport(settings);
    try {
      const result = await sender.sendMail({ ...mail, from: settings.sender });
      if (!result.accepted?.length) {
        const error = new Error('Nenhum endereço aceito');
        error.responseCode = 550;
        throw error;
      }
    } finally {
      sender.close?.();
    }
  }

  async function testMail(merchant, input) {
    const { recipient } = valid(z.object({ recipient: email }).strict(), input, 'Selecione um destinatário autorizado.');
    return db.tx(async client => {
      const row = await one(client, `SELECT authorized,recipients FROM ${settingsTable} WHERE merchant_id=$1 FOR SHARE`, [merchant]);
      if (!row?.authorized || !row.recipients.includes(recipient)) throw new HttpError(409, 'Destinatário sem autorização.');
      try {
        await send({ to: recipient, subject: 'CS TRP 013 — Teste SMTP',
          text: 'Mensagem fictícia de teste. Nenhuma transação ou informação financeira foi enviada.' }, client);
      } catch {
        throw new HttpError(502, 'O servidor SMTP não confirmou o envio de teste.');
      }
      await audit(client, 'reports.smtp_test', { recipient }, merchant);
      return { sent: true };
    });
  }

  async function process(limit = 1) {
    if (!active(config)) return { processed: 0 };
    await db.query(`UPDATE ${queue} SET status='failed',last_error='delivery_uncertain',claim_id=NULL,lease_until=NULL
      WHERE status='processing' AND lease_until<now() AND dispatch_started`);
    await db.query(`UPDATE ${queue} SET status='pending',attempts=attempts-1,claim_id=NULL,lease_until=NULL
      WHERE status='processing' AND lease_until<now() AND NOT dispatch_started`);
    let processed = 0;
    for (let index = 0; index < limit; index++) {
      const claim = randomUUID();
      const item = await one(db, `UPDATE ${queue} SET status='processing',attempts=attempts+1,
        claim_id=$1,lease_until=now()+interval '2 minutes',dispatch_started=false
        WHERE id=(SELECT id FROM ${queue} WHERE status='pending' AND next_attempt_at<=now()
          ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [claim]);
      if (!item) break;
      const dispatch = await one(db, `UPDATE ${queue} SET dispatch_started=true WHERE id=$1 AND claim_id=$2
        AND status='processing' AND lease_until>=now() RETURNING id`, [item.id, claim]);
      if (!dispatch) continue;
      await db.tx(async client => {
        const authorization = await one(client, `SELECT enabled,authorized,recipients FROM ${settingsTable}
          WHERE merchant_id=$1 FOR SHARE`, [item.merchant_id]);
        const current = await one(client, `SELECT id FROM ${queue} WHERE id=$1 AND claim_id=$2 AND status='processing' FOR UPDATE`,
          [item.id, claim]);
        if (!current) return;
        const order = await one(client, 'SELECT status FROM cs_trp_013_v2.orders WHERE id=$1 AND merchant_id=$2',
          [item.order_id, item.merchant_id]);
        let reason = null;
        let retry = false;
        if (!authorization?.enabled || !authorization.authorized || !authorization.recipients.includes(item.recipient)) reason = 'sharing_revoked';
        else if (!['paid','captured'].includes(order?.status)) reason = 'payment_not_captured';
        else {
          let attachment;
          try {
            attachment = await workbook([item.snapshot]);
          } catch {
            reason = 'xlsx_error';
            retry = true;
          }
          if (attachment) {
            try {
              const messageId = '<cs013-' + item.id + '@' + new URL(config.origin).hostname + '>';
              await send(captureMessage(item.snapshot, item.recipient, messageId, attachment), client);
            } catch (error) {
              ({ reason, retry } = deliveryFailure(error));
            }
          }
        }
        const status = reason ? retry && item.attempts < maxAttempts ? 'pending' : 'failed' : 'sent';
        await client.query(`UPDATE ${queue} SET status=$2,last_error=$3,sent_at=CASE WHEN $2='sent' THEN now() END,
          next_attempt_at=now()+make_interval(secs=>$4),claim_id=NULL,lease_until=NULL WHERE id=$1`,
        [item.id, status, reason, 60 * 2 ** (Math.min(item.attempts, maxAttempts) - 1)]);
      });
      processed++;
    }
    return { processed };
  }

  async function history(merchant, filter) {
    const { rows } = await db.query(`SELECT id,order_id,transaction_id,recipient,status,attempts,last_error,created_at,sent_at
      FROM ${queue} WHERE merchant_id=$1 AND ($2::text IS NULL OR status=$2)
      AND ($3::date IS NULL OR (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $3)
      AND ($4::date IS NULL OR (created_at AT TIME ZONE 'America/Sao_Paulo')::date <= $4)
      AND ($5::text IS NULL OR snapshot->>'method'=$5) ORDER BY created_at DESC,id LIMIT 100`,
    [merchant, filter.status ?? null, filter.from ?? null, filter.to ?? null, filter.method ?? null]);
    return rows;
  }

  async function attachment(merchant, id) {
    const row = await one(db, `SELECT snapshot FROM ${queue} WHERE merchant_id=$1 AND id=$2`, [merchant, id]);
    if (!row) throw new HttpError(404, 'Notificação não encontrada.');
    return row.snapshot;
  }

  async function retry(merchant, id, input) {
    const confirmation = valid(z.object({ confirmed: z.literal(true), checkedDelivery: z.boolean().optional() }).strict(),
      input, 'Confirme o reenvio.');
    await db.tx(async client => {
      const permission = await one(client, `SELECT enabled,authorized,recipients FROM ${settingsTable} WHERE merchant_id=$1 FOR SHARE`, [merchant]);
      const row = await one(client, `SELECT * FROM ${queue} WHERE id=$1 AND merchant_id=$2 FOR UPDATE`, [id, merchant]);
      if (!row) throw new HttpError(404, 'Notificação não encontrada.');
      if (!permission?.enabled || !permission.authorized || !permission.recipients.includes(row.recipient) ||
          row.status !== 'failed' || (row.last_error === 'delivery_uncertain' && !confirmation.checkedDelivery)) {
        throw new HttpError(409, 'Reenvio indisponível. Confira o consentimento e, se a entrega é incerta, consulte o provedor SMTP.');
      }
      await client.query(`UPDATE ${queue} SET status='pending',last_error=NULL,next_attempt_at=now() WHERE id=$1`, [id]);
      await audit(client, 'reports.retry', { id, checkedDelivery: Boolean(confirmation.checkedDelivery) }, merchant);
    });
    return { queued: true };
  }

  async function report(merchant, filter) {
    const { rows } = await db.query(`SELECT o.id,o.merchant_id,o.account,o.provider_transaction,o.confirmed_at,
      o.product_name,o.amount,o.payment_method,o.card_brand,o.installments,o.fee_amount,o.net_amount,
      o.status,o.environment,m.name
      FROM cs_trp_013_v2.orders o JOIN cs_trp_013_v2.merchants m ON m.id=o.merchant_id
      LEFT JOIN ${settingsTable} s ON s.merchant_id=o.merchant_id
      WHERE (o.merchant_id=$1 OR ($1::uuid IS NULL AND s.authorized AND NOT m.quarantined))
      AND ($2::text IS NULL OR o.environment=$2)
      AND ($3::text IS NULL OR o.payment_method=$3)
      AND ($4::text IS NULL OR o.status=$4)
      AND ($5::date IS NULL OR (COALESCE(o.confirmed_at,o.created_at) AT TIME ZONE 'America/Sao_Paulo')::date >= $5)
      AND ($6::date IS NULL OR (COALESCE(o.confirmed_at,o.created_at) AT TIME ZONE 'America/Sao_Paulo')::date <= $6)
      AND ($7::text IS NULL OR (COALESCE(o.confirmed_at,o.created_at) AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN
        date_trunc($7,now() AT TIME ZONE 'America/Sao_Paulo')::date AND (now() AT TIME ZONE 'America/Sao_Paulo')::date)
      ORDER BY COALESCE(o.confirmed_at,o.created_at) DESC,o.id LIMIT 10001`,
    [merchant, filter.environment ?? null, filter.method ?? null, filter.status ?? null, filter.from ?? null, filter.to ?? null, filter.period ?? null]);
    if (rows.length > 10000) throw new HttpError(422, 'Reduza o período para exportar até 10.000 pedidos.');
    return rows.map(row => financialRow(row, row.name));
  }

  return { settings, configure, smtpInfo, configureSmtp, testMail, process, history, attachment, retry, report };
}

export const notificationFilter = z.object({
  status: z.enum(['pending','processing','sent','failed']).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  method: z.enum(['credit_card','debit_card']).optional()
}).strict();
export const reportFilter = notificationFilter.omit({ status: true }).extend({
  status: z.enum(['paid','captured','pending','declined','authorized','canceled','refunded','processing','review',
    'communication_error','request_failed','authentication_incomplete','expired','chargedback']).optional(),
  environment: z.enum(['test','live']).optional(),
  period: z.enum(['day','week','month']).optional()
}).strict();

export async function sendWorkbook(res, rows) {
  res.attachment('CS-TRP-013_RELATORIO.xlsx').type(xlsxType).send(await workbook(rows));
}
