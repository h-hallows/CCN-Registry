/**
 * The footer two statutes require on every public page. Web spec § 1.4, work order § 3.
 *
 * Two elements, both required, and neither optional:
 *
 *   § 1812.5095(h)   "… is a referral agency."  — type no smaller than 6 point
 *   § 1812.533(b)(2) the registry's CORRECT name plus a street address or business
 *                    telephone, in EVERY advertisement — and a public page is one
 *
 * It renders LEGAL_NAME, never DISPLAY_NAME: § 1812.533(b)(2) asks for the correct name
 * as filed, not a marketing one.
 *
 * Rendered by the (marketing) layout, never by a page, so a page cannot opt out of its
 * own layout. A production DEPLOY missing any part fails to build; a local build or a
 * preview renders a loud placeholder, because the gate is meant to stop the public site
 * shipping rather than to stop work. VERCEL_ENV and not NODE_ENV, since NODE_ENV is
 * 'production' for every build including the one you run to check a bundle size.
 */
import { brandBlockers, contactLine } from '@/lib/brand';
import { isDeliverable, REFERRAL_AGENCY_LINE } from '@/content/statutory';

export function StatutoryFooter() {
  const blockers = [
    ...brandBlockers(),
    ...(isDeliverable(REFERRAL_AGENCY_LINE)
      ? []
      : [`${REFERRAL_AGENCY_LINE.citation} is ${REFERRAL_AGENCY_LINE.status}.`]),
  ];

  if (blockers.length > 0) {
    if (process.env.VERCEL_ENV === 'production') {
      throw new Error(
        'The statutory footer is incomplete, so no public page may ship:\n'
        + blockers.map((b) => `  - ${b}`).join('\n')
        + '\nSee apps/web/content/statutory/README.md and COUNSEL.md.',
      );
    }
    return (
      <footer
        data-statutory-footer="placeholder"
        style={{
          borderTop: '2px dashed var(--crit)', padding: '1rem', marginTop: '3rem',
          color: 'var(--crit)', fontSize: '0.8125rem', lineHeight: 1.6,
        }}
      >
        <strong>Statutory footer incomplete — this page cannot ship.</strong>
        <ul style={{ marginTop: '.5rem', paddingLeft: '1.2rem' }}>
          {blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      </footer>
    );
  }

  return (
    <footer data-statutory-footer="complete" className="statutory">
      <p>{REFERRAL_AGENCY_LINE.text}</p>
      <p>{contactLine()}</p>
    </footer>
  );
}
