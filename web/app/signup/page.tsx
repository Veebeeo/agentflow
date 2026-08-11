'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { nhost } from '../../lib/nhost';

export default function SignUp() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await nhost().auth.signUpEmailPassword({
        email,
        password,
        options: { displayName },
      });
      if (response.body?.session) {
        router.push('/dashboard');
        return;
      }
      setMessage('Check your email to verify the address, then sign in.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed.');
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
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.35rem' }}>Create an account</h1>
        <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
          You will be the owner of any organization you create.
        </p>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="help">At least 8 characters.</div>
          </div>

          {error && (
            <div className="notice notice-error" style={{ marginBottom: '0.85rem' }}>
              {error}
            </div>
          )}
          {message && (
            <div className="notice notice-info" style={{ marginBottom: '0.85rem' }}>
              {message}
            </div>
          )}

          <button type="submit" className="btn-primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <p className="subtitle" style={{ marginTop: '1rem', marginBottom: 0 }}>
          Already have one? <Link href="/signin">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
