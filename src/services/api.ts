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
}

export const statusLabels: Record<string, string> = {
  created: 'Pedido criado', processing: 'Pagamento iniciado', authorized: 'Pagamento autorizado',
  captured: 'Pagamento capturado', paid: 'Pagamento aprovado', declined: 'Pagamento recusado',
  pending: 'Pagamento pendente', review: 'Pagamento em análise', canceled: 'Pagamento cancelado',
  expired: 'Prazo do checkout encerrado', refunded: 'Pagamento estornado', chargedback: 'Contestação registrada',
  communication_error: 'Confirmação pendente', request_failed: 'Solicitação rejeitada'
};
export const statusLabel = (status: string) => statusLabels[status] ?? 'Status em atualização';
export const brl = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
export const dateTime = (date: string | null) => date
  ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(date))
  : '—';
export const envLabel = (env: Environment) => env === 'test' ? 'Sandbox' : 'Produção';

export class ApiError extends Error {
  constructor(public status: number, message: string, public http?: number, public safeToRetry = false) { super(message); }
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
  if (!response.ok || data === null) throw new ApiError(response.status, data?.message ?? 'Serviço indisponível.', data?.http, data?.safeToRetry === true);
  return data as T;
}
