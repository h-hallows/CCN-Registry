import Link from 'next/link';
import { StatutoryFooter } from '@/components/StatutoryFooter';
import { Wrap } from '@/components/layout';

const NAV = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Rates' },
  { href: '/vetting', label: 'Vetting' },
  { href: '/for-providers', label: 'For providers' },
  { href: '/for-partners', label: 'For partners' },
];

/**
 * Every marketing route renders through here, which is what makes the statutory footer
 * unremovable — a page cannot opt out of its own layout.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header style={{ borderBottom: '1px solid var(--line)', background: 'var(--surface)' }}>
        <Wrap>
          <div style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'baseline',
            gap: '1.5rem', paddingBlock: '1.1rem',
          }}>
            <Link href="/" style={{
              fontFamily: 'var(--display)', fontSize: 'var(--step-1)',
              color: 'var(--ink)', textDecoration: 'none', letterSpacing: '-0.01em',
            }}>
              Century City Concierge Nursing
            </Link>
            <nav style={{ display: 'flex', flexWrap: 'wrap', gap: '1.25rem', fontSize: 'var(--step--1)' }}>
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} style={{ color: 'var(--ink-2)' }}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </Wrap>
      </header>

      <main>
        <Wrap>{children}</Wrap>
      </main>

      <Wrap>
        <StatutoryFooter />
      </Wrap>
    </>
  );
}
