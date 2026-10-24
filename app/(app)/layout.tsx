import Link from 'next/link';
import { requireOperator } from '@/lib/operator';
import { signOut } from '@/lib/auth';
import { getToday } from '@/lib/queries/today';
import { Count } from '@/components/ui';

const NAV = [
  { href: '/today', label: 'Today' },
  { href: '/roster', label: 'Roster' },
  { href: '/cases', label: 'Cases' },
  { href: '/match', label: 'Match' },
  { href: '/compliance', label: 'Compliance' },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { operator, ctx } = await requireOperator();
  const today = await getToday(ctx);

  async function endSession() {
    'use server';
    await signOut();
  }

  return (
    <div className="min-h-screen">
      <header className="border-b hair" style={{ background: 'var(--card)' }}>
        <div className="wrap flex flex-wrap items-center gap-x-5 gap-y-2 py-2.5">
          <Link href="/today" className="text-sm font-semibold tracking-tight">
            CCN Registry
          </Link>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="inline-flex items-center gap-1.5 py-1 underline-offset-4 hover:underline"
              >
                {item.label}
                {item.href === '/today' ? <Count n={today.totalActions} /> : null}
              </Link>
            ))}
          </nav>
          <form action={endSession} className="ml-auto flex items-center gap-3">
            <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
              {operator.displayName}
            </span>
            <button type="submit" className="btn">Sign out</button>
          </form>
        </div>
      </header>
      <main className="wrap py-5">{children}</main>
      <footer className="wrap pb-8 pt-2">
        <p className="text-[0.6875rem] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
          Internal tool. Providers listed here are referred providers. Every read and write
          on this screen is recorded in the audit log.
        </p>
      </footer>
    </div>
  );
}
