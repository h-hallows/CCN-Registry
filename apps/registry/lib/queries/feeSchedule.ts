/**
 * The posted fee schedule, and who was given it. Civil Code § 1812.527.
 *
 * WHAT WAS MISSING. The provider portal reads `fee_schedules` and
 * `fee_schedule_deliveries`; nothing anywhere wrote either. So the statute's two
 * obligations — post a schedule, and give it to a nurse before the interview — could
 * not be met by the software at all, and `/pro/fee-schedule` was permanently empty for
 * every RN and LVN on the roster.
 *
 * THE EMBARGO IS THE DATABASE'S, NOT THIS FILE'S. § 1812.527 requires seven days
 * between posting and taking effect, and `fee_schedule_seven_day_embargo` refuses the
 * row otherwise. What this adds is a readable message and a default date that is
 * already legal, because a CHECK violation on a compliance screen tells the operator
 * they did something wrong and not what.
 *
 * NOTHING IS EVER EDITED. A schedule is posted and superseded, never amended — the
 * whole point of the embargo is that terms cannot change under somebody mid-engagement,
 * and an editable row makes the posted date a claim rather than a record.
 */
import { getDb } from '@h-hallows/core/db';
import { audit, auditRead, type AuditContext } from '@/lib/audit';
import { addDays, civilLA, daysBetween, formatISODate, parseISODate } from '@h-hallows/core/domain';

export class FeeScheduleError extends Error {}

/** § 1812.527 applies to nurses. The others have no posted schedule. */
export const COVERED_TYPES = ['RN', 'LVN'] as const;

export const EMBARGO_DAYS = 7;

export interface FeeScheduleRow {
  id: string;
  version: number;
  maxFeePct: string;
  paymentTerms: string;
  body: string;
  postedOn: string;
  effectiveFrom: string;
  inForce: boolean;
  upcoming: boolean;
  /** Nurses on the roster who have been recorded as given this version. */
  deliveredTo: number;
}

/**
 * Every version, newest first.
 *
 * Prior versions stay. A schedule that quietly replaced its predecessor would leave
 * nobody able to say what the terms were when somebody signed.
 */
export async function feeScheduleHistory(ctx: AuditContext): Promise<FeeScheduleRow[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; version: number; max_fee_pct: string; payment_terms: string;
    body: string; posted_on: string; effective_from: string;
    in_force: boolean; upcoming: boolean; delivered_to: string;
  }>(
    /*
     * "In force" is the latest version whose effective date has arrived, in
     * California. Deciding it from a UTC date showed a schedule as live up to eight
     * hours early on the one screen that exists to make the embargo auditable.
     */
    `WITH live AS (
       SELECT max(effective_from) AS on_date FROM fee_schedules
        WHERE effective_from <= (now() AT TIME ZONE 'America/Los_Angeles')::date
     )
     SELECT s.id, s.version, s.max_fee_pct::text, s.payment_terms, s.body,
            (s.posted_at AT TIME ZONE 'America/Los_Angeles')::date::text AS posted_on,
            s.effective_from::text,
            -- Coalesced: with nothing yet in force the subquery is NULL, and
            -- comparing to NULL yields NULL rather than false, which reaches the
            -- screen as a schedule that is neither live nor upcoming.
            coalesce(s.effective_from = (SELECT on_date FROM live), false) AS in_force,
            (s.effective_from > (now() AT TIME ZONE 'America/Los_Angeles')::date) AS upcoming,
            (SELECT count(*)::text FROM fee_schedule_deliveries d
              WHERE d.schedule_id = s.id) AS delivered_to
       FROM fee_schedules s
      ORDER BY s.version DESC`,
  );
  if (rows.length > 0) await auditRead(ctx, 'fee_schedule');
  return rows.map((r) => ({
    id: r.id,
    version: Number(r.version),
    maxFeePct: r.max_fee_pct,
    paymentTerms: r.payment_terms,
    body: r.body,
    postedOn: r.posted_on,
    effectiveFrom: r.effective_from,
    inForce: r.in_force,
    upcoming: r.upcoming,
    deliveredTo: Number(r.delivered_to),
  }));
}

/**
 * The earliest date a schedule posted now may take effect.
 *
 * Computed in California's civil calendar rather than with a Date, because the
 * database's CHECK compares against `posted_at AT TIME ZONE 'America/Los_Angeles'` —
 * and a UTC day boundary would offer a date the constraint then refuses, after the
 * operator had written the whole schedule.
 */
export function earliestEffectiveFrom(now = new Date()): string {
  return formatISODate(addDays(civilLA(now), EMBARGO_DAYS));
}

export interface PostInput {
  maxFeePct: number;
  paymentTerms: string;
  body: string;
  effectiveFrom: string;
  now?: Date;
}

export async function postFeeSchedule(
  ctx: AuditContext,
  input: PostInput,
): Promise<{ id: string; version: number }> {
  const terms = input.paymentTerms.trim();
  const body = input.body.trim();
  if (!Number.isFinite(input.maxFeePct) || input.maxFeePct <= 0 || input.maxFeePct > 100) {
    throw new FeeScheduleError('The maximum fee is a percentage between 0 and 100.');
  }
  if (terms.length < 3) throw new FeeScheduleError('Say what the payment terms are.');
  if (body.length < 20) {
    throw new FeeScheduleError('The schedule itself cannot be a sentence fragment.');
  }

  const earliest = earliestEffectiveFrom(input.now);
  if (input.effectiveFrom < earliest) {
    throw new FeeScheduleError(
      `§ 1812.527 needs seven days' notice, so the earliest this can take effect is `
      + `${earliest}.`,
    );
  }

  const handle = await getDb();
  return handle.transaction(async (tx) => {
    const [next] = await tx.query<{ version: number }>(
      `SELECT coalesce(max(version), 0) + 1 AS version FROM fee_schedules`,
    );

    const [row] = await tx.query<{ id: string; version: number }>(
      `INSERT INTO fee_schedules
         (version, max_fee_pct, payment_terms, body, posted_at, effective_from)
       VALUES ($1, $2, $3, $4, now(), $5::date)
       RETURNING id, version`,
      [next!.version, input.maxFeePct, terms, body, input.effectiveFrom],
    );
    if (!row) throw new FeeScheduleError('Could not post the schedule.');

    await audit({
      ...ctx,
      action: 'create',
      entity: 'fee_schedule',
      entityId: row.id,
      diff: {
        version: row.version,
        maxFeePct: input.maxFeePct,
        effectiveFrom: input.effectiveFrom,
        // The gap, written down, because it is the thing the statute is about.
        noticeDays: daysBetween(
          civilLA(input.now ?? new Date()), parseISODate(input.effectiveFrom)),
      },
    }, tx);

    return { id: row.id, version: row.version };
  });
}

export interface NurseDelivery {
  providerId: string;
  fullName: string;
  type: string;
  status: string;
  /** The newest version recorded as given to them, if any. */
  deliveredVersion: number | null;
  deliveredOn: string | null;
  beforeInterview: boolean | null;
  /** True when the version in force has not been recorded as given to them. */
  missingCurrent: boolean;
}

/**
 * Every nurse on the roster and where they stand on the current schedule.
 *
 * The auditable question § 1812.527 asks is not "is a schedule posted" but "was this
 * nurse given one, and before the interview". A list that answers it per person is the
 * only form in which a gap is visible.
 */
export async function nurseDeliveries(ctx: AuditContext): Promise<NurseDelivery[]> {
  const { query } = await getDb();
  const rows = await query<{
    provider_id: string; full_name: string; type: string; status: string;
    delivered_version: number | null; delivered_on: string | null;
    before_interview: boolean | null; missing_current: boolean;
  }>(
    `WITH current AS (
       SELECT id FROM fee_schedules
        WHERE effective_from <= (now() AT TIME ZONE 'America/Los_Angeles')::date
        ORDER BY effective_from DESC LIMIT 1
     )
     SELECT p.id AS provider_id, p.full_name, p.type::text AS type,
            p.status::text AS status,
            latest.version AS delivered_version,
            latest.delivered_on,
            latest.before_interview,
            NOT EXISTS (
              SELECT 1 FROM fee_schedule_deliveries d
               WHERE d.provider_id = p.id AND d.schedule_id = (SELECT id FROM current)
            ) AS missing_current
       FROM providers p
       LEFT JOIN LATERAL (
         SELECT s.version, d.delivered_at::date::text AS delivered_on, d.before_interview
           FROM fee_schedule_deliveries d JOIN fee_schedules s ON s.id = d.schedule_id
          WHERE d.provider_id = p.id
          ORDER BY s.version DESC LIMIT 1
       ) latest ON true
      WHERE p.deleted_at IS NULL AND p.type IN ('RN', 'LVN')
      ORDER BY (p.status = 'active') DESC, p.full_name`,
  );

  if (rows.length > 0) await auditRead(ctx, 'fee_schedule_delivery');

  return rows.map((r) => ({
    providerId: r.provider_id,
    fullName: r.full_name,
    type: r.type,
    status: r.status,
    deliveredVersion: r.delivered_version === null ? null : Number(r.delivered_version),
    deliveredOn: r.delivered_on,
    beforeInterview: r.before_interview,
    missingCurrent: r.missing_current,
  }));
}

/**
 * Record that a nurse was given the schedule.
 *
 * `beforeInterview` is asked rather than assumed. § 1812.527 says before the interview,
 * not at signing, and a delivery recorded as "after" is still worth recording — it is
 * the evidence of a gap, and a form that only accepts the compliant answer produces a
 * clean record of something that did not happen.
 */
export async function recordFeeScheduleDelivery(
  ctx: AuditContext,
  input: {
    providerId: string;
    scheduleId: string;
    deliveredOn: string;
    beforeInterview: boolean;
  },
): Promise<void> {
  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [provider] = await tx.query<{ type: string; full_name: string }>(
      `SELECT type::text AS type, full_name FROM providers
        WHERE id = $1 AND deleted_at IS NULL`,
      [input.providerId],
    );
    if (!provider) throw new FeeScheduleError('That provider does not exist.');
    if (!(COVERED_TYPES as readonly string[]).includes(provider.type)) {
      throw new FeeScheduleError(
        `§ 1812.527 covers nurses. ${provider.full_name} is ${provider.type}, so there `
        + 'is no schedule to give them.',
      );
    }

    const [existing] = await tx.query<{ id: string }>(
      `SELECT id FROM fee_schedule_deliveries
        WHERE provider_id = $1 AND schedule_id = $2`,
      [input.providerId, input.scheduleId],
    );
    if (existing) {
      throw new FeeScheduleError('That version is already recorded as given to them.');
    }

    await tx.query(
      `INSERT INTO fee_schedule_deliveries
         (provider_id, schedule_id, delivered_at, delivered_by, before_interview)
       VALUES ($1, $2, $3::date, $4, $5)`,
      [input.providerId, input.scheduleId, input.deliveredOn, ctx.actor,
        input.beforeInterview],
    );

    await audit({
      ...ctx,
      action: 'create',
      entity: 'fee_schedule_delivery',
      entityId: input.providerId,
      diff: {
        scheduleId: input.scheduleId,
        deliveredOn: input.deliveredOn,
        beforeInterview: input.beforeInterview,
      },
    }, tx);
  });
}
