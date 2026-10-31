/**
 * § 1812.5095(f), first paragraph. VERBATIM STATUTORY TEXT — do not edit.
 *
 * Spoken by the operator to the person engaging care, BEFORE the referral. The console's
 * disclosure modal displays this and the operator reads it aloud; the modal's
 * confirmation is what records that it happened.
 */
import type { StatutoryText } from './types';

export const ORAL_DISCLOSURE: StatutoryText = {
  VERSION: '1',
  LAST_REVIEWED: '2026-10-31',
  status: 'statute',
  citation: 'Cal. Civ. Code § 1812.5095(f)',
  purpose:
    'Read aloud to the person engaging care before a referral is made. Recorded as a '
    + 'disclosures row in the same transaction as the referral.',
  text:
    'Century City Concierge Nursing is not the employer of the domestic worker it '
    + 'referred to you. Depending on your arrangement with the domestic worker, you may '
    + 'have employer responsibilities.',
};
