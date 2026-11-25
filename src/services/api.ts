export type Environment = 'test' | 'live';

export interface Product {
  name: string;
  description: string;
  image: string;
  amount: number | null;
  maxInstallments: number;
  enabled: boolean;
  ready?: boolean;
  gatewayVersion?: number;
  environment: Environment;
  operation: 'auth_and_capture' | 'auth_only';
  version: number;
  min?: number;
  max?: number;
}

export interface Receipt {
  id: string;
  status: string;
  amount: number;
  installments: number;
  environment: Environment;
  http: number | null;
  refusalCode: string | null;
  providerStatus: string | null;
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
  checkoutError: string | null;
  reconciliation: string | null;
  newPurchaseAllowed: boolean;
}

export interface Gateway {
  environment: Environment;
  hasKey: boolean;
  enabled: boolean;
  connected: boolean | null;
  testedAt: string | null;
  updatedAt: string | null;
  http: number | null;
  message: string | null;
  activationBlock: string | null;
  authenticated: boolean | null;
  checkoutReadable: boolean | null;
  readError: string | null;
  checkoutCreationVerifiedAt: string | null;
  checkoutAttemptedAt: string | null;
  checkoutHttp: number | null;
  checkoutError: string | null;
}

export const statusLabels: Record<string, string> = {
  created: 'Pedido criado', processing: 'Pagamento iniciado', authorized: 'Pagamento autorizado',
  captured: 'Pagamento capturado', paid: 'Pagamento aprovado', declined: 'Pagamento recusado',
  pending: 'Pagamento pendente', review: 'Pagamento em análise', canceled: 'Pagamento cancelado',
  expired: 'Prazo do checkout encerrado', refunded: 'Pagamento estornado', chargedback: 'Contestação registrada',
  communication_error: 'Falha ao confirmar o checkout', request_failed: 'Solicitação rejeitada'
};
export const statusLabel = (status: string) => statusLabels[status] ?? 'Status em atualização';
export const reconciliations: Record<string, string> = {
  pending: 'Conciliação pendente', checkout_found: 'Checkout localizado', order_found: 'Pedido localizado',
  checkout_found_order_unverified: 'Checkout localizado, consulta de pedidos pendente',
  closed_without_order: 'Link encerrado sem pedido', rejected: 'Criação rejeitada pelo provedor'
};
const providerErrors: Record<string, string> = {
  provider_authentication: 'Falha de autenticação', provider_permission: 'Permissão insuficiente',
  provider_validation: 'Solicitação rejeitada pela Pagar.me', gateway_configuration: 'Erro de configuração do gateway',
  provider_rate_limit: 'Limite de requisições do provedor',
  provider_timeout: 'Tempo de resposta excedido', provider_dns: 'Falha de DNS',
  provider_tls: 'Falha na verificação TLS', provider_connection: 'Falha de conexão',
  provider_unavailable: 'Provedor indisponível', provider_non_json: 'Resposta fora do formato JSON',
  orders_list_invalid_shape: 'Formato incompatível na lista de pedidos',
  order_response_invalid_shape: 'Formato incompatível no pedido retornado',
  checkout_list_invalid_shape: 'Formato incompatível na lista de links',
  checkout_list_incomplete: 'Listagem de links incompleta',
  checkout_response_invalid_shape: 'Formato incompatível nos dados do checkout',
  provider_invalid_json: 'Resposta incompatível com a API', provider_redirect: 'Redirecionamento inesperado da API',
  provider_not_found: 'Referência indisponível no provedor', provider_conflict: 'Solicitação em conflito',
  checkout_id_invalid: 'Identificador de checkout ausente ou inválido',
  checkout_url_missing: 'URL de checkout ausente', checkout_url_invalid: 'URL de checkout rejeitada',
  checkout_reference_mismatch: 'Referência de checkout divergente', checkout_amount_mismatch: 'Valor de checkout divergente',
  checkout_installments_mismatch: 'Parcelamento de checkout divergente', checkout_date_invalid: 'Data de checkout inválida',
  checkout_incomplete: 'Resposta de checkout incompleta', checkout_reference_ambiguous: 'Mais de um checkout para a referência',
  order_reference_mismatch: 'Referência de pedido divergente', order_reference_ambiguous: 'Mais de um pedido para a referência',
  order_amount_mismatch: 'Valor de pedido divergente', gateway_account_mismatch: 'Conta do gateway divergente',
  gateway_account_unverified: 'Vínculo com a conta anterior pendente'
};
export const providerErrorLabel = (category: string | null) => category ? providerErrors[category] ?? 'Falha no provedor' : '—';
export const adminSessionExpired = 'cs013:admin-session-expired';
export const brl = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
export const dateTime = (date: string | null) => date
  ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(date))
  : '—';
export const envLabel = (env: Environment) => env === 'test' ? 'Sandbox' : 'Produção';

export class ApiError extends Error {
  constructor(public status: number, message: string, public http?: number, public safeToRetry = false, public category?: string) { super(message); }
}
export const explain = (error: unknown) => error instanceof ApiError ? error.message : 'Falha de comunicação. Tente novamente.';

export async function api<T>(path: string, options?: { method?: 'POST' | 'PUT'; body?: object; csrf?: string }): Promise<T> {
  const response = await fetch('/api' + path, {
    method: options?.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: options ? {
      'Content-Type': 'application/json',
      ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {})
    } : undefined,
    body: options ? JSON.stringify(options.body ?? {}) : undefined
  });
  const data = await response.json().catch(() => null);
  if (response.status === 401 && path.startsWith('/admin/') && !['/admin/login','/admin/session','/admin/logout'].includes(path)) {
    window.dispatchEvent(new Event(adminSessionExpired));
  }
  if (!response.ok || data === null) throw new ApiError(response.status, data?.message ?? 'Serviço indisponível.', data?.http,
    data?.safeToRetry === true, data?.category);
  return data as T;
}
