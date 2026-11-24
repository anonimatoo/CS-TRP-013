import { useEffect, useState } from 'react';
import { Activity, CircleDot, KeyRound, Power, RefreshCw, Unlink } from 'lucide-react';
import { pagarmeKeyEnvironment } from '../../shared/validation.mjs';
import { Field, Loader } from '../components/UI';
import { ApiError, api, dateTime, envLabel, explain, providerErrorLabel, type Environment, type Gateway as GatewayState, type Product } from '../services/api';

type Action = 'add' | 'replace' | 'test' | 'activate' | 'disable' | 'disconnect';
type Pending = 'activate' | 'disconnect';

interface Props {
  csrf: string;
  env: Environment;
  product: Product | null;
  onCommercialSettings: () => void;
  onEnvironmentChange: (env: Environment) => void;
  onChange: () => void;
  onExpired: () => void;
}

export function Gateway({ csrf, env, product, onCommercialSettings, onEnvironmentChange, onChange, onExpired }: Props) {
  const [configuration, setConfiguration] = useState<GatewayState>();
  const [retry, setRetry] = useState(0);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<Action | 'loading' | ''>('loading');
  const [pending, setPending] = useState<Pending | ''>('');
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState({ error: false, text: '' });
  const path = '/admin/gateway/' + env;
  const gateway = configuration?.environment === env ? configuration : undefined;
  const detected = pagarmeKeyEnvironment(key);
  const changing = busy !== '' && busy !== 'loading';

  useEffect(() => {
    let current = true;
    setBusy('loading');
    setFeedback({ error: false, text: '' });
    setPending('');
    setConfirmed(false);
    api<GatewayState>(path).then(result => {
      if (current) setConfiguration(result);
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
    const detectedEnvironment = pagarmeKeyEnvironment(value);
    if (detectedEnvironment && detectedEnvironment !== env) onEnvironmentChange(detectedEnvironment);
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
    const body = keyAction ? { secret: key } : { confirmed };
    if (keyAction) setKey('');
    try {
      const result = await api<GatewayState>(path + '/' + action, { method: 'POST', csrf, body });
      setConfiguration(result);
      onChange();
      setPending('');
      setConfirmed(false);
      const messages: Record<Action, string> = {
        add: 'Secret Key cadastrada e validada.',
        replace: 'Chave substituída. Revogue a chave anterior no painel oficial da Pagar.me.',
        test: result.message ?? '',
        activate: 'Gateway ativado para novas vendas.',
        disable: 'Gateway desativado. A consulta a transações anteriores continua disponível.',
        disconnect: 'Credencial removida. Para revogá-la definitivamente, acesse o painel oficial da Pagar.me.'
      };
      setFeedback({ error: action === 'test' && !result.connected, text: messages[action] });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setFeedback({ error: true, text: explain(failure) +
        (failure instanceof ApiError && failure.http ? ' HTTP ' + failure.http + '.' : '') +
        (failure instanceof ApiError && failure.category ? ' ' + providerErrorLabel(failure.category) + '.' : '') });
    } finally { setBusy(''); }
  }

  const inCheck = busy === 'loading' || busy === 'test' || busy === 'add' || busy === 'replace';
  const tone = inCheck ? 'blue' : !gateway?.hasKey ? 'gray' : gateway.connected === false ? 'red' : gateway.enabled && !gateway.activationBlock ? 'green' : 'yellow';
  const flag = inCheck ? 'Conexão em verificação' : !gateway?.hasKey ? 'Chave não cadastrada' : gateway.connected === false
    ? (gateway.readError ? providerErrorLabel(gateway.readError) : 'Falha no teste') : gateway.activationBlock ? 'Produção bloqueada' : gateway.enabled ? 'Conectado e ativado' : 'Gateway desativado';

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
        <div><dt>Autenticação</dt><dd>{gateway.authenticated === null ? 'A verificar' : gateway.authenticated ? 'Confirmada' : 'Recusada'}</dd></div>
        <div><dt>Leitura do checkout</dt><dd>{gateway.checkoutReadable === null ? 'A verificar' : gateway.checkoutReadable ? 'Confirmada' : 'Acesso recusado'}</dd></div>
        <div><dt>Criação de checkout</dt><dd>{gateway.checkoutCreationVerifiedAt ? 'Confirmada em ' + dateTime(gateway.checkoutCreationVerifiedAt) : 'A comprovar na criação de um link'}</dd></div>
        <div><dt>Processamento</dt><dd>{gateway.activationBlock ? 'Bloqueado no servidor' : gateway.enabled ? 'Ativado' : 'Desativado'}</dd></div>
        <div><dt>Última atualização</dt><dd>{dateTime(gateway.updatedAt)}</dd></div>
        <div><dt>Último teste</dt><dd>{dateTime(gateway.testedAt)}</dd></div>
        <div><dt>HTTP do teste de leitura</dt><dd>{gateway.http ?? '—'}</dd></div>
        <div><dt>Última tentativa de criar link</dt><dd>{dateTime(gateway.checkoutAttemptedAt)}</dd></div>
        <div><dt>HTTP da criação</dt><dd>{gateway.checkoutHttp ?? '—'}</dd></div>
        <div><dt>Falha na última criação</dt><dd>{providerErrorLabel(gateway.checkoutError)}</dd></div>
      </dl>
      {gateway.message && <p className="notice info">{gateway.message}</p>}
      {gateway.activationBlock && <p className="notice info">{gateway.activationBlock}</p>}
      {!gateway.activationBlock && gateway.connected && !gateway.enabled && <p className="notice info">Para liberar o pagamento em {envLabel(env)}, use <strong>ATIVAR GATEWAY</strong> e confirme.</p>}
      {product && (product.environment !== env || !product.enabled || !product.amount) && <div className="notice info">
        {product.environment !== env && <p>O checkout usa <strong>{envLabel(product.environment)}</strong>. Selecione {envLabel(env)} em <strong>Ambiente do checkout</strong> para usar este gateway na venda.</p>}
        {!product.amount && <p>Informe o valor da venda.</p>}
        {!product.enabled && <p>Marque <strong>Produto disponível para venda</strong>.</p>}
        <button className="text-button" type="button" onClick={onCommercialSettings}>Abrir configuração comercial</button>
      </div>}
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
        <button className="button secondary" type="button" disabled={!!busy || !gateway.connected || gateway.enabled || Boolean(gateway.activationBlock)} onClick={() => { setPending('activate'); setConfirmed(false); }}><Power size={17} /> ATIVAR GATEWAY</button>
        <button className="button secondary" type="button" disabled={!!busy || !gateway.enabled} onClick={() => void act('disable')}><Power size={17} /> DESATIVAR GATEWAY</button>
        <button className="button danger" type="button" disabled={!!busy || !gateway.hasKey} onClick={() => { setPending('disconnect'); setConfirmed(false); }}><Unlink size={17} /> DESCONECTAR CHAVE</button>
      </div>}
    </form>
    {gateway && pending && <div className="confirmation">
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> {pending === 'activate'
        ? (env === 'live' ? 'Confirmei que a Secret Key pode criar links de pagamento na Pagar.me e autorizo cobranças reais neste checkout.'
          : 'Confirmei que a Secret Key pode criar links de pagamento na Pagar.me.')
        : 'Confirmo a remoção da chave deste sistema. Revogarei a chave no painel oficial da Pagar.me.'}</label>
      <div><button className="button secondary" type="button" onClick={() => setPending('')}>Voltar</button>
        <button className={'button ' + (pending === 'disconnect' ? 'danger' : 'primary')} disabled={!confirmed || !!busy} type="button" onClick={() => void act(pending)}>{busy && <Loader />} Confirmar</button></div>
    </div>}
    {feedback.text && <p className={'notice ' + (feedback.error ? 'error' : 'success')} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
  </>;
}
