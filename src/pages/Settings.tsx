import { useEffect, useState, type FormEvent } from 'react';
import { Field, Loader } from '../components/UI';
import { api, merchantPath, brl, explain, type Environment, type Product } from '../services/api';

export function Settings({ csrf, onChange, merchant }: { merchant: string; csrf: string; onChange: () => void }) {
  const [product, setProduct] = useState<Product>();
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState({ text: '', error: false });

  useEffect(() => {
    api<Product>(merchantPath('/admin/product', merchant)).then(result => {
      setProduct(result);
      setPrice(result.amount === null ? '' : brl(result.amount));
    }).catch(error => setMessage({ text: explain(error), error: true })).finally(() => setBusy(false));
  }, [merchant]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!product || busy) return;
    setBusy(true);
    setMessage({ text: '', error: false });
    try {
      const { name, description, image, maxInstallments, enabled, environment, operation } = product;
      const updated = await api<Product>(merchantPath('/admin/product', merchant), { method: 'PUT', csrf, body: { name, description, image, maxInstallments, enabled, environment, operation, price } });
      setProduct({ ...updated, min: product.min, max: product.max });
      setPrice(brl(updated.amount!));
      setMessage({ text: 'Configuração comercial salva.', error: false });
      onChange();
    } catch (error) { setMessage({ text: explain(error), error: true }); }
    finally { setBusy(false); }
  }

  return <>
    {product ? <form onSubmit={submit}>
      <div className="fields two admin-fields">
        <Field label="Nome do produto" required maxLength={100} value={product.name} onChange={e => setProduct({ ...product, name: e.target.value })} />
        <Field label="Valor da venda" required placeholder="R$ 0,00" inputMode="decimal" maxLength={30} value={price} onChange={e => setPrice(e.target.value)} />
        <label className="field span-full">Descrição <textarea required maxLength={500} value={product.description} onChange={e => setProduct({ ...product, description: e.target.value })} /></label>
        <Field label="Caminho ou URL HTTPS da imagem" required maxLength={350} value={product.image} onChange={e => setProduct({ ...product, image: e.target.value })} />
        <Field label="Máximo de parcelas" required type="number" min={1} max={24} value={product.maxInstallments} onChange={e => setProduct({ ...product, maxInstallments: Number(e.target.value) })} />
        <label className="field">Ambiente do checkout<select value={product.environment} onChange={e => setProduct({ ...product, environment: e.target.value as Environment })}><option value="test">Sandbox</option><option value="live">Produção</option></select></label>
        <label className="field">Modo de captura<select value={product.operation} onChange={e => setProduct({ ...product, operation: e.target.value as Product['operation'] })}><option value="auth_and_capture">Autorização e captura</option><option value="auth_only">Captura manual</option></select></label>
      </div>
      {product.min != null && product.max != null && <p className="help">Faixa configurada pelo lojista de {brl(product.min)} a {brl(product.max)}.</p>}
      <label className="checkbox"><input type="checkbox" checked={product.enabled} onChange={e => setProduct({ ...product, enabled: e.target.checked })} /> Produto disponível para venda</label>
      <button className="button primary" disabled={busy}>{busy && <Loader />} SALVAR CONFIGURAÇÃO</button>
    </form> : busy && <p><Loader /> Carregando produto</p>}
    {message.text && <p className={'notice ' + (message.error ? 'error' : 'success')} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
  </>;
}
