import { useState } from 'react';
import { Activity } from 'lucide-react';
import { api, dateTime, envLabel, explain, merchantPath, providerErrorLabel, type Environment } from '../services/api';

type Mode = 'authenticated' | 'pinless' | 'unknown';
type Check = { permission: 'confirmed' | 'denied' | 'unknown'; http: number | null; category: string | null };
interface Diagnosis {
  checkedAt: string;
  credentialEnvironment: Environment | null;
  account: { id: string | null; name: string | null; source: 'webhook' | 'linked' | 'unknown' | 'conflict'; model: 'Gateway' | 'PSP' | null };
  mode: Mode;
  checks: Partial<Record<'orders' | 'charges' | 'hooks' | 'threeDS', Check>>;
  blocks: string[];
  history: {
    state: 'sample' | 'unavailable' | 'account_conflict';
    inspected: number;
    limit: number;
    records: { id: string; status: string; createdAt: string | null; acquirer: string | null; mode: Mode }[];
  };
}

const modes: Record<Mode, string> = { authenticated: 'Autenticado (3DS)', pinless: 'Pinless (sem 3DS)', unknown: 'Não identificada' };
const statuses: Record<string, string> = {
  paid: 'Pago', captured: 'Capturado', declined: 'Recusado', authorized: 'Autorizado',
  review: 'Em análise', processing: 'Em processamento', pending: 'Pendente', refunded: 'Estornado',
  canceled: 'Cancelado', chargedback: 'Chargeback'
};
const checkLabels = { orders: 'Leitura de pedidos', charges: 'Leitura de cobranças', hooks: 'Leitura de webhooks', threeDS: 'Token 3DS Stone' } as const;

export function DebitDiagnostics({ csrf, merchant, env, disabled }: {
  csrf: string; merchant: string; env: Environment; disabled: boolean;
}) {
  const [report, setReport] = useState<Diagnosis>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    setReport(undefined);
    setError('');
    setBusy(true);
    try {
      setReport(await api<Diagnosis>(merchantPath('/admin/gateway/' + env + '/debit-diagnostics', merchant),
        { method: 'POST', csrf, body: {} }));
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  }

  return <section className="card-settings" aria-label="Diagnóstico de cartão de débito">
    <h3>Diagnóstico de cartão de débito</h3>
    <p>Consulte a credencial de {envLabel(env)}, as permissões observadas e uma amostra do histórico. A consulta não cria pedidos nem cobranças.</p>
    <button className="button secondary" type="button" disabled={disabled || busy} onClick={() => void run()}>
      <Activity size={17} /> {busy ? 'Consultando…' : 'Executar diagnóstico'}
    </button>
    {error && <p className="notice error" role="alert">{error}</p>}
    {report && <>
      <dl className="gateway-facts">
        <div><dt>Consulta</dt><dd>{dateTime(report.checkedAt)}</dd></div>
        <div><dt>Ambiente pela chave</dt><dd>{report.credentialEnvironment ? envLabel(report.credentialEnvironment) : 'Não identificado'}</dd></div>
        <div><dt>Conta Pagar.me</dt><dd>{report.account.id ?? (report.account.source === 'conflict' ? 'Vínculo divergente' : 'Não identificada')}
          {report.account.name && <> · {report.account.name}</>}
          {report.account.source === 'linked' && <> · Vínculo registrado</>}
          {report.account.source === 'webhook' && <> · Identificada nos webhooks</>}
        </dd></div>
        <div><dt>Modelo da conta</dt><dd>{report.account.model ? report.account.model + ' · Cadastro local' : 'Gateway ou PSP não informado pela API consultada'}</dd></div>
        <div><dt>Modalidade configurada</dt><dd>{modes[report.mode]}</dd></div>
        <div><dt>Habilitação comercial na Pagar.me</dt><dd>Requer confirmação com o provedor</dd></div>
        {Object.entries(checkLabels).map(([name, label]) => {
          const check = report.checks[name as keyof Diagnosis['checks']];
          return <div key={name}><dt>{label}</dt><dd>
            {check?.permission === 'confirmed' ? name === 'threeDS' ? 'Token emitido' : 'Acesso confirmado'
              : check?.permission === 'denied' ? 'Acesso recusado' : check ? 'Inconclusivo' : 'Não consultado'}
            {check?.http != null && ' · HTTP ' + check.http}
            {check?.category && ' · ' + (check.category === 'provider_3ds_unavailable'
              ? 'Falha na consulta 3DS Stone' : providerErrorLabel(check.category))}
          </dd></div>;
        })}
      </dl>
      <h4>Requisitos e bloqueios</h4>
      <p>A V5 documenta essas modalidades para clientes Gateway. Débito autenticado exige habilitação na Pagar.me e na adquirente, além da autenticação do portador. Pinless exige habilitação na Pagar.me e acordos com emissores e bandeiras.</p>
      <p>HTTP 200 confirma a leitura do recurso. A emissão do token confirma acesso ao início do 3DS. A habilitação comercial e a conclusão da autenticação exigem evidências próprias.</p>
      {report.blocks.length > 0 && <ul>{report.blocks.map(block => <li key={block}>{block}</li>)}</ul>}
      <h4>Evidências anteriores</h4>
      {report.history.state === 'sample' ? <>
        <p>Foram consultadas {report.history.inspected} cobranças da primeira página, com limite de {report.history.limit}. A adquirente exibida se refere à operação observada. A modalidade é identificada quando a cobrança e a transação coincidem com o registro de autenticação deste checkout.</p>
        {report.history.records.length === 0 ? <p>A amostra não contém operações de débito identificáveis.</p> :
          <ul>{report.history.records.map(record => <li key={record.id}>
            <code>{record.id}</code> · {dateTime(record.createdAt)} · {statuses[record.status] ?? record.status} · {modes[record.mode]} · {record.acquirer ?? 'Adquirente não informada'}
          </li>)}</ul>}
      </> : <p>Histórico indisponível nesta consulta. Verifique a leitura de cobranças e o vínculo da conta.</p>}
    </>}
  </section>;
}
