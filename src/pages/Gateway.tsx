import { useEffect, useState } from 'react';
import { Activity, CircleDot, KeyRound, Power, RefreshCw, Unlink } from 'lucide-react';
import { pagarmeKeyEnvironment } from '../../shared/validation.mjs';
import { Field, Loader } from '../components/UI';
import { ApiError, api, dateTime, envLabel, explain, providerErrorLabel, type Environment, type Gateway as GatewayState, type Product } from '../services/api';

type Action = 'add' | 'replace' | 'test' | 'activate' | 'disable' | 'disconnect' | 'cards';
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
  const [cardSettings, setCardSettings] = useState({
    publicKey: '', creditEnabled: true, debitEnabled: false, debitAuthorizationReference: '',
    creditRequires3ds: true, debitRequires3ds: true
  });
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<Action | 'loading' | ''>('loading');
  const [pending, setPending] = useState<Pending | ''>('');
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState({ error: false, text: '' });
  const path = '/admin/gateway/' + env;
  const gateway = configuration?.environment === env ? configuration : undefined;
  useEffect(() => {
    if (!gateway) return;
    setCardSettings({
      publicKey: gateway.publicKey ?? '', creditEnabled: gateway.creditEnabled, debitEnabled: gateway.debitEnabled,
      debitAuthorizationReference: gateway.debitAuthorizationReference ?? '',
      creditRequires3ds: gateway.creditRequires3ds, debitRequires3ds: gateway.debitRequires3ds
    });
  }, [gateway]);

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
    const body = keyAction ? { secret: key } : action === 'cards' ? cardSettings : { confirmed };
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
        cards: 'Configurações de cartão salvas.',
        test: [result.message, result.threeDS === true ? 'Conexão com 3DS confirmada.' : result.threeDS === false ? '3DS indisponível para esta credencial.' : ''].filter(Boolean).join(' '),
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
        <div><dt>Leitura de pedidos</dt><dd>{gateway.checkoutReadable === null ? 'A verificar' : gateway.checkoutReadable ? 'Confirmada' : 'Acesso recusado'}</dd></div>
        <div><dt>Processamento</dt><dd>{gateway.activationBlock ? 'Bloqueado no servidor' : gateway.enabled ? 'Ativado' : 'Desativado'}</dd></div>
        <div><dt>Última atualização</dt><dd>{dateTime(gateway.updatedAt)}</dd></div>
        <div><dt>Último teste</dt><dd>{dateTime(gateway.testedAt)}</dd></div>
        <div><dt>HTTP do teste de leitura</dt><dd>{gateway.http ?? '—'}</dd></div>
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
        <button className="button secondary" type="button" disabled={!!busy || !gateway.connected || !gateway.publicKey || gateway.enabled || Boolean(gateway.activationBlock)} onClick={() => { setPending('activate'); setConfirmed(false); }}><Power size={17} /> ATIVAR GATEWAY</button>
        <button className="button secondary" type="button" disabled={!!busy || !gateway.enabled} onClick={() => void act('disable')}><Power size={17} /> DESATIVAR GATEWAY</button>
        <button className="button danger" type="button" disabled={!!busy || !gateway.hasKey} onClick={() => { setPending('disconnect'); setConfirmed(false); }}><Unlink size={17} /> DESCONECTAR CHAVE</button>
      </div>}
    </form>
    {gateway?.hasKey && <form className="card-settings" onSubmit={event => { event.preventDefault(); void act('cards'); }}>
      <h3>Modalidades e autenticação</h3>
      <Field label="Chave pública (PK) da conta" value={cardSettings.publicKey} autoComplete="off" required disabled={!!busy}
        onChange={event => setCardSettings({ ...cardSettings, publicKey: event.target.value })} />
      <div className="fields two">
        <label><input type="checkbox" disabled={!!busy} checked={cardSettings.creditEnabled}
          onChange={event => setCardSettings({ ...cardSettings, creditEnabled: event.target.checked })} /> Ativar cartão de crédito</label>
        <label><input type="checkbox" disabled={!!busy || !gateway.debitApprovalConfigured} checked={cardSettings.debitEnabled}
          onChange={event => setCardSettings({ ...cardSettings, debitEnabled: event.target.checked })} /> Ativar cartão de débito</label>
        <label><input type="checkbox" disabled={!!busy} checked={cardSettings.creditRequires3ds}
          onChange={event => setCardSettings({ ...cardSettings, creditRequires3ds: event.target.checked })} /> Exigir 3DS no crédito</label>
        <label><input type="checkbox" disabled={!!busy} checked={cardSettings.debitRequires3ds}
          onChange={event => setCardSettings({ ...cardSettings, debitRequires3ds: event.target.checked })} /> Exigir 3DS no débito</label>
      </div>
      {cardSettings.debitEnabled && <Field label="Referência da habilitação do débito pela Pagar.me e adquirente"
        required maxLength={120} value={cardSettings.debitAuthorizationReference} disabled={!!busy}
        onChange={event => setCardSettings({ ...cardSettings, debitAuthorizationReference: event.target.value })} />}
      <p className="help">Confira na Pagar.me as modalidades da conta e a exigência de 3DS antes de salvar.</p>
      <dl className="gateway-facts">
        <div><dt>Crédito no checkout</dt><dd>{gateway.enabled && !gateway.activationBlock && gateway.available.credit_card ? 'Disponível' : 'Indisponível'}</dd></div>
        <div><dt>Débito no checkout</dt><dd>{gateway.enabled && !gateway.activationBlock && gateway.available.debit_card ? 'Disponível' : 'Indisponível'}</dd></div>
      </dl>
      <button className="button secondary" disabled={!!busy || !gateway.connected}>Salvar modalidades</button>
    </form>}
    {gateway && pending && <div className="confirmation">
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> {pending === 'activate'
        ? (env === 'live' ? 'Confirmei que a conta está habilitada para cobranças diretas na Pagar.me e autorizo cobranças reais neste checkout.'
          : 'Confirmei que a conta está habilitada para cobranças diretas na Pagar.me.')
        : 'Confirmo a remoção da chave deste sistema. Revogarei a chave no painel oficial da Pagar.me.'}</label>
      <div><button className="button secondary" type="button" onClick={() => setPending('')}>Voltar</button>
        <button className={'button ' + (pending === 'disconnect' ? 'danger' : 'primary')} disabled={!confirmed || !!busy} type="button" onClick={() => void act(pending)}>{busy && <Loader />} Confirmar</button></div>
    </div>}
    {feedback.text && <p className={'notice ' + (feedback.error ? 'error' : 'success')} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
  </>;
}
