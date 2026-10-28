/**
 * Architecture spec § 6.5.
 *
 * Rendered by the (marketing) layout, never by an individual page, so no page can omit
 * it. The text is imported from content/statutory and never retyped.
 *
 * A production DEPLOY with text counsel has not approved fails to build. A local build
 * or a preview deploy renders a loud placeholder instead, because gating those as well
 * would mean nothing could be developed until the lawyer replied — the gate is meant to
 * stop the public site shipping, not to stop work.
 *
 * VERCEL_ENV rather than NODE_ENV: NODE_ENV is 'production' for every build, including
 * the one you run locally to check a bundle size.
 */
import { isApproved, REFERRAL_AGENCY_STATEMENT } from '@/content/statutory';

export function StatutoryFooter() {
  const statement = REFERRAL_AGENCY_STATEMENT;

  if (!isApproved(statement)) {
    if (process.env.VERCEL_ENV === 'production') {
      throw new Error(
        'The statutory footer statement has not been approved by counsel '
        + `(content/statutory, status "${statement.status}", version ${statement.version}). `
        + 'No marketing page may ship without it. See COUNSEL.md.',
      );
    }
    return (
      <footer
        data-statutory-footer="placeholder"
        style={{
          borderTop: '2px dashed #a4253a', padding: '1rem', marginTop: '3rem',
          color: '#a4253a', fontSize: '0.8125rem', lineHeight: 1.6,
        }}
      >
        <strong>Statutory footer statement not yet supplied.</strong>
        <br />
        {statement.purpose}
        <br />
        This renders everywhere except a production deploy, which fails to build.
      </footer>
    );
  }

  return (
    <footer data-statutory-footer="approved" className="statutory">
      <p>{statement.text}</p>
    </footer>
  );
}
