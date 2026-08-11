'use client';

/**
 * Session and organization context.
 *
 * The active organization is a UI convenience only. It narrows what you see; it
 * never grants anything. Every query is filtered by Hasura against the caller's
 * membership rows regardless of what is selected here, which is exactly why
 * switching orgs in this dropdown cannot show another tenant's data.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { gql } from './gql';
import { nhost } from './nhost';
import { MY_MEMBERSHIPS } from './queries';
import type { Membership, OrgRole } from './types';

interface SessionValue {
  loading: boolean;
  userId: string | null;
  email: string | null;
  memberships: Membership[];
  activeOrgId: string | null;
  activeOrg: Membership | null;
  role: OrgRole | null;
  setActiveOrgId: (orgId: string) => void;
  reloadMemberships: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const ACTIVE_ORG_KEY = 'agentflow.activeOrg';

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(null);

  const loadMemberships = useCallback(async () => {
    // Read the id straight from the session rather than from React state, so
    // this does not depend on setUserId having landed first and does not need
    // userId in the dependency array.
    const uid = nhost().getUserSession()?.user?.id;
    if (!uid) {
      setMemberships([]);
      return;
    }
    const data = await gql<{ org_members: Membership[] }>(MY_MEMBERSHIPS, { userId: uid });
    setMemberships(data.org_members);

    setActiveOrgIdState((current) => {
      const stored = current ?? window.localStorage.getItem(ACTIVE_ORG_KEY);
      const stillAMember = data.org_members.some((m) => m.org_id === stored);
      return stillAMember && stored ? stored : (data.org_members[0]?.org_id ?? null);
    });
  }, []);

  useEffect(() => {
    const client = nhost();

    const sync = async (session: { user?: { id: string; email?: string } } | null) => {
      if (!session?.user) {
        setUserId(null);
        setEmail(null);
        setMemberships([]);
        setLoading(false);
        return;
      }
      setUserId(session.user.id);
      setEmail(session.user.email ?? null);
      try {
        await loadMemberships();
      } finally {
        setLoading(false);
      }
    };

    void sync(client.getUserSession());
    return client.sessionStorage.onChange((session) => void sync(session));
  }, [loadMemberships]);

  const setActiveOrgId = useCallback((orgId: string) => {
    window.localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    setActiveOrgIdState(orgId);
  }, []);

  const signOut = useCallback(async () => {
    const client = nhost();
    const session = client.getUserSession();
    try {
      if (session?.refreshToken) await client.auth.signOut({ refreshToken: session.refreshToken });
    } finally {
      client.clearSession();
      window.localStorage.removeItem(ACTIVE_ORG_KEY);
      router.push('/signin');
    }
  }, [router]);

  const value = useMemo<SessionValue>(() => {
    // Members can see every membership row in their own organization, so this
    // list is not just the caller's. Matching on org_id alone picks up whoever
    // happens to be first and reports their role as yours.
    const activeOrg =
      memberships.find((m) => m.org_id === activeOrgId && m.user_id === userId) ?? null;
    return {
      loading,
      userId,
      email,
      memberships,
      activeOrgId,
      activeOrg,
      role: activeOrg?.role ?? null,
      setActiveOrgId,
      reloadMemberships: loadMemberships,
      signOut,
    };
  }, [loading, userId, email, memberships, activeOrgId, setActiveOrgId, loadMemberships, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}

/** Role checks used by the UI. The backend re-checks all of them. */
export const canTrigger = (role: OrgRole | null) => role === 'owner' || role === 'editor';
export const canEdit = (role: OrgRole | null) => role === 'owner' || role === 'editor';
export const canManageOrg = (role: OrgRole | null) => role === 'owner';
export const canAddPrivilegedStep = (role: OrgRole | null) => role === 'owner';
