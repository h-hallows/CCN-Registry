/**
 * § 8 instrumentation. Write from day one.
 *
 * The second purpose of V1 is to answer questions no market research can. One row per
 * event, raw; derive later. Nothing here is aggregated at write time.
 *
 * Two of these decide whether the rest of the platform is worth funding:
 *
 *  - CAPACITY is measured as active cases held concurrently WITHOUT a service failure,
 *    not as self-reported time per case. A time metric is the first thing abandoned in
 *    any tool, and admin time rises for the first two or three months while records are
 *    entered and habits change — so it would read as failure exactly when the tool is
 *    working. See `recordServiceFailure`.
 *
 *  - LEAKAGE needs a leading indicator, because at 30–50 week median durations a small
 *    book yields perhaps three to six ended cases in six months, which is not a sample.
 *    Billed hours per case per month is the series that shows a household quietly
 *    shifting hours to a direct hire while keeping the registry for fill-in. See
 *    `recordMonthHours`.
 */
import { getDb, type Tx } from '@h-hallows/core/db';
import { formatISODate, civilLA, startOfMonth } from '@h-hallows/core/domain';
import { audit, type AuditContext } from '@/lib/audit';

export class MeasureError extends Error {}

export type MetricName =
  | 'inquiry_received' | 'first_contact' | 'shortlist_generated' | 'referral_made'
  | 'engagement_started' | 'engagement_ended' | 'operator_session' | 'credential_renewed'
  | 'service_failure' | 'billed_hours_recorded';

export interface MetricRef {
  caseId?: string | null;
  providerId?: string | null;
}

export async function emit(
  event: MetricName,
  ref: MetricRef = {},
  payload: Record<string, unknown> = {},
  tx?: Tx,
): Promise<void> {
  const run = tx ?? (await getDb());
  await run.query(
    `INSERT INTO metric_events (event, case_id, provider_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [event, ref.caseId ?? null, ref.providerId ?? null, JSON.stringify(payload)],
  );
}

export type ServiceFailureKind =
  | 'missed_shift' | 'unanswered_discharge_call'
  | 'lapsed_credential_reached_household' | 'no_eligible_provider_available' | 'other';

/**
 * One wording per kind, shared by the case screen and /measure.
 *
 * Written from the household's side rather than the registry's: "a shift was missed",
 * not "provider no-show". The kind is a measurement of what the family experienced, and
 * naming a cause in the label would make it an accusation that the data cannot support.
 */
export const SERVICE_FAILURE_LABEL: Record<ServiceFailureKind, string> = {
  missed_shift: 'A shift was missed',
  unanswered_discharge_call: 'A discharge call went unanswered',
  lapsed_credential_reached_household: 'A lapsed credential reached a household',
  no_eligible_provider_available: 'Nobody eligible was available',
  other: 'Something else',
};

export const SERVICE_FAILURE_KINDS = Object.keys(SERVICE_FAILURE_LABEL) as ServiceFailureKind[];

/**
 * The denominator of the capacity measure. If she holds twelve where she held six
 * without one of these, the tool worked.
 *
 * This function and recordMonthHours existed from the first commit and had NO CALLER
 * until now — so the two series `lib/metrics.ts` describes as deciding whether the
 * platform is worth funding were the two the console could not record. The seed wrote
 * them; the running system never did.
 *
 * It takes a context, which it did not before. A row naming the day a household did not
 * get the care they expected is identifiable information about them, and writing it
 * without recording who decided it happened would be the only mutation in the console
 * with no actor behind it. The audit row goes in the same transaction as the failure,
 * so the log cannot be missing the entry for a write it describes.
 */
export async function recordServiceFailure(
  ctx: AuditContext,
  caseId: string,
  kind: ServiceFailureKind,
  onDate: string,
  note?: string,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate)) {
    throw new MeasureError('Give the date the shift was missed.');
  }
  // A failure cannot be recorded for a day that has not happened. The measure is of
  // what went wrong, and a future date is either a typo or a forecast.
  if (onDate > formatISODate(civilLA(new Date()))) {
    throw new MeasureError('That date is in the future.');
  }

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [kase] = await tx.query<{ id: string }>(
      `SELECT id FROM cases WHERE id = $1 AND deleted_at IS NULL`, [caseId],
    );
    if (!kase) throw new MeasureError('That case does not exist.');

    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO service_failures (case_id, kind, on_date, note)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [caseId, kind, onDate, note?.trim() || null],
    );
    await emit('service_failure', { caseId }, { kind, onDate }, tx);
    await audit({
      ...ctx, action: 'create', entity: 'service_failure', entityId: row!.id,
      diff: { caseId, kind, onDate },
    }, tx);
  });
}

/**
 * The leakage leading indicator. Idempotent per case-month.
 *
 * At 30–50 week median durations a small book yields perhaps three to six ended cases
 * in six months, which is not a sample — so the end reason arrives far too late to steer
 * anything. Billed hours per case per month is the series that shows a household
 * quietly shifting hours to a direct hire while keeping the registry for fill-in, months
 * before they say so.
 *
 * Overwriting is correct here, unlike almost everywhere else in this console: a month's
 * hours are a figure that gets corrected when the invoices land. The audit row records
 * the previous value, so a correction is visible as a correction rather than as the only
 * number there ever was.
 */
export async function recordMonthHours(
  ctx: AuditContext,
  caseId: string,
  month: string,
  billedHours: number,
): Promise<void> {
  if (!/^\d{4}-\d{2}-01$/.test(month)) {
    throw new MeasureError('A month is recorded as its first day, YYYY-MM-01.');
  }
  if (!Number.isFinite(billedHours) || billedHours < 0) {
    throw new MeasureError('Hours cannot be negative.');
  }
  // 24 x 31. Beyond that it is a typo, and a typo here moves the one series that is
  // meant to show a household drifting away.
  if (billedHours > 744) {
    throw new MeasureError('That is more hours than the month holds.');
  }

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [kase] = await tx.query<{ id: string }>(
      `SELECT id FROM cases WHERE id = $1 AND deleted_at IS NULL`, [caseId],
    );
    if (!kase) throw new MeasureError('That case does not exist.');

    const [prior] = await tx.query<{ billed_hours: string }>(
      `SELECT billed_hours::text FROM case_month_hours WHERE case_id = $1 AND month = $2`,
      [caseId, month],
    );

    await tx.query(
      `INSERT INTO case_month_hours (case_id, month, billed_hours)
       VALUES ($1, $2, $3)
       ON CONFLICT (case_id, month)
         DO UPDATE SET billed_hours = EXCLUDED.billed_hours, recorded_at = now()`,
      [caseId, month, billedHours],
    );
    await emit('billed_hours_recorded', { caseId }, { month, billedHours }, tx);
    /*
     * Always `update`, never `create`. The row created is a case_month_hours row; the
     * audit row names the CASE, and "created case" for a month's hours reads as a case
     * being opened. The diff says which it was: a bare figure the first time, a
     * from/to pair when a month is corrected.
     */
    await audit({
      ...ctx,
      action: 'update',
      entity: 'case',
      entityId: caseId,
      diff: prior
        ? { month, billedHours: { from: Number(prior.billed_hours), to: billedHours } }
        : { month, billedHours, firstRecorded: true },
    }, tx);
  });
}
export function currentMonthISO(now = new Date()): string {
  return formatISODate(startOfMonth(civilLA(now)));
}
