/**
 * The bench the household sees, and what comes back from it. Architecture spec § 3.1.
 *
 * This is the operator half of the client portal. Until it existed, `published_shortlists`
 * was written by nobody and `shortlist_requests` was read by nobody: the household portal
 * could show an empty bench forever, and a household that did ask about someone was
 * asking into a table no screen displayed.
 *
 * THE LOAD-BEARING RULE, same as the schema's: a request is a request. Nothing in this
 * file creates a referral. The one path that resolves a request into a referral is
 * `makeReferral`, which writes the § 1812.5095(f) disclosure in the same transaction and
 * then writes the request's `referral_id` back — see `fromRequestId` there.
 *
 * Publishing is the moment a provider reaches a client, so I12 is enforced here with the
 * same screen the match page runs, re-run inside the publishing transaction. A provider
 * whose Live Scan lapsed between the operator looking at the list and pressing the button
 * is refused by name.
 */
import { getDb, type Tx } from '@h-hallows/core/db';
import { audit, auditRead, type AuditContext } from '@/lib/audit';
import { insertTimeline, SKILLED_CARE_TYPES } from '@/lib/domain/referral';
import { screenCase } from './match';

export class BenchError extends Error {}

const SKILLED_SET: ReadonlySet<string> = new Set<string>(SKILLED_CARE_TYPES);

export interface BenchRequest {
  requestId: string;
  providerId: string;
  providerName: string;
  requestedAt: string;
  status: 'pending' | 'referred' | 'declined_by_household' | 'withdrawn';
  note: string | null;
  referralId: string | null;
  resolvedAt: string | null;
}

export interface BenchItem {
  providerId: string;
  providerName: string;
  type: string;
  position: number;
  /** Where the provider stands on the registry's own roster, right now. */
  providerStatus: string;
  requests: BenchRequest[];
}

export interface Bench {
  shortlistId: string;
  caseId: string;
  publishedAt: string;
  publishedBy: string;
  note: string | null;
  withdrawnAt: string | null;
  items: BenchItem[];
}

/** Every bench ever published for a case, newest first, live ones included. */
export async function benchesFor(ctx: AuditContext, caseId: string): Promise<Bench[]> {
  const { query } = await getDb();

  const benches = await query<{
    id: string; case_id: string; published_at: string; published_by: string;
    note: string | null; withdrawn_at: string | null;
  }>(
    `SELECT id, case_id, published_at::text, published_by, note, withdrawn_at::text
       FROM published_shortlists
      WHERE case_id = $1
      ORDER BY published_at DESC`,
    [caseId],
  );
  if (benches.length === 0) return [];

  const ids = benches.map((b) => b.id);

  const items = await query<{
    shortlist_id: string; provider_id: string; full_name: string; type: string;
    position: number; status: string;
  }>(
    `SELECT i.shortlist_id, i.provider_id, p.full_name, p.type::text AS type,
            i.position, p.status::text AS status
       FROM published_shortlist_items i
       JOIN providers p ON p.id = i.provider_id
      WHERE i.shortlist_id = ANY($1::uuid[])
      ORDER BY i.position`,
    [ids],
  );

  const requests = await query<{
    id: string; shortlist_id: string; provider_id: string; full_name: string;
    requested_at: string; status: string; note: string | null;
    referral_id: string | null; resolved_at: string | null;
  }>(
    `SELECT r.id, r.shortlist_id, r.provider_id, p.full_name, r.requested_at::text,
            r.status::text AS status, r.note, r.referral_id, r.resolved_at::text
       FROM shortlist_requests r
       JOIN providers p ON p.id = r.provider_id
      WHERE r.shortlist_id = ANY($1::uuid[])
      ORDER BY r.requested_at`,
    [ids],
  );

  await auditRead(ctx, 'published_shortlist', caseId);

  return benches.map((b) => ({
    shortlistId: b.id,
    caseId: b.case_id,
    publishedAt: b.published_at,
    publishedBy: b.published_by,
    note: b.note,
    withdrawnAt: b.withdrawn_at,
    items: items
      .filter((i) => i.shortlist_id === b.id)
      .map((i) => ({
        providerId: i.provider_id,
        providerName: i.full_name,
        type: i.type,
        position: i.position,
        providerStatus: i.status,
        requests: requests
          .filter((r) => r.shortlist_id === b.id && r.provider_id === i.provider_id)
          .map(asRequest),
      })),
  }));
}

function asRequest(r: {
  id: string; provider_id: string; full_name: string; requested_at: string;
  status: string; note: string | null; referral_id: string | null; resolved_at: string | null;
}): BenchRequest {
  return {
    requestId: r.id,
    providerId: r.provider_id,
    providerName: r.full_name,
    requestedAt: r.requested_at,
    status: r.status as BenchRequest['status'],
    note: r.note,
    referralId: r.referral_id,
    resolvedAt: r.resolved_at,
  };
}

export interface PublishBenchInput {
  caseId: string;
  /** In the order the household should see them. */
  providerIds: string[];
  /** What the operator is telling the household. The household reads this verbatim. */
  note?: string;
  now?: Date;
}

export interface PublishBenchResult {
  shortlistId: string;
  count: number;
  /** Benches withdrawn to make room for this one. */
  replaced: number;
}

/**
 * Put a bench in front of a household.
 *
 * Two guards, both inside the transaction:
 *
 *  1. The case must be referable. An ended case has no bench.
 *  2. Every provider must clear the identical screen the match page ran — eligibility,
 *     scope of practice, area, stated availability and the household's own exclusions.
 *     The failure names the provider and the reason, because the operator needs to know
 *     which one and why; the household never sees either (I12).
 *
 * Publishing a new bench withdraws the live one. One case shows one bench, otherwise the
 * household's own screen shows two lists and no way to tell which is current. Requests
 * already made survive it: their SELECT policy deliberately does not require a live
 * bench, so a household keeps seeing what it asked for.
 */
export async function publishBench(
  ctx: AuditContext,
  input: PublishBenchInput,
): Promise<PublishBenchResult> {
  const providerIds = [...new Set(input.providerIds)];
  if (providerIds.length === 0) {
    throw new BenchError('Choose at least one provider to put in front of the household.');
  }

  const handle = await getDb();
  const now = input.now ?? new Date();

  return handle.transaction(async (tx) => {
    const [kase] = await tx.query<{ status: string }>(
      `SELECT status::text AS status FROM cases WHERE id = $1 AND deleted_at IS NULL`,
      [input.caseId],
    );
    if (!kase) throw new BenchError('Case not found.');
    if (kase.status === 'ended') throw new BenchError('This engagement has ended.');

    const screen = await screenCase(tx, input.caseId, now);
    if (!screen) throw new BenchError('Case not found.');

    const eligible = new Map(screen.eligible.map((e) => [e.providerId, e] as const));
    const excluded = new Map(screen.excluded.map((e) => [e.providerId, e] as const));

    for (const id of providerIds) {
      if (eligible.has(id)) continue;
      const no = excluded.get(id);
      throw new BenchError(
        no
          ? `${no.fullName} cannot be put in front of this household: ${no.exclusion.detail}`
          : 'One of those providers is no longer on the roster. Re-run the match.',
      );
    }

    const withdrawn = await tx.query<{ id: string }>(
      `UPDATE published_shortlists
          SET withdrawn_at = now()
        WHERE case_id = $1 AND withdrawn_at IS NULL
        RETURNING id`,
      [input.caseId],
    );

    const [bench] = await tx.query<{ id: string }>(
      `INSERT INTO published_shortlists (case_id, published_by, note)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.caseId, ctx.actor, input.note?.trim() || null],
    );
    if (!bench) throw new BenchError('Could not publish the bench.');

    for (const [position, providerId] of providerIds.entries()) {
      await tx.query(
        `INSERT INTO published_shortlist_items (shortlist_id, provider_id, position)
         VALUES ($1, $2, $3)`,
        [bench.id, providerId, position],
      );
    }

    const names = providerIds.map((id) => eligible.get(id)?.fullName ?? id);
    await insertTimeline(tx, {
      caseId: input.caseId,
      type: 'shortlist',
      author: ctx.actor,
      body:
        `Bench published to the household: ${names.join(', ')}.`
        + (withdrawn.length > 0 ? ` The previous bench was withdrawn.` : '')
        + (input.note?.trim() ? ` Note sent: ${input.note.trim()}` : ''),
    });

    await audit({
      ...ctx,
      action: 'create',
      entity: 'published_shortlist',
      entityId: bench.id,
      diff: {
        caseId: input.caseId,
        providerIds,
        note: input.note?.trim() || null,
        replacedShortlistIds: withdrawn.map((w) => w.id),
      },
    }, tx);

    return { shortlistId: bench.id, count: providerIds.length, replaced: withdrawn.length };
  });
}

/**
 * Take a bench back. The household stops seeing it, and with it stops seeing the
 * providers on it — `providers_household_select` is scoped to a live bench or a current
 * engagement, which is the point. Requests already made are unaffected.
 */
export async function withdrawBench(
  ctx: AuditContext,
  shortlistId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim()) throw new BenchError('Record why the bench was withdrawn.');

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [bench] = await tx.query<{ case_id: string; withdrawn_at: string | null }>(
      `SELECT case_id, withdrawn_at::text FROM published_shortlists WHERE id = $1`,
      [shortlistId],
    );
    if (!bench) throw new BenchError('That bench does not exist.');
    if (bench.withdrawn_at) throw new BenchError('That bench is already withdrawn.');

    await tx.query(
      `UPDATE published_shortlists SET withdrawn_at = now() WHERE id = $1`,
      [shortlistId],
    );

    await insertTimeline(tx, {
      caseId: bench.case_id,
      type: 'shortlist',
      author: ctx.actor,
      body: `Bench withdrawn from the household. ${reason.trim()}`,
    });

    await audit({
      ...ctx,
      action: 'update',
      entity: 'published_shortlist',
      entityId: shortlistId,
      diff: { withdrawnAt: { from: null, to: 'now' }, reason: reason.trim() },
    }, tx);
  });
}

export interface PendingRequest extends BenchRequest {
  caseId: string;
  shortlistId: string;
  householdName: string;
  /** The decision-maker, so the disclosure form is addressed to the right person. */
  dmName: string;
  care: string;
  crArea: string;
  /** True when this provider has already been referred on this case. */
  alreadyReferred: boolean;
  /**
   * I11: a skilled case cannot be referred without an ordering physician. Reported here
   * so the queue says so before the operator fills the form in, rather than after.
   */
  physicianMissing: boolean;
}

/**
 * Everything a household has asked about and nobody has answered, oldest first.
 *
 * Oldest first on purpose: this is a queue with a person at the other end of it, and the
 * § 1812.533(b)(5) response measure is about how long they waited.
 */
export async function pendingRequests(ctx: AuditContext): Promise<PendingRequest[]> {
  const { query } = await getDb();

  const rows = await query<{
    id: string; shortlist_id: string; case_id: string; provider_id: string;
    full_name: string; requested_at: string; note: string | null;
    display_name: string; dm_name: string; care: string; cr_area: string;
    already_referred: boolean; physician_name: string | null;
  }>(
    `SELECT r.id, r.shortlist_id, s.case_id, r.provider_id, p.full_name,
            r.requested_at::text, r.note,
            h.display_name, h.dm_name, c.care::text AS care, h.cr_area,
            h.physician_name,
            EXISTS (
              SELECT 1 FROM referrals rf
               WHERE rf.case_id = s.case_id AND rf.provider_id = r.provider_id
            ) AS already_referred
       FROM shortlist_requests r
       JOIN published_shortlists s ON s.id = r.shortlist_id
       JOIN cases c ON c.id = s.case_id
       JOIN households h ON h.id = c.household_id
       JOIN providers p ON p.id = r.provider_id
      WHERE r.status = 'pending'
        AND c.deleted_at IS NULL
        AND c.status <> 'ended'
      ORDER BY r.requested_at`,
  );

  await auditRead(ctx, 'shortlist_requests');

  return rows.map((r) => ({
    requestId: r.id,
    shortlistId: r.shortlist_id,
    caseId: r.case_id,
    providerId: r.provider_id,
    providerName: r.full_name,
    requestedAt: r.requested_at,
    status: 'pending' as const,
    note: r.note,
    referralId: null,
    resolvedAt: null,
    householdName: r.display_name,
    dmName: r.dm_name,
    care: r.care,
    crArea: r.cr_area,
    alreadyReferred: r.already_referred,
    physicianMissing: SKILLED_SET.has(r.care) && !r.physician_name?.trim(),
  }));
}

export async function countPendingRequests(): Promise<number> {
  const { query } = await getDb();
  const [row] = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM shortlist_requests r
       JOIN published_shortlists s ON s.id = r.shortlist_id
       JOIN cases c ON c.id = s.case_id
      WHERE r.status = 'pending' AND c.deleted_at IS NULL AND c.status <> 'ended'`,
  );
  return Number(row?.n ?? 0);
}

/**
 * Close a request that is not becoming a referral.
 *
 * Neither outcome is the registry's decision about the provider. `declined_by_household`
 * records what the household said; `withdrawn` records that it is not going ahead. The
 * only way a request reaches `referred` is through `makeReferral`, and the CHECK
 * constraint on the table refuses that status without a referral id, so this function
 * cannot reach it even by accident.
 */
export async function resolveRequest(
  ctx: AuditContext,
  requestId: string,
  outcome: 'declined_by_household' | 'withdrawn',
  note: string,
): Promise<void> {
  if (!note.trim()) throw new BenchError('Record what was said.');

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [req] = await tx.query<{
      status: string; case_id: string; provider_id: string; full_name: string;
    }>(
      `SELECT r.status::text AS status, s.case_id, r.provider_id, p.full_name
         FROM shortlist_requests r
         JOIN published_shortlists s ON s.id = r.shortlist_id
         JOIN providers p ON p.id = r.provider_id
        WHERE r.id = $1`,
      [requestId],
    );
    if (!req) throw new BenchError('That request does not exist.');
    if (req.status !== 'pending') {
      throw new BenchError(`That request is already ${req.status.replace(/_/g, ' ')}.`);
    }

    await tx.query(
      `UPDATE shortlist_requests
          SET status = $2::shortlist_request_status, resolved_at = now(), note = $3
        WHERE id = $1 AND status = 'pending'`,
      [requestId, outcome, note.trim()],
    );

    await insertTimeline(tx, {
      caseId: req.case_id,
      type: 'note',
      author: ctx.actor,
      providerId: req.provider_id,
      body:
        outcome === 'declined_by_household'
          ? `The household decided against ${req.full_name}. ${note.trim()}`
          : `The request about ${req.full_name} is not going ahead. ${note.trim()}`,
    });

    await audit({
      ...ctx,
      action: 'update',
      entity: 'shortlist_request',
      entityId: requestId,
      diff: { status: { from: 'pending', to: outcome }, note: note.trim() },
    }, tx);
  });
}

export interface FeedbackEntry {
  id: string;
  at: string;
  providerName: string;
  referralId: string;
  referralServiceRating: number | null;
  wouldReferAgain: boolean | null;
  notes: string | null;
}

/**
 * What the household said about the referral service, per § 1812.533(b)(5)(B).
 *
 * I7 and § 687.2(e): this informs future referral decisions and nothing else. There is
 * no action to take on a row here and no screen that offers one — no response field, no
 * rating shown against a provider's record, nothing that reaches the provider at all.
 * The rating is of the registry's referral, not of the person referred.
 */
export async function feedbackForCase(
  ctx: AuditContext,
  caseId: string,
): Promise<FeedbackEntry[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; at: string; full_name: string; referral_id: string;
    referral_service_rating: number | null; would_refer_again: boolean | null;
    notes: string | null;
  }>(
    `SELECT f.id, f.at::text, p.full_name, f.referral_id,
            f.referral_service_rating, f.would_refer_again, f.notes
       FROM referral_feedback f
       JOIN referrals r ON r.id = f.referral_id
       JOIN providers p ON p.id = r.provider_id
      WHERE r.case_id = $1
      ORDER BY f.at DESC`,
    [caseId],
  );

  if (rows.length > 0) await auditRead(ctx, 'referral_feedback', caseId);

  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    providerName: r.full_name,
    referralId: r.referral_id,
    referralServiceRating: r.referral_service_rating === null
      ? null : Number(r.referral_service_rating),
    wouldReferAgain: r.would_refer_again,
    notes: r.notes,
  }));
}
