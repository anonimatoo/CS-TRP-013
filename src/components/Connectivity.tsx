import { Field } from './UI';
import { useState } from 'react';
import { api, explain, merchantPath, providerErrorLabel, type Environment } from '../services/api';

interface Report {
  credential: 'missing' | 'unreadable' | 'configured';
  configuredStaticIPs: string[];
  observed: { ipv4: string | null; ipv6: string | null };
  checks: Record<string, { http: number | null; category: string | null }>;
}
const labels: Record<string, string> = { orders: 'Pedidos', charges: 'Cobranças', hooks: 'Webhooks', links: 'Links de pagamento' };

export function Connectivity({ merchant, env, csrf, needsAccount, onVerified }: {
  merchant: string; env: Environment; csrf: string; needsAccount: boolean; onVerified: () => void;
}) {
  const [report, setReport] = useState<Report>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [eventId, setEventId] = useState('');
  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(merchantPath('/admin/gateway/' + env + '/verify-account', merchant), {
        method: 'POST', csrf, body: { eventId }
      });
      onVerified();
    } catch (failure) { setError(explain(failure)); }
    finally { setBusy(false); }
  }
  async function inspect() {
    setBusy(true);
    setError('');
    setReport(undefined);
    try {
      setReport(await api<Report>(merchantPath('/admin/gateway/' + env + '/connectivity', merchant), {
        method: 'POST', csrf, body: {}
      }));
    } catch (failure) { setError(explain(failure)); }
    finally { setBusy(false); }
  }
  return <section className="card-settings">
    <h3>Conectividade com a Pagar.me</h3>
    <button className="button secondary" type="button" disabled={busy} onClick={() => void inspect()}>
      {busy ? 'Consultando…' : 'Diagnosticar conexão e IP de saída'}
    </button>
    {needsAccount && <form onSubmit={verify}>
      <p>Se a listagem de webhooks estiver vazia, use uma referência de evento `hook_` da sua conta Pagar.me.</p>
      <Field label="Referência do evento Pagar.me" maxLength={105} value={eventId} required disabled={busy}
        onChange={event => setEventId(event.target.value)} />
      <button className="button secondary" disabled={busy}>Verificar vínculo da conta</button>
    </form>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {report && <>
      <dl className="gateway-facts">
        <div><dt>IPv4 observado</dt><dd>{report.observed.ipv4 ?? 'Não observado'}</dd></div>
        <div><dt>IPv6 observado</dt><dd>{report.observed.ipv6 ?? 'Não observado'}</dd></div>
        <div><dt>IPs informados pela infraestrutura</dt><dd>{report.configuredStaticIPs.join(', ') || 'Nenhum configurado'}</dd></div>
        {Object.entries(report.checks).map(([name, check]) => <div key={name}>
          <dt>{labels[name] ?? name}</dt>
          <dd>{check.http === null ? '' : 'HTTP ' + check.http + ' · '}{check.category ? providerErrorLabel(check.category) : 'Leitura respondida'}</dd>
        </div>)}
      </dl>
      {report.credential !== 'configured' && <p>{report.credential === 'missing' ? 'Cadastre a Secret Key para testar a Pagar.me.' : 'A Secret Key não pôde ser recuperada pelo servidor.'}</p>}
      <p>O IP observado vale para o serviço de consulta. Se a conta usar IP Allowlist, confirme os IPs fixos provisionados e a rota até a Pagar.me. Um 401 ou 403 genérico não confirma bloqueio por IP.</p>
    </>}
  </section>;
}
