import { api, merchantPath, storefrontMerchant, type CardMethod } from './api';

type Card = { number: string; holder_name: string; exp_month: number; exp_year: number; cvv: string };
type Buyer = { name: string; email: string; cpf: string; phone: string; cep: string; state: string;
  city: string; number: string; street: string; neighborhood: string; complement: string; country: string };
type Result = { tds_server_trans_id?: string; trans_status?: string; challenge_canceled?: boolean };
type Authentication = { status: string; transactionId?: string };
type SDK = { init: (options: object, order: object) => Promise<Result[]> };

let sdkLoad: Promise<SDK> | undefined;
let sdkEnvironment: 'test' | 'live' | undefined;

function loadSdk(environment: 'test' | 'live') {
  if (!sdkLoad || sdkEnvironment !== environment) {
    sdkEnvironment = environment;
    sdkLoad = new Promise<SDK>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://3ds-nx-js.stone.com.br/' + environment + '/v2/3ds2.min.js';
      const timer = window.setTimeout(() => {
        script.remove();
        reject(new Error('A biblioteca 3DS demorou para carregar.'));
      }, 10000);
      script.onload = () => {
        window.clearTimeout(timer);
        const sdk = (window as Window & { TDS?: SDK }).TDS;
        if (sdk) resolve(sdk);
        else reject(new Error('Biblioteca 3DS indisponível.'));
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        script.remove();
        reject(new Error('Biblioteca 3DS indisponível.'));
      };
      document.head.append(script);
    }).catch(error => {
      sdkLoad = undefined;
      throw error;
    });
  }
  return sdkLoad;
}

export async function authenticateCard(card: Card, buyer: Buyer, amount: number, environment: 'test' | 'live',
  request: { method: CardMethod; merchantId?: string; version: number; gatewayVersion: number },
  methodContainer: HTMLElement, challengeContainer: HTMLElement): Promise<Authentication> {
  try {
    const sdk = await loadSdk(environment);
    const { token } = await api<{ token: string }>(merchantPath('/checkout/3ds', storefrontMerchant()), { method: 'POST', body: request });
    const phone = buyer.phone.replace(/\D/g, '');
    const address = { country: buyer.country, state: buyer.state, city: buyer.city, zip_code: buyer.cep.replace(/\D/g, ''),
      line_1: [buyer.number, buyer.street, buyer.neighborhood].join(', '), line_2: buyer.complement };
    const result = await sdk.init({
      token, tds_method_container_element: methodContainer, challenge_container_element: challengeContainer,
      use_default_challenge_iframe_style: false, challenge_window_size: '05'
    }, {
      requestor_url: window.location.origin,
      customer: { name: buyer.name, email: buyer.email, document: buyer.cpf.replace(/\D/g, ''),
        phones: { mobile_phone: { country_code: '55', area_code: phone.slice(0, 2), number: phone.slice(2) } } },
      payments: [{ payment_method: request.method, amount, credit_card: { card: {
        number: card.number, holder_name: card.holder_name, exp_month: card.exp_month, exp_year: card.exp_year,
        billing_address: address
      } } }]
    });
    const status = result[0]?.trans_status ?? '';
    if (result[0]?.challenge_canceled) return { status: 'canceled' };
    if (status === 'Y') {
      const id = result[0]?.tds_server_trans_id;
      return id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
        ? { status, transactionId: id } : { status: 'unavailable' };
    }
    return { status: /^[ANCURI]$/.test(status) ? status : 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function tokenizeCard(card: Card, publicKey: string) {
  const endpoint = new URL('https://api.pagar.me/core/v5/tokens');
  endpoint.searchParams.set('appId', publicKey);
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(12000), body: JSON.stringify({ type: 'card', card })
    });
    if (response.ok) {
      const { id } = await response.json();
      if (typeof id === 'string' && /^token_[A-Za-z0-9_-]{4,120}$/.test(id)) return id;
    }
  } catch {
    // Details returned by the provider can include submitted fields.
  }
  throw new Error('Não foi possível validar os dados do cartão. Confira os campos e tente novamente.');
}
