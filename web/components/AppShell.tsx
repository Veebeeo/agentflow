'use client';

/**
 * Signed-in chrome: brand, org switcher, sign out, and the redirect for anyone
 * who is not signed in. Rendering guards are convenience only; every query
 * behind them is independently scoped by Hasura.
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from '../lib/session';

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { loading, userId, email, memberships, activeOrgId, role, setActiveOrgId, signOut } =
    useSession();

  useEffect(() => {
    if (!loading && !userId) router.replace('/signin');
  }, [loading, userId, router]);

  if (loading) {
    return (
      <div className="shell">
        <div className="page">
          <p className="mono muted">Loading your organizations…</p>
        </div>
      </div>
    );
  }

  if (!userId) return null;

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/dashboard" className="brand" style={{ color: 'var(--ink)' }}>
          AgentFlow
        </Link>

        {memberships.length > 0 && (
          <div className="row" style={{ gap: '0.5rem' }}>
            <span className="eyebrow">org</span>
            <select
              aria-label="Active organization"
              value={activeOrgId ?? ''}
              onChange={(event) => setActiveOrgId(event.target.value)}
              style={{ width: 'auto', minWidth: 170 }}
            >
              {memberships.map((membership) => (
                <option key={membership.id ?? membership.org_id} value={membership.org_id}>
                  {membership.organization.name}
                </option>
              ))}
            </select>
            {role && <span className={`pill pill-${role === 'viewer' ? 'pending' : 'succeeded'}`}>{role}</span>}
          </div>
        )}

        <div className="topbar-spacer" />
        <span className="mono muted" title={email ?? ''}>
          {email}
        </span>
        <button type="button" className="btn-small" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      {children}
    </div>
  );
}
