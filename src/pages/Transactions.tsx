import { useEffect, useState } from 'react';
import { api, merchantPath, brl, dateTime, explain, providerErrorLabel, reconciliations, statusLabel, type Environment, type CardMethod } from '../services/api';
import { Loader } from '../components/UI';

interface Diagnostic {
  operation: string; check: string; http: number | null; hostname?: string;
  body?: { type: string; fields?: Record<string, string>; count?: number; fieldCount?: number };
  data?: Diagnostic['body'];
  cart?: Diagnostic['body'];
}
interface Row {
  id: string; account: string | null; status: string; amount: number; installments: number; created_at: string;
  provider_order: string | null; checkout_provider_id: string | null; provider_charge: string | null; provider_status: string | null;
  has_checkout_url: boolean; checkout_expires_at: string | null; checkout_attempted_at: string | null;
  checkout_http: number | null; checkout_error: string | null; reconciliation_state: string | null;
  reconciliation_http: number | null; reconciliation_error: string | null; reconciliation_at: string | null;
  checkout_diagnostic: Diagnostic | null; reconciliation_diagnostics: Diagnostic[] | null;
  payment_method: CardMethod | null; authorized_amount: number | null;
  provider_transaction: string | null; authentication_status: string | null;
  refusal_code: string | null; refusal_reason: string | null; http_status: number | null;
}
type Event = { id: number; provider_id: string | null; status: string; created_at: string };
const methodLabel = (method: CardMethod | null) => method === 'credit_card' ? 'Crédito' : method === 'debit_card' ? 'Débito' : '—';
const authenticationLabels: Record<string, string> = {
  Y: 'Concluída', A: 'Tentativa registrada', N: 'Não autenticada', C: 'Desafio incompleto',
  U: 'Indisponível', R: 'Negada', I: 'Informativa', canceled: 'Cancelada', unavailable: 'Indisponível'
};
type Action = 'refresh' | 'capture' | 'cancel';

const urlChecks: Record<string, string> = {
  url_missing: 'URL ausente', url_invalid_type: 'Tipo inválido de URL', url_too_long: 'URL acima do tamanho permitido',
  url_invalid_format: 'Formato de URL inválido', url_not_https: 'A URL precisa usar HTTPS',
  url_has_credentials: 'A URL contém credenciais', url_nondefault_port: 'A URL usa porta diferente da padrão',
  url_untrusted_host: 'O endereço está fora da lista de domínios autorizados'
};

function diagnosticText(diagnostic: Diagnostic) {
  return [diagnostic.operation, diagnostic.http == null ? 'HTTP indisponível' : 'HTTP ' + diagnostic.http,
    urlChecks[diagnostic.check] ?? diagnostic.check, diagnostic.hostname].filter(Boolean).join(' · ');
}

function diagnosticShape(value: Diagnostic['body']) {
  if (!value) return null;
  const fields = Object.entries(value.fields ?? {}).map(([name, type]) => name + ' (' + type + ')');
  return [value.type, value.count == null ? null : value.count + ' registros',
    value.fieldCount == null ? null : value.fieldCount + ' campos', ...fields].filter(Boolean).join(' · ');
}

export function Transactions({ env, csrf, merchant, readOnly }: { env: Environment; csrf: string; merchant: string; readOnly: boolean }) {
  const [result, setResult] = useState<{ rows: Row[]; hasNext: boolean }>();
  const [details, setDetails] = useState<{ row: Row; events: Event[] }>();
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<Action>();

  async function load() {
    try { setResult(await api(merchantPath('/admin/transactions/' + env + '?page=' + page, merchant))); }
    catch (failure) { setError(explain(failure)); }
  }
  useEffect(() => { void load(); }, [page]);

  async function open(id: string) {
    setError('');
    setConfirm(undefined);
    try { setDetails(await api(merchantPath('/admin/orders/' + id, merchant))); }
    catch (failure) { setError(explain(failure)); }
  }
  async function run(action: Action) {
    if (!details || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(merchantPath('/admin/orders/' + details.row.id + '/' + action, merchant), { method: 'POST', csrf, body: { confirmed: true } });
      await open(details.row.id);
      await load();
    } catch (failure) {
      await open(details.row.id);
      setError(explain(failure));
    }
    finally { setBusy(false); }
  }

  return <>
    <div className="transaction-header"><h3>Histórico de transações</h3><a className="button secondary" href={merchantPath('/api/admin/report/' + env, merchant)}>Exportar CSV</a></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!result && !error && <p><Loader /> Carregando histórico</p>}
    {result?.rows.length === 0 && <p className="notice">Nenhum pedido neste ambiente.</p>}
    {!!result?.rows.length && <div className="table-scroll"><table>
      <thead><tr><th>Pedido</th><th>Data</th><th>Valor</th><th>Modalidade</th><th>Status</th><th>Provedor</th></tr></thead>
      <tbody>{result.rows.map(row => <tr key={row.id}>
        <td><button type="button" className="text-button" onClick={() => void open(row.id)}>{row.id.slice(0,8)}</button></td>
        <td>{dateTime(row.created_at)}</td><td>{brl(row.amount)}</td><td>{methodLabel(row.payment_method)}</td><td>{statusLabel(row.status)}</td><td>{row.provider_order ?? row.checkout_provider_id ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>}
    {(page > 1 || result?.hasNext) && <div className="dialog-actions">
      <button className="button secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Anterior</button>
      <button className="button secondary" disabled={!result?.hasNext} onClick={() => setPage(page + 1)}>Próxima</button>
    </div>}
    {details && <div className="transaction-detail">
      <div className="transaction-header"><h3>Detalhes do pedido</h3><button className="text-button" onClick={() => setDetails(undefined)}>Fechar detalhes</button></div>
      <dl className="gateway-facts">
        <div><dt>Pedido local</dt><dd>{details.row.id}</dd></div>
        <div><dt>Modalidade</dt><dd>{methodLabel(details.row.payment_method)}</dd></div>
        <div><dt>Valor autorizado</dt><dd>{details.row.authorized_amount == null ? '—' : brl(details.row.authorized_amount)}</dd></div>
        <div><dt>Transação Pagar.me</dt><dd>{details.row.provider_transaction ?? '—'}</dd></div>
        <div><dt>Autenticação 3DS</dt><dd>{authenticationLabels[details.row.authentication_status ?? ''] ?? '—'}</dd></div>
        <div><dt>Conta comercial</dt><dd>{details.row.account ?? '—'}</dd></div>
        <div><dt>Checkout Pagar.me</dt><dd>{details.row.checkout_provider_id ?? '—'}</dd></div>
        <div><dt>Pedido Pagar.me</dt><dd>{details.row.provider_order ?? '—'}</dd></div>
        <div><dt>URL de checkout registrada</dt><dd>{details.row.has_checkout_url ? 'Sim' : 'Não'}</dd></div>
        <div><dt>Validade do checkout</dt><dd>{dateTime(details.row.checkout_expires_at)}</dd></div>
        <div><dt>Cobrança Pagar.me</dt><dd>{details.row.provider_charge ?? '—'}</dd></div>
        <div><dt>Status do provedor</dt><dd>{details.row.provider_status ?? '—'}</dd></div>
        <div><dt>HTTP registrado no pedido</dt><dd>{details.row.http_status ?? '—'}</dd></div>
        <div><dt>HTTP da criação do checkout</dt><dd>{details.row.checkout_http ?? '—'}</dd></div>
        <div><dt>Tentativa de criação</dt><dd>{dateTime(details.row.checkout_attempted_at)}</dd></div>
        <div><dt>Falha na criação</dt><dd>{providerErrorLabel(details.row.checkout_error)}</dd></div>
        <div><dt>Conciliação</dt><dd>{reconciliations[details.row.reconciliation_state ??
          (details.row.status === 'communication_error' ? 'pending' : '')] ?? '—'}</dd></div>
        <div><dt>Última conciliação</dt><dd>{dateTime(details.row.reconciliation_at)}</dd></div>
        <div><dt>HTTP da conciliação</dt><dd>{details.row.reconciliation_http ?? '—'}</dd></div>
        <div><dt>Falha na conciliação</dt><dd>{providerErrorLabel(details.row.reconciliation_error)}</dd></div>
        <div><dt>Código de recusa</dt><dd>{details.row.refusal_code ?? '—'}</dd></div>
        <div className="span-full"><dt>Motivo informado pelo provedor</dt><dd>{details.row.refusal_reason ?? '—'}</dd></div>
      </dl>
      {(details.row.checkout_diagnostic || details.row.reconciliation_diagnostics?.length) && <details>
        <summary>Diagnóstico técnico da Pagar.me</summary>
        <ul className="events">
          {[details.row.checkout_diagnostic, ...(details.row.reconciliation_diagnostics ?? [])].map((entry, index) => entry &&
            <li key={index}>
              <strong>{diagnosticText(entry)}</strong>
              {[entry.body, entry.data, entry.cart].map((value, shapeIndex) => value &&
                <div key={shapeIndex}>{diagnosticShape(value)}</div>)}
            </li>)}
        </ul>
      </details>}
      <ul className="events">{details.events.map(event => <li key={event.id}>{dateTime(event.created_at)} · {statusLabel(event.status)} {event.provider_id ?? ''}</li>)}</ul>
      {!readOnly && <div className="gateway-actions">
        <button className="button secondary" disabled={busy} onClick={() => void run('refresh')}>{busy && <Loader />} Consultar provedor</button>
        {details.row.status === 'authorized' && details.row.payment_method !== 'debit_card' && <button className="button primary" disabled={busy} onClick={() => setConfirm('capture')}>Capturar</button>}
        {['authorized','paid','captured'].includes(details.row.status) && <button className="button danger" disabled={busy} onClick={() => setConfirm('cancel')}>{details.row.status === 'authorized' ? 'Cancelar autorização' : 'Estornar'}</button>}
      </div>}
      {confirm && <div className="confirmation"><p>Confirma {confirm === 'capture' ? 'a captura' : 'o cancelamento ou estorno'} de {brl(details.row.amount)}?</p>
        <div><button className="button secondary" onClick={() => setConfirm(undefined)}>Voltar</button><button className="button primary" disabled={busy} onClick={() => void run(confirm)}>Confirmar</button></div>
      </div>}
    </div>}
  </>;
}
