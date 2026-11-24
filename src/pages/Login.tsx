import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { ApiError, api, explain } from '../services/api';
import { Loader } from '../components/UI';

export function Login({ onLogin, onClose }: { onLogin: (csrf: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ csrf: string }>('/admin/login', { method: 'POST', body: { password } });
      onLogin(result.csrf);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : explain(failure));
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  return <form onSubmit={submit} className="modal-body login">
    <span className="section-icon"><LockKeyhole size={24} /></span>
    <p>Informe a senha administrativa para gerenciar a integração Pagar.me / Stone.</p>
    <label className="field">
      <span>Senha administrativa</span>
      <span className="password-shell">
        <input autoFocus type={shown ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
          required autoComplete="current-password" maxLength={512} />
        <button type="button" className="icon-button" onClick={() => setShown(!shown)} aria-label={shown ? 'Ocultar senha' : 'Mostrar senha'}>{shown ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      </span>
    </label>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="button secondary" type="button" onClick={onClose}>FECHAR</button><button className="button primary" disabled={busy}>{busy && <Loader />} ENTRAR</button></div>
  </form>;
}
