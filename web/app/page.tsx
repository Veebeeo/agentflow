'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '../lib/session';

export default function Home() {
  const router = useRouter();
  const { loading, userId } = useSession();

  useEffect(() => {
    if (loading) return;
    router.replace(userId ? '/dashboard' : '/signin');
  }, [loading, userId, router]);

  return (
    <div className="auth-wrap">
      <p className="mono muted">Starting…</p>
    </div>
  );
}
