import { useEffect, useState } from 'react';
import { Field } from '../components/UI';
import { api, brl, dateTime, explain, merchantPath, providerErrorLabel, type Environment, type Receipt } from '../services/api';

type Link = Receipt & { name: string };
const statusLabels: Record<string, string> = {
  pending: 'Pendente', processing: 'Processando', request_failed: 'Criação recusada', communication_error: 'A conciliar',
  paid: 'Pago', captured: 'Capturado', canceled: 'Cancelado', expired: 'Expirado', declined: 'Recusado', refunded: 'Estornado'
};

export function Links({ merchant, csrf }: { merchant: string; csrf: string }) {
  const [env, setEnv] = useState<Environment>('test');
  const [links, setLinks] = useState<Link[]>([]);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [installments, setInstallments] = useState(1);
  const [id, setId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = '/admin/links/' + env;
  useEffect(() => {
    let current = true;
    setLinks([]);
    setError('');
    api<Link[]>(merchantPath(base, merchant)).then(rows => { if (current) setLinks(rows); })
      .catch(failure => { if (current) setError(explain(failure)); });
    return () => { current = false; };
  }, [base, merchant, busy]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const requestId = id ?? crypto.randomUUID();
    setId(requestId);
    setBusy(true);
    setError('');
    try {
      const result = await api<Link>(merchantPath(base, merchant), {
        method: 'POST', csrf, body: { id: requestId, name, price, installments }
      });
      if (result.checkoutUrl || result.newPurchaseAllowed) setId(undefined);
      if (result.checkoutUrl) { setName(''); setPrice(''); setInstallments(1); }
    } catch (failure) { setError(explain(failure)); }
    finally { setBusy(false); }
  }

  async function refresh(id: string) {
    setBusy(true);
    setError('');
    try { await api(merchantPath(base + '/' + id + '/refresh', merchant), { method: 'POST', csrf, body: {} }); }
    catch (failure) { setError(explain(failure)); }
    finally { setBusy(false); }
  }

  return <section className="card-settings">
    <h3>Links de pagamento</h3>
    <p>Gere links de cartão de crédito com valor em reais. Cada link aceita um pagamento e expira em até 30 minutos.</p>
    <form onSubmit={create}>
      <label className="field">Ambiente do link
        <select value={env} disabled={busy} onChange={event => { setEnv(event.target.value as Environment); setId(undefined); }}>
          <option value="test">Sandbox</option><option value="live">Produção</option>
        </select>
      </label>
      <Field label="Descrição do pagamento" required maxLength={100} value={name} disabled={busy}
        onChange={event => { setName(event.target.value); setId(undefined); }} />
      <Field label="Valor em reais" required maxLength={30} value={price} disabled={busy}
        onChange={event => { setPrice(event.target.value); setId(undefined); }} />
      <label className="field">Parcelas
        <input type="number" min={1} max={24} required value={installments} disabled={busy}
          onChange={event => { setInstallments(event.target.valueAsNumber); setId(undefined); }} />
      </label>
      <button className="button primary" disabled={busy}>Criar link de pagamento</button>
    </form>
    {error && <p className="notice error" role="alert">{error}</p>}
    <h4>Links recentes</h4>
    {!links.length && <p>Nenhum link neste ambiente.</p>}
    <ul>{links.map(link => <li key={link.id}>
      <strong>{link.name}</strong> · {brl(link.amount)} · {link.installments}x · {statusLabels[link.status] ?? link.status}
      {link.checkoutError && <> · {providerErrorLabel(link.checkoutError)}{link.http && ' · HTTP ' + link.http}</>}
      {link.checkoutUrl && <> · <a href={link.checkoutUrl} target="_blank" rel="noreferrer">Abrir checkout</a>
        {' · '}<button type="button" className="text-button" onClick={() => {
          navigator.clipboard.writeText(new URL(link.checkoutUrl!, location.origin).href)
            .catch(() => setError('Não foi possível copiar. Use o endereço do link Abrir checkout.'));
        }}>Copiar link</button> · Expira em {dateTime(link.checkoutExpiresAt)}</>}
      {' · '}<button type="button" className="text-button" disabled={busy} onClick={() => void refresh(link.id)}>Consultar status</button>
    </li>)}</ul>
  </section>;
}
