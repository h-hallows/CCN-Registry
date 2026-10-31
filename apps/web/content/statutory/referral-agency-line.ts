/**
 * The footer, which two statutes between them require on every public page.
 *
 * § 1812.5095(h) sets the first line, in type no smaller than 6 point and contrasting
 * with the background. § 1812.533(b)(2) requires the registry's correct name plus either
 * a street address or a business telephone number in EVERY advertisement — and a public
 * web page is an advertisement.
 *
 * So the footer is two elements, not one, and neither is optional.
 *
 * NEVER HERE, OR ANYWHERE PUBLIC: the surety bond, any licensure, "licensed", "bonded",
 * "insured", or a badge standing in for them. § 1812.5095(i)–(j) bars advertising them
 * outright, and the lint enforces that even inside this directory.
 */
import type { StatutoryText } from './types';

export const MIN_POINT_SIZE = 6;

export const REFERRAL_AGENCY_LINE: StatutoryText = {
  VERSION: '1',
  LAST_REVIEWED: '2026-10-31',
  status: 'statute',
  citation: 'Cal. Civ. Code § 1812.5095(h)',
  purpose: 'First line of the footer on every public page.',
  text: 'Century City Concierge Nursing is a referral agency.',
};

/**
 * § 1812.533(b)(2) is satisfied by a street address OR a business phone. The phone is
 * the right choice — the business is built around the call — but nobody has supplied the
 * number, so this is unfilled and the footer refuses to ship.
 */
export const BUSINESS_CONTACT: StatutoryText = {
  VERSION: '0',
  LAST_REVIEWED: '2026-10-31',
  status: 'unfilled',
  citation: 'Cal. Civ. Code § 1812.533(b)(2)',
  purpose:
    'Second line of the footer: the business telephone number, or failing that the '
    + 'street address. Required in every advertisement, which includes every public page.',
  text: '',
};
