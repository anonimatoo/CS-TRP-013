import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digits, validCpf, states } from '../shared/validation.mjs';
import { audit, one } from './db.mjs';
import { gatewayRow, gatewaySecret } from './gateway.mjs';
import { ProviderError, providerId, readPayment } from './pagarme.mjs';
import { HttpError } from './security.mjs';

const required = (max) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const payment = z.object({
  id: z.uuid(), version: z.number().int().positive(), gatewayVersion: z.number().int().nonnegative(), installments: z.number().int().min(1).max(24),
  token: z.string().regex(/^token_[A-Za-z0-9]{4,100}$/),
  buyer: z.object({
    name: required(128).refine(name => name.split(/\s+/).length >= 2).transform(name => name.toLocaleUpperCase('pt-BR')),
    cpf: z.string().max(14).refine(validCpf).transform(digits),
    email: z.email().max(150), phone: z.string().max(18).transform(digits).refine(phone => /^[1-9][0-9]9\d{8}$/.test(phone)),
    cep: z.string().max(9).transform(digits).refine(cep => /^\d{8}$/.test(cep)),
    street: required(130), number: required(20), complement: z.string().trim().max(128),
    neighborhood: required(100), city: required(64), state: z.enum(states), country: z.literal('BR')
  }).strict()
}).strict();

export const productRow = (db, lock = false) =>
  one(db, 'SELECT * FROM cs_trp_013_v2.product WHERE id=1' + (lock ? ' FOR UPDATE' : ''));

export const publicOrder = row => ({
  id: row.id, status: row.status, amount: row.amount, installments: row.installments, environment: row.environment,
  http: row.http_status, refusalCode: row.refusal_code, providerStatus: row.provider_status
});

function billingDetails(buyer) {
  const address = {
    line_1: [buyer.number, buyer.street, buyer.neighborhood].join(', '),
    ...(buyer.complement ? { line_2: buyer.complement } : {}),
    zip_code: buyer.cep, city: buyer.city, state: buyer.state, country: buyer.country
  };
  return {
    address,
    customer: {
      name: buyer.name, email: buyer.email, document: buyer.cpf, document_type: 'CPF', type: 'individual', address,
      phones: { mobile_phone: { country_code: '55', area_code: buyer.phone.slice(0, 2), number: buyer.phone.slice(2) } }
    }
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
        (id,environment,account,price_version,amount,installments,product_name,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'processing') ON CONFLICT DO NOTHING RETURNING *`,
      [input.id, gateway.environment, gateway.account, product.version, product.amount, input.installments, product.name]);
      return row ? { row, product, gateway } : { row: await get(input.id, client) };
    });
  }

  async function submit(input) {
    const { row, product, gateway } = await reserve(input);
    if (!gateway) return row;
    const key = gatewaySecret(config, gateway);
    const { address, customer } = billingDetails(input.buyer);
    const creditCard = { installments: row.installments, operation_type: product.operation };
    let buyer = { customer };
    let sentOrder = false;

    try {
      if (gateway.mode === 'psp') {
        const created = await pagarme(key, '/customers', { method: 'POST', body: customer });
        const customerId = providerId(created.data?.id, 'cus');
        if (!customerId) throw new ProviderError(null);
        const card = await pagarme(key, '/customers/' + customerId + '/cards', {
          method: 'POST', body: { token: input.token, billing_address: address }
        });
        creditCard.card_id = providerId(card.data?.id, 'card');
        if (!creditCard.card_id) throw new ProviderError(null);
        buyer = { customer_id: customerId };
      } else {
        creditCard.card_token = input.token;
        creditCard.card = { billing_address: address };
      }
      sentOrder = true;
      const result = await pagarme(key, '/orders', { method: 'POST', idempotency: row.id, body: {
        code: row.id, closed: true, ...buyer,
        items: [{ amount: row.amount, description: row.product_name, quantity: 1, code: 'PC-GAMER' }],
        payments: [{ payment_method: 'credit_card', credit_card: creditCard }]
      } });
      const providerOrder = providerId(result.data?.id, 'or');
      const charge = result.data?.charges?.[0];
      if (!providerOrder || result.data?.code !== row.id || result.data?.amount !== row.amount ||
          (charge && charge.amount !== row.amount)) throw new ProviderError(null);
      return await db.tx(client => apply(client, row.id, providerOrder, readPayment(charge, result.data.status), result.http));
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const confirmedFailure = !sentOrder || [400,401,403,422].includes(error.http);
      const status = confirmedFailure ? 'request_failed' : 'communication_error';
      return await one(db, `UPDATE cs_trp_013_v2.orders SET status=$2,http_status=$3,updated_at=now()
        WHERE id=$1 AND provider_order IS NULL RETURNING *`, [row.id, status, error.http]) ?? await get(row.id);
    }
  }

  async function keyFor(row) {
    const gateway = await gatewayRow(db, row.environment);
    if (!gateway.secret || gateway.account !== row.account) {
      throw new HttpError(409, 'Reconecte uma credencial da conta associada ao pedido.');
    }
    return gatewaySecret(config, gateway);
  }

  async function findProviderOrder(key, row) {
    if (row.provider_order) return pagarme(key, '/orders/' + row.provider_order);
    const result = await pagarme(key, '/orders?size=2&code=' + row.id);
    const matches = result.data?.data?.filter(order => order.code === row.id) ?? [];
    if (matches.length > 1) throw new HttpError(409, 'A Pagar.me retornou mais de um pedido para esta referência.');
    return { http: result.http, data: matches[0] };
  }

  async function refresh(row) {
    const key = await keyFor(row);
    if (row.provider_charge) {
      const response = await pagarme(key, '/charges/' + row.provider_charge);
      if (response.data?.amount !== row.amount || response.data?.id !== row.provider_charge) {
        throw new HttpError(409, 'A cobrança retornada diverge do pedido.');
      }
      return db.tx(client => apply(client, row.id, row.provider_order, readPayment(response.data), response.http));
    }
    const result = await findProviderOrder(key, row);
    if (!result.data) return row;
    const id = providerId(result.data.id, 'or');
    if (!id || result.data.code !== row.id || result.data.amount !== row.amount) throw new HttpError(409, 'O pedido retornado diverge da referência local.');
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
      ? await pagarme(key, path + '/capture', { method: 'POST', idempotency: operation, body: { amount: row.amount } })
      : await pagarme(key, path, { method: 'DELETE', idempotency: operation });
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
    if (!row || row.account !== event.account?.id) return;
    if (await one(db, 'SELECT id FROM cs_trp_013_v2.webhook_events WHERE id=$1', [eventId])) return;
    const key = await keyFor(row);
    const auth = await pagarme(key, '/hooks/' + eventId);
    const verified = auth.data;
    if (verified?.id !== eventId || (verified.type ?? verified.event) !== kind ||
        verified.account?.id !== row.account || verified.data?.id !== remoteId) {
      throw new HttpError(403, 'Evento não confirmado pela Pagar.me.');
    }
    const result = await refresh(row);
    if (!result.provider_order || (isOrder ? result.provider_order !== remoteId : result.provider_charge !== remoteId)) {
      throw new HttpError(409, 'O pedido ainda não está disponível para conciliação.');
    }
    await db.query(`INSERT INTO cs_trp_013_v2.webhook_events(id,type,order_id) VALUES ($1,$2,$3)
      ON CONFLICT DO NOTHING`, [eventId, kind, row.id]);
  }

  return { submit, get, refresh, operate, hook };
}
