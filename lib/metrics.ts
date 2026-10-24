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
import { getDb, type Tx } from '@/lib/db/client';
import { formatISODate, civilLA, startOfMonth } from '@/lib/domain/dates';

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

/** The denominator of the capacity measure. If she holds twelve where she held six without
 *  one of these, the tool worked. */
export async function recordServiceFailure(
  caseId: string,
  kind: ServiceFailureKind,
  onDate: string,
  note?: string,
): Promise<void> {
  const { query } = await getDb();
  await query(
    `INSERT INTO service_failures (case_id, kind, on_date, note) VALUES ($1, $2, $3, $4)`,
    [caseId, kind, onDate, note ?? null],
  );
  await emit('service_failure', { caseId }, { kind, onDate });
}

/** The leakage leading indicator. Idempotent per case-month. */
export async function recordMonthHours(
  caseId: string,
  month: string,
  billedHours: number,
): Promise<void> {
  const { query } = await getDb();
  await query(
    `INSERT INTO case_month_hours (case_id, month, billed_hours)
     VALUES ($1, $2, $3)
     ON CONFLICT (case_id, month)
       DO UPDATE SET billed_hours = EXCLUDED.billed_hours, recorded_at = now()`,
    [caseId, month, billedHours],
  );
  await emit('billed_hours_recorded', { caseId }, { month, billedHours });
}

export function currentMonthISO(now = new Date()): string {
  return formatISODate(startOfMonth(civilLA(now)));
}
