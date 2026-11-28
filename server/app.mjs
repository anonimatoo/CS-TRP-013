import { makeTelegram } from './telegram.mjs';
import { diagnoseDebit } from './debit-diagnostics.mjs';
import { addMerchant, defaultMerchant, merchantId, merchantRow, merchantWebhookSecret } from './merchants.mjs';
import { makeNotifications, notificationFilter, reportFilter, sendWorkbook } from './notifications.mjs';
import { cardAvailability, cardMethod, requires3ds, stoneToken } from './cards.mjs';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { audit, one } from './db.mjs';
import { environment, gatewayRow, gatewaySecret, makeGateway } from './gateway.mjs';
import { makePagarme, ProviderError } from './pagarme.mjs';
import { makePayments, payment, productRow, publicOrder } from './payments.mjs';
import { equalSecret, HttpError, makeSecurity } from './security.mjs';
import { parseBrl, states } from '../shared/validation.mjs';

export const policy = {
  defaultSrc: ["'none'"], baseUri: ["'none'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
  scriptSrc: ["'self'", "https://3ds-nx-js.stone.com.br"], styleSrc: ["'self'"], imgSrc: ["'self'", 'https:'],
  connectSrc: ["'self'", 'https://api.pagar.me', 'https://3ds.stone.com.br', 'https://3ds-sdx.stone.com.br'],
  frameSrc: ['https:'], fontSrc: ["'self'"], formAction: ["https:"]
};

const shopForm = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  image: z.string().trim().max(350).refine(value => /^\/images\/[\w.-]+$/.test(value) || z.url({ protocol: /^https$/ }).safeParse(value).success),
  price: z.string().max(30), maxInstallments: z.number().int().min(1).max(24),
  enabled: z.boolean(), environment, operation: z.enum(['auth_and_capture','auth_only'])
}).strict();

const safeShop = shop => ({
  merchantId: shop.merchant_id,
  name: shop.name, description: shop.description, image: shop.image,
  amount: shop.amount, maxInstallments: shop.max_installments, enabled: shop.enabled,
  environment: shop.environment, operation: shop.operation, version: shop.version
});
const uuidParam = z.uuid();

function parse(schema, value, message) {
  const checked = schema.safeParse(value);
  if (!checked.success) throw new HttpError(422, message);
  return checked.data;
}

const csvCell = value => {
  const text = value instanceof Date ? value.toISOString() : String(value ?? '');
  const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
};

function adminOrder({ checkout_url, telegram_payment, ...row }) {
  return { ...row, has_checkout_url: Boolean(checkout_url) };
}

export function createApp({ db, config, pagarme = makePagarme(), viaFetch = fetch, stoneFetch = fetch, mailTransport, telegramFetch, runLocalNotifications = false }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: { directives: { ...policy, upgradeInsecureRequests: config.production ? [] : null } },
    strictTransportSecurity: config.production,
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '128kb' }));
  const security = makeSecurity(db, config);
  const notifications = makeNotifications(db, config, mailTransport);
  const telegram = makeTelegram(db, config, telegramFetch);
  const runReports = config.notifications?.enabled && config.notifications.onCapture;
  if (runLocalNotifications && (runReports || config.telegram?.enabled)) {
    const timer = setInterval(() => {
      if (runReports) notifications.process().catch(() => console.error('Falha ao processar a fila de relatórios.'));
      if (config.telegram?.enabled) telegram.process().catch(() => console.error('Falha ao processar a fila Telegram.'));
    }, 30000);
    timer.unref();
  }
  function scopedPayments(merchant) {
    return makePayments(db, config, pagarme, merchant.id);
  }
  async function publicMerchant(req) {
    return merchantRow(db, req.query.lojista);
  }
  function validateCheckoutMerchant(input, merchant) {
    if ((input.merchantId ?? defaultMerchant) !== merchant.id) {
      throw new HttpError(409, 'O lojista do checkout mudou. Atualize a página.', { safeToRetry: true });
    }
  }

  app.get('/api/checkout', async (req, res) => {
    const merchant = await publicMerchant(req);
    const product = await productRow(db, merchant.id);
    const current = await gatewayRow(db, merchant.id, product.environment);
    const ready = Boolean(product.enabled && product.amount && current.enabled && current.last_ok && current.secret &&
      (current.environment !== 'live' || config.allowLive));
    const methods = cardAvailability(current, config);
    res.json({ ...safeShop(product), ready: ready && Object.values(methods).some(Boolean),
      methods: ready ? methods : { credit_card: false, debit_card: false },
      publicKey: ready ? current.public_key : null, gatewayVersion: current.version,
      requires3ds: { credit_card: current.credit_requires_3ds, debit_card: current.debit_requires_3ds } });
  });

  app.get('/api/cep/:cep', security.limit('cep', 60, 60), async (req, res) => {
    const cep = parse(z.string().regex(/^\d{8}$/), req.params.cep, 'Informe um CEP com 8 dígitos.');
    let response, data;
    try {
      response = await viaFetch('https://viacep.com.br/ws/' + cep + '/json/', { signal: AbortSignal.timeout(4000), redirect: 'error' });
      if (response.ok) data = await response.json();
    } catch {
      throw new HttpError(503, 'ViaCEP indisponível. Preencha o endereço manualmente.');
    }
    if (response.status === 400) throw new HttpError(422, 'CEP inválido.');
    if (!response.ok || !data) throw new HttpError(503, 'ViaCEP indisponível. Preencha o endereço manualmente.');
    if (data.erro) throw new HttpError(404, 'CEP não encontrado. Preencha o endereço manualmente.');
    res.json({
      street: String(data.logradouro ?? ''), neighborhood: String(data.bairro ?? ''),
      city: String(data.localidade ?? ''), state: states.includes(data.uf) ? data.uf : ''
    });
  });

  app.post('/api/checkout/3ds', security.origin, security.limit('checkout-3ds', 12, 120), async (req, res) => {
    const input = parse(z.object({ method: cardMethod, merchantId: merchantId.optional(), gatewayVersion: z.number().int(), version: z.number().int() }).strict(),
      req.body, 'Dados inválidos para autenticação.');
    const merchant = await publicMerchant(req);
    validateCheckoutMerchant(input, merchant);
    const product = await productRow(db, merchant.id);
    const row = await gatewayRow(db, merchant.id, product.environment);
    if (!product.enabled || !product.amount || !row.enabled || !row.last_ok || !row.secret ||
        (row.environment === 'live' && !config.allowLive) || !cardAvailability(row, config)[input.method] ||
        !requires3ds(row, input.method) || input.version !== product.version || input.gatewayVersion !== row.version) {
      throw new HttpError(409, 'A autenticação não está disponível para este checkout.', { safeToRetry: true });
    }
    res.json({ token: await stoneToken(gatewaySecret(config, row), row.environment, stoneFetch) });
  });

  app.post('/api/orders', security.origin, security.limit('checkout', 12, 120), async (req, res) => {
    const result = payment.safeParse(req.body);
    if (!result.success) throw new HttpError(422, 'Confira os dados obrigatórios, o CPF e o parcelamento.', { safeToRetry: true });
    const input = result.data;
    const merchant = await publicMerchant(req);
    validateCheckoutMerchant(input, merchant);
    res.json(publicOrder(await scopedPayments(merchant).submit(input)));
  });
  app.get('/api/orders/:id', security.limit('status', 90, 60), async (req, res) => {
    const payments = scopedPayments(await publicMerchant(req));
    const row = await payments.get(parse(uuidParam, req.params.id, 'Referência inválida.'));
    if (!row) throw new HttpError(404, 'Pedido não encontrado.');
    res.json(publicOrder(await payments.status(row)));
  });

  app.post('/api/hooks/pagarme/:secret', async (req, res, next) => {
    if (!equalSecret(req.params.secret, config.webhookSecret)) throw new HttpError(404, 'Rota inexistente.');
    next();
  }, security.limit('hooks', 300, 60, true), async (req, res) => {
    await scopedPayments({ id: defaultMerchant }).hook(req.body);
    res.sendStatus(204);
  });

  app.post('/api/hooks/pagarme/:merchant/:env/:secret', security.limit('hooks', 300, 60, true), async (req, res) => {
    const id = merchantId.safeParse(req.params.merchant).data;
    const env = environment.safeParse(req.params.env).data;
    if (!id || !env || !equalSecret(req.params.secret, merchantWebhookSecret(config.webhookSecret, id, env))) {
      throw new HttpError(404, 'Rota inexistente.');
    }
    const merchant = await merchantRow(db, id);
    await scopedPayments(merchant).hook(req.body, env);
    res.sendStatus(204);
  });

  app.get('/api/jobs/notifications', async (req, res) => {
    const secret = config.notifications?.cronSecret;
    if (!secret || !equalSecret(req.get('Authorization') ?? '', 'Bearer ' + secret)) {
      throw new HttpError(404, 'Rota inexistente.');
    }
    if (!config.telegram?.enabled) return res.json(await notifications.process());
    const [reports, monitor] = await Promise.allSettled([notifications.process(), telegram.process()]);
    if (monitor.status === 'rejected') console.error('Falha ao processar a fila Telegram.');
    if (reports.status === 'rejected') throw reports.reason;
    res.json({ ...reports.value, telegram: monitor.status === 'fulfilled' ? monitor.value : { error: 'queue_processing_failed' } });
  });

  app.post('/api/admin/login', security.origin, security.limit('login-ip', 8, 900), security.limit('login-total', 80, 900, true), security.login);
  app.use('/api/admin', security.active);
  app.use('/api/admin', (req, res, next) => ['GET','HEAD'].includes(req.method) ? next() :
    security.origin(req, res, () => security.csrf(req, res, next)));
  app.get('/api/admin/session', (req, res) => res.json({ csrf: req.admin.csrf }));
  app.post('/api/admin/logout', security.logout);
  app.get('/api/admin/merchants', async (_req, res) => {
    const { rows } = await db.query('SELECT id,name,quarantined FROM cs_trp_013_v2.merchants ORDER BY quarantined,created_at,id');
    res.json(rows);
  });
  app.post('/api/admin/merchants', security.limit('merchants', 20, 60), async (req, res) => {
    res.status(201).json(await addMerchant(db, req.body));
  });

  app.get('/api/admin/notifications/smtp', async (_req, res) => res.json(await notifications.smtpInfo()));
  app.put('/api/admin/notifications/smtp', security.limit('smtp-config', 8, 60), async (req, res) => {
    res.json(await notifications.configureSmtp(req.body));
  });

  app.use('/api/admin', async (req, res, next) => {
    const merchant = await merchantRow(db, req.query.lojista, { allowQuarantine: true });
    res.locals.merchant = merchant;
    if (merchant.quarantined && (!['GET','HEAD'].includes(req.method) ||
        !/^\/(summary|transactions|report|orders|financial-report)(\/|$)/.test(req.path))) {
      throw new HttpError(409, 'O histórico sem titularidade está disponível somente para consulta.');
    }
    res.locals.payments = scopedPayments(merchant);
    next();
  });

  app.get('/api/admin/telegram', async (_req, res) => {
    res.json(await telegram.overview(res.locals.merchant.id));
  });
  app.put('/api/admin/telegram/configuration', security.limit('telegram-config', 10, 60, true), async (req, res) => {
    res.json(await telegram.configure(req.body));
  });
  app.put('/api/admin/telegram/activation', security.limit('telegram-config', 10, 60, true), async (req, res) => {
    const input = parse(z.object({ enabled: z.boolean() }).strict(), req.body, 'Informe a configuração de ativação.');
    res.json(await telegram.toggle(input.enabled));
  });
  app.put('/api/admin/telegram/authorization', security.limit('telegram-consent', 20, 60), async (req, res) => {
    res.json(await telegram.authorize(res.locals.merchant.id, req.body));
  });
  app.post('/api/admin/telegram/:action', security.limit('telegram-test', 6, 60, true), async (req, res) => {
    const action = parse(z.enum(['connection','test-message']), req.params.action, 'Ação inválida.');
    res.json(await telegram.test(action === 'test-message'));
  });

  app.get('/api/admin/notifications', async (req, res) => {
    const { lojista, ...query } = req.query;
    const filter = parse(notificationFilter, query, 'Filtros inválidos.');
    res.json(await notifications.history(res.locals.merchant.id, filter));
  });
  app.get('/api/admin/notifications/settings', async (_req, res) => {
    res.json(await notifications.settings(res.locals.merchant.id));
  });
  app.put('/api/admin/notifications/settings', async (req, res) => {
    res.json(await notifications.configure(res.locals.merchant.id, req.body));
  });
  app.post('/api/admin/notifications/test', security.limit('smtp-test', 5, 60), async (req, res) => {
    res.json(await notifications.testMail(res.locals.merchant.id, req.body));
  });
  app.get('/api/admin/notifications/:id/xlsx', async (req, res) => {
    const id = parse(uuidParam, req.params.id, 'Notificação inválida.');
    const snapshot = await notifications.attachment(res.locals.merchant.id, id);
    return sendWorkbook(res, [snapshot]);
  });
  app.post('/api/admin/notifications/:id/retry', security.limit('smtp-retry', 20, 60), async (req, res) => {
    const id = parse(uuidParam, req.params.id, 'Notificação inválida.');
    res.json(await notifications.retry(res.locals.merchant.id, id, req.body));
  });
  app.get('/api/admin/financial-report', async (req, res) => {
    const { lojista, consolidated, format, ...query } = req.query;
    const filter = parse(reportFilter, query, 'Filtros inválidos.');
    if (filter.from && filter.to && filter.from > filter.to) throw new HttpError(422, 'Revise o intervalo de datas.');
    if (consolidated === 'true' && res.locals.merchant.quarantined) throw new HttpError(409, 'Selecione um lojista ativo para consolidar.');
    const rows = await notifications.report(consolidated === 'true' ? null : res.locals.merchant.id, filter);
    if (format === 'xlsx') return sendWorkbook(res, rows);
    const captured = rows.filter(row => row.confirmedAt && ['paid','captured'].includes(row.status));
    const sum = field => captured.some(row => row[field] != null) ? captured.reduce((total, row) => total + (row[field] ?? 0), 0) : null;
    res.json({ orders: rows.length, captured: captured.length, gross: sum('gross') ?? 0, fees: sum('fee'), net: sum('net') });
  });

  const adminGateway = res => makeGateway(db, config, pagarme, stoneFetch, res.locals.merchant.id);
  app.get('/api/admin/gateway/:env', async (req, res) => {
    const env = parse(environment, req.params.env, 'Ambiente inválido.');
    const id = res.locals.merchant.id;
    const webhookUrl = config.origin + '/api/hooks/pagarme/' + id + '/' + env + '/' + merchantWebhookSecret(config.webhookSecret, id, env);
    res.json({ ...await adminGateway(res).get(env), webhookUrl });
  });
  app.post('/api/admin/gateway/:env/debit-diagnostics', security.limit('debit-diagnostics', 12, 60), async (req, res) => {
    const env = parse(environment, req.params.env, 'Ambiente inválido.');
    res.json(await diagnoseDebit({ db, config, pagarme, stoneFetch, env, merchant: res.locals.merchant.id }));
  });
  app.post('/api/admin/gateway/:env/:action', security.limit('gateway', 25, 60), async (req, res) => {
    const env = parse(environment, req.params.env, 'Ambiente inválido.');
    const gateway = adminGateway(res);
    const action = parse(z.enum(['add','replace','test','activate','disable','disconnect','cards']), req.params.action, 'Ação inválida.');
    if (action === 'add' || action === 'replace') return res.json(await gateway.save(env, action, req.body));
    if (action === 'cards') return res.json(await gateway.configure(env, req.body));
    if (action === 'test') return res.json(await gateway.test(env));
    res.json(await gateway.change(env, action, req.body));
  });
  app.get('/api/admin/product', async (_req, res) => {
    res.json({ ...safeShop(await productRow(db, res.locals.merchant.id)), min: config.min, max: config.max });
  });
  app.put('/api/admin/product', async (req, res) => {
    const form = parse(shopForm, req.body, 'Revise os campos da configuração comercial.');
    const amount = parseBrl(form.price);
    if (amount === null || amount < config.min || amount > config.max) throw new HttpError(422, 'Informe um valor em reais dentro dos limites configurados.');
    if (form.maxInstallments > amount) throw new HttpError(422, 'Cada parcela precisa ter pelo menos um centavo.');
    const merchant = res.locals.merchant.id;
    const result = await db.tx(async client => {
      const row = await one(client, `UPDATE cs_trp_013_v2.product SET name=$1,description=$2,image=$3,amount=$4,
        max_installments=$5,enabled=$6,environment=$7,operation=$8,version=version+1
        WHERE id=1 AND merchant_id=$9 RETURNING *`, [form.name,form.description,form.image,amount,form.maxInstallments,
        form.enabled,form.environment,form.operation,merchant]);
      await client.query('INSERT INTO cs_trp_013_v2.prices(version,amount,merchant_id) VALUES($1,$2,$3)', [row.version, amount, merchant]);
      await audit(client, 'product.update', { version: row.version, amount, environment: form.environment }, merchant);
      return safeShop(row);
    });
    res.json(result);
  });

  app.get('/api/admin/summary/:env', async (req, res) => {
    const env = parse(environment, req.params.env, 'Ambiente inválido.');
    const row = await one(db, `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status IN ('paid','captured'))::int AS sales,
      COALESCE(sum(COALESCE(actual_paid,amount)) FILTER (WHERE status IN ('paid','captured')),0) AS approved,
      count(*) FILTER (WHERE status='declined')::int AS declined,
      count(*) FILTER (WHERE status IN ('pending','processing','review','authorized','communication_error'))::int AS pending,
      count(*) FILTER (WHERE status IN ('canceled','refunded'))::int AS canceled
      FROM cs_trp_013_v2.orders WHERE environment=$1 AND merchant_id=$2`, [env,res.locals.merchant.id]);
    res.json(row);
  });

  app.get('/api/admin/transactions/:env', async (req, res) => {
    const env = parse(environment, req.params.env, 'Ambiente inválido.');
    const page = parse(z.coerce.number().int().min(1).max(100000), req.query.page ?? 1, 'Página inválida.');
    const { rows } = await db.query('SELECT * FROM cs_trp_013_v2.orders WHERE environment=$1 AND merchant_id=$3 ORDER BY created_at DESC,id LIMIT 51 OFFSET $2', [env, (page - 1) * 50, res.locals.merchant.id]);
    res.json({ rows: rows.slice(0, 50).map(adminOrder), hasNext: rows.length > 50 });
  });

  app.get('/api/admin/report/:env', async (req, res) => {
    const env = parse(environment, req.params.env, 'Ambiente inválido.');
    const { rows } = await db.query(`SELECT id,created_at,amount,installments,status,checkout_provider_id,provider_order,provider_charge,
      refusal_code,refusal_reason,payment_method,authorized_amount,provider_transaction,authentication_status FROM cs_trp_013_v2.orders WHERE environment=$1 AND merchant_id=$2 ORDER BY created_at DESC LIMIT 10001`, [env, res.locals.merchant.id]);
    if (rows.length > 10000) throw new HttpError(422, 'O volume excede o limite de exportação de 10.000 registros.');
    const heading = ['Pedido','Data UTC','Valor centavos','Parcelas','Status','Checkout Pagar.me','Pedido Pagar.me','Cobrança Pagar.me','Código','Motivo','Modalidade','Autorizado em centavos','Transação Pagar.me','Autenticação'];
    res.attachment('cs-trp-013-' + env + '.csv').type('text/csv').send('\uFEFF' + [heading, ...rows.map(Object.values)].map(row => row.map(csvCell).join(';')).join('\r\n'));
  });

  app.get('/api/admin/orders/:id', async (req, res) => {
    const id = parse(uuidParam, req.params.id, 'Referência inválida.');
    const row = await res.locals.payments.get(id);
    if (!row) throw new HttpError(404, 'Pedido não encontrado.');
    const { rows } = await db.query('SELECT * FROM cs_trp_013_v2.transactions WHERE order_id=$1 AND merchant_id=$2 ORDER BY id DESC', [id, res.locals.merchant.id]);
    res.json({ row: adminOrder(row), events: rows });
  });

  app.post('/api/admin/orders/:id/:action', security.limit('sales-operations', 35, 60), async (req, res) => {
    const { id, action } = req.params;
    const payments = res.locals.payments;
    const row = await payments.get(parse(uuidParam, id, 'Referência inválida.'));
    if (!row) throw new HttpError(404, 'Pedido não encontrado.');
    if (action === 'refresh') return res.json(adminOrder(await payments.refresh(row)));
    const operation = parse(z.enum(['capture','cancel']), action, 'Ação inválida.');
    if (req.body?.confirmed !== true) throw new HttpError(422, 'Confirme a operação.');
    res.json(adminOrder(await payments.operate(row, operation)));
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'Rota inexistente.')));
  app.use((error, _req, res, _next) => {
    if (error instanceof HttpError) return res.status(error.status).json({ message: error.message, ...error.data });
    if (error instanceof ProviderError) return res.status(502).json({ message: 'A Pagar.me não concluiu a consulta. Concilie antes de repetir.', http: error.http, category: error.category });
    if (error.type === 'entity.too.large') return res.status(413).json({ message: 'Solicitação muito grande.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ message: 'JSON inválido.' });
    console.error('Falha interna CS TRP 013', { type: error.constructor?.name, code: /^[A-Z0-9]{5}$/.test(error.code ?? '') ? error.code : undefined });
    res.status(500).json({ message: 'Serviço temporariamente indisponível.' });
  });
  return app;
}
