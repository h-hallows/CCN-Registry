import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getPortalSession } from '@/lib/session';
import { Wrap } from '@/components/layout';

/** Dynamic, server-rendered, never indexed. Spec § 6.2. */
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  const session = await getPortalSession();
  if (!session) redirect('/login');
  if (session.role !== 'household') redirect(session.role === 'provider' ? '/pro' : '/login');

  return (
    <div data-surface="portal" style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)' }}>
      <header style={{ borderBottom: '1px solid var(--line)' }}>
        <Wrap>
          <div style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'baseline',
            gap: '1.25rem', paddingBlock: '1rem',
          }}>
            <Link href="/portal" style={{
              fontFamily: 'var(--display)', color: 'var(--ink)', textDecoration: 'none',
            }}>
              Century City Concierge Nursing
            </Link>
            <span className="label" style={{ marginLeft: 'auto' }}>{session.displayName}</span>
          </div>
        </Wrap>
      </header>
      <main><Wrap>{children}</Wrap></main>
    </div>
  );
}
