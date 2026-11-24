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
const activeHostedStatuses = ['processing','pending','communication_error','review','authorized'];

export const publicOrder = row => ({
  id: row.id, status: row.status, amount: row.amount, installments: row.installments, environment: row.environment,
  http: row.http_status, refusalCode: row.refusal_code, providerStatus: row.provider_status,
  checkoutUrl: row.status === 'pending' && !row.provider_order && Date.parse(row.checkout_expires_at) > Date.now()
    ? hostedCheckoutUrl(row.checkout_url) : null
});

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
    if (current.provider_charge && snapshot.chargeId && current.provider_charge !== snapshot.chargeId) {
      throw new HttpError(409, 'A cobrança retornada não corresponde à cobrança local.');
    }
    const row = await one(client, `UPDATE cs_trp_013_v2.orders SET
      provider_order=COALESCE($2, provider_order),provider_charge=COALESCE($3, provider_charge),
      status=$4,http_status=$5,refusal_code=$6,refusal_reason=$7,provider_status=$8,
      provider_updated_at=COALESCE($9,provider_updated_at),actual_paid=COALESCE($10,actual_paid),updated_at=now()
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
        (id,environment,account,price_version,amount,installments,product_name,status,hosted_checkout)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',true) ON CONFLICT DO NOTHING RETURNING *`,
      [input.id, gateway.environment, gateway.account, product.version, product.amount, input.installments, product.name]);
      return row ? { row, product, gateway } : { row: await get(input.id, client) };
    });
  }

  async function storeCheckout(row, data, http) {
    const id = providerId(data?.id, 'pl');
    const url = hostedCheckoutUrl(data?.url);
    const total = data?.cart_settings?.total_cost;
    if (!id || !url || data.name !== hostedCheckoutName(row.id) || (total != null && total !== row.amount)) {
      throw new ProviderError(null);
    }
    const created = Date.parse(data.created_at);
    const expires = new Date((Number.isFinite(created) ? created : Date.parse(row.created_at)) + checkoutMinutes * 60000);
    return await one(db, `UPDATE cs_trp_013_v2.orders SET
      checkout_provider_id=$2,checkout_url=$3,checkout_expires_at=$4,
      status=CASE WHEN provider_order IS NULL THEN 'pending' ELSE status END,
      http_status=CASE WHEN provider_order IS NULL THEN $5 ELSE http_status END,updated_at=now()
      WHERE id=$1 AND checkout_provider_id IS NULL RETURNING *`,
    [row.id, id, url, expires, http]) ?? await get(row.id);
  }

  async function submit(input) {
    const { row, product, gateway } = await reserve(input);
    if (!gateway) return row;
    const key = gatewaySecret(config, gateway);
    const returnUrl = new URL(config.origin);
    returnUrl.searchParams.set('pedido', row.id);
    try {
      const result = await pagarme(key, '/paymentlinks', { method: 'POST', idempotency: row.id, body: {
        type: 'order', name: hostedCheckoutName(row.id), order_code: row.id,
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
      return await storeCheckout(row, result.data, result.http);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const status = [400,401,403,422].includes(error.http) ? 'request_failed' : 'communication_error';
      return await one(db, `UPDATE cs_trp_013_v2.orders SET status=$2,http_status=$3,updated_at=now()
        WHERE id=$1 AND provider_order IS NULL AND checkout_provider_id IS NULL RETURNING *`,
      [row.id, status, error.http]) ?? await get(row.id);
    }
  }

  async function keyFor(row) {
    const gateway = await gatewayRow(db, row.environment);
    if (!gateway.secret || (row.account && gateway.account !== row.account)) {
      throw new HttpError(409, 'Reconecte uma credencial da conta associada ao pedido.');
    }
    return gatewaySecret(config, gateway);
  }

  async function findProviderOrder(key, row) {
    const options = { hosted: row.hosted_checkout };
    if (row.provider_order) return pagarme(key, '/orders/' + row.provider_order, options);
    const result = await pagarme(key, '/orders?size=2&code=' + row.id, options);
    const matches = result.data?.data?.filter(order => order.code === row.id) ?? [];
    if (matches.length > 1) throw new HttpError(409, 'A Pagar.me retornou mais de um pedido para esta referência.');
    return { http: result.http, data: matches[0] };
  }

  async function refreshHostedCheckout(key, row) {
    if (!row.checkout_provider_id) {
      const name = hostedCheckoutName(row.id);
      const result = await pagarme(key, '/paymentlinks?name=' + encodeURIComponent(name));
      const entries = Array.isArray(result.data) ? result.data : result.data?.data;
      const matches = Array.isArray(entries) ? entries.filter(link => link.name === name) : [];
      if (matches.length > 1) throw new HttpError(409, 'A Pagar.me retornou mais de um checkout para esta referência.');
      return matches[0] ? storeCheckout(row, matches[0], result.http) : row;
    }
    if (Date.parse(row.checkout_expires_at) > Date.now()) return row;
    const result = await pagarme(key, '/paymentlinks/' + row.checkout_provider_id);
    if (result.data?.id !== row.checkout_provider_id || result.data?.name !== hostedCheckoutName(row.id)) {
      throw new HttpError(409, 'O checkout retornado diverge da referência local.');
    }
    if (result.data.total_sessions !== 0 || !['expired','canceled','cancelled'].includes(result.data.status)) return row;
    const status = result.data.status === 'expired' ? 'expired' : 'canceled';
    return await one(db, `UPDATE cs_trp_013_v2.orders SET status=$2,http_status=$3,updated_at=now()
      WHERE id=$1 AND provider_order IS NULL AND status IN ('pending','communication_error') RETURNING *`,
    [row.id, status, result.http]) ?? await get(row.id);
  }

  async function status(row) {
    if (!row.hosted_checkout || !activeHostedStatuses.includes(row.status)) return row;
    if (row.status === 'processing' && Date.now() - Date.parse(row.created_at) < 15000) return row;
    const claimed = await one(db, `UPDATE cs_trp_013_v2.orders SET checkout_synced_at=now()
      WHERE id=$1 AND (checkout_synced_at IS NULL OR checkout_synced_at < now()-interval '15 seconds')
      RETURNING *`, [row.id]);
    if (!claimed) return row;
    try {
      return await refresh(claimed);
    } catch (error) {
      if (error instanceof ProviderError || error instanceof HttpError) return claimed;
      throw error;
    }
  }

  async function refresh(row) {
    const key = await keyFor(row);
    if (row.provider_charge) {
      const response = await pagarme(key, '/charges/' + row.provider_charge, { hosted: row.hosted_checkout });
      if (response.data?.amount !== row.amount || response.data?.id !== row.provider_charge) {
        throw new HttpError(409, 'A cobrança retornada diverge do pedido.');
      }
      return db.tx(client => apply(client, row.id, row.provider_order, readPayment(response.data), response.http));
    }
    const result = await findProviderOrder(key, row);
    if (!result.data) return row.hosted_checkout ? refreshHostedCheckout(key, row) : row;
    const id = providerId(result.data.id, 'or');
    if (!id || result.data.code !== row.id || result.data.amount !== row.amount ||
        (result.data.charges?.[0] && result.data.charges[0].amount !== row.amount)) throw new HttpError(409, 'O pedido retornado diverge da referência local.');
    return db.tx(client => apply(client, row.id, id, readPayment(result.data.charges?.[0], result.data.status), result.http));
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
      ? await pagarme(key, path + '/capture', { method: 'POST', idempotency: operation, body: { amount: row.amount }, hosted: row.hosted_checkout })
      : await pagarme(key, path, { method: 'DELETE', idempotency: operation, hosted: row.hosted_checkout });
    if (result.data?.id !== row.provider_charge || result.data?.amount !== row.amount) throw new ProviderError(null);
    const snapshot = readPayment(result.data);
    return db.tx(client => apply(client, row.id, row.provider_order, snapshot, result.http));
  }

  async function hook(event) {
    const eventId = providerId(event?.id, 'hook');
    const kind = typeof event?.type === 'string' ? event.type : '';
    if (!eventId || !/^(order|charge)\.[a-z_]{1,50}$/.test(kind)) return;
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
    const auth = await pagarme(key, '/hooks/' + eventId, { hosted: row.hosted_checkout });
    const verified = auth.data;
    if (verified?.id !== eventId || (verified.type ?? verified.event) !== kind ||
        verified.account?.id !== account || verified.data?.id !== remoteId) {
      throw new HttpError(403, 'Evento não confirmado pela Pagar.me.');
    }
    const result = await refresh(row);
    if (!result.provider_order || (isOrder ? result.provider_order !== remoteId : result.provider_charge !== remoteId)) {
      throw new HttpError(409, 'O pedido ainda não está disponível para conciliação.');
    }
    await db.query(`INSERT INTO cs_trp_013_v2.webhook_events(id,type,order_id) VALUES ($1,$2,$3)
      ON CONFLICT DO NOTHING`, [eventId, kind, row.id]);
  }

  return { submit, get, status, refresh, operate, hook };
}
