import { useEffect, useState } from 'react';
import { api, brl, dateTime, explain, statusLabel, type Environment } from '../services/api';
import { Loader } from '../components/UI';

interface Row {
  id: string; account: string; status: string; amount: number; installments: number; created_at: string;
  provider_order: string | null; provider_charge: string | null; provider_status: string | null;
  refusal_code: string | null; refusal_reason: string | null; http_status: number | null;
}
type Event = { id: number; provider_id: string | null; status: string; created_at: string };
type Action = 'refresh' | 'capture' | 'cancel';

export function Transactions({ env, csrf }: { env: Environment; csrf: string }) {
  const [result, setResult] = useState<{ rows: Row[]; hasNext: boolean }>();
  const [details, setDetails] = useState<{ row: Row; events: Event[] }>();
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<Action>();

  async function load() {
    try { setResult(await api('/admin/transactions/' + env + '?page=' + page)); }
    catch (failure) { setError(explain(failure)); }
  }
  useEffect(() => { void load(); }, [page]);

  async function open(id: string) {
    setError('');
    setConfirm(undefined);
    try { setDetails(await api('/admin/orders/' + id)); }
    catch (failure) { setError(explain(failure)); }
  }
  async function run(action: Action) {
    if (!details || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/admin/orders/' + details.row.id + '/' + action, { method: 'POST', csrf, body: { confirmed: true } });
      await open(details.row.id);
      await load();
    } catch (failure) { setError(explain(failure)); setConfirm(undefined); }
    finally { setBusy(false); }
  }

  return <>
    <div className="transaction-header"><h3>Histórico de transações</h3><a className="button secondary" href={'/api/admin/report/' + env}>Exportar CSV</a></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!result && !error && <p><Loader /> Carregando histórico</p>}
    {result?.rows.length === 0 && <p className="notice">Nenhum pedido neste ambiente.</p>}
    {!!result?.rows.length && <div className="table-scroll"><table>
      <thead><tr><th>Pedido</th><th>Data</th><th>Valor</th><th>Status</th><th>Provedor</th></tr></thead>
      <tbody>{result.rows.map(row => <tr key={row.id}>
        <td><button type="button" className="text-button" onClick={() => void open(row.id)}>{row.id.slice(0,8)}</button></td>
        <td>{dateTime(row.created_at)}</td><td>{brl(row.amount)}</td><td>{statusLabel(row.status)}</td><td>{row.provider_order ?? '—'}</td>
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
        <div><dt>Conta comercial</dt><dd>{details.row.account}</dd></div>
        <div><dt>Cobrança Pagar.me</dt><dd>{details.row.provider_charge ?? '—'}</dd></div>
        <div><dt>Status do provedor</dt><dd>{details.row.provider_status ?? '—'}</dd></div>
        <div><dt>Resposta HTTP</dt><dd>{details.row.http_status ?? '—'}</dd></div>
        <div><dt>Código de recusa</dt><dd>{details.row.refusal_code ?? '—'}</dd></div>
        <div className="span-full"><dt>Motivo informado pelo provedor</dt><dd>{details.row.refusal_reason ?? '—'}</dd></div>
      </dl>
      <ul className="events">{details.events.map(event => <li key={event.id}>{dateTime(event.created_at)} · {statusLabel(event.status)} {event.provider_id ?? ''}</li>)}</ul>
      <div className="gateway-actions">
        <button className="button secondary" disabled={busy} onClick={() => void run('refresh')}>{busy && <Loader />} Consultar provedor</button>
        {details.row.status === 'authorized' && <button className="button primary" disabled={busy} onClick={() => setConfirm('capture')}>Capturar</button>}
        {['authorized','paid','captured'].includes(details.row.status) && <button className="button danger" disabled={busy} onClick={() => setConfirm('cancel')}>{details.row.status === 'authorized' ? 'Cancelar autorização' : 'Estornar'}</button>}
      </div>
      {confirm && <div className="confirmation"><p>Confirma {confirm === 'capture' ? 'a captura' : 'o cancelamento ou estorno'} de {brl(details.row.amount)}?</p>
        <div><button className="button secondary" onClick={() => setConfirm(undefined)}>Voltar</button><button className="button primary" disabled={busy} onClick={() => void run(confirm)}>Confirmar</button></div>
      </div>}
    </div>}
  </>;
}
