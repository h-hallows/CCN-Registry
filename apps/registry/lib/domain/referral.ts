/**
 * The referral transaction. Spec § 4.6.
 *
 * I3: no code path creates a referral row without an explicit operator action that also
 * writes a disclosure row in the same transaction. The `referrals.disclosure_id` FK is
 * NOT NULL, so the database refuses the half-done state even if this function is
 * bypassed — but this is the only sanctioned way in.
 *
 * There is no skip path and no "record later" option. `spokenDisclosureGiven` must be
 * explicitly true: the operator confirms, in an un-prechecked box, that the spoken
 * disclosure was given, and names the person it was given to.
 *
 * Counsel question 1 (COUNSEL.md) is open, so `method` permits only a live human
 * channel. If counsel later allows a recorded or interactive voice disclosure, that is a
 * schema change plus a review, not a config flag.
 */
import type { Tx } from '@h-hallows/core/db';
import { getDb } from '@h-hallows/core/db';
import { audit, type AuditContext } from '@/lib/audit';
import { emit } from '@/lib/metrics';
import { asISODate, civilLA, eligibility, formatISODate, writtenStatementDueOn } from '@h-hallows/core/domain';
import type { CredentialLike } from '@h-hallows/core/domain';

/**
 * Which care types are private duty nursing under Civil Code § 1812.524. Defined in
 * @h-hallows/core because the front door has to apply the same test — an intake form that
 * disagrees about what counts as skilled is an intake form that collects the wrong
 * record. Re-exported so existing imports in this app keep working.
 */
import { SKILLED, isSkilled } from '@h-hallows/core/domain';
export { SKILLED as SKILLED_CARE_TYPES, isSkilled };

export interface MakeReferralInput {
  caseId: string;
  providerId: string;
  /** The person the spoken disclosure was given to. Required; § 1812.5095(f). */
  disclosedTo: string;
  /** The operator who gave it. */
  disclosedBy: string;
  method: 'phone' | 'in_person';
  /** Must be explicitly true. The modal's confirmation is never pre-checked. */
  spokenDisclosureGiven: boolean;
  /** Optional note added to the referral timeline entry. */
  note?: string;
  /**
   * The household's own request this referral answers, if it answers one.
   *
   * Architecture spec § 3.1: a request never becomes a referral by itself, so the link
   * is written in this direction and only here — after the referral row exists, inside
   * the same transaction. The request must be pending, must sit on a bench published for
   * this case, and must name this provider. Any of those failing aborts the referral
   * rather than quietly recording an unlinked one, because the two records disagreeing
   * is the thing the CHECK constraint on that table exists to prevent.
   */
  fromRequestId?: string;
  /** Overridable only in tests, so the business-day maths is assertable. */
  now?: Date;
}

export interface MakeReferralResult {
  referralId: string;
  disclosureId: string;
  writtenDueOn: string;
}

export class ReferralError extends Error {}

export async function makeReferral(
  ctx: AuditContext,
  input: MakeReferralInput,
): Promise<MakeReferralResult> {
  if (input.spokenDisclosureGiven !== true) {
    throw new ReferralError(
      'The spoken disclosure must be given and confirmed before a referral can be recorded.',
    );
  }
  if (!input.disclosedTo.trim()) {
    throw new ReferralError('Record the name of the person the disclosure was given to.');
  }

  const handle = await getDb();
  const now = input.now ?? new Date();
  const today = formatISODate(civilLA(now));
  const writtenDue = writtenStatementDueOn(today);

  return handle.transaction(async (tx) => {
    await assertCaseReferable(tx, input.caseId);
    await assertProviderEligible(tx, input.providerId, now);

    const disclosureTimeline = await insertTimeline(tx, {
      caseId: input.caseId,
      type: 'disclosure',
      author: input.disclosedBy,
      body:
        `Spoken disclosure given to ${input.disclosedTo} by ${input.method === 'phone' ? 'phone' : 'in person'}. `
        + `Written statement due ${writtenDue}.`,
      providerId: input.providerId,
    });

    const [disclosure] = await tx.query<{ id: string }>(
      `INSERT INTO disclosures
         (case_id, timeline_id, disclosed_to, disclosed_by, method, written_due_on)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [input.caseId, disclosureTimeline, input.disclosedTo.trim(), input.disclosedBy,
        input.method, writtenDue],
    );
    if (!disclosure) throw new ReferralError('Could not record the disclosure.');

    // I3: the referral is inserted only after, and only with, its disclosure.
    const [referral] = await tx.query<{ id: string }>(
      `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.caseId, input.providerId, disclosure.id, input.disclosedBy],
    );
    if (!referral) throw new ReferralError('Could not record the referral.');

    await insertTimeline(tx, {
      caseId: input.caseId,
      type: 'referral',
      author: input.disclosedBy,
      body: input.note?.trim() || 'Provider referred to the household.',
      providerId: input.providerId,
    });

    /**
     * Spec § 4.6 writes `status='referred'` unconditionally. That would move an already
     * active case backwards when an alternate is referred mid-engagement, so the status
     * only moves forward out of inquiry/matching. referred_on and written_due_on track
     * the most recent referral either way.
     */
    await tx.query(
      `UPDATE cases
          SET status = CASE WHEN status IN ('inquiry','matching') THEN 'referred'::case_status
                            ELSE status END,
              referred_on = $2,
              written_due_on = $3
        WHERE id = $1`,
      [input.caseId, today, writtenDue],
    );

    if (input.fromRequestId) {
      await linkRequest(tx, input.fromRequestId, input.caseId, input.providerId, referral.id);
    }

    await emit('referral_made', { caseId: input.caseId, providerId: input.providerId },
      { method: input.method, writtenDueOn: writtenDue }, tx);

    /**
     * In the transaction, with the rows it describes. § 1812.5095(f) makes this the
     * record that the spoken disclosure was given and when the written statement fell
     * due; `metric_events` is instrumentation and is not that record.
     */
    await audit({
      ...ctx,
      action: 'create',
      entity: 'referral',
      entityId: referral.id,
      diff: {
        caseId: input.caseId,
        providerId: input.providerId,
        disclosureId: disclosure.id,
        disclosedTo: input.disclosedTo.trim(),
        disclosedBy: input.disclosedBy,
        method: input.method,
        writtenDueOn: writtenDue,
        fromRequestId: input.fromRequestId ?? null,
      },
    }, tx);

    return { referralId: referral.id, disclosureId: disclosure.id, writtenDueOn: writtenDue };
  });
}

/**
 * Mark the household's request as answered by this referral.
 *
 * The UPDATE names `status` and `referral_id` together because
 * `shortlist_request_referred_has_referral` refuses either without the other — so a bug
 * here is a raised exception and a rolled-back referral, not a half-linked record.
 */
async function linkRequest(
  tx: Tx,
  requestId: string,
  caseId: string,
  providerId: string,
  referralId: string,
): Promise<void> {
  const [req] = await tx.query<{ status: string; case_id: string; provider_id: string }>(
    `SELECT r.status::text AS status, s.case_id, r.provider_id
       FROM shortlist_requests r
       JOIN published_shortlists s ON s.id = r.shortlist_id
      WHERE r.id = $1`,
    [requestId],
  );
  if (!req) throw new ReferralError('That request does not exist.');
  if (req.status !== 'pending') {
    throw new ReferralError(`That request is already ${req.status.replace(/_/g, ' ')}.`);
  }
  if (req.case_id !== caseId) {
    throw new ReferralError('That request belongs to another case.');
  }
  if (req.provider_id !== providerId) {
    throw new ReferralError('That request is about a different provider.');
  }

  await tx.query(
    `UPDATE shortlist_requests
        SET status = 'referred', referral_id = $2, resolved_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [requestId, referralId],
  );
}

async function assertCaseReferable(tx: Tx, caseId: string): Promise<void> {
  const [row] = await tx.query<{ status: string; care: string; physician_name: string | null }>(
    `SELECT c.status, c.care, h.physician_name
       FROM cases c JOIN households h ON h.id = c.household_id
      WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [caseId],
  );
  if (!row) throw new ReferralError('Case not found.');
  if (row.status === 'ended') throw new ReferralError('This engagement has ended.');

  // I11. Also enforced by trg_physician_skilled; asserted here so the operator gets a
  // readable message instead of a raised exception.
  if (isSkilled(row.care)
      && !row.physician_name?.trim()) {
    throw new ReferralError(
      'A skilled case cannot be referred without an ordering physician on the household record.',
    );
  }
}

async function assertProviderEligible(tx: Tx, providerId: string, now: Date): Promise<void> {
  const [provider] = await tx.query<{
    full_name: string; type: never; transports: boolean; status: never;
  }>(
    `SELECT full_name, type, transports, status FROM providers
      WHERE id = $1 AND deleted_at IS NULL`,
    [providerId],
  );
  if (!provider) throw new ReferralError('Provider not found.');

  const creds = await tx.query<{ type: never; expires_on: string | null }>(
    `SELECT type, expires_on FROM credentials
      WHERE provider_id = $1 AND deleted_at IS NULL`,
    [providerId],
  );

  // I12: no override exists, for any role.
  const result = eligibility(
    { type: provider.type, transports: provider.transports, status: provider.status },
    creds.map((c): CredentialLike => ({ type: c.type, expiresOn: asISODate(c.expires_on) })),
    now,
  );
  if (!result.eligible) {
    throw new ReferralError(
      `${provider.full_name} cannot be referred: ${result.reason ?? 'not eligible'}.`,
    );
  }
}

type TimelineType =
  | 'inquiry' | 'call' | 'note' | 'shortlist' | 'referral' | 'disclosure'
  | 'written_disclosure' | 'schedule_change' | 'document' | 'status_change';

export async function insertTimeline(
  tx: Tx,
  entry: {
    caseId?: string | null;
    householdId?: string | null;
    type: TimelineType;
    author: string;
    body: string;
    providerId?: string | null;
  },
): Promise<string> {
  // `at` is server-set. It is never accepted from the client.
  const [row] = await tx.query<{ id: string }>(
    `INSERT INTO timeline_entries (case_id, household_id, type, author, body, provider_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [entry.caseId ?? null, entry.householdId ?? null, entry.type, entry.author, entry.body,
      entry.providerId ?? null],
  );
  if (!row) throw new ReferralError('Could not write the timeline entry.');
  return row.id;
}

/**
 * Mark the § 1812.5095(f) written statement as sent. The disclosure record is immutable
 * apart from these two fields (trg_disclosure_guard).
 */
export async function markWrittenStatementSent(
  ctx: AuditContext,
  disclosureId: string,
  sentOn: string,
  method: string,
  actor: string,
  /**
   * A copy of what was actually sent, if one was kept. Migration 0018.
   *
   * Optional, and that is the deliberate part: some statements go out by post from a
   * template and nobody scans the copy. Requiring one would make the choice between an
   * unrecorded delivery and a fabricated document, and an unrecorded delivery is the
   * § 1812.5095(f) failure the whole screen exists to prevent.
   */
  sentStatement?: { filename: string; contentType: string; bytes: Buffer },
): Promise<void> {
  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [before] = await tx.query<{ case_id: string }>(
      `SELECT case_id FROM disclosures WHERE id = $1`, [disclosureId]);
    if (!before) throw new ReferralError('Disclosure not found.');

    /*
     * The document is filed first, inside this transaction, so the reference the
     * disclosure takes cannot point at a row that failed to write — and a failure
     * anywhere below rolls the document back with the delivery it belongs to.
     */
    let documentId: string | null = null;
    if (sentStatement) {
      const { fileDocumentIn } = await import('@/lib/queries/documents');
      documentId = await fileDocumentIn(tx, ctx, {
        subject: { kind: 'case', id: before.case_id },
        kind: 'written_statement',
        filename: sentStatement.filename,
        contentType: sentStatement.contentType,
        bytes: sentStatement.bytes,
        note: `The statement sent ${sentOn} by ${method}.`,
        // They received it. A copy of their own statement is theirs to re-read.
        visibleToSubject: true,
      });
    }

    const [row] = await tx.query<{ case_id: string }>(
      `UPDATE disclosures
          SET written_sent_on = $2, written_method = $3,
              written_statement_document_id = COALESCE($4, written_statement_document_id)
        WHERE id = $1 RETURNING case_id`,
      [disclosureId, sentOn, method, documentId],
    );
    if (!row) throw new ReferralError('Disclosure not found.');
    await insertTimeline(tx, {
      caseId: row.case_id,
      type: 'written_disclosure',
      author: actor,
      body: `Written statement sent ${sentOn} by ${method}.`
        + (documentId ? ' A copy of what was sent is on file.' : ''),
    });
    await tx.query(`UPDATE cases SET written_sent_on = $2 WHERE id = $1`, [row.case_id, sentOn]);
    await audit({
      ...ctx,
      action: 'update',
      entity: 'disclosure',
      entityId: disclosureId,
      diff: {
        writtenSentOn: sentOn,
        writtenMethod: method,
        caseId: row.case_id,
        writtenStatementDocumentId: documentId,
      },
    }, tx);
  });
}

/**
 * Record what came of a referral. Spec § 4.6, § 8.
 *
 * Migration 0001 anticipated this write — "Referrals may be updated only to record an
 * outcome", enforced by trg_referral_guard — and the app never made it. The referral
 * could be created and never resolved, which had three consequences that all look like
 * missing data rather than a missing feature:
 *
 *  - `cases.primary_provider_id` was never set by anything, so endEngagement read it as
 *    null and `engagement_ended` carried no provider. That is the LEAKAGE series in § 8,
 *    unattributable.
 *  - `engagement_started` was declared in MetricName and emitted by nothing, so there
 *    was no start to measure a duration from.
 *  - the roster's placement count is `count(*) FILTER (WHERE outcome = 'engaged')`, so
 *    every provider showed zero engagements and a null average, permanently.
 *
 * I4: none of the four outcomes is one the registry can cause. The household engaged
 * someone or declined, the provider declined, or nobody answered. There is no value here
 * for the registry ending anything, and `endEngagement` remains the only way an
 * engagement closes.
 *
 * Write-once. The outcome is part of the permanent referral record, and the trigger
 * allows the update whether or not one is already there, so the guard is here.
 */
export type ReferralOutcome =
  | 'engaged' | 'declined_by_household' | 'declined_by_provider' | 'no_response';

const OUTCOME_WORDING: Record<ReferralOutcome, string> = {
  engaged: 'The household engaged this provider.',
  declined_by_household: 'The household declined this provider.',
  declined_by_provider: 'The provider declined this referral.',
  no_response: 'No response to this referral.',
};

export async function recordReferralOutcome(
  ctx: AuditContext,
  input: {
    referralId: string;
    outcome: ReferralOutcome;
    note?: string;
    /** The operator recording it, by name, for the timeline the household may be shown. */
    actor: string;
  },
): Promise<{ caseId: string; providerId: string; engaged: boolean }> {
  const handle = await getDb();
  const result = await handle.transaction(async (tx) => {
    const [referral] = await tx.query<{
      case_id: string; provider_id: string; outcome: string | null;
      full_name: string; status: string; primary_provider_id: string | null;
    }>(
      `SELECT r.case_id, r.provider_id, r.outcome, p.full_name,
              c.status, c.primary_provider_id
         FROM referrals r
         JOIN providers p ON p.id = r.provider_id
         JOIN cases c ON c.id = r.case_id
        WHERE r.id = $1
        FOR UPDATE OF r`,
      [input.referralId],
    );
    if (!referral) throw new ReferralError('Referral not found.');
    if (referral.outcome) {
      throw new ReferralError(
        `An outcome is already recorded for this referral (${referral.outcome.replace(/_/g, ' ')}). `
        + 'The referral record is permanent and is not corrected in place.',
      );
    }

    const [updated] = await tx.query<{ id: string }>(
      `UPDATE referrals SET outcome = $2, outcome_note = $3, outcome_at = now()
        WHERE id = $1 AND outcome IS NULL
        RETURNING id`,
      [input.referralId, input.outcome, input.note?.trim() || null],
    );
    if (!updated) throw new ReferralError('This referral was resolved by someone else.');

    const engaged = input.outcome === 'engaged';
    if (engaged) {
      /**
       * The case moves forward only out of the pre-engagement statuses, for the same
       * reason makeReferral does: an alternate engaged mid-engagement must not drag an
       * active or paused case backwards, and an ended one stays ended.
       */
      await tx.query(
        `UPDATE cases
            SET primary_provider_id = $2,
                status = CASE WHEN status IN ('inquiry','matching','referred')
                              THEN 'active'::case_status ELSE status END
          WHERE id = $1`,
        [referral.case_id, referral.provider_id],
      );
      await emit('engagement_started',
        { caseId: referral.case_id, providerId: referral.provider_id }, {}, tx);
    }

    await insertTimeline(tx, {
      caseId: referral.case_id,
      type: engaged ? 'status_change' : 'referral',
      author: input.actor,
      body: `${OUTCOME_WORDING[input.outcome]}${input.note?.trim() ? ` ${input.note.trim()}` : ''}`,
      providerId: referral.provider_id,
    });

    await audit({
      ...ctx,
      action: 'update',
      entity: 'referral',
      entityId: input.referralId,
      diff: {
        outcome: { from: null, to: input.outcome },
        caseId: referral.case_id,
        providerId: referral.provider_id,
        ...(engaged
          ? { primaryProviderId: { from: referral.primary_provider_id, to: referral.provider_id } }
          : {}),
        recordedBy: input.actor,
      },
    }, tx);

    return { caseId: referral.case_id, providerId: referral.provider_id, engaged };
  });
  return result;
}

/**
 * I4: the registry cannot end a household–provider relationship. Only the household
 * ending the engagement, the provider declining, or a mutual end is recordable, and the
 * `ended_by` enum has no `registry` member. There is deliberately no terminateProvider
 * function in this codebase.
 *
 * § 8: end_reason is required and comes from a fixed list, one option being the
 * direct-arrangement case. As free text it would be left blank, and the number that
 * matters most would not exist.
 */
export type EndReasonCode =
  | 'moved_to_direct_arrangement' | 'care_no_longer_needed' | 'hospitalized'
  | 'moved_to_facility' | 'deceased' | 'cost' | 'household_dissatisfied'
  | 'provider_unavailable' | 'moved_to_another_agency' | 'other';

export async function endEngagement(ctx: AuditContext, input: {
  caseId: string;
  endedBy: 'household' | 'provider' | 'mutual';
  endReason: EndReasonCode;
  note?: string;
  endedOn: string;
  actor: string;
}): Promise<void> {
  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [before] = await tx.query<{ created_at: string; primary_provider_id: string | null }>(
      `SELECT created_at, primary_provider_id FROM cases WHERE id = $1`, [input.caseId],
    );
    if (!before) throw new ReferralError('Case not found.');

    await tx.query(
      `UPDATE cases
          SET status = 'ended', ended_on = $2, ended_by = $3,
              end_reason = $4, end_reason_note = $5
        WHERE id = $1`,
      [input.caseId, input.endedOn, input.endedBy, input.endReason, input.note ?? null],
    );
    await insertTimeline(tx, {
      caseId: input.caseId,
      type: 'status_change',
      author: input.actor,
      body: `Engagement ended ${input.endedOn}, ended by ${input.endedBy}. `
        + `Reason: ${input.endReason.replace(/_/g, ' ')}.${input.note ? ` ${input.note}` : ''}`,
    });

    const weeks = Math.max(
      0,
      Math.round(
        (Date.parse(`${input.endedOn}T12:00:00Z`) - Date.parse(before.created_at)) / 604_800_000,
      ),
    );
    await emit('engagement_ended',
      { caseId: input.caseId, providerId: before.primary_provider_id },
      { endReason: input.endReason, endedBy: input.endedBy, weeks }, tx);

    // I4: the registry did not end this. The log records who recorded it, and that the
    // household, the provider or both are what ended it.
    await audit({
      ...ctx,
      action: 'update',
      entity: 'case',
      entityId: input.caseId,
      diff: {
        status: { from: 'active', to: 'ended' },
        endedOn: input.endedOn,
        endedBy: input.endedBy,
        endReason: input.endReason,
        recordedBy: input.actor,
      },
    }, tx);
  });
}
