import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BadgeCheck, Barcode, Check, CreditCard, Hash, Headset, Info, Laptop, LockKeyhole, Mail, MapPin, Phone, Search, Settings, ShieldCheck, Truck, UserRound } from 'lucide-react';
import { digits, states, validCpf } from '../../shared/validation.mjs';
import { ApiError, api, brl, explain, statusLabel, type Product, type Receipt } from '../services/api';
import { Field, Loader, SectionHeading } from '../components/UI';

const defaultProduct = {
  amount: null, name: 'PC Gamer', description: 'Computador gamer personalizado', image: '/images/pc-gamer.webp',
  maxInstallments: 1, ready: false, environment: 'test', operation: 'auth_and_capture', enabled: false, version: 0
} satisfies Product;
const emptyBuyer = { name: '', cpf: '', email: '', phone: '', cep: '', street: '', number: '', complement: '', neighborhood: '', city: '', state: '', country: 'BR' };
const receiptKey = 'cs013.receipt';
const orderReference = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function receiptStorage(id?: string) {
  try {
    if (id === undefined) return sessionStorage.getItem(receiptKey) ?? '';
    if (id) sessionStorage.setItem(receiptKey, id);
    else sessionStorage.removeItem(receiptKey);
  } catch {
    return '';
  }
  return '';
}

function currentReceipt() {
  const returned = new URLSearchParams(window.location.search).get('pedido');
  if (returned && orderReference.test(returned)) {
    receiptStorage(returned);
    return returned;
  }
  return receiptStorage();
}

function mask(value: string, template: string) {
  let out = '';
  let index = 0;
  for (const char of template) {
    if (index === value.length) break;
    if (char === '#') out += value[index++];
    else out += char;
  }
  return out;
}

function installmentsLabel(amount: number, parts: number) {
  const base = Math.floor(amount / parts);
  const larger = amount % parts;
  if (!larger) return parts + '× de ' + brl(base);
  return (parts - larger) + '× de ' + brl(base) + ' + ' + larger + '× de ' + brl(base + 1);
}

export function Checkout({ onAdmin, product, loadError, refresh }: {
  onAdmin: () => void; product: Product | null; loadError: string; refresh: () => void;
}) {
  const shop = product ?? defaultProduct;
  const [buyer, setBuyer] = useState(emptyBuyer);
  const [installments, setInstallments] = useState(1);
  const [lookup, setLookup] = useState({ busy: false, message: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [lastId, setLastId] = useState(currentReceipt);
  const addressRequest = useRef(0);
  const inFlight = useRef(false);
  const chargeStarted = useRef(false);
  const count = shop.amount ? Math.min(shop.maxInstallments, shop.amount) : 1;
  const incomplete = ['processing','communication_error','pending','review','authorized','created'].includes(receipt?.status ?? '');
  const saved = Boolean(lastId);

  useEffect(() => { setInstallments(1); }, [shop.version]);
  useEffect(() => {
    if (!lastId || busy) return;
    let active = true;
    const sync = () => api<Receipt>('/orders/' + lastId).then(result => {
      if (active) setReceipt(result);
    }).catch(() => {});
    if (!receipt) void sync();
    const id = window.setInterval(() => { if (!receipt || incomplete) void sync(); }, 6500);
    return () => { active = false; window.clearInterval(id); };
  }, [lastId, busy, receipt, incomplete]);

  const field = (key: keyof typeof buyer, transform = (value: string) => value) => ({
    value: buyer[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setBuyer({ ...buyer, [key]: transform(event.target.value) })
  });

  async function searchCep(value = buyer.cep) {
    const cep = digits(value);
    const seq = ++addressRequest.current;
    if (cep.length !== 8) { setLookup({ busy: false, message: 'Informe um CEP com 8 dígitos.' }); return; }
    setLookup({ busy: true, message: '' });
    try {
      const data = await api<Pick<typeof buyer, 'street' | 'neighborhood' | 'city' | 'state'>>('/cep/' + cep);
      if (seq !== addressRequest.current) return;
      setBuyer(current => ({ ...current, ...Object.fromEntries(Object.entries(data).filter(([, text]) => text)) }));
      setLookup({ busy: false, message: 'Endereço consultado. Confira os dados.' });
    } catch (failure) {
      if (seq === addressRequest.current) setLookup({ busy: false, message: explain(failure) });
    }
  }

  function newPurchase() {
    receiptStorage('');
    const url = new URL(window.location.href);
    if (url.searchParams.has('pedido')) {
      url.searchParams.delete('pedido');
      window.history.replaceState(null, '', url);
    }
    setLastId('');
    setReceipt(null);
    setError('');
    chargeStarted.current = false;
  }

  async function pay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shop.ready || shop.gatewayVersion === undefined || saved || inFlight.current || chargeStarted.current) return;
    setError('');
    if (buyer.name.trim().split(/\s+/).length < 2) { setError('Informe o nome completo.'); return; }
    if (!validCpf(buyer.cpf)) { setError('Informe um CPF válido.'); return; }
    if (!/^[1-9][0-9]9\d{8}$/.test(digits(buyer.phone))) { setError('Informe um celular com DDD.'); return; }
    if (digits(buyer.cep).length !== 8) { setError('Informe um CEP com 8 dígitos.'); return; }
    inFlight.current = true;
    setBusy(true);
    let id = '';
    try {
      id = crypto.randomUUID();
      receiptStorage(id);
      setLastId(id);
      chargeStarted.current = true;
      const result = await api<Receipt>('/orders', { method: 'POST', body: {
        id, version: shop.version, gatewayVersion: shop.gatewayVersion, installments, buyer
      } });
      setReceipt(result);
      if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
    } catch (failure) {
      if (id && failure instanceof ApiError && failure.safeToRetry) {
        newPurchase();
        if (failure.status === 409 || failure.status === 503) refresh();
        setError(explain(failure));
      } else if (id) {
        setError('Confirmação pendente. Guarde a referência e acompanhe a situação deste pedido.');
      } else setError(explain(failure));
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  return <>
    <header className="topbar">
      <div className="header-inner">
        <div className="brand"><Laptop size={41} aria-hidden="true" /><h1>CS TRP 013</h1></div>
        <div className="header-security"><ShieldCheck size={30} aria-hidden="true" /><div><strong>Checkout seguro</strong><span>Finalize sua compra</span></div></div>
        <div className="header-benefits"><span><Truck size={26} /> Compra online</span><span><Headset size={25} /> Suporte do lojista</span><span><BadgeCheck size={25} /> Cartão de crédito</span></div>
      </div>
    </header>
    <main className="container">
      <div className="gateway-banner panel">
        <SectionHeading icon={Settings} title="Configurações de pagamento" subtitle="Gerenciamento do gateway Pagar.me / Stone" />
        <button className="button primary connect" type="button" onClick={onAdmin}>
          <LockKeyhole size={21} aria-hidden="true" /><span>CONECTAR CHAVE SK<small>PAGAR.ME / STONE</small></span>
        </button>
      </div>
      <div className="checkout-grid">
        <form className="checkout-form" onSubmit={pay}>
          <section className="panel form-panel">
            <SectionHeading icon={UserRound} title="Dados do comprador" subtitle="Informe seus dados para emissão do pedido." />
            <div className="fields two">
              <Field label="Nome completo" icon={UserRound} required autoComplete="name" maxLength={64} placeholder="Seu nome completo" {...field('name', value => value.toLocaleUpperCase('pt-BR'))} />
              <Field label="CPF" icon={Barcode} required inputMode="numeric" placeholder="000.000.000-00" {...field('cpf', value => mask(digits(value), '###.###.###-##'))} />
              <Field label="E-mail" icon={Mail} required type="email" autoComplete="email" maxLength={64} placeholder="nome@exemplo.com" {...field('email')} />
              <Field label="Celular com DDD" icon={Phone} required inputMode="tel" autoComplete="tel-national" placeholder="(00) 00000-0000" {...field('phone', value => mask(digits(value), '(##) #####-####'))} />
            </div>
          </section>
          <section className="panel form-panel">
            <SectionHeading icon={MapPin} title="Endereço de cobrança" subtitle="Informe o endereço de cobrança do cartão." />
            <div className="cep-row">
              <Field label="CEP" icon={MapPin} required inputMode="numeric" autoComplete="postal-code" placeholder="00000-000"
                value={buyer.cep} onChange={event => {
                  const cep = mask(digits(event.target.value), '#####-###');
                  ++addressRequest.current;
                  setBuyer(current => ({ ...current, cep }));
                  setLookup({ busy: false, message: '' });
                  if (digits(cep).length === 8) void searchCep(cep);
                }} />
              <button type="button" className="button dark" onClick={() => void searchCep()} disabled={lookup.busy}>
                {lookup.busy ? <Loader /> : <Search size={17} />} Consultar CEP
              </button>
              <small className="cep-note" aria-live="polite"><Info size={17} />{lookup.message || 'Informe o CEP para buscar o endereço.'}</small>
            </div>
            <div className="fields address">
              <Field label="Rua" icon={MapPin} required autoComplete="address-line1" maxLength={130} placeholder="Logradouro" {...field('street')} />
              <Field label="Número" icon={Hash} required maxLength={20} placeholder="Nº" {...field('number')} />
              <Field label="Complemento" autoComplete="address-line2" maxLength={128} placeholder="Apartamento, bloco ou casa" {...field('complement')} />
              <Field label="Bairro" required maxLength={100} placeholder="Bairro" {...field('neighborhood')} />
              <Field label="Cidade" required autoComplete="address-level2" maxLength={64} placeholder="Cidade" {...field('city')} />
              <div className="fields two">
                <label className="field">UF <select required autoComplete="address-level1" value={buyer.state} onChange={e => setBuyer({ ...buyer, state: e.target.value })}><option value="">UF</option>{states.map(state => <option key={state}>{state}</option>)}</select></label>
                <label className="field">País <select autoComplete="country" value="BR" onChange={() => {}}><option value="BR">Brasil</option></select></label>
              </div>
            </div>
          </section>
          <section className="panel form-panel payment-panel">
            <div className="payment-heading">
              <SectionHeading icon={CreditCard} title="Pagamento" subtitle="Cartão de crédito" />
              <div className="brands" aria-label="Bandeiras sujeitas à habilitação da conta"><span className="visa">VISA</span><span className="mastercard" aria-label="Mastercard" /><span className="elo">elo</span><span className="amex">AMEX</span><span className="hiper">Hipercard</span></div>
            </div>
            <label className="field">Parcelamento <select aria-label="Parcelamento" disabled={busy || saved || !shop.amount} value={Math.min(installments, count)} onChange={e => setInstallments(Number(e.target.value))}>
              {shop.amount ? Array.from({ length: count }, (_, index) => <option key={index} value={index + 1}>{installmentsLabel(shop.amount!, index + 1)}</option>) : <option value={1}>Aguardando valor da venda</option>}
            </select></label>
            <div className="payment-note"><LockKeyhole size={23} /><span><strong>Pagamento no checkout oficial da Pagar.me</strong><small>Ao finalizar, você será encaminhado na mesma aba para preencher os dados do cartão.</small></span><b className="pagarme">pagar.me</b></div>
            {shop.environment === 'test' && shop.ready && <p className="notice info">Ambiente de teste. Use somente os cartões de teste oficiais da Pagar.me.</p>}
            {(loadError || (product && !shop.ready)) && <p className="notice" role="status">{loadError || 'O checkout está aguardando a liberação do lojista.'}</p>}
            {error && <p className="notice error" role="alert">{error}</p>}
            {saved && <div className="notice receipt" role="status">
              <strong>{receipt ? statusLabel(receipt.status) : 'Confirmação pendente'}</strong>
              <span>Pedido {lastId}</span>
              {receipt?.status === 'declined' && <span>A transação foi recusada. Confira os dados do cartão ou consulte o emissor.{receipt.refusalCode ? ' Código: ' + receipt.refusalCode + '.' : ''}</span>}
              {receipt?.status === 'request_failed' && <span>A solicitação não foi processada. Confira os dados ou contate o lojista.</span>}
              {incomplete && <span>Acompanhe a confirmação usando a referência do pedido.</span>}
              {receipt?.checkoutUrl && <a className="button primary" href={receipt.checkoutUrl}>CONTINUAR NA PAGAR.ME</a>}
              {receipt && ['declined','request_failed','paid','captured','canceled','expired','refunded'].includes(receipt.status) && <button type="button" className="button secondary" onClick={newPurchase}>Nova compra</button>}
            </div>}
            <button className="button primary purchase" type="submit" disabled={busy || saved || !shop.ready}>
              {busy ? <Loader /> : <LockKeyhole size={20} />} {busy ? 'PROCESSANDO' : 'FINALIZAR PAGAMENTO'}
            </button>
          </section>
        </form>
        <aside className="panel order-panel" aria-label="Resumo do pedido">
          <div className="product-card">
            <img src={shop.image} alt={shop.name + ' com gabinete e iluminação RGB'} width={640} height={390} referrerPolicy="no-referrer" />
            <div className="product-info">
              <h2>{shop.name}</h2><p>{shop.description}</p>
              <div className="quantity">Quantidade <strong>1</strong></div>
              <div className="order-line"><span>Subtotal</span><b>{shop.amount === null ? '—' : brl(shop.amount)}</b></div>
              <div className="order-line total"><span>Total</span><strong>{shop.amount === null ? 'A definir' : brl(shop.amount)}</strong></div>
              {shop.amount !== null && <p className="installment-caption">{shop.maxInstallments > 1 ? 'Em até ' + count + ' parcelas no cartão de crédito' : 'À vista no cartão de crédito'}</p>}
            </div>
          </div>
          <div className="safe-card"><ShieldCheck size={33} /><span><strong>Ambiente seguro</strong><small>Confira o endereço do checkout antes de pagar.</small></span></div>
          <div className="trust-card">
            <h3><BadgeCheck size={18} /> Sobre o pagamento</h3>
            <p><Check size={16} /> Processamento via Pagar.me</p>
            <p><Check size={16} /> Acompanhe o resultado pelo pedido</p>
            <p><Check size={16} /> Cartão de crédito com parcelamento</p>
          </div>
        </aside>
      </div>
    </main>
  </>;
}
