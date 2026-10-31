/**
 * The business name, in one place. Work order 01 § 3.
 *
 * The trading name is blocked on counsel — three provisions now: HSC § 1726(b),
 * 22 CCR § 74600(b), and Civil Code § 1812.533(b)(4), which bars presenting as a home
 * care agency by name, advertising *or other representation*. That would normally block
 * every marketing page.
 *
 * It does not have to. Nothing hardcodes a name; everything imports from here. When
 * counsel clears it, this is two environment variables rather than a find-and-replace
 * across sixty pages and six statutory documents.
 *
 * LEGAL_NAME is the registry's correct name as filed. It is the ONLY name that may
 * appear in statutory text — Civ. Code § 1812.5095(f), (d), (h) and § 1812.533(b)(2),
 * (b)(4). § 1812.533(b)(2) requires the "correct name" in every advertisement, so the
 * footer uses LEGAL_NAME and never a marketing name.
 *
 * DISPLAY_NAME is for marketing headings only, and only once counsel confirms a
 * registered DBA is acceptable. Until then it equals LEGAL_NAME.
 */

export const PENDING_LEGAL_NAME = 'PENDING_LEGAL_NAME';
export const PENDING_PHONE = 'PENDING_PHONE';

export const LEGAL_NAME = process.env.NEXT_PUBLIC_LEGAL_NAME ?? PENDING_LEGAL_NAME;
export const DISPLAY_NAME = process.env.NEXT_PUBLIC_DISPLAY_NAME ?? LEGAL_NAME;
export const PHONE = process.env.NEXT_PUBLIC_PHONE ?? PENDING_PHONE;
export const STREET = process.env.NEXT_PUBLIC_STREET ?? null;

/** True once counsel has cleared a name and it is configured. */
export function legalNameResolved(): boolean {
  return LEGAL_NAME !== PENDING_LEGAL_NAME && LEGAL_NAME.trim().length > 0;
}

/**
 * § 1812.533(b)(2) is satisfied by a street address OR a business telephone number.
 * Either will do; neither being present will not.
 */
export function contactResolved(): boolean {
  return (PHONE !== PENDING_PHONE && PHONE.trim().length > 0)
    || (STREET !== null && STREET.trim().length > 0);
}

/** What the footer prints as the second required line. */
export function contactLine(): string {
  if (PHONE !== PENDING_PHONE && PHONE.trim()) return PHONE.trim();
  if (STREET && STREET.trim()) return STREET.trim();
  return '';
}

/** Everything the footer needs, and why it cannot render when it cannot. */
export function brandBlockers(): string[] {
  const blockers: string[] = [];
  if (!legalNameResolved()) {
    blockers.push(
      'NEXT_PUBLIC_LEGAL_NAME is unset. The registry\'s correct name is required in '
      + 'every advertisement by § 1812.533(b)(2), and the trading name is blocked on '
      + 'counsel — HSC § 1726(b), 22 CCR § 74600(b), Civ. Code § 1812.533(b)(4).',
    );
  }
  if (!contactResolved()) {
    blockers.push(
      'Neither NEXT_PUBLIC_PHONE nor NEXT_PUBLIC_STREET is set. § 1812.533(b)(2) '
      + 'requires the name plus one of them in every advertisement.',
    );
  }
  return blockers;
}
