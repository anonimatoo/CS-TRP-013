import { useEffect, useState } from 'react';
import { Field } from '../components/UI';
import { api, dateTime, explain, merchantPath, type Merchant } from '../services/api';

interface Monitor {
  configured: boolean;
  source: 'panel' | 'environment';
  systemEnabled: boolean;
  enabled: boolean;
  active: boolean;
  schedulerConfigured: boolean;
  authorized: boolean;
  authorizedAt: string | null;
  revokedAt: string | null;
  totals: { sent: number; failed: number };
  history: {
    id: string; transaction_id: string; status: string; attempts: number;
    last_error: string | null; created_at: string; sent_at: string | null;
  }[];
}

const statuses: Record<string, string> = { pending: 'Na fila', processing: 'Em envio', sent: 'Enviada', failed: 'Falhou' };
const errors: Record<string, string> = {
  invalid_token: 'Token recusado', chat_unavailable: 'Chat inacessível', rate_limited: 'Limite do Telegram',
  connection_failed: 'Falha de conexão', telegram_unavailable: 'Telegram indisponível',
  delivery_uncertain: 'Entrega incerta. Confira o chat.', authorization_revoked: 'Autorização revogada ou destino alterado',
  payment_not_confirmed: 'Pagamento deixou de estar confirmado'
};

export function TelegramMonitor({ csrf, merchant, platform }: { csrf: string; merchant: Merchant; platform: boolean }) {
  const [monitor, setMonitor] = useState<Monitor>();
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState({ error: false, text: '' });
  const path = '/admin/telegram';
  const scoped = (suffix = '') => merchantPath(path + suffix, merchant.id);

  useEffect(() => {
    let mounted = true;
    api<Monitor>(scoped()).then(data => { if (mounted) setMonitor(data); })
      .catch(error => { if (mounted) setFeedback({ error: true, text: explain(error) }); });
    return () => { mounted = false; };
  }, [merchant.id]);

  async function act(suffix: string, method: 'PUT' | 'POST', body: object, message: string) {
    setBusy(true);
    setFeedback({ error: false, text: '' });
    try {
      await api(scoped(suffix), { method, body, csrf });
      setMonitor(await api<Monitor>(scoped()));
      if (suffix === '/configuration') setChatId('');
      setFeedback({ error: false, text: message });
    } catch (error) {
      setFeedback({ error: true, text: explain(error) });
    } finally {
      setBusy(false);
      setToken('');
      setConfirmed(false);
    }
  }

  return <section className="card-settings" aria-label="Telegram Monitor">
    <h3>Telegram Monitor</h3>
    <p>O bot central recebe pagamentos de produção confirmados de lojistas que autorizaram o compartilhamento.</p>
    {feedback.text && <p className={'notice ' + (feedback.error ? 'error' : 'info')} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {monitor && <>
      <dl className="gateway-facts">
        <div><dt>Envio automático</dt><dd>{monitor.active ? 'Habilitado na configuração' : 'Desativado ou incompleto'}</dd></div>
        <div><dt>Credenciais</dt><dd>{monitor.configured ? 'Configuradas' : 'Ausentes ou inválidas'} · {monitor.source === 'environment' ? 'Variáveis da Vercel' : 'Painel'}</dd></div>
        <div><dt>Agendador</dt><dd>{monitor.schedulerConfigured ? 'Segredo configurado' : 'CRON_SECRET ausente'}</dd></div>
        <div><dt>Enviadas pelo lojista</dt><dd>{monitor.totals.sent}</dd></div>
        <div><dt>Falhas do lojista</dt><dd>{monitor.totals.failed}</dd></div>
      </dl>
      {platform && <>
      <form onSubmit={event => { event.preventDefault(); void act('/configuration', 'PUT', { token, chatId }, 'Configuração salva.'); }}>
        <h4>Destino central de todos os lojistas</h4>
        {monitor.source === 'environment' && <p>Para alterar o destino central, atualize as variáveis de ambiente da Vercel.</p>}
        <Field label="Token do bot" type="password" autoComplete="off" value={token} maxLength={121} required
          disabled={busy || monitor.source === 'environment'} onChange={event => setToken(event.target.value)} />
        <Field label="Chat ID" type="password" autoComplete="off" value={chatId} maxLength={17} required
          disabled={busy || monitor.source === 'environment'} onChange={event => setChatId(event.target.value)} />
        <button className="button secondary" disabled={busy || monitor.source === 'environment'}>Salvar configuração</button>
      </form>
      <div className="gateway-actions">
        <button type="button" className="button secondary" disabled={busy || !monitor.configured}
          onClick={() => void act('/connection', 'POST', {}, 'Bot e chat localizados no Telegram.')}>Testar conexão</button>
        <button type="button" className="button secondary" disabled={busy || !monitor.configured}
          onClick={() => void act('/test-message', 'POST', {}, 'Envio de teste confirmado pelo Telegram.')}>Enviar notificação de teste</button>
        <button type="button" className="button secondary" disabled={busy || monitor.active || !monitor.configured || !monitor.systemEnabled || !monitor.schedulerConfigured}
          onClick={() => void act('/activation', 'PUT', { enabled: true }, 'Notificações automáticas ativadas.')}>Ativar notificações</button>
        <button type="button" className="button secondary" disabled={busy || !monitor.enabled}
          onClick={() => void act('/activation', 'PUT', { enabled: false }, 'Notificações automáticas desativadas.')}>Desativar notificações</button>
      </div>
      </>}
      <h4>Autorização de {merchant.name}</h4>
      <p>{monitor.authorized ? 'Autorizado para o chat atual desde ' + dateTime(monitor.authorizedAt) :
        monitor.revokedAt ? 'Autorização revogada em ' + dateTime(monitor.revokedAt) : 'Sem autorização para o chat atual.'}</p>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
        Confirmo a decisão do lojista sobre compartilhar os dados de pagamento com o chat central configurado.</label>
      <div className="gateway-actions">
        <button type="button" className="button secondary" disabled={busy || !confirmed || !monitor.configured || monitor.authorized}
          onClick={() => void act('/authorization', 'PUT', { authorized: true, confirmed }, 'Autorização registrada.')}>Registrar autorização</button>
        <button type="button" className="button secondary" disabled={busy || !confirmed || !monitor.authorizedAt || !!monitor.revokedAt}
          onClick={() => void act('/authorization', 'PUT', { authorized: false, confirmed }, 'Autorização revogada.')}>Revogar autorização</button>
      </div>
      <h4>Histórico do lojista</h4>
      {monitor.history.length ? <ul>{monitor.history.map(item => <li key={item.id}>
        <code>{item.transaction_id}</code> · {statuses[item.status]} · {item.attempts} tentativa(s) · {dateTime(item.sent_at ?? item.created_at)}
        {item.last_error && ' · ' + (errors[item.last_error] ?? 'Falha de envio')}
      </li>)}</ul> : <p>Sem notificações registradas.</p>}
      <button type="button" className="button secondary" disabled={busy} onClick={() => {
        setBusy(true);
        api<Monitor>(scoped()).then(setMonitor).catch(error => setFeedback({ error: true, text: explain(error) }))
          .finally(() => setBusy(false));
      }}>Atualizar histórico</button>
    </>}
  </section>;
}
