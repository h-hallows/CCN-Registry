/**
 * Day one: every screen against a database that has been migrated and nothing else.
 *
 * This is not a hypothetical state. It is the state of the Vercel deployment the moment
 * a Postgres is attached to it — migrations applied, every table empty, one operator who
 * has never opened the console before. The first thing that happens is that they click
 * through the navigation, and the first thing they would learn from a screen that throws
 * is that the tool does not work.
 *
 * Nothing in the suite covered it. Every other test file seeds first, because every
 * other test is about behaviour and behaviour needs rows. The only evidence that the
 * empty path worked at all was that both `/api/health` endpoints return 503 when there
 * is no database, which is a different question entirely.
 *
 * WHAT GOES WRONG HERE, SPECIFICALLY. An aggregate over no rows is not no rows: `SELECT
 * count(*)` returns one row holding zero, `SELECT max(x)` returns one row holding null,
 * and `SELECT ... LIMIT 1` returns none at all. Code that destructures `const [row] =`
 * and reaches for `row!.n` is right about the first two and wrong about the third, and
 * TypeScript cannot tell them apart because the non-null assertion is where the
 * programmer promised it could not happen. Percentages divide by a denominator that is
 * now zero. `Math.max(...[])` is `-Infinity`. A date range over nothing has no ends.
 *
 * So this file calls every list and summary the console renders, with no rows anywhere,
 * and asks only that it comes back. What each returns is the business of the other
 * files; that it returns at all is the business of this one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, truncateAll, TEST_CTX } from '@h-hallows/core/testing';

import { record as advertisingRecord } from '@/lib/queries/advertising';
import {
  countUnhandledApplications, recentlyDecidedApplications, unhandledApplications,
} from '@/lib/queries/applications';
import {
  actors, householdChoices, integrity as auditIntegrity, providerChoices, recentWrites,
} from '@/lib/queries/audit';
import { countPendingRequests, pendingRequests } from '@/lib/queries/bench';
import { listCases } from '@/lib/queries/cases';
import { getCompliance } from '@/lib/queries/compliance';
import { feeScheduleHistory, nurseDeliveries } from '@/lib/queries/feeSchedule';
import {
  countUnhandledInquiries, recentlyHandled, unhandledInquiries,
} from '@/lib/queries/intake';
import {
  bySource, capacity, failures, funnel, leakage,
} from '@/lib/queries/measure';
import { listPartners, unattributedReferrals } from '@/lib/queries/partners';
import { listProvidersWithStanding } from '@/lib/queries/providers';
import { blockers, integrity as registerIntegrity, register } from '@/lib/queries/register';
import {
  countPendingSubmissions, listPendingSubmissions, listReviewedSubmissions,
} from '@/lib/queries/submissions';
import { getToday } from '@/lib/queries/today';

let db: DbHandle;

beforeAll(async () => {
  /*
   * `seededDb` memoises one handle per process and vitest gives each file its own, so
   * truncating here empties the database for this file and no other. The seed runs
   * first and is thrown away, which is a second of waste and the price of not adding a
   * second preparation path to core for one test file to use.
   */
  db = await seededDb();
  await truncateAll(db);
});

/** Nothing is asserted about the contents. The point is that there is a return value. */
async function renders(name: string, run: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await run();
    expect(result, `${name} returned nothing at all`).toBeDefined();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${name} threw on an empty database: ${message}`);
  }
}

describe('the database really is empty', () => {
  it('holds no rows in any table the console reads', async () => {
    // Sabotage guard. Everything below passes trivially against a seeded database, so
    // if the truncate silently stopped working this file would assert nothing at all.
    for (const table of [
      'cases', 'households', 'providers', 'referrals', 'disclosures', 'credentials',
      'inquiries', 'audit_log', 'assignment_log', 'advertising_log', 'timeline_entries',
    ]) {
      const [row] = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table}`);
      expect(Number(row!.n), `${table} is not empty`).toBe(0);
    }
  });
});

describe('every screen renders on day one', () => {
  it('/today', async () => {
    const today = await renders('getToday', () => getToday(TEST_CTX));
    const shaped = today as { ordered: unknown[]; totalActions: number };
    // The seven buckets are present and empty, which is what lets the screen render
    // counts rather than deciding whether each section exists.
    expect(shaped.ordered).toHaveLength(7);
    expect(shaped.totalActions).toBe(0);
  });

  it('/intake', async () => {
    await renders('unhandledInquiries', () => unhandledInquiries(TEST_CTX));
    await renders('countUnhandledInquiries', () => countUnhandledInquiries());
    await renders('recentlyHandled', () => recentlyHandled(TEST_CTX));
  });

  it('/roster', async () => {
    await renders('listProvidersWithStanding', () => listProvidersWithStanding(TEST_CTX));
  });

  it('/applications', async () => {
    await renders('unhandledApplications', () => unhandledApplications(TEST_CTX));
    await renders('countUnhandledApplications', () => countUnhandledApplications());
    await renders('recentlyDecidedApplications', () => recentlyDecidedApplications(TEST_CTX));
  });

  it('/cases', async () => {
    await renders('listCases', () => listCases(TEST_CTX));
  });

  it('/requests', async () => {
    await renders('pendingRequests', () => pendingRequests(TEST_CTX));
    await renders('countPendingRequests', () => countPendingRequests());
  });

  it('/submissions', async () => {
    await renders('listPendingSubmissions', () => listPendingSubmissions(TEST_CTX));
    await renders('countPendingSubmissions', () => countPendingSubmissions());
    await renders('listReviewedSubmissions', () => listReviewedSubmissions(TEST_CTX));
  });

  it('/partners', async () => {
    await renders('listPartners', () => listPartners(TEST_CTX));
    await renders('unattributedReferrals', () => unattributedReferrals(TEST_CTX));
  });

  it('/compliance', async () => {
    await renders('getCompliance', () => getCompliance(TEST_CTX));
    await renders('feeScheduleHistory', () => feeScheduleHistory(TEST_CTX));
    await renders('nurseDeliveries', () => nurseDeliveries(TEST_CTX));
  });

  it('/measure', async () => {
    /*
     * The likeliest of all of them to break. Every figure here is an aggregate, two are
     * percentages, one takes a Math.max over a series, and the month series is built
     * from `min(referred_on)` over a table with no rows.
     */
    await renders('funnel', () => funnel(TEST_CTX));
    await renders('bySource', () => bySource(TEST_CTX));
    const cap = await renders('capacity', () => capacity(TEST_CTX)) as {
      heldNow: number; cleanNow: number; peak: unknown; months: unknown[];
    };
    expect(cap.heldNow).toBe(0);
    expect(cap.cleanNow).toBe(0);
    // Null rather than a zero with a month attached: no month has finished, and saying
    // "0 in Nov 2026" would be reporting a record that does not exist.
    expect(cap.peak).toBeNull();
    await renders('leakage', () => leakage(TEST_CTX));
    await renders('failures', () => failures(TEST_CTX));
  });

  it('/register', async () => {
    const page = await renders('register', () => register(TEST_CTX)) as {
      sheets: unknown[]; total: number; truncated: boolean;
    };
    expect(page.sheets).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.truncated).toBe(false);
    await renders('register integrity', () => registerIntegrity(TEST_CTX));
    await renders('blockers', () => blockers());
  });

  it('/advertising', async () => {
    const state = await renders('advertising record', () => advertisingRecord(TEST_CTX)) as {
      entries: unknown[]; coverage: { empty: boolean; uncoveredDays: number };
    };
    expect(state.entries).toEqual([]);
    // Empty, not covered. The screen says the difference, and this is where it matters:
    // a registry on its first day has recorded nothing, and reporting a clean trailing
    // year would be the register asserting compliance from an empty table.
    expect(state.coverage.empty).toBe(true);
    expect(state.coverage.uncoveredDays).toBe(0);
  });

  it('/audit', async () => {
    await renders('audit integrity', () => auditIntegrity(TEST_CTX));
    await renders('actors', () => actors(TEST_CTX));
    await renders('recentWrites', () => recentWrites(TEST_CTX));
    await renders('householdChoices', () => householdChoices());
    await renders('providerChoices', () => providerChoices());
  });
});
