import { useEffect, useState, type FormEvent } from 'react';
import { Field } from '../components/UI';
import { api, brl, dateTime, explain, merchantPath, statusLabel, type Merchant } from '../services/api';

interface Sharing {
  enabled: boolean; authorized: boolean; recipients: string[]; suggestedRecipient: string; systemEnabled: boolean;
  authorized_at?: string;
}
interface SmtpInfo { host: string; port: number; secure: boolean; configured: boolean; sender: string }
interface Notice {
  id: string; order_id: string; transaction_id: string; recipient: string; status: string;
  attempts: number; last_error: string | null; created_at: string; sent_at: string | null;
}
interface Totals { orders: number; captured: number; gross: number; fees: number | null; net: number | null }

const noticeStatus: Record<string, string> = { pending: 'Pendente', processing: 'Processando', sent: 'Enviada', failed: 'Falhou' };
const errorLabels: Record<string, string> = {
  sharing_revoked: 'Compartilhamento desativado ou revogado',
  payment_not_captured: 'Pagamento deixou de estar capturado',
  delivery_uncertain: 'Entrega incerta',
  smtp_connection: 'Conexão SMTP indisponível',
  xlsx_error: 'Falha ao gerar o XLSX'
};
const orderStatuses = ['paid','captured','pending','declined','authorized','canceled','refunded','processing','review',
  'communication_error','request_failed','authentication_incomplete','expired','chargedback'];

export function Notifications({ merchant, csrf }: { merchant: Merchant; csrf: string }) {
  const [sharing, setSharing] = useState<Sharing>();
  const [enabled, setEnabled] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [recipients, setRecipients] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [testRecipient, setTestRecipient] = useState('');
  const [smtp, setSmtp] = useState<SmtpInfo>();
  const [sender, setSender] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [retry, setRetry] = useState<Notice>();
  const [checkedDelivery, setCheckedDelivery] = useState(false);
  const [totals, setTotals] = useState<Totals>();
  const [filter, setFilter] = useState({ from: '', to: '', method: '', status: '', environment: 'live', period: 'month', consolidated: '' });
  const [noticeFilter, setNoticeFilter] = useState('');
  const [feedback, setFeedback] = useState({ text: '', error: false });
  const [busy, setBusy] = useState(false);
  const scoped = (path: string) => merchantPath(path, merchant.id);

  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value));
  const reportPath = scoped('/admin/financial-report?' + query);
  const notificationQuery = new URLSearchParams(Object.entries({
    from: filter.from, to: filter.to, method: filter.method, status: noticeFilter
  }).filter(([, value]) => value));
  const historyPath = scoped('/admin/notifications?' + notificationQuery);

  function showSharing(row: Sharing) {
    setSharing(row);
    setEnabled(row.enabled);
    setAuthorized(row.authorized);
    setRecipients(row.recipients.join(', '));
    setTestRecipient(row.recipients[0] ?? '');
    setConfirmed(false);
  }
  function showSmtp(row: SmtpInfo) {
    setSmtp(row);
    setSender(row.sender);
  }

  useEffect(() => {
    if (merchant.quarantined) return;
    let current = true;
    Promise.all([
      api<Sharing>(scoped('/admin/notifications/settings')),
      api<SmtpInfo>('/admin/notifications/smtp')
    ]).then(([sharing, smtp]) => {
      if (current) { showSharing(sharing); showSmtp(smtp); }
    }).catch(error => { if (current) setFeedback({ error: true, text: explain(error) }); });
    return () => { current = false; };
  }, [merchant.id]);

  useEffect(() => {
    let current = true;
    setTotals(undefined);
    api<Totals>(reportPath).then(row => { if (current) setTotals(row); })
      .catch(error => { if (current) setFeedback({ error: true, text: explain(error) }); });
    return () => { current = false; };
  }, [reportPath]);

  async function refreshHistory() {
    if (!merchant.quarantined) setNotices(await api<Notice[]>(historyPath));
  }

  useEffect(() => {
    if (merchant.quarantined) return;
    let current = true;
    api<Notice[]>(historyPath).then(rows => { if (current) setNotices(rows); })
      .catch(error => { if (current) setFeedback({ error: true, text: explain(error) }); });
    return () => { current = false; };
  }, [historyPath]);

  async function submit(event: FormEvent, action: () => Promise<unknown>, message: string) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback({ text: '', error: false });
    try {
      await action();
      setFeedback({ text: message, error: false });
    } catch (error) { setFeedback({ text: explain(error), error: true }); }
    finally { setBusy(false); }
  }

  return <>
    <section className="report-section">
      <h3>Relatórios financeiros</h3>
      <div className="fields two">
        <label className="field">Período<select value={filter.period} onChange={e => setFilter({ ...filter, period: e.target.value })}>
          <option value="day">Hoje</option><option value="week">Semana atual</option><option value="month">Mês atual</option>
          <option value="">Intervalo personalizado</option>
        </select></label>
        <label className="field">Ambiente do relatório<select value={filter.environment} onChange={e => setFilter({ ...filter, environment: e.target.value })}>
          <option value="live">Produção</option><option value="test">Sandbox</option><option value="">Todos</option>
        </select></label>
        <Field label="Data inicial" type="date" value={filter.from} onChange={e => setFilter({ ...filter, from: e.target.value, period: '' })} />
        <Field label="Data final" type="date" value={filter.to} onChange={e => setFilter({ ...filter, to: e.target.value, period: '' })} />
        <label className="field">Modalidade<select value={filter.method} onChange={e => setFilter({ ...filter, method: e.target.value })}>
          <option value="">Todas</option><option value="credit_card">Crédito</option><option value="debit_card">Débito</option>
        </select></label>
        <label className="field">Status financeiro<select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
          <option value="">Todos</option>{orderStatuses.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
        </select></label>
      </div>
      {!merchant.quarantined && <label><input type="checkbox" checked={filter.consolidated === 'true'}
        onChange={e => setFilter({ ...filter, consolidated: e.target.checked ? 'true' : '' })} /> Consolidar lojistas com compartilhamento autorizado</label>}
      {totals && <div className="dashboard">
        {[['Pedidos', totals.orders], ['Capturas confirmadas', totals.captured], ['Valor bruto capturado', brl(totals.gross)],
          ['Taxas informadas', totals.fees == null ? '—' : brl(totals.fees)], ['Líquido informado', totals.net == null ? '—' : brl(totals.net)]]
          .map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>}
      <div><a className="button secondary" href={'/api' + reportPath + '&format=xlsx'}>Baixar XLSX</a></div>
    </section>
    {!merchant.quarantined && <>
      {sharing && <form className="report-section" onSubmit={e => void submit(e, async () => {
        const row = await api<Sharing>(scoped('/admin/notifications/settings'), { method: 'PUT', csrf, body: {
          enabled, authorized, confirmed, recipients: recipients.split(',').map(value => value.trim()).filter(Boolean)
        } });
        showSharing(row);
        await refreshHistory();
      }, 'Compartilhamento atualizado.')}>
        <h3>Compartilhamento e envio automático</h3>
        {!sharing.systemEnabled && <p className="help">O envio automático está desativado nas configurações do servidor.</p>}
        <Field label="Destinatários autorizados" placeholder="Separe os endereços por vírgulas" value={recipients}
          onChange={e => { setRecipients(e.target.value); setConfirmed(false); }} />
        {sharing.suggestedRecipient && <div><button type="button" className="text-button" onClick={() => {
          setRecipients(current => [current, sharing.suggestedRecipient].filter(Boolean).join(', ')); setConfirmed(false);
        }}>Usar destinatário sugerido ({sharing.suggestedRecipient})</button></div>}
        <div className="report-checkboxes">
          <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enviar após captura</label>
          <label><input type="checkbox" checked={authorized} onChange={e => { setAuthorized(e.target.checked); setConfirmed(false); }} /> Autorizar compartilhamento deste lojista</label>
        </div>
        {authorized && <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Confirmo que o lojista autorizou estes destinatários</label>}
        {sharing.authorized_at && <p className="help">Autorização registrada em {dateTime(sharing.authorized_at)}.</p>}
        <div><button className="button primary" disabled={busy || (authorized && !confirmed)}>Salvar compartilhamento</button></div>
      </form>}
      {smtp && <form className="report-section" onSubmit={e => void submit(e, async () => {
        const password = smtpPassword;
        setSmtpPassword('');
        showSmtp(await api<SmtpInfo>('/admin/notifications/smtp', { method: 'PUT', csrf, body: { user: smtpUser, sender, password } }));
        setSmtpUser('');
      }, 'Configuração SMTP salva.')}>
        <h3>SMTP da plataforma</h3>
        <p className="help">{smtp.host ? `${smtp.host}:${smtp.port} · ${smtp.secure ? 'TLS' : 'STARTTLS'} · ${smtp.configured ? 'Configurado' : 'Credenciais pendentes'}` : 'Defina SMTP_HOST no servidor.'}</p>
        <div className="fields two">
          <Field label="Remetente SMTP" type="email" required value={sender} onChange={e => setSender(e.target.value)} disabled={!smtp.host} />
          <Field label="Usuário SMTP" required autoComplete="off" value={smtpUser} onChange={e => setSmtpUser(e.target.value)} disabled={!smtp.host} />
          <Field label="Senha SMTP" required type="password" autoComplete="new-password" value={smtpPassword} onChange={e => setSmtpPassword(e.target.value)} disabled={!smtp.host} />
        </div>
        <div><button className="button secondary" disabled={busy || !smtp.host}>Salvar credenciais SMTP</button></div>
      </form>}
      {sharing?.authorized && smtp?.configured && <form className="report-section" onSubmit={e => void submit(e, () =>
        api(scoped('/admin/notifications/test'), { method: 'POST', csrf, body: { recipient: testRecipient } }), 'E-mail fictício aceito pelo SMTP.')}>
        <label className="field">Destinatário do teste<select value={testRecipient} onChange={e => setTestRecipient(e.target.value)}>
          {sharing.recipients.map(value => <option key={value}>{value}</option>)}
        </select></label>
        <div><button className="button secondary" disabled={busy || !testRecipient}>Enviar teste fictício</button></div>
      </form>}
      <section className="report-section">
        <h3>Histórico de notificações</h3>
        <div className="fields two">
          <label className="field">Status do envio<select value={noticeFilter} onChange={e => setNoticeFilter(e.target.value)}>
            <option value="">Todos</option>{Object.entries(noticeStatus).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
          </select></label>
          <div><button type="button" className="button secondary" onClick={() => void refreshHistory().catch(error => setFeedback({ error: true, text: explain(error) }))}>Atualizar histórico</button></div>
        </div>
        {notices.length === 0 ? <p className="help">Nenhuma notificação para os filtros selecionados.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Criada</th><th>Transação</th><th>Destinatário</th><th>Status</th><th>Tentativas</th><th>Enviada</th><th>Resultado</th><th>Ação</th></tr></thead>
          <tbody>{notices.map(row => <tr key={row.id}>
            <td>{dateTime(row.created_at)}</td><td>{row.transaction_id}</td><td>{row.recipient}</td>
            <td>{noticeStatus[row.status]}</td><td>{row.attempts}</td><td>{dateTime(row.sent_at)}</td>
            <td>{row.last_error ? errorLabels[row.last_error] ?? row.last_error.replace(/^smtp_/, 'SMTP ') : '—'}</td><td><a className="text-button" href={'/api' + scoped('/admin/notifications/' + row.id + '/xlsx')}>XLSX</a> {row.status === 'failed' && <button className="text-button" type="button" onClick={() => {
              setRetry(row); setCheckedDelivery(false);
            }}>Reenviar</button>}</td>
          </tr>)}</tbody>
        </table></div>}
        {retry && <form className="confirmation" onSubmit={e => void submit(e, async () => {
          await api(scoped('/admin/notifications/' + retry.id + '/retry'), { method: 'POST', csrf, body: { confirmed: true, checkedDelivery } });
          setRetry(undefined);
          await refreshHistory();
        }, 'Notificação recolocada na fila.')}>
          <p>Recolocar a notificação de {retry.transaction_id} na fila?</p>
          {retry.last_error === 'delivery_uncertain' && <label><input type="checkbox" checked={checkedDelivery}
            onChange={e => setCheckedDelivery(e.target.checked)} /> Confirmei com o SMTP que a entrega anterior não foi aceita</label>}
          <button className="button secondary" type="button" onClick={() => setRetry(undefined)}>Voltar</button>
          <button className="button primary" disabled={busy || (retry.last_error === 'delivery_uncertain' && !checkedDelivery)}>Confirmar reenvio</button>
        </form>}
      </section>
    </>}
    {feedback.text && <p className={'notice ' + (feedback.error ? 'error' : 'success')} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
  </>;
}
