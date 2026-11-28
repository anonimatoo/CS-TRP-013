export const API = 'https://api.pagar.me/core/v5';
const SANDBOX_PAYMENT_LINK_API = 'https://sdx-api.pagar.me/core/v5';
const checkoutHosts = new Set([
  'checkout.pagar.me',
  'payment-link.pagar.me',
  'payment-link.stone.com.br'
]);

export function inspectCheckoutUrl(value) {
  if (value == null || value === '') return { reason: 'url_missing' };
  if (typeof value !== 'string') return { reason: 'url_invalid_type' };
  if (value.length > 2048) return { reason: 'url_too_long' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { reason: 'url_invalid_format' };
  }
  const hostname = checkoutHosts.has(url.hostname) ? url.hostname : undefined;
  if (url.protocol !== 'https:') return { reason: 'url_not_https', hostname };
  if (url.username || url.password) return { reason: 'url_has_credentials', hostname };
  if (url.port) return { reason: 'url_nondefault_port', hostname };
  if (!hostname) return { reason: 'url_untrusted_host' };
  return { url: url.href, hostname };
}

export function hostedCheckoutUrl(value) {
  return inspectCheckoutUrl(value).url ?? null;
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
  constructor(http, category, diagnostic) {
    super('A comunicação com a Pagar.me falhou.');
    this.http = http;
    this.category = category;
    if (diagnostic) this.diagnostic = diagnostic;
  }
}

export function makePagarme(fetcher = fetch, { timeout = 8000 } = {}) {
  return async function pagarme(key, path, { method = 'GET', body, idempotency, signal: deadline } = {}) {
    const paymentLink = /^\/paymentlinks(?:[/?]|$)/.test(path);
    const base = paymentLink && key.startsWith('sk_test_') ? SANDBOX_PAYMENT_LINK_API : API;
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = deadline ? AbortSignal.any([deadline, timeoutSignal]) : timeoutSignal;
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

function cleanRefusal(message) {
  if (typeof message !== 'string' || !/^[\p{L} .,;:!?()'-]{1,180}$/u.test(message)) return null;
  return message;
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
  const refusalCode = transaction?.acquirer_return_code ?? transaction?.gateway_response?.code;
  const date = Math.max(...[charge?.updated_at, transaction?.updated_at].map(Date.parse).filter(Number.isFinite));
  const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null;
  const brand = transaction?.card?.brand ?? transaction?.network_token?.brand;
  const captured = chargeStatus === 'paid' && transactionStatus === 'captured' &&
    charge.paid_amount === charge.amount && cents(charge.paid_amount) > 0 && transaction?.success !== false;
  const method = charge?.payment_method;
  const installments = transaction?.installments;
  const paidAt = Date.parse(charge?.paid_at);
  const telegramPayment = captured ? {
    method: ['credit_card','debit_card'].includes(method) ? method : null,
    installments: method === 'debit_card' ? 1 : Number.isInteger(installments) && installments >= 1 && installments <= 24 ? installments : null,
    at: Number.isFinite(paidAt) ? new Date(paidAt) : Number.isFinite(date) ? new Date(date) : null
  } : null;
  return {
    telegramPayment, captured, brand: typeof brand === 'string' && /^[A-Za-z][A-Za-z0-9 -]{0,30}$/.test(brand) ? brand : null,
    fee: cents(charge?.fee_amount), net: cents(charge?.net_amount),
    status, providerStatus: paymentStatuses.has(gatewayStatus) ? gatewayStatus : null,
    chargeId: providerId(charge?.id, 'ch'),
    transactionId: providerId(transaction?.id, 'tran'),
    updatedAt: Number.isFinite(date) ? new Date(date) : null,
    authorized: ['authorized','paid','captured'].includes(status)
      ? [transaction?.authorized_amount, charge?.paid_amount || undefined, transaction?.amount, charge?.amount]
        .find(amount => Number.isSafeInteger(amount) && amount >= 0) ?? null : null,
    paid: Number.isSafeInteger(charge?.paid_amount) ? charge.paid_amount : null,
    refusalCode: status === 'declined' && typeof refusalCode === 'string' && /^[A-Za-z0-9]{1,8}$/.test(refusalCode) ? refusalCode : null,
    refusalReason: status === 'declined'
      ? cleanRefusal(transaction?.acquirer_message) ?? 'Pagamento recusado pela Pagar.me.' : null
  };
}
