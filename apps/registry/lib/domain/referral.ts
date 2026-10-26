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
import type { Tx } from '@ccn/core/db';
import { getDb } from '@ccn/core/db';
import { emit } from '@/lib/metrics';
import { asISODate, civilLA, eligibility, formatISODate, writtenStatementDueOn } from '@ccn/core/domain';
import type { CredentialLike } from '@ccn/core/domain';

/**
 * Which care types are private duty nursing under Civil Code § 1812.524. Defined in
 * @ccn/core because the front door has to apply the same test — an intake form that
 * disagrees about what counts as skilled is an intake form that collects the wrong
 * record. Re-exported so existing imports in this app keep working.
 */
import { SKILLED, isSkilled } from '@ccn/core/domain';
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
  /** Overridable only in tests, so the business-day maths is assertable. */
  now?: Date;
}

export interface MakeReferralResult {
  referralId: string;
  disclosureId: string;
  writtenDueOn: string;
}

export class ReferralError extends Error {}

export async function makeReferral(input: MakeReferralInput): Promise<MakeReferralResult> {
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

    await emit('referral_made', { caseId: input.caseId, providerId: input.providerId },
      { method: input.method, writtenDueOn: writtenDue }, tx);

    return { referralId: referral.id, disclosureId: disclosure.id, writtenDueOn: writtenDue };
  });
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
  disclosureId: string,
  sentOn: string,
  method: string,
  actor: string,
): Promise<void> {
  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [row] = await tx.query<{ case_id: string }>(
      `UPDATE disclosures SET written_sent_on = $2, written_method = $3
        WHERE id = $1 RETURNING case_id`,
      [disclosureId, sentOn, method],
    );
    if (!row) throw new ReferralError('Disclosure not found.');
    await insertTimeline(tx, {
      caseId: row.case_id,
      type: 'written_disclosure',
      author: actor,
      body: `Written statement sent ${sentOn} by ${method}.`,
    });
    await tx.query(`UPDATE cases SET written_sent_on = $2 WHERE id = $1`, [row.case_id, sentOn]);
  });
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

export async function endEngagement(input: {
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
  });
}
