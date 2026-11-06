/**
 * Reviewing what a provider handed in. Migration 0008; web build spec § 4.2, W8.
 *
 * I12: a provider cannot make themselves eligible. Migration 0003 had granted providers
 * INSERT on `credentials`, and `eligibility()` treats the presence of a row of the
 * required type as that requirement being met — so a provider could insert their own
 * Live Scan and walk onto a household's shortlist. 0008 drops that policy and routes
 * uploads into `credential_submissions`, which nothing computes eligibility from.
 *
 * This module is the other half of that fix: the only sanctioned way a submission turns
 * into a credential. Two rules hold it together.
 *
 *  1. Accepting writes the `credentials` row and marks the submission accepted in ONE
 *     transaction. The two CHECK constraints — submission_reviewed_has_reviewer and
 *     submission_accepted_has_credential — describe the shape of a reviewed row; the
 *     transaction is what stops a submission reading 'accepted' while the credential it
 *     points at was never written. Same trick, and the same reason, as
 *     lib/domain/referral.ts, where a referral and its disclosure go in together.
 *
 *  2. Nothing on the credential is copied from the submission. The expiry, the
 *     verification source, the verified-on date and the identifier are all typed by the
 *     operator from what they checked against the issuing body. A provider's assertion
 *     about their own document is not evidence — that is the whole point of 0008, and
 *     prefilling these fields from the submission would hand the provider back, through
 *     the form, exactly the write the migration took away.
 *
 * There is no bulk accept and no "accept as submitted" path, for the same reason.
 */
import { getDb } from '@h-hallows/core/db';
import { asISODate } from '@h-hallows/core/domain';
import type { CredentialType } from '@h-hallows/core/schema';
import { audit, type AuditContext } from '@/lib/audit';
import { assertInspection, type LicenceInspection } from '@/lib/domain/licenceInspection';
import { emit } from '@/lib/metrics';

export class SubmissionError extends Error {}

/**
 * What the OPERATOR checked. Every field here is their finding, not the provider's
 * claim; `credential_submissions.identifier` is deliberately not a default for any of
 * them. See rule 2 above.
 */
export interface AcceptSubmissionInput {
  submissionId: string;
  /** The identifier as the issuing body has it, re-keyed by the operator. */
  identifier?: string | null;
  issuedOn?: string | null;
  /** Null means the credential does not expire. Typed by the operator either way. */
  expiresOn: string | null;
  verifiedOn: string;
  /** How it was checked, e.g. "BRN license verification". Required; free text. */
  verificationSource: string;
  /** Anything the operator wants on the submission record itself. */
  reviewNote?: string | null;
  /** Operator note stored on the credential. */
  notes?: string | null;
  /**
   * § 1812.528: the licence physically inspected, with the expiry noted from the
   * document itself. Required for a nursing licence; see lib/domain/licenceInspection.
   * `expiryNoted` is what the operator read off the document in front of them, which is
   * why it is separate from `expiresOn`, what the issuing body says.
   */
  inspection?: LicenceInspection | null;
}

export interface AcceptSubmissionResult {
  submissionId: string;
  credentialId: string;
  providerId: string;
  type: CredentialType;
  /** True when the provider already held a live credential of this type. */
  renewed: boolean;
}

export interface RejectSubmissionInput {
  submissionId: string;
  /** Required. A rejection with no stated reason is not a reviewable record. */
  reviewNote: string;
}

interface SubmissionRow {
  id: string;
  provider_id: string;
  type: CredentialType;
  state: 'submitted' | 'accepted' | 'rejected';
  document_url: string | null;
}

/**
 * Accept a submission: create the verified credential and mark the submission accepted,
 * together or not at all.
 *
 * `verified_by` is the operator from the audit context. It is never read from the
 * submission, and there is no parameter that would let a caller supply it.
 */
/**
 * Credential types that always carry an expiry.
 *
 * A blank expiry is right for a Live Scan and never right for these. The consequence
 * is not cosmetic: credStatus(null) is 'none', eligibility() blocks only on 'expired',
 * and worstRequiredStatus ranks 'none' as the BEST status — so one empty date field
 * produced a required credential that never expires, never blocks a shortlist and
 * never appears on the Today or Compliance screens. That is the I12 outcome reached
 * through a form field instead of an override.
 */
const MUST_EXPIRE: readonly string[] = [
  'rn_license', 'lvn_license', 'cna_cert', 'hca_registry', 'tb_clearance', 'cpr_bls',
  'auto_insurance', 'drivers_license',
];

export async function acceptSubmission(
  ctx: AuditContext,
  input: AcceptSubmissionInput,
): Promise<AcceptSubmissionResult> {
  if (!input.verificationSource.trim()) {
    throw new SubmissionError('Record how the credential was verified against the issuing body.');
  }
  if (!input.verifiedOn.trim()) {
    throw new SubmissionError('Record the date the credential was verified.');
  }

  const handle = await getDb();
  const result = await handle.transaction(async (tx): Promise<AcceptSubmissionResult> => {
    const [submission] = await tx.query<SubmissionRow>(
      `SELECT id, provider_id, type, state, document_url
         FROM credential_submissions
        WHERE id = $1
        FOR UPDATE`,
      [input.submissionId],
    );
    if (!submission) throw new SubmissionError('Submission not found.');
    if (submission.state !== 'submitted') {
      throw new SubmissionError(`This submission has already been ${submission.state}.`);
    }

    // Caught here so the operator reads a sentence rather than a constraint name. The
    // CHECK is still what enforces it; this is only the readable half.
    if (MUST_EXPIRE.includes(submission.type) && !input.expiresOn?.trim()) {
      throw new SubmissionError(
        'This credential expires, so it needs an expiry date. Leaving it blank would '
        + 'record it as never expiring, and it would stop appearing in the renewal '
        + 'queue entirely.',
      );
    }

    // § 1812.528, same rule and same message as the credential vault's own form.
    const { inspectedAt, inspectedBy, inspectedExpiryNoted: inspectedExpiry } =
      assertInspection(submission.type, input.inspection, ctx.actor, input.verifiedOn);

    // One live row per credential type (credentials_one_live_per_type), so a provider
    // handing in a renewal updates the row they already have rather than adding a
    // second. The history goes to credential_events, which is append-only.
    const [existing] = await tx.query<{
      id: string; expires_on: string | null; verified_on: string;
    }>(
      `SELECT id, expires_on, verified_on FROM credentials
        WHERE provider_id = $1 AND type = $2 AND deleted_at IS NULL`,
      [submission.provider_id, submission.type],
    );

    let credentialId: string;
    if (existing) {
      await tx.query(
        `UPDATE credentials
            SET identifier = $2, issued_on = $3, expires_on = $4, verified_on = $5,
                verified_by = $6, verification_source = $7, document_url = $8, notes = $9,
                inspected_at = COALESCE($10, inspected_at),
                inspected_by = COALESCE($11, inspected_by),
                inspected_expiry_noted = COALESCE($12, inspected_expiry_noted)
          WHERE id = $1`,
        [existing.id, input.identifier ?? null, input.issuedOn ?? null,
          input.expiresOn ?? null, input.verifiedOn, ctx.actor, input.verificationSource,
          submission.document_url, input.notes ?? null,
          inspectedAt, inspectedBy, inspectedExpiry],
      );
      await tx.query(
        `INSERT INTO credential_events
           (credential_id, actor, prev_expires_on, new_expires_on,
            prev_verified_on, new_verified_on, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [existing.id, ctx.actor, asISODate(existing.expires_on), input.expiresOn ?? null,
          asISODate(existing.verified_on), input.verifiedOn, input.notes ?? null],
      );
      await emit('credential_renewed', { providerId: submission.provider_id },
        { type: submission.type, fromSubmission: submission.id }, tx);
      credentialId = existing.id;
    } else {
      const [created] = await tx.query<{ id: string }>(
        `INSERT INTO credentials
           (provider_id, type, identifier, issued_on, expires_on, verified_on,
            verified_by, verification_source, document_url, notes,
            inspected_at, inspected_by, inspected_expiry_noted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [submission.provider_id, submission.type, input.identifier ?? null,
          input.issuedOn ?? null, input.expiresOn ?? null, input.verifiedOn, ctx.actor,
          input.verificationSource, submission.document_url, input.notes ?? null,
          inspectedAt, inspectedBy, inspectedExpiry],
      );
      if (!created) throw new SubmissionError('Could not record the credential.');
      await tx.query(
        `INSERT INTO credential_events
           (credential_id, actor, new_expires_on, new_verified_on, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [created.id, ctx.actor, input.expiresOn ?? null, input.verifiedOn,
          input.notes ?? null],
      );
      credentialId = created.id;
    }

    // Only now, and only in this transaction, does the submission say it was accepted.
    // The `state = 'submitted'` predicate is the second guard: if anything else reviewed
    // this row since the SELECT, no row updates and the credential write above is undone.
    const [reviewed] = await tx.query<{ id: string }>(
      `UPDATE credential_submissions
          SET state = 'accepted', reviewed_at = now(), reviewed_by = $2,
              review_note = $3, credential_id = $4
        WHERE id = $1 AND state = 'submitted'
        RETURNING id`,
      [submission.id, ctx.actor, input.reviewNote?.trim() || null, credentialId],
    );
    if (!reviewed) throw new SubmissionError('This submission was reviewed by someone else.');

    return {
      submissionId: submission.id,
      credentialId,
      providerId: submission.provider_id,
      type: submission.type,
      renewed: Boolean(existing),
    };
  });

  await audit({
    ...ctx,
    action: 'update',
    entity: 'credential_submission',
    entityId: result.submissionId,
    diff: {
      state: { from: 'submitted', to: 'accepted' },
      credentialId: result.credentialId,
      type: result.type,
      expiresOn: input.expiresOn,
      verifiedOn: input.verifiedOn,
      verificationSource: input.verificationSource,
    },
  });
  return result;
}

/**
 * Reject a submission. Writes no credential, so nothing the provider sent changes what
 * they are eligible for. The submission itself is kept: what was handed in is a record
 * of what was handed in.
 */
export async function rejectSubmission(
  ctx: AuditContext,
  input: RejectSubmissionInput,
): Promise<{ submissionId: string; providerId: string }> {
  const note = input.reviewNote.trim();
  if (!note) {
    throw new SubmissionError('Record why the submission was not accepted.');
  }

  const handle = await getDb();
  const row = await handle.transaction(async (tx) => {
    const [rejected] = await tx.query<{ id: string; provider_id: string }>(
      `UPDATE credential_submissions
          SET state = 'rejected', reviewed_at = now(), reviewed_by = $2, review_note = $3
        WHERE id = $1 AND state = 'submitted'
        RETURNING id, provider_id`,
      [input.submissionId, ctx.actor, note],
    );
    if (!rejected) {
      const [exists] = await tx.query<{ state: string }>(
        `SELECT state FROM credential_submissions WHERE id = $1`, [input.submissionId],
      );
      throw new SubmissionError(
        exists ? `This submission has already been ${exists.state}.` : 'Submission not found.',
      );
    }
    return rejected;
  });

  await audit({
    ...ctx,
    action: 'update',
    entity: 'credential_submission',
    entityId: row.id,
    diff: { state: { from: 'submitted', to: 'rejected' }, reviewNote: note },
  });
  return { submissionId: row.id, providerId: row.provider_id };
}
