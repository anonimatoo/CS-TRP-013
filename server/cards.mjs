import { z } from 'zod';
import { ProviderError } from './pagarme.mjs';

export const cardMethod = z.enum(['credit_card','debit_card']);
export const publicKeyPattern = /^pk_(?:test_)?[A-Za-z0-9_-]{8,150}$/;

export function cardAvailability(row, config) {
  return {
    credit_card: Boolean(row.public_key && row.credit_enabled),
    debit_card: Boolean(row.public_key && row.debit_enabled && row.debit_authorization_reference &&
      row.debit_authorization_reference === config.debitApproval?.[row.environment])
  };
}

export const requires3ds = (row, method) =>
  method === 'debit_card' ? row.debit_requires_3ds : row.credit_requires_3ds;

export async function stoneToken(secret, environment, fetcher = fetch) {
  const host = environment === 'test' ? '3ds-sdx.stone.com.br' : '3ds.stone.com.br';
  let response;
  try {
    response = await fetcher('https://' + host + '/v2/tds-token', {
      headers: { Authorization: 'Basic ' + Buffer.from(secret + ':').toString('base64') },
      redirect: 'error',
      signal: AbortSignal.timeout(8000)
    });
    if (response.ok) {
      const { tds_token: token } = await response.json();
      if (typeof token === 'string' && token.length) return token;
    }
  } catch {
    throw new ProviderError(null, 'provider_3ds_unavailable');
  }
  throw new ProviderError(response.status, 'provider_3ds_unavailable');
}
