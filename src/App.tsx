import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { Checkout } from './pages/Checkout';
import { Login } from './pages/Login';
import { Gateway } from './pages/Gateway';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { Transactions } from './pages/Transactions';
import { Loader, Modal } from './components/UI';
import { ApiError, adminSessionExpired, api, explain, type Environment, type Product } from './services/api';

const tabs = [
  { key: 'gateway', label: 'Gateway' }, { key: 'dashboard', label: 'Dashboard' },
  { key: 'settings', label: 'Configuração comercial' }, { key: 'transactions', label: 'Transações' }
] as const;

export default function App() {
  const [product, setProduct] = useState<Product | null>(null);
  const [loadError, setLoadError] = useState('');
  const [opened, setOpened] = useState(false);
  const [csrf, setCsrf] = useState('');
  const [checking, setChecking] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [env, setEnv] = useState<Environment>('test');
  const [tab, setTab] = useState<typeof tabs[number]['key']>('gateway');

  function refresh() {
    api<Product>('/checkout').then(result => { setProduct(result); setLoadError(''); })
      .catch(() => { setProduct(null); setLoadError('Não foi possível carregar a configuração do checkout.'); });
  }
  useEffect(refresh, []);
  useEffect(() => {
    const expire = () => setCsrf('');
    window.addEventListener(adminSessionExpired, expire);
    return () => window.removeEventListener(adminSessionExpired, expire);
  }, []);

  function open() {
    setTab('gateway');
    setEnv(product?.environment ?? 'test');
    setOpened(true);
    setChecking(true);
    api<{ csrf: string }>('/admin/session').then(result => setCsrf(result.csrf))
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
        : !csrf ? <Login onLogin={setCsrf} onClose={close} />
        : <>
          <div className="modal-body">
            <nav className="admin-nav" aria-label="Seções administrativas">
              {tabs.map(item => <button className={'tab ' + (tab === item.key ? 'active' : '')} type="button" key={item.key} aria-pressed={tab === item.key} onClick={() => setTab(item.key)}>{item.label}</button>)}
            </nav>
            {(tab === 'dashboard' || tab === 'transactions') && <label className="field env-field">Ambiente<select value={env} onChange={e => setEnv(e.target.value as Environment)}><option value="test">Sandbox</option><option value="live">Produção</option></select></label>}
            {tab === 'gateway' && <Gateway csrf={csrf} env={env} product={product} onCommercialSettings={() => setTab('settings')} onEnvironmentChange={setEnv} onChange={refresh} onExpired={() => setCsrf('')} />}
            {tab === 'dashboard' && <Dashboard key={env} env={env} />}
            {tab === 'settings' && <Settings csrf={csrf} onChange={refresh} />}
            {tab === 'transactions' && <Transactions key={env} csrf={csrf} env={env} />}
            {logoutError && <p className="notice error" role="alert">{logoutError}</p>}
          </div>
          <footer className="modal-footer"><button className="button danger" type="button" onClick={() => void logout()}><LogOut size={17} /> SAIR</button><button className="button dark" type="button" onClick={close}>FECHAR</button></footer>
        </>}
    </Modal>}
  </>;
}
