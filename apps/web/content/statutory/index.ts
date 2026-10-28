/**
 * The statutory texts. One copy each, imported, never retyped.
 *
 * These are the § 1812.5095(f) and (d) notices. They are the only place in the codebase
 * where the word "employee" may appear — a notice cannot state what the registry is
 * *not* without it — and `ccn-lint` exempts this directory for exactly that reason.
 *
 * THE TEXT IS NOT WRITTEN. It is a legal notice, not copy, and inventing it would be
 * worse than leaving it blank: a plausible-looking notice is one nobody checks. It
 * comes from the California employment and healthcare attorney named in COUNSEL.md,
 * together with the questions in § 10 of the backend spec.
 *
 * Until `status` is 'approved', `StatutoryFooter` refuses to render in a production
 * build. The site cannot ship a marketing page without this.
 */

export interface StatutoryText {
  /** Bump when counsel supplies a revision, so what was shown when is recoverable. */
  version: string;
  status: 'awaiting_counsel' | 'approved';
  /** What the notice is for, in our words. Never shown to anyone. */
  purpose: string;
  /** The notice itself, verbatim from counsel. */
  text: string;
}

/** § 1812.5095(f) — what must be disclosed to the household at the point of referral. */
export const REFERRAL_DISCLOSURE: StatutoryText = {
  version: '0',
  status: 'awaiting_counsel',
  purpose:
    'Spoken at the point of referral and confirmed in writing within three California '
    + 'business days: that the provider is referred rather than the registry\'s own, the '
    + 'fee charged to the household, and that the rate is set by the provider.',
  text: '',
};

/** § 1812.5095(d) — the written notice a referred provider acknowledges. */
export const PROVIDER_NOTICE: StatutoryText = {
  version: '0',
  status: 'awaiting_counsel',
  purpose:
    'Acknowledged by a referred provider before any referral is made, recorded as '
    + 'providers.written_notice_ack_on.',
  text: '',
};

/** The one-line statement every marketing page carries in its footer. */
export const REFERRAL_AGENCY_STATEMENT: StatutoryText = {
  version: '0',
  status: 'awaiting_counsel',
  purpose:
    'Footer statement identifying the business as a nurses\' registry that refers '
    + 'providers rather than employing them. Must not mention the bond or any licensure '
    + '— § 1812.5095(i)–(j) bars advertising either, and the lint enforces it here too.',
  text: '',
};

export const ALL_STATUTORY_TEXTS = [
  REFERRAL_DISCLOSURE, PROVIDER_NOTICE, REFERRAL_AGENCY_STATEMENT,
] as const;

export function isApproved(t: StatutoryText): boolean {
  return t.status === 'approved' && t.text.trim().length > 0;
}
