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

const httpCategories = new Map([
  [400, 'provider_validation'], [401, 'provider_authentication'], [403, 'provider_permission'],
  [404, 'provider_not_found'], [409, 'provider_conflict'], [422, 'provider_validation'], [429, 'provider_rate_limit']
]);
const timeoutCodes = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const dnsCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA']);

function transportCategory(error) {
  const code = error?.cause?.code ?? error?.code ?? '';
  if (['TimeoutError', 'AbortError'].includes(error?.name) || timeoutCodes.has(code)) return 'provider_timeout';
  if (dnsCodes.has(code)) return 'provider_dns';
  if (/^(ERR_(TLS|SSL)|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code)) return 'provider_tls';
  return 'provider_connection';
}

export class ProviderError extends Error {
  constructor(http, category) {
    super('A comunicação com a Pagar.me falhou.');
    this.http = http;
    this.category = category;
  }
}

export function makePagarme(fetcher = fetch, { timeout = 8000 } = {}) {
  return async function pagarme(key, path, { method = 'GET', body, idempotency } = {}) {
    const paymentLink = /^\/paymentlinks(?:[/?]|$)/.test(path);
    const base = paymentLink && key.startsWith('sk_test_') ? SANDBOX_PAYMENT_LINK_API : API;
    const signal = AbortSignal.timeout(timeout);
    let response;
    try {
      response = await fetcher(base + path, {
        method, redirect: 'manual', signal,
        headers: {
          Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'),
          Accept: 'application/json',
          'User-Agent': paymentLink ? 'pagarme-skill-generated/1.0' : 'CS-TRP-013/1.0',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotency ? { 'Idempotency-Key': idempotency } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      throw new ProviderError(null, transportCategory(error));
    }
    const http = response.status;
    if (!response.ok) {
      // Errors may contain submitted fields. Only the status is needed for diagnostics.
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(http, httpCategories.get(http) ??
        (http >= 500 ? 'provider_unavailable' : http >= 300 && http < 400 ? 'provider_redirect' : 'provider_http'));
    }
    try {
      return { http, data: await response.json() };
    } catch (error) {
      throw new ProviderError(http, error instanceof SyntaxError ? 'provider_non_json' : transportCategory(error));
    }
  };
}

export function providerId(value, prefix) {
  return typeof value === 'string' && new RegExp('^' + prefix + '_[A-Za-z0-9]{4,100}$').test(value) ? value : null;
}

const paymentStatuses = new Set([
  'pending','paid','captured','partial_capture','failed','not_authorized','with_error','authorized_pending_capture',
  'pre_authorized','antifraud_pending','antifraud_manual_analysis','in_review','processing','waiting_capture',
  'canceled','cancelled','voided','refunded','partial_refunded','chargedback'
]);

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
  const refusalCode = transaction?.acquirer_return_code ?? transaction?.gateway_response?.code;
  const date = Math.max(...[charge?.updated_at, transaction?.updated_at].map(Date.parse).filter(Number.isFinite));
  return {
    status, providerStatus: paymentStatuses.has(gatewayStatus) ? gatewayStatus : null,
    chargeId: providerId(charge?.id, 'ch'),
    transactionId: providerId(transaction?.id, 'tran'),
    updatedAt: Number.isFinite(date) ? new Date(date) : null,
    paid: Number.isSafeInteger(charge?.paid_amount) ? charge.paid_amount : null,
    refusalCode: status === 'declined' && typeof refusalCode === 'string' && /^[A-Za-z0-9]{1,8}$/.test(refusalCode) ? refusalCode : null,
    refusalReason: status === 'declined' ? 'Pagamento recusado pela Pagar.me.' : null
  };
}
