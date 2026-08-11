'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { nhost } from '../../lib/nhost';

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await nhost().auth.signInEmailPassword({ email, password });
      if (!response.body?.session) {
        setError('That email and password did not match an account.');
        return;
      }
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: '1.25rem' }}>
          AgentFlow
        </div>
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.35rem' }}>Sign in</h1>
        <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
          Build, run and supervise agent workflows.
        </p>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <div className="notice notice-error" style={{ marginBottom: '0.85rem' }}>
              {error}
            </div>
          )}

          <button type="submit" className="btn-primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="subtitle" style={{ marginTop: '1rem', marginBottom: 0 }}>
          No account yet? <Link href="/signup">Create one</Link>
        </p>
      </div>
    </div>
  );
}
