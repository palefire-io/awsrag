import { useState, type FormEvent } from 'react';
import { fetchCognitoConfig, login } from './cognito';

export function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const config = await fetchCognitoConfig();
      const token = await login(config, username, password);
      onLogin(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <span className="corner-bl" />
        <span className="corner-br" />
        <p className="login-mark">CloudRAG</p>
        <p className="login-tagline">Specialist knowledge, on call.</p>
        <form onSubmit={submit}>
          <input
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <input
            placeholder="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        {error && <p className="login-error">{error}</p>}
      </div>
    </div>
  );
}
