/**
 * § 8 instrumentation, written and read.
 *
 * The events have been emitted since the first commit. Nothing read them, and
 * `recordServiceFailure` and `recordMonthHours` — the two series lib/metrics.ts names as
 * deciding whether the platform is worth funding — had NO CALLER. The seed wrote them so
 * the tables would not look empty; the running system never could.
 *
 * The test that would have caught that is the last one in this file, and it is about the
 * shape of the code rather than its behaviour: an exported function with no caller is
 * dead, and dead measurement code is indistinguishable from a measurement nobody takes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  MeasureError, recordMonthHours, recordServiceFailure, currentMonthISO,
} from '@/lib/metrics';
import {
  bySource, capacity, failures, funnel, leakage, measureForCase, trendOf, FUNNEL_STEPS,
} from '@/lib/queries/measure';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

const anActiveCase = () => one<{ id: string; household_id: string }>(
  `SELECT id, household_id FROM cases
    WHERE status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
);

describe('recording a service failure', () => {
  it('writes the failure, the metric event and the audit row together', async () => {
    const kase = await anActiveCase();
    const ctx = { ...TEST_CTX, actor: 'ops@example.com' };

    await recordServiceFailure(ctx, kase.id, 'missed_shift', '2026-11-02', 'Cover arrived late.');

    const failure = await one<{ id: string; kind: string; note: string }>(
      `SELECT id, kind::text, note FROM service_failures
        WHERE case_id = $1 AND on_date = '2026-11-02'`,
      [kase.id],
    );
    expect(failure.kind).toBe('missed_shift');

    const metric = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_events
        WHERE event = 'service_failure' AND case_id = $1
          AND payload ->> 'onDate' = '2026-11-02'`,
      [kase.id],
    );
    expect(Number(metric.n)).toBe(1);

    /*
     * The audit row names the failure itself, so it lands in the household's span. A
     * measurement of a bad day for a particular family is identifiable information
     * about them, and before this it was written with no actor at all.
     */
    const logged = await one<{ actor: string }>(
      `SELECT actor FROM audit_log
        WHERE entity = 'service_failure' AND entity_id = $1`,
      [failure.id],
    );
    expect(logged.actor).toBe('ops@example.com');
  });

  it('refuses a date that has not happened yet', async () => {
    const kase = await anActiveCase();
    await expect(
      recordServiceFailure(TEST_CTX, kase.id, 'missed_shift', '2099-01-01', 'x'),
    ).rejects.toThrow(MeasureError);
  });

  it('refuses a case that does not exist, and writes nothing', async () => {
    const before = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_events WHERE event = 'service_failure'`,
    );
    await expect(
      recordServiceFailure(
        TEST_CTX, '00000000-0000-0000-0000-000000000000', 'other', '2026-10-01', 'x',
      ),
    ).rejects.toThrow(MeasureError);
    const after = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM metric_events WHERE event = 'service_failure'`,
    );
    /*
     * The metric and the failure go in one transaction, so a refused failure leaves no
     * event behind to inflate the count the capacity measure divides by.
     *
     * Note for whoever reads this next: passing `tx` to emit() is not optional. On
     * PGlite a transaction holds the only connection, so emitting on the pool handle
     * from inside one DEADLOCKS rather than failing — I tried it to check this
     * assertion bites and the suite hung instead of going red. Do not "fix" that hang
     * by moving the emit outside the transaction; that is the bug, not the deadlock.
     */
    expect(after.n).toBe(before.n);
  });

  it('reaches no provider record and changes nobody\'s standing (I7)', async () => {
    const kase = await anActiveCase();
    const before = await one<{ providers: string; credentials: string; referrals: string }>(
      `SELECT (SELECT count(*)::text FROM providers WHERE status <> 'active') AS providers,
              (SELECT count(*)::text FROM credentials) AS credentials,
              (SELECT count(*)::text FROM referrals WHERE outcome IS NOT NULL) AS referrals`,
    );
    await recordServiceFailure(TEST_CTX, kase.id, 'other', '2026-10-05', 'Recorded only.');
    const after = await one<{ providers: string; credentials: string; referrals: string }>(
      `SELECT (SELECT count(*)::text FROM providers WHERE status <> 'active') AS providers,
              (SELECT count(*)::text FROM credentials) AS credentials,
              (SELECT count(*)::text FROM referrals WHERE outcome IS NOT NULL) AS referrals`,
    );
    expect(after).toEqual(before);
  });
});

describe('recording a month\'s hours', () => {
  it('records, then corrects, keeping the old figure in the log', async () => {
    const kase = await anActiveCase();
    const month = '2026-07-01';
    const ctx = { ...TEST_CTX, actor: 'books@example.com' };

    await recordMonthHours(ctx, kase.id, month, 90);
    await recordMonthHours(ctx, kase.id, month, 104.5);

    const row = await one<{ billed_hours: string }>(
      `SELECT billed_hours::text FROM case_month_hours WHERE case_id = $1 AND month = $2`,
      [kase.id, month],
    );
    expect(Number(row.billed_hours)).toBe(104.5);

    /*
     * One row per case-month, so the correction overwrote. That is right here and almost
     * nowhere else in this console — the figure changes when the invoices land — which
     * is exactly why the previous value has to survive in the log.
     */
    const correction = await one<{ diff: { billedHours: { from: number; to: number } } }>(
      `SELECT diff FROM audit_log
        WHERE actor = 'books@example.com' AND action = 'update' AND entity = 'case'
          AND entity_id = $1 AND diff ->> 'month' = $2`,
      [kase.id, month],
    );
    expect(correction.diff.billedHours.from).toBe(90);
    expect(correction.diff.billedHours.to).toBe(104.5);
  });

  it('refuses a figure larger than the month holds', async () => {
    const kase = await anActiveCase();
    await expect(recordMonthHours(TEST_CTX, kase.id, '2026-06-01', 900))
      .rejects.toThrow(/more hours than the month holds/);
  });

  it('refuses a month that is not a first-of-month', async () => {
    const kase = await anActiveCase();
    await expect(recordMonthHours(TEST_CTX, kase.id, '2026-06-15', 10))
      .rejects.toThrow(MeasureError);
  });

  it('gives the current month in California, as a first-of-month', () => {
    expect(currentMonthISO()).toMatch(/^\d{4}-\d{2}-01$/);
  });
});

describe('the funnel', () => {
  it('counts a case once however many times it reached a step', async () => {
    const kase = await anActiveCase();
    const before = (await funnel(TEST_CTX)).find((s) => s.step === 'shortlist_generated')!;

    // Two screenings of the same case. The funnel asks whether it got there at all.
    await db.query(
      `INSERT INTO metric_events (event, case_id) VALUES ('shortlist_generated', $1)`,
      [kase.id],
    );
    await db.query(
      `INSERT INTO metric_events (event, case_id) VALUES ('shortlist_generated', $1)`,
      [kase.id],
    );

    const after = (await funnel(TEST_CTX)).find((s) => s.step === 'shortlist_generated')!;
    expect(after.cases).toBe(before.cases + 1);
  });

  it('reports cases that skipped the step above rather than inventing a rate', async () => {
    const steps = await funnel(TEST_CTX);
    const referral = steps.find((s) => s.step === 'referral_made')!;
    /*
     * The seed refers cases without ever opening the match screen, so `referral_made`
     * holds cases with no `shortlist_generated` behind them. A funnel whose later step
     * exceeds its earlier one is not a funnel, and quietly dividing the two would be a
     * tidy chart of a fiction.
     */
    expect(referral.skippedPrevious).toBeGreaterThan(0);
    // Every share is measured against enquiries arriving, which is the only true top.
    for (const step of steps) {
      expect(step.ofEnquiries).not.toBeNull();
      expect(step.ofEnquiries!).toBeGreaterThanOrEqual(0);
    }
    expect(steps.map((s) => s.step)).toEqual([...FUNNEL_STEPS]);
  });

  it('withholds a median until three cases have made both steps', async () => {
    for (const step of await funnel(TEST_CTX)) {
      if (step.medianOf < 3) expect(step.medianDays, step.step).toBeNull();
    }
  });
});

describe('capacity', () => {
  it('counts cases held now, and how many have never had a failure', async () => {
    const cap = await capacity(TEST_CTX);
    expect(cap.heldNow).toBeGreaterThan(0);
    expect(cap.cleanNow).toBeLessThanOrEqual(cap.heldNow);

    const withFailure = await one<{ n: string }>(
      `SELECT count(DISTINCT c.id)::text AS n FROM cases c
        JOIN service_failures f ON f.case_id = c.id
       WHERE c.deleted_at IS NULL AND c.referred_on IS NOT NULL AND c.ended_on IS NULL`,
    );
    expect(cap.heldNow - cap.cleanNow).toBe(Number(withFailure.n));
  });

  it('uses one definition of held for now and for every past month', async () => {
    /*
     * The defect this exists for: "held now" counted status = 'active' while the month
     * series counted referred-and-not-ended, so the current month on the screen
     * disagreed with the figure printed above it by one case — the household that had
     * been referred and was waiting on a first shift. Two definitions of the same word,
     * a hand's width apart.
     */
    const cap = await capacity(TEST_CTX);
    const thisMonth = cap.months[cap.months.length - 1]!;
    expect(thisMonth.activeCases).toBe(cap.heldNow);
  });

  it('does not count an enquiry still in the queue as capacity held', async () => {
    const cap = await capacity(TEST_CTX);
    const held = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM cases
        WHERE deleted_at IS NULL AND referred_on IS NOT NULL AND ended_on IS NULL`,
    );
    const waiting = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM cases
        WHERE deleted_at IS NULL AND referred_on IS NULL`,
    );
    expect(Number(waiting.n), 'the seed no longer has an unreferred case').toBeGreaterThan(0);
    expect(cap.heldNow).toBe(Number(held.n));
  });
});

describe('leakage', () => {
  it('calls a sustained decline, and says how far', () => {
    const falling = trendOf([
      { hours: 100 }, { hours: 95 }, { hours: 60 }, { hours: 40 },
    ]);
    expect(falling.trend).toBe('falling');
    expect(falling.decline).toBeGreaterThan(0.2);
  });

  it('will not call a direction on three months', () => {
    expect(trendOf([{ hours: 100 }, { hours: 50 }, { hours: 20 }]).trend).toBe('too_short');
  });

  it('reads one fortnight of cover as steady, not as a household leaving', () => {
    /*
     * The expensive false positive. The response to "they are leaving" is a conversation
     * that implies you think they are going, so one soft month inside an otherwise flat
     * series must not trigger it.
     */
    expect(trendOf([
      { hours: 90 }, { hours: 88 }, { hours: 70 }, { hours: 92 },
    ]).trend).toBe('steady');
  });

  it('finds the tapering engagement in the seed and puts it first', async () => {
    const rows = await leakage(TEST_CTX);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.trend).toBe('falling');
    expect(rows[0]!.householdName.length).toBeGreaterThan(0);
  });

  it('audits the read against every household it names', async () => {
    const ctx = { ...TEST_CTX, actor: 'analyst@example.com' };
    const rows = await leakage(ctx);
    for (const row of rows) {
      const logged = await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log
          WHERE actor = 'analyst@example.com' AND entity = 'household'
            AND entity_id = $1 AND diff ->> 'read' = 'the § 8 leakage series'`,
        [row.householdId],
      );
      expect(Number(logged.n), row.householdName).toBeGreaterThan(0);
    }
  });
});

describe('what the screens read', () => {
  it('names a household on every failure, and audits each one', async () => {
    const ctx = { ...TEST_CTX, actor: 'reader@example.com' };
    const rows = await failures(ctx);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.householdName.length).toBeGreaterThan(0);
      const logged = await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log
          WHERE actor = 'reader@example.com' AND entity = 'household' AND entity_id = $1
            AND diff ->> 'read' = 'service failures'`,
        [row.householdId],
      );
      expect(Number(logged.n)).toBeGreaterThan(0);
    }
  });

  it('attributes a source to every enquiry, recorded or not', async () => {
    const rows = await bySource(TEST_CTX);
    const total = rows.reduce((n, r) => n + r.enquiries, 0);
    const enquiries = await one<{ n: string }>(
      `SELECT count(DISTINCT case_id)::text AS n FROM metric_events
        WHERE event = 'inquiry_received' AND case_id IS NOT NULL`,
    );
    // Nothing falls off the bottom: an enquiry with no source is 'Not recorded', not
    // absent, because a channel breakdown that silently drops rows understates the top.
    expect(total).toBe(Number(enquiries.n));
    for (const row of rows) {
      expect(row.reachedReferral).toBeLessThanOrEqual(row.enquiries);
    }
  });

  it('gives a case its own two series', async () => {
    const kase = await anActiveCase();
    await recordMonthHours(TEST_CTX, kase.id, '2026-05-01', 60);
    const mine = await measureForCase(TEST_CTX, kase.id);
    expect(mine.hours.some((h) => h.month === '2026-05-01')).toBe(true);
    expect(mine.failures.length).toBeGreaterThan(0);
  });
});

describe('nothing in lib/metrics.ts is dead', () => {
  /*
   * The regression that matters. recordServiceFailure and recordMonthHours existed from
   * the first commit with no caller anywhere, so the two series § 8 calls load-bearing
   * were the two the console could not record — and every test passed, because there was
   * nothing to test. An exported measurement function with no caller is a measurement
   * nobody takes.
   */
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sources(path, out);
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
    return out;
  }

  it('has a caller outside the module for every exported function', () => {
    const root = join(import.meta.dirname, '..');
    const metrics = readFileSync(join(root, 'lib/metrics.ts'), 'utf8');
    const exported = [...metrics.matchAll(/export async function (\w+)|export function (\w+)/g)]
      .map((m) => m[1] ?? m[2]!)
      .filter((name) => name !== 'emit');

    expect(exported.length).toBeGreaterThan(2);

    const elsewhere = sources(join(root, 'lib'))
      .concat(sources(join(root, 'app')))
      .filter((p) => !p.endsWith('lib/metrics.ts'))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');

    const dead = exported.filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(elsewhere));
    expect(
      dead,
      `exported from lib/metrics.ts and called by nothing: ${dead.join(', ')}`,
    ).toEqual([]);
  });
});
