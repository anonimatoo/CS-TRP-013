import { useEffect, useState } from 'react';
import { Activity, CircleDot, KeyRound, Power, RefreshCw, Unlink } from 'lucide-react';
import { pagarmeKeyEnvironment } from '../../shared/validation.mjs';
import { Field, Loader } from '../components/UI';
import { ApiError, api, dateTime, envLabel, explain, type Environment, type Gateway as GatewayState } from '../services/api';

type Action = 'add' | 'replace' | 'configure' | 'test' | 'activate' | 'disable' | 'disconnect';
type Pending = 'activate' | 'disconnect';

interface Props {
  csrf: string;
  env: Environment;
  onEnvironmentChange: (env: Environment) => void;
  onChange: () => void;
  onExpired: () => void;
}

export function Gateway({ csrf, env, onEnvironmentChange, onChange, onExpired }: Props) {
  const [configuration, setConfiguration] = useState<GatewayState>();
  const [retry, setRetry] = useState(0);
  const [key, setKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [account, setAccount] = useState('');
  const [mode, setMode] = useState<'gateway' | 'psp'>('gateway');
  const [busy, setBusy] = useState<Action | 'loading' | ''>('loading');
  const [pending, setPending] = useState<Pending | ''>('');
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState({ error: false, text: '' });
  const path = '/admin/gateway/' + env;
  const gateway = configuration?.environment === env ? configuration : undefined;
  const detected = pagarmeKeyEnvironment(key, 'sk');
  const changing = busy !== '' && busy !== 'loading';

  useEffect(() => {
    let current = true;
    setBusy('loading');
    setFeedback({ error: false, text: '' });
    setPending('');
    setConfirmed(false);
    api<GatewayState>(path).then(result => {
      if (current) apply(result);
    }).catch(error => {
      if (!current) return;
      setConfiguration(undefined);
      if (error instanceof ApiError && error.status === 401) onExpired();
      else setFeedback({ error: true, text: explain(error) });
    }).finally(() => {
      if (current) setBusy('');
    });
    return () => { current = false; };
  }, [path, retry]);

  function editKey(value: string) {
    setKey(value);
    const detectedEnvironment = pagarmeKeyEnvironment(value, 'sk');
    if (detectedEnvironment && detectedEnvironment !== env) onEnvironmentChange(detectedEnvironment);
  }

  function apply(result: GatewayState) {
    setConfiguration(result);
    setPublicKey(result.publicKey ?? '');
    setAccount(result.account ?? '');
    setMode(result.mode ?? 'gateway');
  }

  async function act(action: Action) {
    if (busy || !gateway) return;
    const keyAction = action === 'add' || action === 'replace';
    if (keyAction && detected !== env) {
      setFeedback({ error: true, text: 'Informe uma Secret Key (SK) válida.' });
      return;
    }
    setBusy(action);
    setFeedback({ error: false, text: '' });
    const body = keyAction ? { secret: key }
      : action === 'configure' ? { publicKey, account, mode } : { confirmed };
    if (keyAction) setKey('');
    try {
      const result = await api<GatewayState>(path + '/' + action, { method: 'POST', csrf, body });
      apply(result);
      onChange();
      setPending('');
      setConfirmed(false);
      const messages: Record<Action, string> = {
        add: result.checkoutConfigured ? 'Secret Key cadastrada e validada.' : 'Secret Key cadastrada e validada. Configure a tokenização para receber pagamentos.',
        configure: 'Configuração de tokenização salva.',
        replace: 'Chave substituída. Revogue a chave anterior no painel oficial da Pagar.me.',
        test: result.message ?? '',
        activate: 'Gateway ativado.',
        disable: 'Gateway desativado. A consulta a transações anteriores continua disponível.',
        disconnect: 'Credencial removida. Para revogá-la definitivamente, acesse o painel oficial da Pagar.me.'
      };
      setFeedback({ error: action === 'test' && !result.connected, text: messages[action] });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setFeedback({ error: true, text: explain(failure) +
        (failure instanceof ApiError && failure.http ? ' HTTP ' + failure.http + '.' : '') });
    } finally { setBusy(''); }
  }

  const inCheck = busy === 'loading' || busy === 'test' || busy === 'add' || busy === 'replace' || busy === 'configure';
  const tone = inCheck ? 'blue' : !gateway?.hasKey ? 'gray' : gateway.connected === false ? 'red' : gateway.enabled ? 'green' : 'yellow';
  const flag = inCheck ? 'Conexão em verificação' : !gateway?.hasKey ? 'Chave não cadastrada' : gateway.connected === false
    ? ([401,403].includes(gateway.http ?? 0) ? 'Autenticação recusada' : 'Falha no teste') : gateway.enabled ? 'Conectado e ativado' : gateway.checkoutConfigured ? 'Gateway desativado' : 'Secret Key cadastrada';

  return <>
    <label className="field env-field">Ambiente
      <select value={env} disabled={changing} onChange={event => {
        setKey('');
        onEnvironmentChange(event.target.value as Environment);
      }}>
        <option value="test">Sandbox</option><option value="live">Produção</option>
      </select>
    </label>
    <div className="gateway-status">
      <span className={'status-pill ' + tone}>{inCheck ? <Loader /> : <CircleDot size={15} />}{flag}</span>
      <span className="status-environment">{envLabel(env)}</span>
    </div>
    {gateway ? <>
      <dl className="gateway-facts">
        <div><dt>Chave cadastrada</dt><dd>{gateway.hasKey ? 'Sim' : 'Não'}</dd></div>
        <div><dt>Conexão com a Pagar.me</dt><dd>{gateway.connected === null ? 'A testar' : gateway.connected ? 'Leitura validada' : 'Falha no teste'}</dd></div>
        <div><dt>Processamento</dt><dd>{gateway.enabled ? 'Ativado' : gateway.checkoutConfigured ? 'Desativado' : 'Aguardando tokenização'}</dd></div>
        <div><dt>Última atualização</dt><dd>{dateTime(gateway.updatedAt)}</dd></div>
        <div><dt>Último teste</dt><dd>{dateTime(gateway.testedAt)}</dd></div>
        <div><dt>HTTP do provedor</dt><dd>{gateway.http ?? '—'}</dd></div>
      </dl>
      {gateway.message && <p className="notice info">{gateway.message}</p>}
    </> : busy ? <p><Loader /> Consultando configuração</p> : <button className="button secondary" onClick={() => setRetry(value => value + 1)}>Recarregar</button>}
    <form onSubmit={event => { event.preventDefault(); if (gateway) void act(gateway.hasKey ? 'replace' : 'add'); }}>
      <div className="fields admin-fields">
        <Field label="Nova Secret Key (SK)" icon={KeyRound} type="password" autoComplete="off" name="gateway-secret" placeholder="sk_… ou sk_test_…" disabled={changing}
          value={key} onChange={e => editKey(e.target.value)} maxLength={140} spellCheck={false} />
        <p className="help" aria-live="polite">{detected && 'Ambiente identificado: ' + envLabel(detected) + '.'}</p>
      </div>
      {gateway && <div className="gateway-actions">
        <button className="button primary" type={gateway.hasKey ? 'button' : 'submit'} disabled={!!busy || gateway.hasKey}><KeyRound size={17} /> ADICIONAR CHAVE</button>
        <button className="button dark" type="button" disabled={!!busy || !gateway.hasKey} onClick={() => void act('test')}><Activity size={17} /> TESTAR CONEXÃO</button>
        <button className="button secondary" type={gateway.hasKey ? 'submit' : 'button'} disabled={!!busy || !gateway.hasKey}><RefreshCw size={17} /> SUBSTITUIR CHAVE SK</button>
        <button className="button secondary" type="button" disabled={!!busy || !gateway.connected || !gateway.checkoutConfigured || gateway.enabled} onClick={() => { setPending('activate'); setConfirmed(false); }}><Power size={17} /> ATIVAR GATEWAY</button>
        <button className="button secondary" type="button" disabled={!!busy || !gateway.enabled} onClick={() => void act('disable')}><Power size={17} /> DESATIVAR GATEWAY</button>
        <button className="button danger" type="button" disabled={!!busy || !gateway.hasKey} onClick={() => { setPending('disconnect'); setConfirmed(false); }}><Unlink size={17} /> DESCONECTAR CHAVE</button>
      </div>}
    </form>
    {gateway?.hasKey && <details className="gateway-checkout-settings">
      <summary>Configuração da tokenização</summary>
      <p className="help">O checkout de cartão usa a chave pública da Pagar.me. Esta configuração é feita separadamente e pode ser reaproveitada ao trocar a SK.</p>
      <form onSubmit={event => { event.preventDefault(); void act('configure'); }}>
        <div className="fields two admin-fields">
          <Field label="Chave pública para tokenização" required autoComplete="off" placeholder={env === 'test' ? 'pk_test_…' : 'pk_…'}
            value={publicKey} onChange={e => setPublicKey(e.target.value)} maxLength={140} spellCheck={false} />
          <Field label="Identificador da conta Pagar.me" required placeholder="acc_…" value={account} onChange={e => setAccount(e.target.value)} maxLength={104} spellCheck={false} />
          <label className="field">Modalidade da conta<select value={mode} onChange={e => setMode(e.target.value as 'gateway' | 'psp')}><option value="gateway">Gateway</option><option value="psp">PSP</option></select></label>
        </div>
        <button className="button secondary" type="submit" disabled={!!busy}>SALVAR TOKENIZAÇÃO</button>
      </form>
    </details>}
    {gateway && pending && <div className="confirmation">
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> {pending === 'activate'
        ? 'Confirmei as permissões de escrita e que a chave pública pertence à conta no painel da Pagar.me.'
        : 'Confirmo a remoção da chave deste sistema. Revogarei a chave no painel oficial da Pagar.me.'}</label>
      <div><button className="button secondary" type="button" onClick={() => setPending('')}>Voltar</button>
        <button className={'button ' + (pending === 'disconnect' ? 'danger' : 'primary')} disabled={!confirmed || !!busy} type="button" onClick={() => void act(pending)}>{busy && <Loader />} Confirmar</button></div>
    </div>}
    {feedback.text && <p className={'notice ' + (feedback.error ? 'error' : 'success')} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
  </>;
}
