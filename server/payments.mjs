import { merchantId } from './merchants.mjs';
import { enqueueCapture } from './notifications.mjs';
import { cardAvailability, cardMethod, requires3ds } from './cards.mjs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digits, validCpf, states } from '../shared/validation.mjs';
import { audit, one } from './db.mjs';
import { bindGatewayAccount, gatewayRow, gatewaySecret } from './gateway.mjs';
import { hostedCheckoutName, hostedCheckoutUrl, inspectCheckoutUrl, ProviderError, providerId, readPayment } from './pagarme.mjs';
import { HttpError } from './security.mjs';

const required = (max) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const payment = z.object({
  id: z.uuid(), version: z.number().int().positive(), gatewayVersion: z.number().int().nonnegative(), installments: z.number().int().min(1).max(24),
  merchantId: merchantId.optional(),
  method: cardMethod,
  cardToken: z.string().regex(/^token_[A-Za-z0-9_-]{4,120}$/).optional(),
  authentication: z.object({ status: z.enum(['Y','A','N','C','U','R','I','canceled','unavailable']),
    transactionId: z.uuid().optional() }).strict().optional(),
  buyer: z.object({
    name: required(64).refine(name => name.split(/\s+/).length >= 2).transform(name => name.toLocaleUpperCase('pt-BR')),
    cpf: z.string().max(14).refine(validCpf).transform(digits),
    email: z.email().max(64), phone: z.string().max(18).transform(digits).refine(phone => /^[1-9][0-9]9\d{8}$/.test(phone)),
    cep: z.string().max(9).transform(digits).refine(cep => /^\d{8}$/.test(cep)),
    street: required(130), number: required(20), complement: z.string().trim().max(128),
    neighborhood: required(100), city: required(64), state: z.enum(states), country: z.literal('BR')
  }).strict()
}).strict();

export const productRow = (db, merchant, lock = false) =>
  one(db, 'SELECT * FROM cs_trp_013_v2.product WHERE id=1 AND merchant_id=$1' + (lock ? ' FOR UPDATE' : ''), [merchant]);

const checkoutMinutes = 30;
const activeHostedStatuses = ['processing','pending','communication_error','review','authorized','request_failed'];
const financialEnd = ['paid','captured','declined','canceled','refunded','chargedback'];
const closedLinkStatuses = ['expired','cancelled','canceled'];
const rejectedCreation = new Set([400,401,403,422]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const incompleteOrderLists = ['orders_list_invalid_shape', 'provider_non_json'];
const inconsistentOrders = [...incompleteOrderLists, 'order_reference_mismatch', 'order_reference_ambiguous',
  'order_response_invalid_shape', 'order_amount_mismatch'];
const linkPageSize = 30;
const linkPageLimit = 5;
const linkCollectionFields = ['data', 'payment_links', 'paymentlinks', 'links', 'items', 'results'];
const diagnosticFields = [
  ...linkCollectionFields, 'paging', 'pagination', 'next', 'next_page', 'has_next', 'total', 'total_pages',
  'id', 'code', 'order', 'orders', 'order_code', 'name', 'url', 'type', 'status', 'amount', 'charges', 'cart_settings',
  'total_cost', 'payment_settings', 'credit_card_settings', 'installments', 'created_at', 'expires_at',
  'expires_in', 'total_sessions', 'total_paid_sessions', 'max_sessions', 'max_paid_sessions', 'message', 'errors'
];

const dataType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

function shape(value) {
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (!object(value)) return { type: dataType(value) };
  return {
    type: 'object',
    fields: Object.fromEntries(diagnosticFields.filter(field => Object.hasOwn(value, field))
      .map(field => [field, dataType(value[field])])),
    fieldCount: Object.keys(value).length
  };
}

function responseError(operation, result, check, category, extra) {
  return new ProviderError(result.http, category, {
    operation, http: result.http, check, body: shape(result.data),
    ...(result.data?.data != null ? { data: shape(result.data.data) } : {}),
    ...extra
  });
}

function linkCollection(body) {
  if (Array.isArray(body)) return { entries: body };
  if (!object(body)) return {};
  const arrays = [body, body.data].filter(object).flatMap(container => linkCollectionFields
    .filter(field => Array.isArray(container[field]))
    .map(field => ({ entries: container[field], paging: container.paging ?? container.pagination ?? body.paging ?? body.pagination })));
  return arrays.length === 1 ? arrays[0] : {};
}

function hasMoreLinks(paging, page, count) {
  if (paging == null) return count === linkPageSize;
  if (!object(paging)) return null;
  const { next, next_page: nextPage, has_next: hasNext, total, total_pages: totalPages } = paging;
  if ((next != null && typeof next !== 'string') ||
      (nextPage != null && nextPage !== 0 && (!Number.isSafeInteger(nextPage) || nextPage <= page)) ||
      (hasNext != null && typeof hasNext !== 'boolean') ||
      [total, totalPages].some(value => value != null && (!Number.isSafeInteger(value) || value < 0))) return null;
  if (!['next', 'next_page', 'has_next', 'total', 'total_pages'].some(field => Object.hasOwn(paging, field))) return null;
  return Boolean(next || nextPage || hasNext || total > page * linkPageSize || totalPages > page);
}

function correlatedCheckoutId(row, data, requireName = false) {
  if (!object(data) || (requireName && data.name !== hostedCheckoutName(row.id)) ||
      (data.name != null && data.name !== hostedCheckoutName(row.id)) ||
      (data.order_code != null && data.order_code !== row.id)) return null;
  const id = providerId(data.id, 'pl');
  return !row.checkout_provider_id || id === row.checkout_provider_id ? id : null;
}

export function publicOrder(row) {
  const checkoutUrl = row.status === 'pending' && !row.provider_order && !row.provider_charge &&
    (row.reconciliation_state == null || ['checkout_found','checkout_found_order_unverified'].includes(row.reconciliation_state)) &&
    Date.parse(row.checkout_expires_at) > Date.now() ? hostedCheckoutUrl(row.checkout_url) : null;
  return {
    id: row.id, merchantId: row.merchant_id, method: row.payment_method, authenticationStatus: row.authentication_status, status: row.status, amount: row.amount, installments: row.installments, environment: row.environment,
    http: row.http_status, refusalCode: row.refusal_code, providerStatus: row.provider_status, checkoutUrl,
    checkoutError: row.checkout_error ?? null,
    reconciliation: row.reconciliation_state ?? (row.status === 'communication_error' ? 'pending' : null),
    checkoutExpiresAt: row.checkout_expires_at ?? null,
    newPurchaseAllowed: row.status === 'authentication_incomplete' || (row.status === 'request_failed' && row.reconciliation_state === 'rejected') ||
      row.reconciliation_state === 'closed_without_order' ||
      (row.reconciliation_state == null && Boolean(row.checkout_provider_id) && ['expired','canceled'].includes(row.status)) ||
      (Boolean(row.provider_order || row.provider_charge) && financialEnd.includes(row.status))
  };
}

function checkoutDate(value) {
  return typeof value === 'string' && z.iso.datetime({ offset: true }).safeParse(value).success ? Date.parse(value) : NaN;
}

function validateCheckout(row, result, operation) {
  const envelope = result.data;
  const data = operation === 'GET /paymentlinks/{id}' && object(envelope) &&
    !Object.hasOwn(envelope, 'id') && object(envelope.data) ? envelope.data : envelope;
  const require = (condition, check, category = 'checkout_response_invalid_shape', extra) => {
    if (!condition) throw responseError(operation, result, check, category, extra);
  };
  require(object(data), 'checkout_object');
  const id = providerId(data.id, 'pl');
  require(id && (!row.checkout_provider_id || id === row.checkout_provider_id), 'checkout_id', 'checkout_id_invalid');
  require(data.name == null || data.name === hostedCheckoutName(row.id), 'checkout_name', 'checkout_reference_mismatch');
  require(data.order_code == null || data.order_code === row.id, 'checkout_order_code', 'checkout_reference_mismatch');
  const url = inspectCheckoutUrl(data.url);
  require(url.url, url.reason, url.reason === 'url_missing' ? 'checkout_url_missing' : 'checkout_url_invalid',
    url.hostname ? { hostname: url.hostname } : undefined);
  require(data.name != null, 'checkout_name', 'checkout_incomplete');
  require(data.type === 'order', 'checkout_type', data.type == null ? 'checkout_incomplete' : 'checkout_response_invalid_shape');
  const total = data.cart_settings?.total_cost;
  require(total != null, 'checkout_cart_total', 'checkout_incomplete');
  require(Number.isSafeInteger(total), 'checkout_cart_total', 'checkout_response_invalid_shape', { cart: shape(data.cart_settings) });
  require(total === row.amount, 'checkout_cart_total', 'checkout_amount_mismatch');
  const plans = data.payment_settings?.credit_card_settings?.installments;
  if (plans != null) {
    require(Array.isArray(plans) && plans.length === 1 && plans[0]?.number === row.installments &&
      plans[0]?.total === row.amount, 'checkout_installments', 'checkout_installments_mismatch');
  }
  require(data.status != null && data.total_sessions != null, 'checkout_session_state', 'checkout_incomplete');
  require(['active', 'building', ...closedLinkStatuses].includes(data.status), 'checkout_status');
  const paidSessions = data.total_paid_sessions ?? 0;
  require(Number.isSafeInteger(data.total_sessions) && data.total_sessions >= 0 &&
    Number.isSafeInteger(paidSessions) && paidSessions >= 0 && paidSessions <= data.total_sessions, 'checkout_session_counters');

  const created = checkoutDate(data.created_at);
  const absolute = checkoutDate(data.expires_at);
  require((data.created_at == null || Number.isFinite(created)) && (data.expires_at == null || Number.isFinite(absolute)),
    'checkout_dates', 'checkout_date_invalid');
  require(Number.isFinite(absolute) || Number.isFinite(created), 'checkout_dates', 'checkout_incomplete');
  const duration = data.expires_in ?? checkoutMinutes;
  require(Number.isSafeInteger(duration) && duration >= 0 && (duration > 0 || Number.isFinite(absolute)), 'checkout_duration', 'checkout_date_invalid');
  const cap = Number.isFinite(created) ? created + checkoutMinutes * 60000 : absolute;
  const expires = new Date(Math.min(cap, Number.isFinite(absolute) ? absolute : created + duration * 60000));
  require(Number.isFinite(expires.getTime()) && (!Number.isFinite(created) || expires.getTime() >= created), 'checkout_dates', 'checkout_date_invalid');
  return {
    id, url: url.url, expires, remoteStatus: data.status, used: data.total_sessions > 0,
    singleSession: data.max_sessions === 1 && data.max_paid_sessions === 1
  };
}

function billingDetails(buyer) {
  const address = {
    line_1: [buyer.number, buyer.street, buyer.neighborhood].join(', '),
    ...(buyer.complement ? { line_2: buyer.complement } : {}),
    zip_code: buyer.cep, city: buyer.city, state: buyer.state, country: buyer.country
  };
  return {
    name: buyer.name, email: buyer.email, document: buyer.cpf, document_type: 'CPF', type: 'individual', address,
    phones: { mobile_phone: { country_code: '55', area_code: buyer.phone.slice(0, 2), number: buyer.phone.slice(2) } }
  };
}

export function makePayments(db, config, pagarme, merchant) {
  const get = (id, connection = db, lock = false) =>
    one(connection, 'SELECT * FROM cs_trp_013_v2.orders WHERE id=$1 AND merchant_id=$2' + (lock ? ' FOR UPDATE' : ''), [id, merchant]);

  async function apply(client, id, providerOrder, snapshot, http) {
    const current = await get(id, client, true);
    if (!current || (current.provider_order && providerOrder && current.provider_order !== providerOrder)) {
      throw new HttpError(409, 'O pedido retornado não corresponde ao pedido local.');
    }
    if (current.provider_updated_at && (!snapshot.updatedAt || current.provider_updated_at > snapshot.updatedAt)) return current;
    if (['paid','captured','refunded','canceled','chargedback'].includes(current.status) &&
        ['pending','processing','review','authorized','declined'].includes(snapshot.status)) return current;
    if (['refunded','canceled','chargedback'].includes(current.status) && ['paid','captured'].includes(snapshot.status)) return current;
    if (current.provider_charge && snapshot.chargeId && current.provider_charge !== snapshot.chargeId) {
      throw new HttpError(409, 'A cobrança retornada não corresponde à cobrança local.');
    }
    const row = await one(client, `UPDATE cs_trp_013_v2.orders SET
      provider_order=COALESCE($2, provider_order),provider_charge=COALESCE($3, provider_charge),
      status=$4,http_status=$5,refusal_code=$6,refusal_reason=$7,provider_status=$8,
      provider_updated_at=COALESCE($9,provider_updated_at),actual_paid=COALESCE($10,actual_paid),
      authorized_amount=COALESCE($11,authorized_amount),provider_transaction=COALESCE($12,provider_transaction),
      reconciliation_state=CASE WHEN hosted_checkout THEN 'order_found' ELSE reconciliation_state END,
      reconciliation_error=NULL,reconciliation_http=$5,reconciliation_diagnostics=NULL,reconciliation_at=now(),updated_at=now(),
      card_brand=COALESCE($14,card_brand), fee_amount=COALESCE($15,fee_amount),
      net_amount=COALESCE($16,net_amount), confirmed_at=COALESCE(confirmed_at,$17), account=COALESCE(account,$18),
      telegram_payment=CASE WHEN confirmed_at IS NULL THEN $19::jsonb ELSE telegram_payment END
      WHERE id=$1 AND merchant_id=$13 RETURNING *`,
    [id, providerOrder, snapshot.chargeId, snapshot.status, http, snapshot.refusalCode,
      snapshot.refusalReason, snapshot.providerStatus, snapshot.updatedAt, snapshot.paid, snapshot.authorized, snapshot.transactionId, merchant, snapshot.brand, snapshot.fee, snapshot.net,
      snapshot.captured ? snapshot.updatedAt ?? new Date() : null, snapshot.verifiedAccount ?? null,
      current.environment === 'live' && snapshot.telegramPayment ? JSON.stringify(snapshot.telegramPayment) : null]);
    const latest = await one(client, `SELECT provider_id,status FROM cs_trp_013_v2.transactions
      WHERE order_id=$1 AND merchant_id=$2 ORDER BY id DESC LIMIT 1`, [id, merchant]);
    if (latest?.status !== row.status || latest?.provider_id !== snapshot.transactionId) {
      await client.query(`INSERT INTO cs_trp_013_v2.transactions(order_id,provider_id,status,payment_method,authorized_amount,
        authentication_status,refusal_code,refusal_reason,merchant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, snapshot.transactionId, row.status, row.payment_method, row.authorized_amount,
          row.authentication_status, row.refusal_code, row.refusal_reason, merchant]);
    }
    const action = await one(client, 'SELECT action FROM cs_trp_013_v2.payment_actions WHERE order_id=$1 AND merchant_id=$2', [id, merchant]);
    const completed = action?.action === 'capture' ? ['paid','captured'] : ['canceled','refunded','chargedback'];
    if (action && completed.includes(row.status)) {
      await client.query('DELETE FROM cs_trp_013_v2.payment_actions WHERE order_id=$1 AND merchant_id=$2', [id, merchant]);
    }
    if (!current.confirmed_at) await enqueueCapture(client, config, row, snapshot);
    return row;
  }

  async function reserve(input) {
    return db.tx(async client => {
      const previous = await get(input.id, client);
      if (previous) return { row: previous };
      const product = await productRow(client, merchant, true);
      const afterLock = await get(input.id, client);
      if (afterLock) return { row: afterLock };
      const gateway = await gatewayRow(client, merchant, product.environment, true);
      if (!product.enabled || !product.amount || !gateway.enabled || !gateway.last_ok || !gateway.secret ||
          (gateway.environment === 'live' && !config.allowLive)) {
        throw new HttpError(503, 'Pagamento indisponível no momento.', { safeToRetry: true });
      }
      if (input.version !== product.version || input.gatewayVersion !== gateway.version) {
        throw new HttpError(409, 'O lojista atualizou o checkout. Revise o valor e tente novamente.', { safeToRetry: true });
      }
      if (!cardAvailability(gateway, config)[input.method]) throw new HttpError(409, 'Modalidade indisponível.', { safeToRetry: true });
      const needs3ds = requires3ds(gateway, input.method);
      const authenticated = input.authentication?.status === 'Y' && Boolean(input.authentication.transactionId);
      const incomplete = needs3ds && !authenticated;
      if ((!needs3ds && input.authentication) || (needs3ds && !input.authentication) ||
          (!incomplete && !input.cardToken) || (incomplete && input.cardToken)) {
        throw new HttpError(422, 'Dados de autenticação ou token inválidos.', { safeToRetry: true });
      }
      if (input.method === 'debit_card' && input.installments !== 1) {
        throw new HttpError(422, 'O débito deve ser pago à vista.', { safeToRetry: true });
      }
      if (input.installments > Math.min(product.max_installments, product.amount)) {
        throw new HttpError(422, 'O parcelamento selecionado não está disponível.', { safeToRetry: true });
      }
      const row = await one(client, `INSERT INTO cs_trp_013_v2.orders
        (id,environment,account,price_version,amount,installments,product_name,status,payment_method,authentication_status,checkout_attempted_at,merchant_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11) ON CONFLICT DO NOTHING RETURNING *`,
      [input.id, gateway.environment, gateway.account, product.version, product.amount, input.installments, product.name,
        incomplete ? 'authentication_incomplete' : 'processing', input.method,
        needs3ds ? input.authentication.status : null, merchant]);
      if (row && incomplete) {
        await client.query(`INSERT INTO cs_trp_013_v2.transactions(order_id,status,payment_method,authentication_status,merchant_id)
          VALUES ($1,$2,$3,$4,$5)`, [row.id, row.status, row.payment_method, row.authentication_status, merchant]);
        return { row };
      }
      if (row) return { row, product, gateway };
      const existing = await get(input.id, client);
      if (!existing) throw new HttpError(409, 'Referência indisponível neste checkout.', { safeToRetry: true });
      return { row: existing };
    });
  }

  async function providerRead(operation, key, path, signal) {
    try {
      return await pagarme(key, path, { signal });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      throw new ProviderError(error.http, error.category, { operation, http: error.http, check: error.category });
    }
  }

  async function rememberCheckout(row, result, operation) {
    const id = correlatedCheckoutId(row, result.data, operation === 'GET /paymentlinks');
    if (!id || row.checkout_provider_id) return row;
    try {
      const updated = await one(db, `UPDATE cs_trp_013_v2.orders SET checkout_provider_id=$2,updated_at=now()
        WHERE id=$1 AND merchant_id=$3 AND checkout_provider_id IS NULL RETURNING *`, [row.id, id, merchant]);
      const stored = updated ?? await get(row.id);
      if (stored.checkout_provider_id === id) return { ...row, checkout_provider_id: id };
    } catch (error) {
      if (error.code !== '23505' || error.constraint !== 'orders_merchant_env_checkout_key') throw error;
    }
    throw responseError(operation, result, 'checkout_id_conflict', 'checkout_reference_ambiguous');
  }

  async function storeCheckout(row, result, { operation, creationHttp = null, orderError } = {}) {
    const link = validateCheckout(row, result, operation);
    const closed = closedLinkStatuses.includes(link.remoteStatus);
    const available = link.remoteStatus === 'active' && !link.used && link.expires.getTime() > Date.now() &&
      (!orderError || (link.singleSession && incompleteOrderLists.includes(orderError.category) &&
        !orderError.diagnostic.matchingOrderEvidence));
    const closedWithoutOrder = closed && !link.used && !orderError && creationHttp == null;
    const state = available ? (orderError ? 'checkout_found_order_unverified' : 'checkout_found') :
      closedWithoutOrder ? 'closed_without_order' : 'pending';
    const status = closedWithoutOrder ? (link.remoteStatus === 'expired' ? 'expired' : 'canceled') : 'pending';
    const diagnostics = orderError ? JSON.stringify([orderError.diagnostic]) : null;
    return await one(db, `UPDATE cs_trp_013_v2.orders SET checkout_provider_id=$2,checkout_url=$3,checkout_expires_at=$4,
      status=$5,http_status=$6,reconciliation_state=$7,
      checkout_http=COALESCE($8,checkout_http),
      checkout_synced_at=CASE WHEN checkout_url IS NULL AND $7::text='checkout_found' THEN NULL ELSE checkout_synced_at END,
      reconciliation_error=$11,reconciliation_http=$10,reconciliation_diagnostics=$12::jsonb,reconciliation_at=now(),updated_at=now()
      WHERE id=$1 AND merchant_id=$13 AND (checkout_provider_id IS NULL OR checkout_provider_id=$2)
      AND provider_order IS NULL AND provider_charge IS NULL
      AND (reconciliation_at IS NULL OR reconciliation_at <= $9) RETURNING *`,
    [row.id, link.id, available ? link.url : null, link.expires, status, creationHttp ?? result.http, state, creationHttp,
      row.reconcileStartedAt ?? row.checkout_attempted_at, orderError?.http ?? result.http, orderError?.category ?? null, diagnostics, merchant])
      ?? await get(row.id);
  }

  async function storeCheckoutResponse(key, row, result, { operation, creationHttp, orderError, signal }) {
    const linked = await rememberCheckout(row, result, operation);
    // A collection entry can be a summary. Confirm the chosen reference through the authenticated detail endpoint.
    if (operation === 'GET /paymentlinks' && correlatedCheckoutId(linked, result.data, true)) {
      const id = linked.checkout_provider_id;
      const detail = await providerRead('GET /paymentlinks/{id}', key, '/paymentlinks/' + id, signal);
      return storeCheckout(linked, detail, { operation: 'GET /paymentlinks/{id}', orderError });
    }
    try {
      return await storeCheckout(linked, result, { operation, creationHttp, orderError });
    } catch (error) {
      if (!(error instanceof ProviderError) || !correlatedCheckoutId(linked, result.data) ||
          !['checkout_incomplete', 'checkout_url_missing'].includes(error.category) || operation !== 'POST /orders') throw error;
      const detail = await providerRead('GET /paymentlinks/{id}', key, '/paymentlinks/' + linked.checkout_provider_id, signal);
      return storeCheckout(linked, detail, { operation: 'GET /paymentlinks/{id}', creationHttp, orderError });
    }
  }

  async function recordCreation(gateway, row, http, error = null) {
    await db.query(`UPDATE cs_trp_013_v2.gateway SET checkout_attempted_at=$3,checkout_http=$4,checkout_error=$5,
      checkout_creation_verified_at=CASE WHEN $5::text IS NULL THEN $3 ELSE checkout_creation_verified_at END
      WHERE environment=$1 AND merchant_id=$6 AND secret=$2 AND (checkout_attempted_at IS NULL OR checkout_attempted_at <= $3)`,
    [gateway.environment, gateway.secret, row.checkout_attempted_at, http, error, merchant]);
  }

  async function submit(input) {
    const { row, product, gateway } = await reserve(input);
    if (!gateway) {
      return ['processing','communication_error','request_failed'].includes(row.status) ? status(row) : row;
    }
    let http = null;
    try {
      const key = paymentSecret(gateway);
      const customer = billingDetails(input.buyer);
      const card = {
        card_token: input.cardToken, card: { billing_address: customer.address },
        ...(input.method === 'credit_card' ? { installments: row.installments, operation_type: product.operation } : {}),
        ...(requires3ds(gateway, input.method) ? {
          authentication: { type: 'threed_secure', threed_secure: {
            mpi: 'pagarme', transaction_id: input.authentication.transactionId
          } }
        } : {})
      };
      const result = await pagarme(key, '/orders', { method: 'POST', idempotency: row.id, body: {
        code: row.id, closed: true, customer,
        items: [{ code: 'CS-TRP-013', description: row.product_name, amount: row.amount, quantity: 1 }],
        payments: [{ payment_method: input.method, [input.method]: card }]
      } });
      http = result.http;
      return await applyProviderOrder(row, { ...result, operation: 'POST /orders' });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const recordedHttp = http ?? error.http;
      const rejected = http === null && (rejectedCreation.has(error.http) || error.category === 'gateway_configuration');
      const diagnostic = error.diagnostic ?? { operation: 'POST /orders', http: error.http, check: error.category };
      console.warn('Falha no checkout Pagar.me', { order: row.id, environment: row.environment, http: recordedHttp, category: error.category, diagnostic });
      const saved = await one(db, `UPDATE cs_trp_013_v2.orders SET
        status=CASE WHEN checkout_url IS NULL AND provider_order IS NULL AND reconciliation_at IS NULL THEN $2 ELSE status END,
        http_status=CASE WHEN reconciliation_at IS NULL THEN $3 ELSE http_status END,
        checkout_http=$3,checkout_error=$4,checkout_diagnostic=$6::jsonb,
        checkout_attempted_at=COALESCE(checkout_attempted_at,now()),
        reconciliation_state=CASE WHEN reconciliation_at IS NULL THEN $5 ELSE reconciliation_state END,updated_at=now()
        WHERE id=$1 AND merchant_id=$7 RETURNING *`,
      [row.id, rejected ? 'request_failed' : 'communication_error', recordedHttp, error.category, rejected ? 'rejected' : 'pending',
        JSON.stringify(diagnostic), merchant])
        ?? await get(row.id);
      if (rejected && saved.status === 'request_failed') {
        await db.query(`INSERT INTO cs_trp_013_v2.transactions(order_id,status,payment_method,authentication_status,merchant_id)
          VALUES ($1,$2,$3,$4,$5)`, [row.id, saved.status, row.payment_method, row.authentication_status, merchant]);
      }
      await recordCreation(gateway, row, recordedHttp, error.category);
      return saved;
    }
  }

  function paymentSecret(gateway) {
    try {
      return gatewaySecret(config, gateway);
    } catch {
      throw new ProviderError(null, 'gateway_configuration');
    }
  }

  async function keyFor(row) {
    const gateway = await gatewayRow(db, merchant, row.environment);
    if (!gateway.secret || (row.account && gateway.account !== row.account)) {
      throw new HttpError(409, 'Reconecte uma credencial da conta associada ao pedido.');
    }
    return paymentSecret(gateway);
  }

  async function findProviderOrder(key, row, signal) {
    if (row.provider_order) return {
      ...await providerRead('GET /orders/{id}', key, '/orders/' + row.provider_order, signal),
      operation: 'GET /orders/{id}'
    };
    const operation = 'GET /orders';
    const result = await providerRead(operation, key, '/orders?size=2&code=' + row.id, signal);
    const body = result.data;
    const list = body?.data;
    if (!Array.isArray(list) || (body.errors != null && (!Array.isArray(body.errors) || body.errors.length > 0))) {
      const possible = [body, list].flatMap(value => [value, value?.orders, value?.order,
        ...linkCollectionFields.map(field => value?.[field])]);
      const found = possible.flatMap(value => Array.isArray(value) ? value : [value]).some(order => order?.code === row.id);
      const check = Array.isArray(list) ? 'orders_error_envelope' : 'orders_data_array';
      throw responseError(operation, result, check, 'orders_list_invalid_shape',
        found ? { matchingOrderEvidence: true } : undefined);
    }
    const paging = body.paging;
    if (paging != null && (!object(paging) ||
        (paging.next != null && typeof paging.next !== 'string') ||
        (paging.total != null && (!Number.isSafeInteger(paging.total) || paging.total < list.length)))) {
      throw responseError(operation, result, 'orders_paging', 'orders_list_invalid_shape',
        list.length ? { matchingOrderEvidence: true } : undefined);
    }
    if (list.length > 1 || paging?.next || paging?.total > list.length) {
      throw responseError(operation, result, 'orders_reference_unique', 'order_reference_ambiguous');
    }
    if (list.some(order => order?.code !== row.id)) {
      throw responseError(operation, result, 'order_code', 'order_reference_mismatch');
    }
    return { http: result.http, data: list[0], operation };
  }

  async function setReconciliation(row, { http, error = null, diagnostics = [], state = 'pending', blockCheckout = false }) {
    return await one(db, `UPDATE cs_trp_013_v2.orders SET
      status=CASE WHEN status='processing' AND provider_order IS NULL THEN 'communication_error' ELSE status END,
      reconciliation_state=CASE WHEN provider_order IS NULL AND reconciliation_state IS DISTINCT FROM 'rejected'
        AND ($7 OR reconciliation_state IS NULL OR reconciliation_state IN ('pending','checkout_found_order_unverified') OR
          (reconciliation_state='checkout_found' AND checkout_expires_at<=now())) THEN $5 ELSE reconciliation_state END,
      reconciliation_error=$2,reconciliation_http=$3,reconciliation_diagnostics=$6::jsonb,reconciliation_at=now()
      WHERE id=$1 AND merchant_id=$8 AND (reconciliation_at IS NULL OR reconciliation_at <= $4) RETURNING *`,
    [row.id, error, http, row.reconcileStartedAt, state, diagnostics.length ? JSON.stringify(diagnostics) : null, blockCheckout, merchant])
      ?? await get(row.id);
  }

  async function findProviderCheckout(key, row, signal) {
    const operation = 'GET /paymentlinks';
    const name = hostedCheckoutName(row.id);
    const query = new URLSearchParams({ per_page: String(linkPageSize), name });
    let match;
    for (let page = 1; page <= linkPageLimit; page++) {
      query.set('page', String(page));
      const result = await providerRead(operation, key, '/paymentlinks?' + query, signal);
      const { entries, paging } = linkCollection(result.data);
      if (!entries || entries.length > linkPageSize || !entries.every(link => object(link) && typeof link.name === 'string')) {
        throw responseError(operation, result, 'paymentlinks_collection', 'checkout_list_invalid_shape');
      }
      for (const entry of entries) {
        if (entry.name !== name) continue;
        if (match) throw responseError(operation, result, 'paymentlinks_reference_unique', 'checkout_reference_ambiguous');
        match = { ...result, data: entry };
      }
      const more = hasMoreLinks(paging, page, entries.length);
      if (more === null) throw responseError(operation, result, 'paymentlinks_paging', 'checkout_list_invalid_shape');
      if (!more) return { match, http: result.http };
      if (page === linkPageLimit) {
        throw responseError(operation, result, 'paymentlinks_paging_limit', 'checkout_list_incomplete');
      }
    }
  }

  async function refreshHostedCheckout(key, row, { orderError, signal }) {
    if (row.checkout_provider_id) {
      if (!orderError && row.reconciliation_state === 'checkout_found' && Date.parse(row.checkout_expires_at) > Date.now()) return row;
      const operation = 'GET /paymentlinks/{id}';
      const result = await providerRead(operation, key, '/paymentlinks/' + row.checkout_provider_id, signal);
      return storeCheckout(row, result, { operation, orderError });
    }
    const { match, http } = await findProviderCheckout(key, row, signal);
    if (match) return storeCheckoutResponse(key, row, match, { operation: 'GET /paymentlinks', orderError, signal });
    const rejected = !orderError && row.status === 'request_failed' && rejectedCreation.has(row.http_status);
    return setReconciliation(row, {
      http: orderError?.http ?? http, error: orderError?.category,
      diagnostics: orderError ? [orderError.diagnostic] : [],
      state: rejected ? 'rejected' : 'pending', blockCheckout: Boolean(orderError)
    });
  }

  async function status(row) {
    if (!activeHostedStatuses.includes(row.status) ||
        row.reconciliation_state === 'rejected') return row;
    if (row.status === 'processing' && Date.now() - Date.parse(row.created_at) < 20000) return row;
    const claimed = await one(db, `UPDATE cs_trp_013_v2.orders SET checkout_synced_at=now()
      WHERE id=$1 AND merchant_id=$2 AND (checkout_synced_at IS NULL OR checkout_synced_at < now()-interval '30 seconds')
      RETURNING *`, [row.id, merchant]);
    return claimed ? refresh(claimed, { background: true }) : get(row.id);
  }

  async function applyProviderOrder(row, result, verifiedAccount) {
    const { data, operation = 'GET /orders/{id}' } = result;
    const id = providerId(data?.id, 'or');
    if (!id || (row.provider_order && id !== row.provider_order) || data.code !== row.id) {
      throw responseError(operation, result, 'order_id_and_code', 'order_reference_mismatch');
    }
    if (!['pending','paid','canceled','failed'].includes(data.status) ||
        (data.charges != null && (!Array.isArray(data.charges) || data.charges.length > 1))) {
      throw responseError(operation, result, 'order_status_or_charges', 'order_response_invalid_shape');
    }
    const charge = data.charges?.[0];
    if (data.amount !== row.amount || (charge && charge.amount !== row.amount)) {
      throw responseError(operation, result, 'order_amount', 'order_amount_mismatch');
    }
    if (row.payment_method && charge?.payment_method && charge.payment_method !== row.payment_method) {
      throw responseError(operation, result, 'payment_method', 'order_reference_mismatch');
    }
    const snapshot = readPayment(charge, data.status);
    snapshot.verifiedAccount = verifiedAccount;
    if (charge && !snapshot.chargeId) throw responseError(operation, result, 'charge_id', 'order_reference_mismatch');
    if (!snapshot.updatedAt && Number.isFinite(Date.parse(data.updated_at))) snapshot.updatedAt = new Date(data.updated_at);
    return db.tx(client => apply(client, row.id, id, snapshot, result.http));
  }

  async function refresh(row, { background = false } = {}) {
    const current = { ...row, reconcileStartedAt: new Date() };
    const signal = AbortSignal.timeout(22000);
    let orderError;
    try {
      const key = await keyFor(row);
      if (row.provider_charge) {
        const operation = 'GET /charges/{id}';
        const result = await providerRead(operation, key, '/charges/' + row.provider_charge, signal);
        if (result.data?.id !== row.provider_charge) throw responseError(operation, result, 'charge_id', 'order_reference_mismatch');
        if (result.data?.amount !== row.amount) throw responseError(operation, result, 'charge_amount', 'order_amount_mismatch');
        return await db.tx(client => apply(client, row.id, row.provider_order, readPayment(result.data), result.http));
      }
      try {
        const result = await findProviderOrder(key, row, signal);
        if (result.data !== undefined) return await applyProviderOrder(row, result);
      } catch (error) {
        const incompatible = error instanceof ProviderError && error.diagnostic?.operation === 'GET /orders' &&
          inconsistentOrders.includes(error.category);
        if (!row.hosted_checkout || row.provider_order || !incompatible || error.http < 200 || error.http >= 300) throw error;
        orderError = error;
      }
      if (row.hosted_checkout) return await refreshHostedCheckout(key, current, { orderError, signal });
      return row.provider_order || !['processing','communication_error'].includes(row.status)
        ? row : await setReconciliation(current, { http: 200 });
    } catch (error) {
      if (!(error instanceof ProviderError || error instanceof HttpError)) throw error;
      const category = error.category ?? 'gateway_configuration';
      const diagnostics = [orderError?.diagnostic, error.diagnostic ??
        { operation: 'gateway', http: error.http ?? null, check: category }].filter(Boolean);
      const updated = await setReconciliation(current, {
        http: error.http ?? null, error: category, diagnostics,
        blockCheckout: Boolean(orderError || error.diagnostic?.operation.startsWith('GET /orders'))
      });
      if (background) return updated;
      throw error;
    }
  }

  async function operate(row, action) {
    const statuses = action === 'capture' ? ['authorized'] : ['authorized','paid','captured'];
    if ((action === 'capture' && row.payment_method === 'debit_card') || !row.provider_charge || !statuses.includes(row.status)) throw new HttpError(409, 'A ação não está disponível neste estado.');
    if (row.environment === 'live' && !config.allowLive) throw new HttpError(409, 'Operações financeiras de produção estão bloqueadas.');
    const key = await keyFor(row);
    const operation = await db.tx(async client => {
      const current = await get(row.id, client, true);
      if (!statuses.includes(current.status)) throw new HttpError(409, 'O estado da cobrança mudou.');
      const pending = await one(client, 'SELECT action FROM cs_trp_013_v2.payment_actions WHERE order_id=$1 AND merchant_id=$2 LIMIT 1', [row.id, merchant]);
      if (pending) throw new HttpError(409, 'Há uma operação já enviada. Atualize a cobrança e concilie no painel da Pagar.me.');
      const requestId = randomUUID();
      await client.query('INSERT INTO cs_trp_013_v2.payment_actions(order_id,action,request_id,merchant_id) VALUES ($1,$2,$3,$4)', [row.id, action, requestId, merchant]);
      await audit(client, 'payments.' + action, { id: row.id }, merchant);
      return requestId;
    });
    const path = '/charges/' + row.provider_charge;
    const result = action === 'capture'
      ? await pagarme(key, path + '/capture', { method: 'POST', idempotency: operation, body: { amount: row.amount } })
      : await pagarme(key, path, { method: 'DELETE', idempotency: operation });
    if (result.data?.id !== row.provider_charge || result.data?.amount !== row.amount) throw new ProviderError(result.http, 'order_reference_mismatch');
    const snapshot = readPayment(result.data);
    return db.tx(client => apply(client, row.id, row.provider_order, snapshot, result.http));
  }

  async function hook(event, environment) {
    const eventId = providerId(event?.id, 'hook');
    const kind = event?.type ?? event?.event ?? '';
    if (!eventId || typeof kind !== 'string' || !/^(order|charge)\.[a-z_]{1,50}$/.test(kind)) return;
    const isOrder = kind.startsWith('order.');
    const remoteId = providerId(event.data?.id, isOrder ? 'or' : 'ch');
    const localId = isOrder ? event.data?.code : event.data?.order?.code;
    const lookup = z.uuid().safeParse(localId);
    if (!remoteId) return;
    let row;
    if (lookup.success) row = await get(lookup.data);
    else {
      const { rows } = await db.query(`SELECT * FROM cs_trp_013_v2.orders
        WHERE merchant_id=$1 AND ($2::text IS NULL OR environment=$2)
        AND ${isOrder ? 'provider_order' : 'provider_charge'}=$3 LIMIT 2`,
      [merchant, environment ?? null, remoteId]);
      if (rows.length !== 1) return;
      [row] = rows;
    }
    const account = providerId(event.account?.id, 'acc');
    if (!row || !account || (environment && row.environment !== environment) || (row.account && row.account !== account)) return;
    const expectedId = isOrder ? row.provider_order : row.provider_charge;
    if (expectedId && expectedId !== remoteId) throw new HttpError(403, 'Evento não corresponde ao pedido.');
    const gateway = await gatewayRow(db, merchant, row.environment);
    if (gateway.account && gateway.account !== account) return;
    if (await one(db, 'SELECT id FROM cs_trp_013_v2.webhook_events WHERE id=$1 AND merchant_id=$2 AND environment=$3',
      [eventId, merchant, row.environment])) return;
    if (!gateway.secret || (row.account && row.account !== gateway.account)) {
      throw new HttpError(409, 'Reconecte uma credencial da conta associada ao pedido.');
    }
    const key = paymentSecret(gateway);
    const auth = await pagarme(key, '/hooks/' + eventId);
    const verified = auth.data;
    if (verified?.id !== eventId || (verified.type ?? verified.event) !== kind ||
        verified.account?.id !== account || verified.data?.id !== remoteId) {
      throw new HttpError(403, 'Evento não confirmado pela Pagar.me.');
    }
    await bindGatewayAccount(db, config, gateway, account);
    let result;
    if (isOrder) result = await applyProviderOrder(row, await pagarme(key, '/orders/' + remoteId), account);
    else if (row.provider_charge) {
      const charge = await pagarme(key, '/charges/' + remoteId);
      if (charge.data?.id !== remoteId || charge.data?.amount !== row.amount) {
        throw new HttpError(409, 'A cobrança não corresponde ao pedido.');
      }
      const snapshot = readPayment(charge.data);
      snapshot.verifiedAccount = account;
      result = await db.tx(client => apply(client, row.id, row.provider_order, snapshot, charge.http));
    } else {
      const order = await findProviderOrder(key, row, AbortSignal.timeout(22000));
      if (order.data?.charges?.[0]?.id !== remoteId) throw new HttpError(409, 'A cobrança ainda não está disponível.');
      result = await applyProviderOrder(row, order, account);
    }
    if (!result.provider_order || (isOrder ? result.provider_order !== remoteId : result.provider_charge !== remoteId)) {
      throw new HttpError(409, 'O pedido ainda não está disponível para conciliação.');
    }
    await db.query(`INSERT INTO cs_trp_013_v2.webhook_events(id,type,order_id,merchant_id,environment) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING`, [eventId, kind, row.id, merchant, row.environment]);
  }

  return { submit, get, status, refresh, operate, hook };
}
