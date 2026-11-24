import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digits, validCpf, states } from '../shared/validation.mjs';
import { audit, one } from './db.mjs';
import { gatewayRow, gatewaySecret } from './gateway.mjs';
import { hostedCheckoutName, hostedCheckoutUrl, ProviderError, providerId, readPayment } from './pagarme.mjs';
import { HttpError } from './security.mjs';

const required = (max) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const payment = z.object({
  id: z.uuid(), version: z.number().int().positive(), gatewayVersion: z.number().int().nonnegative(), installments: z.number().int().min(1).max(24),
  buyer: z.object({
    name: required(64).refine(name => name.split(/\s+/).length >= 2).transform(name => name.toLocaleUpperCase('pt-BR')),
    cpf: z.string().max(14).refine(validCpf).transform(digits),
    email: z.email().max(64), phone: z.string().max(18).transform(digits).refine(phone => /^[1-9][0-9]9\d{8}$/.test(phone)),
    cep: z.string().max(9).transform(digits).refine(cep => /^\d{8}$/.test(cep)),
    street: required(130), number: required(20), complement: z.string().trim().max(128),
    neighborhood: required(100), city: required(64), state: z.enum(states), country: z.literal('BR')
  }).strict()
}).strict();

export const productRow = (db, lock = false) =>
  one(db, 'SELECT * FROM cs_trp_013_v2.product WHERE id=1' + (lock ? ' FOR UPDATE' : ''));

const checkoutMinutes = 30;
const activeHostedStatuses = ['processing','pending','communication_error','review','authorized','request_failed'];
const financialEnd = ['paid','captured','declined','canceled','refunded','chargedback'];
const closedLinkStatuses = ['expired','cancelled','canceled'];
const rejectedCreation = new Set([400,401,403,422]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function publicOrder(row) {
  const checkoutUrl = row.status === 'pending' && !row.provider_order && row.reconciliation_state !== 'pending' &&
    Date.parse(row.checkout_expires_at) > Date.now() ? hostedCheckoutUrl(row.checkout_url) : null;
  return {
    id: row.id, status: row.status, amount: row.amount, installments: row.installments, environment: row.environment,
    http: row.http_status, refusalCode: row.refusal_code, providerStatus: row.provider_status, checkoutUrl,
    checkoutError: row.checkout_error ?? null,
    reconciliation: row.reconciliation_state ?? (row.status === 'communication_error' ? 'pending' : null),
    checkoutExpiresAt: row.checkout_expires_at ?? null,
    newPurchaseAllowed: (row.status === 'request_failed' && row.reconciliation_state === 'rejected') ||
      row.reconciliation_state === 'closed_without_order' ||
      (row.reconciliation_state == null && Boolean(row.checkout_provider_id) && ['expired','canceled'].includes(row.status)) ||
      (Boolean(row.provider_order || row.provider_charge) && financialEnd.includes(row.status))
  };
}

function checkoutDate(value) {
  return typeof value === 'string' && z.iso.datetime({ offset: true }).safeParse(value).success ? Date.parse(value) : NaN;
}

function validateCheckout(row, data, http) {
  const require = (condition, category) => {
    if (!condition) throw new ProviderError(http, category);
  };
  require(object(data), 'provider_invalid_json');
  const id = providerId(data.id, 'pl');
  require(id && (!row.checkout_provider_id || id === row.checkout_provider_id), 'checkout_id_invalid');
  require(data.url != null && data.url !== '', 'checkout_url_missing');
  const url = hostedCheckoutUrl(data.url);
  require(url, 'checkout_url_invalid');
  require(data.name != null, 'checkout_incomplete');
  require(data.name === hostedCheckoutName(row.id) && (data.order_code == null || data.order_code === row.id), 'checkout_reference_mismatch');
  require(data.type === 'order', data.type == null ? 'checkout_incomplete' : 'provider_invalid_json');
  const total = data.cart_settings?.total_cost;
  require(total != null, 'checkout_incomplete');
  require(Number.isSafeInteger(total), 'provider_invalid_json');
  require(total === row.amount, 'checkout_amount_mismatch');
  const plans = data.payment_settings?.credit_card_settings?.installments;
  if (plans != null) {
    require(Array.isArray(plans) && plans.length === 1 && plans[0]?.number === row.installments &&
      plans[0]?.total === row.amount, 'checkout_installments_mismatch');
  }
  require(data.status != null && data.total_sessions != null, 'checkout_incomplete');
  require(['active', 'building', ...closedLinkStatuses].includes(data.status) &&
    Number.isSafeInteger(data.total_sessions) && data.total_sessions >= 0, 'provider_invalid_json');

  const created = checkoutDate(data.created_at);
  const absolute = checkoutDate(data.expires_at);
  require((data.created_at == null || Number.isFinite(created)) && (data.expires_at == null || Number.isFinite(absolute)),
    'checkout_date_invalid');
  require(Number.isFinite(absolute) || Number.isFinite(created), 'checkout_incomplete');
  const duration = data.expires_in ?? checkoutMinutes;
  require(Number.isSafeInteger(duration) && duration >= 0 && (duration > 0 || Number.isFinite(absolute)), 'checkout_date_invalid');
  const cap = Number.isFinite(created) ? created + checkoutMinutes * 60000 : absolute;
  const expires = new Date(Math.min(cap, Number.isFinite(absolute) ? absolute : created + duration * 60000));
  require(Number.isFinite(expires.getTime()) && (!Number.isFinite(created) || expires.getTime() >= created), 'checkout_date_invalid');
  return { id, url, expires, remoteStatus: data.status, used: data.total_sessions > 0 };
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

export function makePayments(db, config, pagarme) {
  const get = (id, connection = db, lock = false) =>
    one(connection, 'SELECT * FROM cs_trp_013_v2.orders WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id]);

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
      reconciliation_state=CASE WHEN hosted_checkout THEN 'order_found' ELSE reconciliation_state END,
      reconciliation_error=NULL,reconciliation_http=$5,reconciliation_at=now(),updated_at=now()
      WHERE id=$1 RETURNING *`,
    [id, providerOrder, snapshot.chargeId, snapshot.status, http, snapshot.refusalCode,
      snapshot.refusalReason, snapshot.providerStatus, snapshot.updatedAt, snapshot.paid]);
    const latest = await one(client, `SELECT provider_id,status FROM cs_trp_013_v2.transactions
      WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, [id]);
    if (latest?.status !== row.status || latest?.provider_id !== snapshot.transactionId) {
      await client.query('INSERT INTO cs_trp_013_v2.transactions(order_id,provider_id,status) VALUES ($1,$2,$3)',
        [id, snapshot.transactionId, row.status]);
    }
    const action = await one(client, 'SELECT action FROM cs_trp_013_v2.payment_actions WHERE order_id=$1', [id]);
    const completed = action?.action === 'capture' ? ['paid','captured'] : ['canceled','refunded','chargedback'];
    if (action && completed.includes(row.status)) {
      await client.query('DELETE FROM cs_trp_013_v2.payment_actions WHERE order_id=$1', [id]);
    }
    return row;
  }

  async function reserve(input) {
    return db.tx(async client => {
      const previous = await get(input.id, client);
      if (previous) return { row: previous };
      const product = await productRow(client, true);
      const afterLock = await get(input.id, client);
      if (afterLock) return { row: afterLock };
      const gateway = await gatewayRow(client, product.environment, true);
      if (!product.enabled || !product.amount || !gateway.enabled || !gateway.last_ok || !gateway.secret ||
          (gateway.environment === 'live' && !config.allowLive)) {
        throw new HttpError(503, 'Pagamento indisponível no momento.', { safeToRetry: true });
      }
      if (input.version !== product.version || input.gatewayVersion !== gateway.version) {
        throw new HttpError(409, 'O lojista atualizou o checkout. Revise o valor e tente novamente.', { safeToRetry: true });
      }
      if (input.installments > Math.min(product.max_installments, product.amount)) {
        throw new HttpError(422, 'O parcelamento selecionado não está disponível.', { safeToRetry: true });
      }
      const row = await one(client, `INSERT INTO cs_trp_013_v2.orders
        (id,environment,account,price_version,amount,installments,product_name,status,hosted_checkout,checkout_attempted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',true,now()) ON CONFLICT DO NOTHING RETURNING *`,
      [input.id, gateway.environment, gateway.account, product.version, product.amount, input.installments, product.name]);
      return row ? { row, product, gateway } : { row: await get(input.id, client) };
    });
  }

  async function storeCheckout(row, data, http, creationHttp = null) {
    const link = validateCheckout(row, data, http);
    const closed = closedLinkStatuses.includes(link.remoteStatus);
    const available = link.remoteStatus === 'active' && !link.used && link.expires.getTime() > Date.now();
    const state = available ? 'checkout_found' : closed && !link.used ? 'closed_without_order' : 'pending';
    const status = closed && !link.used ? (link.remoteStatus === 'expired' ? 'expired' : 'canceled') : 'pending';
    return await one(db, `UPDATE cs_trp_013_v2.orders SET checkout_provider_id=$2,checkout_url=$3,checkout_expires_at=$4,
      status=$5,http_status=$6,reconciliation_state=$7,
      checkout_http=COALESCE($8,checkout_http),
      checkout_synced_at=CASE WHEN checkout_provider_id IS NULL AND $7::text='checkout_found' THEN NULL ELSE checkout_synced_at END,
      reconciliation_error=NULL,reconciliation_http=$10,reconciliation_at=now(),updated_at=now()
      WHERE id=$1 AND (checkout_provider_id IS NULL OR checkout_provider_id=$2)
      AND provider_order IS NULL
      AND (reconciliation_at IS NULL OR reconciliation_at <= $9) RETURNING *`,
    [row.id, link.id, link.url, link.expires, status, creationHttp ?? http, state, creationHttp,
      row.reconcileStartedAt ?? row.checkout_attempted_at, http]) ?? await get(row.id);
  }

  async function storeCheckoutResponse(key, row, result, creationHttp = null) {
    try {
      return await storeCheckout(row, result.data, result.http, creationHttp);
    } catch (error) {
      const id = providerId(result.data?.id, 'pl');
      if (!(error instanceof ProviderError) || !id ||
          !['checkout_incomplete', 'checkout_url_missing'].includes(error.category)) throw error;
      const detail = await pagarme(key, '/paymentlinks/' + id);
      return storeCheckout({ ...row, checkout_provider_id: id }, detail.data, detail.http, creationHttp);
    }
  }

  async function recordCreation(gateway, row, http, error = null) {
    await db.query(`UPDATE cs_trp_013_v2.gateway SET checkout_attempted_at=$3,checkout_http=$4,checkout_error=$5,
      checkout_creation_verified_at=CASE WHEN $5::text IS NULL THEN $3 ELSE checkout_creation_verified_at END
      WHERE environment=$1 AND secret=$2 AND (checkout_attempted_at IS NULL OR checkout_attempted_at <= $3)`,
    [gateway.environment, gateway.secret, row.checkout_attempted_at, http, error]);
  }

  async function submit(input) {
    const { row, product, gateway } = await reserve(input);
    if (!gateway) {
      return ['processing','communication_error','request_failed'].includes(row.status) ? status(row) : row;
    }
    let http = null;
    try {
      const key = paymentSecret(gateway);
      const returnUrl = new URL(config.origin);
      returnUrl.searchParams.set('pedido', row.id);
      const result = await pagarme(key, '/paymentlinks', { method: 'POST', idempotency: row.id, body: {
        type: 'order', is_building: false, name: hostedCheckoutName(row.id), order_code: row.id,
        max_sessions: 1, max_paid_sessions: 1, expires_in: checkoutMinutes,
        cart_settings: { items: [{ name: row.product_name, amount: row.amount, default_quantity: 1 }] },
        customer_settings: { customer: billingDetails(input.buyer) },
        payment_settings: {
          accepted_payment_methods: ['credit_card'],
          credit_card_settings: {
            operation_type: product.operation,
            installments: [{ number: row.installments, total: row.amount }]
          }
        },
        ...(returnUrl.protocol === 'https:' ? { flow_settings: { success_url: returnUrl.href } } : {})
      } });
      http = result.http;
      const saved = await storeCheckoutResponse(key, row, result, http);
      await recordCreation(gateway, row, http);
      return saved;
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const recordedHttp = http ?? error.http;
      const rejected = http === null && (rejectedCreation.has(error.http) || error.category === 'gateway_configuration');
      console.warn('Falha no checkout Pagar.me', { order: row.id, environment: row.environment, http: recordedHttp, category: error.category });
      const saved = await one(db, `UPDATE cs_trp_013_v2.orders SET status=$2,http_status=$3,checkout_http=$3,checkout_error=$4,
        checkout_attempted_at=COALESCE(checkout_attempted_at,now()),reconciliation_state=$5,updated_at=now()
        WHERE id=$1 AND provider_order IS NULL AND checkout_provider_id IS NULL RETURNING *`,
      [row.id, rejected ? 'request_failed' : 'communication_error', recordedHttp, error.category, rejected ? 'rejected' : 'pending'])
        ?? await get(row.id);
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
    const gateway = await gatewayRow(db, row.environment);
    if (!gateway.secret || (row.account && gateway.account !== row.account)) {
      throw new HttpError(409, 'Reconecte uma credencial da conta associada ao pedido.');
    }
    return paymentSecret(gateway);
  }

  async function findProviderOrder(key, row) {
    if (row.provider_order) return pagarme(key, '/orders/' + row.provider_order);
    const result = await pagarme(key, '/orders?size=2&code=' + row.id);
    const list = result.data?.data;
    if (!Array.isArray(list)) throw new ProviderError(result.http, 'provider_invalid_json');
    const matches = list.filter(order => order?.code === row.id);
    if (matches.length > 1 || result.data?.paging?.next) {
      throw new ProviderError(result.http, 'order_reference_ambiguous');
    }
    if (list.some(order => order?.code !== row.id)) throw new ProviderError(result.http, 'order_reference_mismatch');
    return { http: result.http, data: matches[0] };
  }

  async function setReconciliation(row, http, error = null, state = 'pending') {
    return await one(db, `UPDATE cs_trp_013_v2.orders SET
      status=CASE WHEN status='processing' AND provider_order IS NULL THEN 'communication_error' ELSE status END,
      reconciliation_state=CASE WHEN provider_order IS NULL AND reconciliation_state IS DISTINCT FROM 'rejected'
        AND (reconciliation_state IS NULL OR reconciliation_state='pending' OR
          (reconciliation_state='checkout_found' AND checkout_expires_at<=now())) THEN $5 ELSE reconciliation_state END,
      reconciliation_error=$2,reconciliation_http=$3,reconciliation_at=now()
      WHERE id=$1 AND (reconciliation_at IS NULL OR reconciliation_at <= $4) RETURNING *`,
    [row.id, error, http, row.reconcileStartedAt, state]) ?? await get(row.id);
  }

  async function refreshHostedCheckout(key, row) {
    if (row.checkout_provider_id) {
      if (row.reconciliation_state !== 'pending' && Date.parse(row.checkout_expires_at) > Date.now()) return row;
      const result = await pagarme(key, '/paymentlinks/' + row.checkout_provider_id);
      return storeCheckout(row, result.data, result.http);
    }
    const name = hostedCheckoutName(row.id);
    const result = await pagarme(key, '/paymentlinks?per_page=30&name=' + encodeURIComponent(name));
    const entries = Array.isArray(result.data) ? result.data : result.data?.data;
    if (!Array.isArray(entries)) throw new ProviderError(result.http, 'provider_invalid_json');
    const matches = entries.filter(link => link?.name === name);
    if (matches.length > 1 || (matches.length && (entries.length === 30 || result.data?.paging?.next))) {
      throw new ProviderError(result.http, 'checkout_reference_ambiguous');
    }
    if (matches[0]) return storeCheckoutResponse(key, row, { data: matches[0], http: result.http });
    const rejected = row.status === 'request_failed' && rejectedCreation.has(row.http_status);
    return setReconciliation(row, result.http, null, rejected ? 'rejected' : 'pending');
  }

  async function status(row) {
    if (!row.hosted_checkout || !activeHostedStatuses.includes(row.status) ||
        row.reconciliation_state === 'rejected') return row;
    if (row.status === 'processing' && Date.now() - Date.parse(row.created_at) < 20000) return row;
    const claimed = await one(db, `UPDATE cs_trp_013_v2.orders SET checkout_synced_at=now()
      WHERE id=$1 AND (checkout_synced_at IS NULL OR checkout_synced_at < now()-interval '30 seconds')
      RETURNING *`, [row.id]);
    return claimed ? refresh(claimed, { background: true }) : get(row.id);
  }

  async function applyProviderOrder(row, result) {
    const data = result.data;
    const id = providerId(data?.id, 'or');
    if (!id || (row.provider_order && id !== row.provider_order) || data.code !== row.id) {
      throw new ProviderError(result.http, 'order_reference_mismatch');
    }
    if (!['pending','paid','canceled','failed'].includes(data.status) ||
        (data.charges != null && (!Array.isArray(data.charges) || data.charges.length > 1))) {
      throw new ProviderError(result.http, 'provider_invalid_json');
    }
    const charge = data.charges?.[0];
    if (data.amount !== row.amount || (charge && charge.amount !== row.amount)) {
      throw new ProviderError(result.http, 'order_amount_mismatch');
    }
    const snapshot = readPayment(charge, data.status);
    if (charge && !snapshot.chargeId) throw new ProviderError(result.http, 'order_reference_mismatch');
    if (!snapshot.updatedAt && Number.isFinite(Date.parse(data.updated_at))) snapshot.updatedAt = new Date(data.updated_at);
    return db.tx(client => apply(client, row.id, id, snapshot, result.http));
  }

  async function refresh(row, { background = false } = {}) {
    const current = { ...row, reconcileStartedAt: new Date() };
    try {
      const key = await keyFor(row);
      if (row.provider_charge) {
        const response = await pagarme(key, '/charges/' + row.provider_charge);
        if (response.data?.id !== row.provider_charge) throw new ProviderError(response.http, 'order_reference_mismatch');
        if (response.data?.amount !== row.amount) throw new ProviderError(response.http, 'order_amount_mismatch');
        return await db.tx(client => apply(client, row.id, row.provider_order, readPayment(response.data), response.http));
      }
      const result = await findProviderOrder(key, row);
      if (result.data !== undefined) return await applyProviderOrder(row, result);
      return row.hosted_checkout ? await refreshHostedCheckout(key, current) : row;
    } catch (error) {
      if (!(error instanceof ProviderError || error instanceof HttpError)) throw error;
      const updated = await setReconciliation(current, error.http ?? null, error.category ?? 'gateway_configuration');
      if (background) return updated;
      throw error;
    }
  }

  async function operate(row, action) {
    const statuses = action === 'capture' ? ['authorized'] : ['authorized','paid','captured'];
    if (!row.provider_charge || !statuses.includes(row.status)) throw new HttpError(409, 'A ação não está disponível neste estado.');
    if (row.environment === 'live' && !config.allowLive) throw new HttpError(409, 'Operações financeiras de produção estão bloqueadas.');
    const key = await keyFor(row);
    const operation = await db.tx(async client => {
      const current = await get(row.id, client, true);
      if (!statuses.includes(current.status)) throw new HttpError(409, 'O estado da cobrança mudou.');
      const pending = await one(client, 'SELECT action FROM cs_trp_013_v2.payment_actions WHERE order_id=$1 LIMIT 1', [row.id]);
      if (pending) throw new HttpError(409, 'Há uma operação já enviada. Atualize a cobrança e concilie no painel da Pagar.me.');
      const requestId = randomUUID();
      await client.query('INSERT INTO cs_trp_013_v2.payment_actions(order_id,action,request_id) VALUES ($1,$2,$3)', [row.id, action, requestId]);
      await audit(client, 'payments.' + action, { id: row.id });
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

  async function hook(event) {
    const eventId = providerId(event?.id, 'hook');
    const kind = event?.type ?? event?.event ?? '';
    if (!eventId || typeof kind !== 'string' || !/^(order|charge)\.[a-z_]{1,50}$/.test(kind)) return;
    const isOrder = kind.startsWith('order.');
    const remoteId = providerId(event.data?.id, isOrder ? 'or' : 'ch');
    const localId = isOrder ? event.data?.code : event.data?.order?.code;
    const lookup = z.uuid().safeParse(localId);
    if (!remoteId) return;
    let row = await one(db, `SELECT * FROM cs_trp_013_v2.orders WHERE ${isOrder ? 'provider_order' : 'provider_charge'}=$1`, [remoteId]);
    if (!row && lookup.success) row = await get(lookup.data);
    const account = providerId(event.account?.id, 'acc');
    if (!row || !account || (row.account && row.account !== account)) return;
    if (await one(db, 'SELECT id FROM cs_trp_013_v2.webhook_events WHERE id=$1', [eventId])) return;
    const key = await keyFor(row);
    const auth = await pagarme(key, '/hooks/' + eventId);
    const verified = auth.data;
    if (verified?.id !== eventId || (verified.type ?? verified.event) !== kind ||
        verified.account?.id !== account || verified.data?.id !== remoteId) {
      throw new HttpError(403, 'Evento não confirmado pela Pagar.me.');
    }
    const result = isOrder
      ? await applyProviderOrder(row, await pagarme(key, '/orders/' + remoteId))
      : await refresh(row);
    if (!result.provider_order || (isOrder ? result.provider_order !== remoteId : result.provider_charge !== remoteId)) {
      throw new HttpError(409, 'O pedido ainda não está disponível para conciliação.');
    }
    await db.query(`INSERT INTO cs_trp_013_v2.webhook_events(id,type,order_id) VALUES ($1,$2,$3)
      ON CONFLICT DO NOTHING`, [eventId, kind, row.id]);
  }

  return { submit, get, status, refresh, operate, hook };
}
