import { StatutoryFooter } from '@/components/StatutoryFooter';

/**
 * Every marketing route renders through here, which is what makes the statutory footer
 * unremovable — a page cannot opt out of its own layout.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4">
      {children}
      <StatutoryFooter />
    </div>
  );
}
