import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { ApiError, api, explain } from '../services/api';
import { Loader } from '../components/UI';

export function Login({ onLogin, onClose }: { onLogin: (csrf: string, platform: boolean) => void; onClose: () => void }) {
  const [mode, setMode] = useState<'operator' | 'merchant' | 'register'>('operator');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
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
      const path = mode === 'operator' ? '/admin/login' : '/merchant/' + (mode === 'register' ? 'register' : 'login');
      const body = mode === 'operator' ? { password } : { email, password, ...(mode === 'register' ? { name } : {}) };
      const result = await api<{ csrf: string }>(path, { method: 'POST', body });
      onLogin(result.csrf, mode === 'operator');
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : explain(failure));
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  return <form onSubmit={submit} className="modal-body login">
    <span className="section-icon"><LockKeyhole size={24} /></span>
    <label className="field">Tipo de acesso
      <select value={mode} disabled={busy} onChange={event => {
        setMode(event.target.value as typeof mode); setError(''); setPassword(''); setShown(false);
      }}>
        <option value="operator">Operação da plataforma</option>
        <option value="merchant">Entrar como lojista</option>
        <option value="register">Cadastrar lojista</option>
      </select>
    </label>
    {mode === 'register' && <label className="field">Nome comercial
      <input required maxLength={100} value={name} onChange={event => setName(event.target.value)} />
    </label>}
    {mode !== 'operator' && <label className="field">E-mail
      <input type="email" required maxLength={254} autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} />
    </label>}
    <label className="field">
      <span>{mode === 'operator' ? 'Senha administrativa' : 'Senha do lojista'}</span>
      <span className="password-shell">
        <input autoFocus type={shown ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
          required autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          minLength={mode === 'register' ? 12 : undefined} maxLength={mode === 'operator' ? 512 : 128} />
        <button type="button" className="icon-button" onClick={() => setShown(!shown)} aria-label={shown ? 'Ocultar senha' : 'Mostrar senha'}>{shown ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      </span>
    </label>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="button secondary" type="button" onClick={onClose}>FECHAR</button><button className="button primary" disabled={busy}>{busy && <Loader />} {mode === 'register' ? 'CADASTRAR' : 'ENTRAR'}</button></div>
  </form>;
}
