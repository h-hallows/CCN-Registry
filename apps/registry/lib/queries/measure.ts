/**
 * § 8 instrumentation, read back.
 *
 * The second purpose of V1 is to answer questions no market research can, and the events
 * have been written since the first commit. Nothing read them. `recordServiceFailure`
 * and `recordMonthHours` — the two series lib/metrics.ts names as deciding whether the
 * platform is worth funding — had no caller at all: the seed wrote them so they would
 * not look empty, and the running system never could.
 *
 * Three questions, and nothing here invents a fourth:
 *
 *  - THE FUNNEL. Where the work comes from and where it stops. The useful part is not
 *    the counts, which are small, but which step loses people — a registry losing them
 *    between enquiry and first contact has a staffing problem, and one losing them
 *    between bench and referral has a matching problem. Those need opposite responses.
 *
 *  - CAPACITY, measured as concurrent active cases held WITHOUT a service failure. Not
 *    self-reported minutes per case: a time metric is the first thing abandoned in any
 *    tool, and admin time rises for the first two or three months while records are
 *    entered and habits change, so it would read as failure exactly when the tool is
 *    working.
 *
 *  - LEAKAGE, as billed hours per case per month. At 30–50 week median durations a small
 *    book yields three to six ended cases in six months, which is not a sample — so the
 *    end reason arrives far too late to steer anything. A household quietly shifting
 *    hours to a direct hire while keeping the registry for fill-in shows up here months
 *    before they say so.
 *
 * WHAT IS AGGREGATE AND WHAT IS NOT. The funnel, the sources and the capacity series are
 * counts; no row in them names anybody, so reading them records one audit row for the
 * screen and none for a subject. The leakage list and the failure list are NOT: both are
 * per case, and both link to the household, because "hours are falling" is useless
 * without knowing whose. Those two reads are audited against every household they name,
 * the same as opening the case would be. An instrumentation screen is not a side door.
 */
import { getDb } from '@h-hallows/core/db';
import { auditRead, type AuditContext } from '@/lib/audit';
import type { ServiceFailureKind } from '@/lib/metrics';

/** The § 8 event vocabulary, in the order the work actually happens. */
export const FUNNEL_STEPS = [
  'inquiry_received', 'first_contact', 'shortlist_generated', 'referral_made',
  'engagement_started', 'engagement_ended',
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const STEP_LABEL: Record<FunnelStep, string> = {
  inquiry_received: 'Enquiry arrived',
  first_contact: 'Someone called them back',
  shortlist_generated: 'A bench was screened',
  referral_made: 'A provider was referred',
  engagement_started: 'Care started',
  engagement_ended: 'Care ended',
};

export interface FunnelRow {
  step: FunnelStep;
  label: string;
  /** Distinct cases that reached this step, ever. */
  cases: number;
  /** As a share of the cases that ever arrived at all. */
  ofEnquiries: number | null;
  /**
   * Cases at this step with NO record of the step before it.
   *
   * This is the number that makes the rest of the column trustworthy. The steps are not
   * nested: `shortlist_generated` fires when the operator opens the match screen, which
   * is an action she may skip, so a case can be referred with no bench on its record.
   * Reporting a conversion rate over that silently would be a tidy chart of a fiction.
   */
  skippedPrevious: number;
  /**
   * Median days from the previous step, over the cases that made both. Null where fewer
   * than three did: a median of one case is that case, and putting it beside a
   * percentage invites it to be read as a rate.
   */
  medianDays: number | null;
  medianOf: number;
}

const MIN_FOR_MEDIAN = 3;

export async function funnel(ctx: AuditContext): Promise<FunnelRow[]> {
  const { query } = await getDb();

  /*
   * First occurrence per case per step. A case can be screened repeatedly and referred
   * twice; the funnel asks whether it got there at all, and the second referral would
   * otherwise make one case look like two.
   */
  const firsts = await query<{ case_id: string; event: string; at: string }>(
    `SELECT case_id, event::text AS event, min(at)::text AS at
       FROM metric_events
      WHERE case_id IS NOT NULL AND event::text = ANY($1)
      GROUP BY case_id, event`,
    [[...FUNNEL_STEPS]],
  );

  const gaps = await query<{ event: string; days: string | null; n: string }>(
    `WITH firsts AS (
       SELECT case_id, event::text AS event, min(at) AS at
         FROM metric_events
        WHERE case_id IS NOT NULL AND event::text = ANY($1)
        GROUP BY case_id, event
     ),
     ordered AS (
       SELECT f.case_id, f.event, f.at, array_position($1::text[], f.event) AS step
         FROM firsts f
     ),
     paired AS (
       SELECT a.event, extract(epoch FROM (a.at - b.at)) / 86400 AS days
         FROM ordered a
         JOIN ordered b ON b.case_id = a.case_id AND b.step = a.step - 1
        WHERE a.at >= b.at
     )
     SELECT event,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::text AS days,
            count(*)::text AS n
       FROM paired GROUP BY event`,
    [[...FUNNEL_STEPS]],
  );
  const gapByStep = new Map(gaps.map((g) => [g.event, g]));

  const reached = new Map<FunnelStep, Set<string>>();
  for (const step of FUNNEL_STEPS) reached.set(step, new Set());
  for (const row of firsts) {
    reached.get(row.event as FunnelStep)?.add(row.case_id);
  }

  await auditRead(ctx, 'today', null, { read: 'the § 8 funnel' });

  const arrived = reached.get(FUNNEL_STEPS[0])!.size;

  return FUNNEL_STEPS.map((step, i) => {
    const here = reached.get(step)!;
    const previous = i === 0 ? null : reached.get(FUNNEL_STEPS[i - 1]!)!;
    const gap = gapByStep.get(step);
    const n = Number(gap?.n ?? 0);
    return {
      step,
      label: STEP_LABEL[step],
      cases: here.size,
      ofEnquiries: arrived === 0 ? null : here.size / arrived,
      skippedPrevious: previous === null
        ? 0
        : [...here].filter((id) => !previous.has(id)).length,
      medianDays:
        gap?.days != null && n >= MIN_FOR_MEDIAN
          ? Math.round(Number(gap.days) * 10) / 10
          : null,
      medianOf: n,
    };
  });
}

export interface SourceRow {
  source: string;
  enquiries: number;
  reachedReferral: number;
}

/**
 * Where the work comes from, and whether it converts.
 *
 * § 8 needs this to answer whether the binding constraint is demand or capacity: a
 * channel that sends many and converts none is not the same problem as a channel that
 * sends three and converts all three.
 */
export async function bySource(ctx: AuditContext): Promise<SourceRow[]> {
  const { query } = await getDb();
  const rows = await query<{ source: string; enquiries: string; referred: string }>(
    `WITH enq AS (
       SELECT case_id,
              coalesce(nullif(payload ->> 'source', ''), 'Not recorded') AS source
         FROM metric_events
        WHERE event = 'inquiry_received' AND case_id IS NOT NULL
     ),
     ref AS (
       SELECT DISTINCT case_id FROM metric_events WHERE event = 'referral_made'
     )
     SELECT e.source,
            count(*)::text AS enquiries,
            count(r.case_id)::text AS referred
       FROM enq e LEFT JOIN ref r ON r.case_id = e.case_id
      GROUP BY e.source
      ORDER BY count(*) DESC, e.source`,
  );
  return rows.map((r) => ({
    source: r.source,
    enquiries: Number(r.enquiries),
    reachedReferral: Number(r.referred),
  }));
}

export interface CapacityMonth {
  month: string;
  /** Cases held at any point in the month, by the definition in `capacity()`. */
  activeCases: number;
  /** Service failures recorded in it. */
  failures: number;
  /**
   * True for the month that has not finished. Decided in SQL from California's date so
   * one expression settles it, because this row is not comparable with the ones above
   * it: its `activeCases` is still rising and its `failures` has had fewer days to
   * accumulate in. On the first of the month it is a row of almost nothing.
   */
  partial: boolean;
}

export interface Capacity {
  /** Cases held right now, by the one definition below. */
  heldNow: number;
  /** Of those, how many have never had a service failure. The measure § 8 asks for. */
  cleanNow: number;
  /**
   * The most concurrent cases held in a month that has FINISHED, and when.
   *
   * The month in progress is excluded, because "most ever held at once" compared against
   * a figure that is still climbing is not a comparison. Nothing is hidden by it: the
   * current month's own number is the first row of the table below this tile.
   *
   * Null until one month has completed, which is honest rather than tidy — a registry in
   * its first month has no finished month to report, and printing this month's figure
   * there would be the same error with a different sign.
   */
  peak: { month: string; cases: number } | null;
  /**
   * Cases that were held during this month and are not held now, because they ended
   * part-way through it.
   *
   * This is the whole of the difference between `heldNow` and the current month's
   * `activeCases`, and it is here so the screen can state it rather than leave two
   * numbers a hand's width apart to be reconciled by whoever is looking. See the note
   * in `capacity()` on why they are different measures and must stay so.
   */
  endedThisMonth: number;
  months: CapacityMonth[];
  failuresByKind: { kind: ServiceFailureKind; failures: number }[];
}

export async function capacity(ctx: AuditContext): Promise<Capacity> {
  const { query } = await getDb();

  /*
   * HELD: referred and not ended.
   *
   * `referred_on` rather than `created_at`, because an enquiry sitting in the queue is
   * not capacity being held — it is capacity not yet used, and counting it would make a
   * backlog look like throughput.
   *
   * It includes a case that is `referred` and not yet started, and one that is `paused`.
   * § 8 asks whether she can hold twelve where she held six, and both of those are
   * carried: the referred case is a household waiting on a first shift and the paused one
   * is a relationship still being managed. The first version of this screen counted
   * `status = 'active'` for "now" and this definition for every past month, so the
   * current month disagreed with the figure printed above it by one case.
   *
   * TWO MEASURES, NOT ONE DEFINITION TWICE. The fix for that defect wrote "held, defined
   * once" here and then wrote it twice in SQL anyway, because the two questions are not
   * the same question:
   *
   *   - a month asks how many cases were held AT ANY POINT in it, which is the
   *     concurrency § 8 is about, and
   *   - "now" asks how many are held AT THIS MOMENT.
   *
   * For a month that has finished those are the same number. For the month in progress
   * they differ by exactly the cases that ended part-way through it, and a test asserting
   * they were equal passed for as long as no case happened to end in the current month —
   * then failed on a Sunday with nothing changed but the date. So the difference is
   * computed (`endedThisMonth`), the unfinished month is flagged (`partial`), and the
   * screen states the relationship instead of implying there is none.
   *
   * CALIFORNIA'S DATE, not the server's. `current_date` on a managed Postgres is UTC,
   * and nothing in this codebase sets a connection TimeZone. From late afternoon Pacific
   * on the last day of a month, `date_trunc('month', current_date)` is already next
   * month: the series grew a row for a month that had not started, holding every case as
   * though it had carried into it, and the "partial" flag would have landed on it. Third
   * instance of this bug in this repository; the other two are in V1-REVIEW § 2.
   */
  const months = await query<
    { month: string; active: string; failures: string; partial: boolean }
  >(
    `WITH today AS (
       SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date AS d
     ),
     span AS (
       SELECT date_trunc('month', generate_series(
                coalesce((SELECT min(referred_on) FROM cases WHERE referred_on IS NOT NULL),
                         (SELECT d FROM today)),
                (SELECT d FROM today), interval '1 month'))::date AS month
     )
     SELECT s.month::text,
            s.month = date_trunc('month', (SELECT d FROM today))::date AS partial,
            (SELECT count(*) FROM cases c
              WHERE c.deleted_at IS NULL
                AND c.referred_on IS NOT NULL
                AND c.referred_on < (s.month + interval '1 month')
                AND (c.ended_on IS NULL OR c.ended_on >= s.month))::text AS active,
            (SELECT count(*) FROM service_failures f
              WHERE f.on_date >= s.month
                AND f.on_date < (s.month + interval '1 month'))::text AS failures
       FROM span s
      ORDER BY s.month`,
  );

  const [now] = await query<{ held: string; clean: string }>(
    `SELECT count(*)::text AS held,
            count(*) FILTER (
              WHERE NOT EXISTS (SELECT 1 FROM service_failures f WHERE f.case_id = c.id)
            )::text AS clean
       FROM cases c
      WHERE c.deleted_at IS NULL
        AND c.referred_on IS NOT NULL
        AND c.ended_on IS NULL`,
  );

  /*
   * The whole of the difference between `heldNow` and the current month's `activeCases`:
   * cases that were held during this month and have since ended.
   *
   * The predicates are the complement of the two queries above, deliberately written out
   * rather than taken as `active - held`. Subtraction would always produce a number and
   * the number would always reconcile, because it was made out of the two figures it
   * reconciles — so the screen would be explaining its own arithmetic. Counted from the
   * rows, it is a fact about cases, and `tests/measure.test.ts` compares it against an
   * independent count of the same rows. That comparison catches a disagreement between
   * the three queries; it cannot catch someone replacing this one with the subtraction,
   * which is undetectable from outside and is why the reason is written down here.
   */
  const [ended] = await query<{ n: string }>(
    `WITH m AS (
       SELECT date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles')::date)::date AS start
     )
     SELECT count(*)::text AS n
       FROM cases c, m
      WHERE c.deleted_at IS NULL
        AND c.referred_on IS NOT NULL
        AND c.referred_on < (m.start + interval '1 month')
        AND c.ended_on IS NOT NULL
        AND c.ended_on >= m.start`,
  );

  const kinds = await query<{ kind: string; n: string }>(
    `SELECT kind::text, count(*)::text AS n FROM service_failures
      GROUP BY kind ORDER BY count(*) DESC`,
  );

  await auditRead(ctx, 'today', null, { read: 'the § 8 capacity measure' });

  const shaped = months.map((m) => ({
    month: m.month,
    activeCases: Number(m.active),
    failures: Number(m.failures),
    partial: m.partial,
  }));
  // Finished months only. See the note on `Capacity.peak`.
  const peak = shaped.filter((m) => !m.partial).reduce<{ month: string; cases: number } | null>(
    (best, m) => (best === null || m.activeCases > best.cases
      ? { month: m.month, cases: m.activeCases } : best),
    null,
  );

  return {
    heldNow: Number(now!.held),
    cleanNow: Number(now!.clean),
    peak: peak && peak.cases > 0 ? peak : null,
    endedThisMonth: Number(ended!.n),
    months: shaped,
    failuresByKind: kinds.map((k) => ({
      kind: k.kind as ServiceFailureKind,
      failures: Number(k.n),
    })),
  };
}

export type Trend = 'falling' | 'steady' | 'rising' | 'too_short';

export interface LeakageRow {
  caseId: string;
  householdId: string;
  householdName: string;
  status: string;
  /** Oldest first, so the series reads left to right. */
  series: { month: string; hours: number }[];
  trend: Trend;
  /** How far the recent months sit below the earlier ones, as a share. */
  decline: number | null;
}

/**
 * How many months of hours before a direction is called.
 *
 * Four. Two points are a line through any two numbers, and three lets one month of
 * holiday cover read as a household leaving — which is the expensive false positive,
 * because the response to it is a conversation that implies you think they are going.
 */
const MIN_MONTHS_FOR_TREND = 4;

/** Below this, the change is month-to-month noise in a book this size. */
const MATERIAL_DECLINE = 0.2;

export function trendOf(series: { hours: number }[]): { trend: Trend; decline: number | null } {
  if (series.length < MIN_MONTHS_FOR_TREND) return { trend: 'too_short', decline: null };
  const half = Math.floor(series.length / 2);
  const earlier = series.slice(0, half);
  const recent = series.slice(-half);
  const mean = (xs: { hours: number }[]) => xs.reduce((n, x) => n + x.hours, 0) / xs.length;
  const before = mean(earlier);
  const after = mean(recent);
  if (before === 0) return { trend: after > 0 ? 'rising' : 'steady', decline: null };
  const change = (after - before) / before;
  if (change <= -MATERIAL_DECLINE) return { trend: 'falling', decline: -change };
  if (change >= MATERIAL_DECLINE) return { trend: 'rising', decline: null };
  return { trend: 'steady', decline: null };
}

export async function leakage(ctx: AuditContext, months = 8): Promise<LeakageRow[]> {
  const { query } = await getDb();
  const rows = await query<{
    case_id: string; household_id: string; display_name: string; status: string;
    month: string; billed_hours: string;
  }>(
    `SELECT h.case_id, c.household_id, hh.display_name, c.status::text,
            h.month::text, h.billed_hours::text
       FROM case_month_hours h
       JOIN cases c ON c.id = h.case_id
       JOIN households hh ON hh.id = c.household_id
      WHERE c.deleted_at IS NULL
        -- California's date, for the reason given in capacity() above. Here the server's
        -- would pull in one month more of history from late afternoon Pacific on the
        -- last day of a month rather than dropping one, which is the same mistake
        -- wearing a harmless face.
        AND h.month >= date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles')::date)
                       - ($1 || ' months')::interval
      ORDER BY h.case_id, h.month`,
    [String(months)],
  );

  /*
   * Named, so audited per household — not as one anonymous screen read. Knowing that a
   * particular family's hours are falling is knowing something about that family.
   */
  for (const householdId of new Set(rows.map((r) => r.household_id))) {
    await auditRead(ctx, 'household', householdId, { read: 'the § 8 leakage series' });
  }

  const byCase = new Map<string, LeakageRow>();
  for (const row of rows) {
    const existing = byCase.get(row.case_id);
    const point = { month: row.month, hours: Number(row.billed_hours) };
    if (existing) existing.series.push(point);
    else {
      byCase.set(row.case_id, {
        caseId: row.case_id,
        householdId: row.household_id,
        householdName: row.display_name,
        status: row.status,
        series: [point],
        trend: 'too_short',
        decline: null,
      });
    }
  }

  const out = [...byCase.values()].map((row) => ({ ...row, ...trendOf(row.series) }));

  /*
   * Falling first, and within that the steepest. This screen exists to surface the one
   * household drifting away, and a list sorted by case id buries it among the steady
   * ones.
   */
  const rank: Record<Trend, number> = { falling: 0, rising: 1, steady: 2, too_short: 3 };
  return out.sort((a, b) => rank[a.trend] - rank[b.trend]
    || (b.decline ?? 0) - (a.decline ?? 0));
}

export interface FailureRow {
  id: string;
  caseId: string;
  householdId: string;
  householdName: string;
  kind: ServiceFailureKind;
  onDate: string;
  note: string | null;
  recordedAt: string;
}

/**
 * The failures themselves, named by case.
 *
 * Unlike everything else here this is identifiable, so the read is audited against each
 * household it names. A missed shift is a thing that happened to a family, and the
 * screen that counts them should not be the one place they are anonymous.
 */
export async function failures(ctx: AuditContext, limit = 50): Promise<FailureRow[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; case_id: string; household_id: string; display_name: string;
    kind: string; on_date: string; note: string | null; created_at: string;
  }>(
    `SELECT f.id, f.case_id, c.household_id, h.display_name,
            f.kind::text, f.on_date::text, f.note, f.created_at::text
       FROM service_failures f
       JOIN cases c ON c.id = f.case_id
       JOIN households h ON h.id = c.household_id
      ORDER BY f.on_date DESC
      LIMIT ${limit}`,
  );

  for (const householdId of new Set(rows.map((r) => r.household_id))) {
    await auditRead(ctx, 'household', householdId, { read: 'service failures' });
  }

  return rows.map((r) => ({
    id: r.id,
    caseId: r.case_id,
    householdId: r.household_id,
    householdName: r.display_name,
    kind: r.kind as ServiceFailureKind,
    onDate: r.on_date,
    note: r.note,
    recordedAt: r.created_at,
  }));
}

export interface CaseMeasure {
  failures: { id: string; kind: ServiceFailureKind; onDate: string; note: string | null }[];
  hours: { month: string; hours: number; recordedAt: string }[];
}

/** One case's own § 8 record, for the case screen. */
export async function measureForCase(
  ctx: AuditContext,
  caseId: string,
): Promise<CaseMeasure> {
  const { query } = await getDb();
  const [f, h] = await Promise.all([
    query<{ id: string; kind: string; on_date: string; note: string | null }>(
      `SELECT id, kind::text, on_date::text, note FROM service_failures
        WHERE case_id = $1 ORDER BY on_date DESC`,
      [caseId],
    ),
    query<{ month: string; billed_hours: string; recorded_at: string }>(
      `SELECT month::text, billed_hours::text, recorded_at::text FROM case_month_hours
        WHERE case_id = $1 ORDER BY month DESC LIMIT 12`,
      [caseId],
    ),
  ]);

  if (f.length > 0 || h.length > 0) {
    await auditRead(ctx, 'case', caseId, { read: 'hours and service failures' });
  }

  return {
    failures: f.map((r) => ({
      id: r.id, kind: r.kind as ServiceFailureKind, onDate: r.on_date, note: r.note,
    })),
    hours: h.map((r) => ({
      month: r.month, hours: Number(r.billed_hours), recordedAt: r.recorded_at,
    })),
  };
}
