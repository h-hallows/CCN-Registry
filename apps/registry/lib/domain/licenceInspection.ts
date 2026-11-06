/**
 * § 1812.528 — the licence physically inspected, with its expiry noted.
 *
 * A different act from the primary-source lookup recorded in
 * `credentials.verification_source`, and the statute wants both. Migration 0004 added
 * `inspected_at` / `inspected_by` / `inspected_expiry_noted` and the
 * `nurse_license_inspected` CHECK, which makes all three mandatory on a nursing licence.
 *
 * The CHECK is NOT VALID, so rows that predate it survive — but an UPDATE is still
 * checked, which means a legacy nursing licence cannot be renewed without the inspection
 * either. Every path in this app that writes a `credentials` row goes through
 * `assertInspection` first, so the operator reads a sentence rather than a constraint
 * name, and so there is one place to look for what the statute requires.
 *
 * One module rather than a constant repeated per call site: a list of credential types
 * that must be kept in step with a database constraint is exactly the thing that falls
 * out of step when it is written down three times.
 */
import type { CredentialType } from '@h-hallows/core/schema';

/** The types `nurse_license_inspected` covers. Keep in step with migration 0004. */
export const INSPECTION_REQUIRED: readonly CredentialType[] = ['rn_license', 'lvn_license'];

export function requiresInspection(type: CredentialType): boolean {
  return INSPECTION_REQUIRED.includes(type);
}

/** What the operator recorded when they looked at the licence itself. */
export interface LicenceInspection {
  /** The expiry printed on the document in front of them — not what the registry's record says. */
  expiryNoted: string;
  /** The day they inspected it. Defaults to the verification date. */
  on?: string | null;
}

export class InspectionRequiredError extends Error {
  constructor() {
    super(
      'A nursing licence cannot be recorded without the § 1812.528 inspection: '
      + 'note the expiry date shown on the licence you inspected.',
    );
  }
}

/**
 * Throw unless the inspection is present where the statute requires it. Returns the three
 * column values to write, which are null for every type the CHECK does not cover.
 */
export function assertInspection(
  type: CredentialType,
  inspection: LicenceInspection | null | undefined,
  actor: string,
  verifiedOn: string,
): { inspectedAt: string | null; inspectedBy: string | null; inspectedExpiryNoted: string | null } {
  if (requiresInspection(type) && !inspection?.expiryNoted) {
    throw new InspectionRequiredError();
  }
  if (!inspection?.expiryNoted) {
    return { inspectedAt: null, inspectedBy: null, inspectedExpiryNoted: null };
  }
  return {
    inspectedAt: inspection.on || verifiedOn,
    inspectedBy: actor,
    inspectedExpiryNoted: inspection.expiryNoted,
  };
}
