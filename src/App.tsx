import { Links } from './pages/Links';
import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { Checkout } from './pages/Checkout';
import { Login } from './pages/Login';
import { Gateway } from './pages/Gateway';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { TelegramMonitor } from './pages/TelegramMonitor';
import { Notifications } from './pages/Notifications';
import { Field } from './components/UI';
import { Transactions } from './pages/Transactions';
import { Loader, Modal } from './components/UI';
import { ApiError, adminSessionExpired, api, explain, merchantPath, storefrontMerchant, type Environment, type Merchant, type Product } from './services/api';

const tabs = [
  { key: 'gateway', label: 'Gateway' }, { key: 'dashboard', label: 'Dashboard' },
  { key: 'settings', label: 'Configuração comercial' }, { key: 'transactions', label: 'Transações' }, { key: 'notifications', label: 'Relatórios e Notificações' }, { key: 'telegram', label: 'Telegram Monitor' }, { key: 'links', label: 'Links de pagamento' }
] as const;

export default function App() {
  const [product, setProduct] = useState<Product | null>(null);
  const [loadError, setLoadError] = useState('');
  const [opened, setOpened] = useState(false);
  const [csrf, setCsrf] = useState('');
  const [platform, setPlatform] = useState(false);
  const [checking, setChecking] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState('');
  const [merchantName, setMerchantName] = useState('');
  const [merchantError, setMerchantError] = useState('');
  const [addingMerchant, setAddingMerchant] = useState(false);
  const [merchantProduct, setMerchantProduct] = useState<Product | null>(null);
  const merchant = merchants.find(row => row.id === merchantId);
  const [env, setEnv] = useState<Environment>('test');
  const [tab, setTab] = useState<typeof tabs[number]['key']>('gateway');

  function refresh() {
    api<Product>(merchantPath('/checkout', storefrontMerchant())).then(result => { setProduct(result); setLoadError(''); })
      .catch(() => { setProduct(null); setLoadError('Não foi possível carregar a configuração do checkout.'); });
  }
  useEffect(refresh, []);
  useEffect(() => {
    if (!opened || !csrf) return;
    let current = true;
    setMerchantError('');
    api<Merchant[]>('/admin/merchants').then(rows => {
      if (!current) return;
      setMerchants(rows);
      const initial = rows.find(row => row.id === storefrontMerchant() && !row.quarantined)?.id ?? rows[0]?.id ?? '';
      setMerchantId(value => rows.some(row => row.id === value) ? value : initial);
    }).catch(error => { if (current) setMerchantError(explain(error)); });
    return () => { current = false; };
  }, [opened, csrf]);

  function loadMerchantProduct(id: string) {
    return api<Product>(merchantPath('/admin/product', id));
  }
  useEffect(() => {
    setMerchantProduct(null);
    if (!merchant || merchant.quarantined) return;
    let current = true;
    loadMerchantProduct(merchant.id).then(value => { if (current) setMerchantProduct(value); })
      .catch(error => { if (current) setMerchantError(explain(error)); });
    return () => { current = false; };
  }, [merchant?.id]);

  async function addMerchant(event: React.FormEvent) {
    event.preventDefault();
    if (addingMerchant) return;
    setAddingMerchant(true);
    setMerchantError('');
    try {
      const row = await api<Merchant>('/admin/merchants', { method: 'POST', csrf, body: { name: merchantName } });
      setMerchants(current => [...current, row]);
      setMerchantName('');
      selectMerchant(row);
    } catch (error) { setMerchantError(explain(error)); }
    finally { setAddingMerchant(false); }
  }

  function selectMerchant(row: Merchant) {
    setMerchantId(row.id);
    setEnv('test');
    setTab(row.quarantined ? 'transactions' : 'gateway');
  }

  useEffect(() => {
    const expire = () => setCsrf('');
    window.addEventListener(adminSessionExpired, expire);
    return () => window.removeEventListener(adminSessionExpired, expire);
  }, []);

  function open() {
    setTab(merchant?.quarantined ? 'transactions' : 'gateway');
    setEnv(product?.environment ?? 'test');
    setOpened(true);
    setChecking(true);
    api<{ csrf: string; platform: boolean }>('/admin/session').then(result => { setPlatform(result.platform); setCsrf(result.csrf); })
      .catch(() => setCsrf('')).finally(() => setChecking(false));
  }

  function close() {
    setOpened(false);
    setLogoutError('');
  }

  async function logout() {
    try {
      await api('/admin/logout', { method: 'POST', csrf });
      setCsrf('');
      close();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { setCsrf(''); close(); }
      else setLogoutError(explain(error));
    }
  }

  return <>
    <Checkout onAdmin={open} product={product} loadError={loadError} refresh={refresh} />
    {opened && <Modal label={csrf ? 'CENTRAL DE CONFIGURAÇÃO PAGAR.ME / STONE' : 'Acesso administrativo'} onClose={close} wide={Boolean(csrf)}>
      {checking ? <p className="modal-body"><Loader /> Verificando sessão</p>
        : !csrf ? <Login onLogin={(token, isPlatform) => { setMerchants([]); setMerchantId(''); setPlatform(isPlatform); setCsrf(token); }} onClose={close} />
        : <>
          <div className="modal-body">
            <div className="fields two admin-fields">
              <label className="field">Lojista<select value={merchantId} onChange={event => {
                const row = merchants.find(item => item.id === event.target.value);
                if (row) selectMerchant(row);
              }}><option value="" disabled>Selecione um lojista</option>
                {merchants.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select></label>
              {platform && <form onSubmit={addMerchant}>
                <Field label="Nome do novo lojista" maxLength={100} required value={merchantName} onChange={event => setMerchantName(event.target.value)} />
                <button className="button secondary" disabled={addingMerchant}>Adicionar lojista</button>
              </form>}
            </div>
            {merchant && !merchant.quarantined && <p className="help"><a href={merchantPath('/', merchant.id)}>Abrir checkout deste lojista</a></p>}
            {merchantError && <p className="notice error" role="alert">{merchantError}</p>}
            {merchant && <>
            {merchant.quarantined && <p className="notice info">Histórico preservado para consulta até a regularização da titularidade.</p>}
            <nav className="admin-nav" aria-label="Seções administrativas">
              {tabs.filter(item => !merchant.quarantined || ['dashboard','transactions','notifications'].includes(item.key)).map(item => <button className={'tab ' + (tab === item.key ? 'active' : '')} type="button" key={item.key} aria-pressed={tab === item.key} onClick={() => setTab(item.key)}>{item.label}</button>)}
            </nav>
            {(tab === 'dashboard' || tab === 'transactions') && <label className="field env-field">Ambiente<select value={env} onChange={e => setEnv(e.target.value as Environment)}><option value="test">Sandbox</option><option value="live">Produção</option></select></label>}
            {tab === 'gateway' && !merchant.quarantined && <Gateway key={merchant.id} merchant={merchant.id} csrf={csrf} env={env} product={merchantProduct?.merchantId === merchant.id ? merchantProduct : null} onCommercialSettings={() => setTab('settings')} onEnvironmentChange={setEnv} onChange={refresh} onExpired={() => setCsrf('')} />}
            {tab === 'dashboard' && <Dashboard key={merchant.id + env} merchant={merchant.id} env={env} />}
            {tab === 'settings' && !merchant.quarantined && <Settings key={merchant.id} merchant={merchant.id} csrf={csrf} onChange={() => {
              refresh();
              void loadMerchantProduct(merchant.id).then(setMerchantProduct).catch(() => {});
            }} />}
            {tab === 'transactions' && <Transactions key={merchant.id + env} merchant={merchant.id} csrf={csrf} env={env} readOnly={merchant.quarantined} />}
            {tab === 'links' && !merchant.quarantined && <Links key={merchant.id} merchant={merchant.id} csrf={csrf} />}
            {tab === 'telegram' && !merchant.quarantined && <TelegramMonitor key={merchant.id} merchant={merchant} csrf={csrf} platform={platform} />}
            {tab === 'notifications' && <Notifications key={merchant.id} merchant={merchant} csrf={csrf} platform={platform} />}
            </>}
            {logoutError && <p className="notice error" role="alert">{logoutError}</p>}
          </div>
          <footer className="modal-footer"><button className="button danger" type="button" onClick={() => void logout()}><LogOut size={17} /> SAIR</button><button className="button dark" type="button" onClick={close}>FECHAR</button></footer>
        </>}
    </Modal>}
  </>;
}
