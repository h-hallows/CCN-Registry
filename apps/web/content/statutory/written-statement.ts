/**
 * § 1812.5095(f), second paragraph. VERBATIM STATUTORY TEXT — do not edit.
 *
 * Mailed within three California business days of the referral, in type no smaller than
 * 10 point. MIN_POINT_SIZE is set explicitly rather than inherited through a rem chain
 * that could resolve smaller, and a test asserts the print stylesheet honours it.
 *
 * This text contains "independent contractor" because the statute does. § 1812.5095(g)
 * separately bars CCN from using that label in its own copy — see this directory's
 * README for why both are true at once.
 */
import type { StatutoryText } from './types';

export const MIN_POINT_SIZE = 10;

export const WRITTEN_STATEMENT: StatutoryText = {
  VERSION: '1',
  LAST_REVIEWED: '2026-10-31',
  status: 'statute',
  citation: 'Cal. Civ. Code § 1812.5095(f)',
  purpose:
    'Mailed to the person engaging care within three California business days of the '
    + 'referral. Recorded as disclosures.written_sent_on.',
  text:
    'Century City Concierge Nursing is not the employer of the domestic worker it '
    + 'referred to you. The domestic worker may be your employee or an independent '
    + 'contractor depending on the relationship you have with him or her. If you direct '
    + 'and control the manner and means by which the domestic worker performs his or her '
    + 'work you may have employer responsibilities, including employment taxes and '
    + "workers' compensation, under state and federal law. For additional information "
    + 'contact your local Employment Development Department and the Internal Revenue '
    + 'Service.',
};
