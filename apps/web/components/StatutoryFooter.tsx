/**
 * The footer two statutes require on every public page. Spec § 1.4.
 *
 * Rendered by the (marketing) layout, never by an individual page, so a page cannot opt
 * out of its own layout. Both lines are required:
 *
 *   § 1812.5095(h)  "… is a referral agency."  — type no smaller than 6 point
 *   § 1812.533(b)(2) the name plus a street address or business telephone, in EVERY
 *                    advertisement, which includes every public page
 *
 * A production DEPLOY missing either line fails to build. A local build or a preview
 * renders a loud placeholder instead: the gate is meant to stop the public site
 * shipping, not to stop work. VERCEL_ENV rather than NODE_ENV, because NODE_ENV is
 * 'production' for every build including the one you run to check a bundle size.
 */
import { BUSINESS_CONTACT, isDeliverable, REFERRAL_AGENCY_LINE } from '@/content/statutory';

export function StatutoryFooter() {
  const missing = [REFERRAL_AGENCY_LINE, BUSINESS_CONTACT].filter((t) => !isDeliverable(t));

  if (missing.length > 0) {
    if (process.env.VERCEL_ENV === 'production') {
      throw new Error(
        'The statutory footer is incomplete, so no public page may ship: '
        + missing.map((t) => `${t.citation} (${t.status})`).join('; ')
        + '. See apps/web/content/statutory/README.md and COUNSEL.md.',
      );
    }
    return (
      <footer
        data-statutory-footer="placeholder"
        style={{
          borderTop: '2px dashed var(--crit, #A33227)', padding: '1rem', marginTop: '3rem',
          color: 'var(--crit, #A33227)', fontSize: '0.8125rem', lineHeight: 1.6,
        }}
      >
        <strong>Statutory footer incomplete — this page cannot ship.</strong>
        <ul style={{ marginTop: '0.5rem' }}>
          {missing.map((t) => (
            <li key={t.citation}>
              <code>{t.citation}</code> — {t.status}. {t.purpose}
            </li>
          ))}
        </ul>
      </footer>
    );
  }

  return (
    <footer data-statutory-footer="complete" className="statutory">
      <p>{REFERRAL_AGENCY_LINE.text}</p>
      <p>{BUSINESS_CONTACT.text}</p>
    </footer>
  );
}
