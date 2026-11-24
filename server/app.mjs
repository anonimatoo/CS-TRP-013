import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { audit, one } from './db.mjs';
import { checkoutConfigured, environment, gatewayRow, makeGateway } from './gateway.mjs';
import { makePagarme, ProviderError } from './pagarme.mjs';
import { makePayments, payment, productRow, publicOrder } from './payments.mjs';
import { equalSecret, HttpError, makeSecurity } from './security.mjs';
import { parseBrl, states } from '../shared/validation.mjs';

export const policy = {
  defaultSrc: ["'none'"], baseUri: ["'none'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
  scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'https:'],
  connectSrc: ["'self'", 'https://api.pagar.me'], fontSrc: ["'self'"], formAction: ["'none'"]
};

const shopForm = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  image: z.string().trim().max(350).refine(value => /^\/images\/[\w.-]+$/.test(value) || z.url({ protocol: /^https$/ }).safeParse(value).success),
  price: z.string().max(30), maxInstallments: z.number().int().min(1).max(24),
  enabled: z.boolean(), environment, operation: z.enum(['auth_and_capture','auth_only'])
}).strict();

const safeShop = shop => ({
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

export function createApp({ db, config, pagarme = makePagarme(), viaFetch = fetch }) {
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
  const gateway = makeGateway(db, config, pagarme);
  const payments = makePayments(db, config, pagarme);

  app.get('/api/checkout', async (_req, res) => {
    const product = await productRow(db);
    const current = await gatewayRow(db, product.environment);
    const ready = Boolean(product.enabled && product.amount && current.enabled && current.last_ok && current.secret && checkoutConfigured(current) &&
      (current.environment !== 'live' || config.allowLive));
    res.json({ ...safeShop(product), ready, gatewayVersion: current.version, publicKey: ready ? current.public_key : null });
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

  app.post('/api/orders', security.origin, security.limit('checkout', 12, 120), async (req, res) => {
    const result = payment.safeParse(req.body);
    if (!result.success) throw new HttpError(422, 'Confira os dados obrigatórios, o CPF e o parcelamento.', { safeToRetry: true });
    const input = result.data;
    res.json(publicOrder(await payments.submit(input)));
  });
  app.get('/api/orders/:id', security.limit('status', 90, 60), async (req, res) => {
    const row = await payments.get(parse(uuidParam, req.params.id, 'Referência inválida.'));
    if (!row) throw new HttpError(404, 'Pedido não encontrado.');
    res.json(publicOrder(row));
  });

  app.post('/api/hooks/pagarme/:secret', async (req, res, next) => {
    if (!equalSecret(req.params.secret, config.webhookSecret)) throw new HttpError(404, 'Rota inexistente.');
    next();
  }, security.limit('hooks', 300, 60, true), async (req, res) => {
    await payments.hook(req.body);
    res.sendStatus(204);
  });

  app.post('/api/admin/login', security.origin, security.limit('login-ip', 8, 900), security.limit('login-total', 80, 900, true), security.login);
  app.use('/api/admin', security.active);
  app.use('/api/admin', (req, res, next) => ['GET','HEAD'].includes(req.method) ? next() :
    security.origin(req, res, () => security.csrf(req, res, next)));
  app.get('/api/admin/session', (req, res) => res.json({ csrf: req.admin.csrf }));
  app.post('/api/admin/logout', security.logout);
  app.get('/api/admin/gateway/:env', async (req, res) => {
    res.json(await gateway.get(parse(environment, req.params.env, 'Ambiente inválido.')));
  });
  app.post('/api/admin/gateway/:env/:action', security.limit('gateway', 25, 60), async (req, res) => {
    const env = parse(environment, req.params.env, 'Ambiente inválido.');
    const action = parse(z.enum(['add','replace','configure','test','activate','disable','disconnect']), req.params.action, 'Ação inválida.');
    if (['add','replace','configure'].includes(action)) return res.json(await gateway.save(env, action, req.body));
    if (action === 'test') return res.json(await gateway.test(env));
    res.json(await gateway.change(env, action, req.body));
  });
  app.get('/api/admin/product', async (_req, res) => {
    res.json({ ...safeShop(await productRow(db)), min: config.min, max: config.max });
  });
  app.put('/api/admin/product', async (req, res) => {
    const form = parse(shopForm, req.body, 'Revise os campos da configuração comercial.');
    const amount = parseBrl(form.price);
    if (amount === null || amount < config.min || amount > config.max) throw new HttpError(422, 'Informe um valor em reais dentro dos limites configurados.');
    if (form.maxInstallments > amount) throw new HttpError(422, 'Cada parcela precisa ter pelo menos um centavo.');
    const result = await db.tx(async client => {
      const row = await one(client, `UPDATE cs_trp_013_v2.product SET name=$1,description=$2,image=$3,amount=$4,
        max_installments=$5,enabled=$6,environment=$7,operation=$8,version=version+1
        WHERE id=1 RETURNING *`, [form.name,form.description,form.image,amount,form.maxInstallments,
        form.enabled,form.environment,form.operation]);
      await client.query('INSERT INTO cs_trp_013_v2.prices(version,amount) VALUES($1,$2)', [row.version, amount]);
      await audit(client, 'product.update', { version: row.version, amount, environment: form.environment });
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
      FROM cs_trp_013_v2.orders WHERE environment=$1`, [env]);
    res.json(row);
  });

  app.get('/api/admin/transactions/:env', async (req, res) => {
    const env = parse(environment, req.params.env, 'Ambiente inválido.');
    const page = parse(z.coerce.number().int().min(1).max(100000), req.query.page ?? 1, 'Página inválida.');
    const { rows } = await db.query('SELECT * FROM cs_trp_013_v2.orders WHERE environment=$1 ORDER BY created_at DESC,id LIMIT 51 OFFSET $2', [env, (page - 1) * 50]);
    res.json({ rows: rows.slice(0, 50), hasNext: rows.length > 50 });
  });

  app.get('/api/admin/report/:env', async (req, res) => {
    const env = parse(environment, req.params.env, 'Ambiente inválido.');
    const { rows } = await db.query(`SELECT id,created_at,amount,installments,status,provider_order,provider_charge,
      refusal_code,refusal_reason FROM cs_trp_013_v2.orders WHERE environment=$1 ORDER BY created_at DESC LIMIT 10001`, [env]);
    if (rows.length > 10000) throw new HttpError(422, 'O volume excede o limite de exportação de 10.000 registros.');
    const heading = ['Pedido','Data UTC','Valor centavos','Parcelas','Status','Pedido Pagar.me','Cobrança Pagar.me','Código','Motivo'];
    res.attachment('cs-trp-013-' + env + '.csv').type('text/csv').send('\uFEFF' + [heading, ...rows.map(Object.values)].map(row => row.map(csvCell).join(';')).join('\r\n'));
  });

  app.get('/api/admin/orders/:id', async (req, res) => {
    const id = parse(uuidParam, req.params.id, 'Referência inválida.');
    const row = await payments.get(id);
    if (!row) throw new HttpError(404, 'Pedido não encontrado.');
    const { rows } = await db.query('SELECT * FROM cs_trp_013_v2.transactions WHERE order_id=$1 ORDER BY id DESC', [id]);
    res.json({ row, events: rows });
  });

  app.post('/api/admin/orders/:id/:action', security.limit('sales-operations', 35, 60), async (req, res) => {
    const { id, action } = req.params;
    const row = await payments.get(parse(uuidParam, id, 'Referência inválida.'));
    if (!row) throw new HttpError(404, 'Pedido não encontrado.');
    if (action === 'refresh') return res.json(await payments.refresh(row));
    const operation = parse(z.enum(['capture','cancel']), action, 'Ação inválida.');
    if (req.body?.confirmed !== true) throw new HttpError(422, 'Confirme a operação.');
    res.json(await payments.operate(row, operation));
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'Rota inexistente.')));
  app.use((error, _req, res, _next) => {
    if (error instanceof HttpError) return res.status(error.status).json({ message: error.message, ...error.data });
    if (error instanceof ProviderError) return res.status(502).json({ message: 'A Pagar.me não concluiu a consulta. Concilie antes de repetir.', http: error.http });
    if (error.type === 'entity.too.large') return res.status(413).json({ message: 'Solicitação muito grande.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ message: 'JSON inválido.' });
    console.error('Falha interna CS TRP 013', { type: error.constructor?.name, code: /^[A-Z0-9]{5}$/.test(error.code ?? '') ? error.code : undefined });
    res.status(500).json({ message: 'Serviço temporariamente indisponível.' });
  });
  return app;
}
