export const API = 'https://api.pagar.me/core/v5';
const SANDBOX_PAYMENT_LINK_API = 'https://sdx-api.pagar.me/core/v5';
const checkoutHosts = new Set(['checkout.pagar.me', 'payment-link.pagar.me']);

export function hostedCheckoutUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && checkoutHosts.has(url.hostname) &&
      !url.username && !url.password && !url.port ? url.href : null;
  } catch {
    return null;
  }
}

export const hostedCheckoutName = id => 'CS TRP 013 ' + id;

function sanitized(value, max = 220) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  // Skip provider text that may contain credentials, identifiers of a buyer, or raw inputs.
  if (!clean || /(?:sk|pk|token)_[\w-]+|\d(?:[ .-]?\d){8,}|[\w.-]+@[\w.-]+/i.test(clean)) return null;
  return clean.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

export class ProviderError extends Error {
  constructor(status, payload) {
    super('A Pagar.me retornou um erro.');
    this.http = status;
    // Never retain the original payload, which may echo fields from the request.
    this.providerMessage = [401, 403].includes(status)
      ? sanitized(payload?.message)
      : null;
  }
}

export function makePagarme(fetcher = fetch) {
  return async function pagarme(key, path, { method = 'GET', body, idempotency, hosted = false } = {}) {
    let response;
    try {
      const paymentLink = /^\/paymentlinks(?:[/?]|$)/.test(path);
      const base = (paymentLink || hosted) && key.startsWith('sk_test_') ? SANDBOX_PAYMENT_LINK_API : API;
      response = await fetcher(base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(4500),
        headers: {
          Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'),
          Accept: 'application/json',
          ...(paymentLink ? { 'User-Agent': 'CS-TRP-013/1.0' } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotency ? { 'Idempotency-Key': idempotency } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await response.json();
      if (!response.ok) throw new ProviderError(response.status, data);
      return { http: response.status, data };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(response?.ok ? null : response?.status ?? null);
    }
  };
}

export function providerId(value, prefix) {
  return typeof value === 'string' && new RegExp('^' + prefix + '_[A-Za-z0-9]{4,100}$').test(value) ? value : null;
}

export function readPayment(charge, orderStatus) {
  const transaction = charge?.last_transaction;
  const chargeStatus = charge?.status;
  const transactionStatus = transaction?.status;
  const gatewayStatus = transactionStatus || chargeStatus || orderStatus;
  let status = 'pending';
  if (chargeStatus === 'refunded' || ['refunded','partial_refunded'].includes(transactionStatus)) status = 'refunded';
  else if (chargeStatus === 'chargedback' || transactionStatus === 'chargedback') status = 'chargedback';
  else if (['canceled','cancelled','voided'].includes(chargeStatus) || transactionStatus === 'voided') status = 'canceled';
  else if (chargeStatus === 'paid' || (orderStatus === 'paid' && !chargeStatus)) status = 'paid';
  else if (['captured','partial_capture'].includes(transactionStatus)) status = 'captured';
  else if (chargeStatus === 'failed' || orderStatus === 'failed' || ['not_authorized','failed','with_error'].includes(transactionStatus)) status = 'declined';
  else if (['authorized_pending_capture','pre_authorized'].includes(transactionStatus) || chargeStatus === 'authorized_pending_capture') status = 'authorized';
  else if ([chargeStatus, transactionStatus].some(value => ['antifraud_pending','antifraud_manual_analysis','in_review'].includes(value))) status = 'review';
  else if (['processing','waiting_capture'].includes(gatewayStatus)) status = 'processing';
  else if (orderStatus === 'canceled' && !chargeStatus) status = 'canceled';
  const date = Math.max(...[charge?.updated_at, transaction?.updated_at].map(Date.parse).filter(Number.isFinite));
  return {
    status, providerStatus: sanitized(gatewayStatus, 70),
    chargeId: providerId(charge?.id, 'ch'),
    transactionId: providerId(transaction?.id, 'tran'),
    updatedAt: Number.isFinite(date) ? new Date(date) : null,
    paid: Number.isSafeInteger(charge?.paid_amount) ? charge.paid_amount : null,
    refusalCode: status === 'declined' ? sanitized(transaction?.acquirer_return_code ?? transaction?.gateway_response?.code, 32) : null,
    refusalReason: status === 'declined' ? sanitized(transaction?.acquirer_message ?? transaction?.gateway_response?.errors?.[0]?.message) : null
  };
}
