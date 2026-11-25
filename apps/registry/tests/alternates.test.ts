/**
 * The cover on a case, and the count that nothing could move.
 *
 * `cases.alternate_provider_ids` arrived in migration 0001 carrying the comment
 * `-- target 2`. The Cover table on the case screen renders a row per alternate;
 * `/today` buckets every live case below `THIN_BENCH_TARGET` eligible ones into a
 * section whose blurb reads "one illness away from a service failure", and eight
 * households were in it. The only writer in either application was `src/db/seed.ts`.
 *
 * So the first test here is the one that matters: record an alternate through the module
 * and watch `/today` drop the case. Everything under it guards a way of getting that
 * wrong — a form is a list of identifiers a browser sent, and the filters are the only
 * thing that decides who may be put in front of a household.
 *
 * `beforeEach(restore)` rather than a trailing cleanup. `seededDb()` is one database per
 * test process and a restore written at the end of a test does not run when the test
 * fails — which leaves the next test reading a case somebody else moved, and that is the
 * recorded failure mode of this suite: a fixture that could not reach the case rather
 * than a bad assertion.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { caseIdWhere, providerIdByName, seededDb, TEST_CTX } from '@h-hallows/core/testing';
import { AlternateError, recordAlternates, standingAlternates } from '@/lib/queries/alternates';
import { screenCase } from '@/lib/queries/match';
import { getToday } from '@/lib/queries/today';
import { THIN_BENCH_TARGET } from '@/lib/domain/buckets';

let db: DbHandle;

/**
 * A live case the filters can actually serve, chosen from the fixture rather than named.
 *
 * `eligible` excludes the case's own primary, because that is the list the match screen
 * offers and the writer refuses that pairing outright — a fixture that handed the
 * primary back would be exercising the refusal by accident and calling it cover.
 */
async function caseWithEligible(
  atLeast: number, from?: string[],
): Promise<{ caseId: string; eligible: string[] }> {
  const rows = from
    ? from.map((id) => ({ id }))
    : await db.query<{ id: string }>(
      `SELECT id FROM cases WHERE deleted_at IS NULL AND status <> 'ended' ORDER BY created_at`,
    );
  for (const { id } of rows) {
    const [kase] = await db.query<{ primary: string | null }>(
      `SELECT primary_provider_id::text AS primary FROM cases WHERE id = $1`, [id]);
    const screen = await screenCase(db, id);
    const eligible = (screen?.eligible ?? [])
      .map((e) => e.providerId)
      .filter((pid) => pid !== kase?.primary);
    if (eligible.length >= atLeast) return { caseId: id, eligible };
  }
  throw new Error(`no fixture case has ${atLeast} eligible providers`);
}

/** The same, restricted to cases `/today` is currently calling a thin bench. */
async function thinCaseWithEligible(
  atLeast: number,
): Promise<{ caseId: string; eligible: string[] }> {
  const today = await getToday(TEST_CTX);
  const thin = today.thinBench.rows.map((r) => r.caseId);
  expect(thin.length, 'the fixture has no thin bench to fix').toBeGreaterThan(0);
  return caseWithEligible(atLeast, thin);
}

async function recordedOn(caseId: string): Promise<string[]> {
  const [row] = await db.query<{ ids: string[] | null }>(
    `SELECT alternate_provider_ids::text[] AS ids FROM cases WHERE id = $1`, [caseId],
  );
  return (row?.ids ?? []).map(String);
}

async function auditRows(caseId: string): Promise<number> {
  const [row] = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE entity = 'case' AND entity_id = $1 AND action = 'update'`,
    [caseId],
  );
  return Number(row?.n ?? 0);
}

let saved: { caseId: string; ids: string[] }[] = [];

async function restore(): Promise<void> {
  for (const { caseId, ids } of saved) {
    await db.query(
      `UPDATE cases SET alternate_provider_ids = $2::uuid[] WHERE id = $1`, [caseId, ids]);
  }
  saved = [];
}

async function remember(caseId: string): Promise<void> {
  saved.push({ caseId, ids: await recordedOn(caseId) });
}

beforeAll(async () => {
  db = await seededDb();
});

beforeEach(restore);

describe('the count /today keeps can now be moved', () => {
  it('drops a case out of the thin-bench section once it has enough cover', async () => {
    const { caseId, eligible } = await thinCaseWithEligible(THIN_BENCH_TARGET);
    await remember(caseId);

    const written = await recordAlternates(
      TEST_CTX, caseId, eligible.slice(0, THIN_BENCH_TARGET));
    expect(written.added).toHaveLength(THIN_BENCH_TARGET);
    expect(written.standing).toHaveLength(THIN_BENCH_TARGET);

    const after = await getToday(TEST_CTX);
    expect(
      after.thinBench.rows.some((r) => r.caseId === caseId),
      'the case still reads as a thin bench after its alternates were recorded',
    ).toBe(false);
  });

  it('writes the identifiers the two screens read, in the order given', async () => {
    const { caseId, eligible } = await caseWithEligible(2);
    await remember(caseId);

    const pair = [eligible[1]!, eligible[0]!];
    await recordAlternates(TEST_CTX, caseId, pair);

    expect(await recordedOn(caseId)).toEqual(pair);
    expect((await standingAlternates(caseId)).map((s) => s.providerId)).toEqual(pair);
  });
});

describe('the filters decide, not the form', () => {
  it('refuses somebody this case excludes, and says which reason', async () => {
    const { caseId } = await caseWithEligible(1);
    await remember(caseId);
    const screen = await screenCase(db, caseId);
    /*
     * Not one who is already standing. Those are kept on purpose — see the suite below
     * — so picking one here would assert the opposite of the rule under test.
     */
    const untouched = await recordedOn(caseId);
    const already = new Set(untouched);
    const barred = screen!.excluded.find((e) => !already.has(e.providerId));
    expect(barred, 'every provider this case excludes is already standing on it')
      .toBeTruthy();

    await expect(recordAlternates(TEST_CTX, caseId, [barred!.providerId]))
      .rejects.toThrow(AlternateError);

    // And the reason is the one the match screen printed beside that provider.
    await expect(recordAlternates(TEST_CTX, caseId, [barred!.providerId]))
      .rejects.toThrow(barred!.exclusion.detail);

    // A refusal writes nothing. Whatever the case already had, it still has.
    expect(await recordedOn(caseId)).toEqual(untouched);
  });

  it('refuses the primary, because a case naming one person twice has no cover', async () => {
    const { caseId, eligible } = await caseWithEligible(1);
    await remember(caseId);
    const primary = eligible[0]!;
    await db.query(`UPDATE cases SET primary_provider_id = $2 WHERE id = $1`,
      [caseId, primary]);
    try {
      await expect(recordAlternates(TEST_CTX, caseId, [primary]))
        .rejects.toThrow(/cannot also be the alternate/);
    } finally {
      await db.query(`UPDATE cases SET primary_provider_id = NULL WHERE id = $1`, [caseId]);
    }
  });

  it('refuses a case that is not on file', async () => {
    await expect(recordAlternates(
      TEST_CTX, '00000000-0000-0000-0000-000000000000', [],
    )).rejects.toThrow(/not on file/);
  });
});

describe('saving the form does not drop the cover a case already has', () => {
  /*
   * THE ONE THAT WOULD HURT. The write is a replace, and a provider whose credential
   * lapsed after being recorded no longer appears in the eligible list — so a form built
   * from that list alone renders them unticked, and saving it takes a household's
   * fallback away silently, on the screen whose whole subject is how thin that cover is.
   * `standingAlternates` exists so the page can render them ticked; this proves the
   * writer accepts them when it does.
   */
  /*
   * HOW SOMEBODY STOPS CLEARING THE FILTERS, AND WHY NOT BY A LAPSED CREDENTIAL.
   *
   * This read `UPDATE credentials SET expires_on = CURRENT_DATE - 1 WHERE type =
   * 'tb_clearance'` on whichever provider the filters offered first, and restored it to
   * a fixed `CURRENT_DATE + 365`. It was green on the day it was written and red the
   * next morning. Three things were wrong with it, and each is worth keeping out of
   * here: which credentials a provider must hold depends on their type; which provider
   * the filters offer first depends on today's date; and a provider whose type requires
   * none of that paperwork stays eligible however much of it expires — which is the
   * case the fixture happened to offer the following day. Expiring every credential
   * they hold does not fix it, because for such a provider no credential decides
   * anything.
   *
   * The rule under test is not about credentials. It is that an alternate already
   * standing is kept when they no longer clear the filters, whatever stopped them. So
   * use the one route the filters certainly read — the provider's own standing — and
   * put it back afterwards. Nothing here depends on the date, on a provider's type, or
   * on what the seed happened to offer first.
   */
  const standingOf = async (providerId: string) => (await db.query<{ status: string }>(
    `SELECT status::text AS status FROM providers WHERE id = $1`, [providerId],
  ))[0]!.status;

  const setStanding = (providerId: string, status: string) => db.query(
    `UPDATE providers SET status = $2::provider_status WHERE id = $1`,
    [providerId, status],
  );

  it('keeps an alternate who no longer clears the filters', async () => {
    const { caseId, eligible } = await caseWithEligible(2);
    await remember(caseId);
    const [keep, other] = [eligible[0]!, eligible[1]!];
    const wasStanding = await standingOf(keep);

    // Recorded while they still cleared the filters: cover the household already had.
    await recordAlternates(TEST_CTX, caseId, [keep]);
    await setStanding(keep, 'do_not_refer');

    try {
      const screen = await screenCase(db, caseId);
      expect(
        screen!.eligible.some((e) => e.providerId === keep),
        'the provider chosen for having lost eligibility is eligible again, so the rest '
        + 'of this test is not testing what it says',
      ).toBe(false);

      // Still named, because they were already standing.
      const written = await recordAlternates(TEST_CTX, caseId, [keep, other]);
      expect(written.added).toHaveLength(1);
      expect(await recordedOn(caseId)).toEqual([keep, other]);
    } finally {
      await setStanding(keep, wasStanding);
    }
  });

  it('removes somebody when they are left out, because that is what the box means', async () => {
    const { caseId, eligible } = await caseWithEligible(2);
    await remember(caseId);

    await recordAlternates(TEST_CTX, caseId, [eligible[0]!, eligible[1]!]);
    const written = await recordAlternates(TEST_CTX, caseId, [eligible[1]!]);

    expect(written.removed).toHaveLength(1);
    expect(await recordedOn(caseId)).toEqual([eligible[1]!]);
  });

  it('accepts an empty list, because a case with no cover is a thing to record', async () => {
    const { caseId, eligible } = await caseWithEligible(1);
    await remember(caseId);

    await recordAlternates(TEST_CTX, caseId, [eligible[0]!]);
    const written = await recordAlternates(TEST_CTX, caseId, []);

    expect(written.standing).toEqual([]);
    expect(written.removed).toHaveLength(1);
    expect(await recordedOn(caseId)).toEqual([]);
  });
});

describe('what it records about itself', () => {
  it('writes one audit row naming who was added', async () => {
    const { caseId, eligible } = await caseWithEligible(1);
    await remember(caseId);

    const before = await auditRows(caseId);
    await recordAlternates(TEST_CTX, caseId, [eligible[0]!]);
    expect(await auditRows(caseId)).toBe(before + 1);

    const [row] = await db.query<{ diff: Record<string, unknown> }>(
      `SELECT diff FROM audit_log
        WHERE entity = 'case' AND entity_id = $1 AND action = 'update'
        ORDER BY at DESC LIMIT 1`,
      [caseId],
    );
    expect(row!.diff.wrote).toEqual(['alternate_provider_ids']);
    expect(Array.isArray(row!.diff.added) ? row!.diff.added : []).toHaveLength(1);
  });

  it('writes nothing at all when nothing changed', async () => {
    const { caseId, eligible } = await caseWithEligible(1);
    await remember(caseId);

    await recordAlternates(TEST_CTX, caseId, [eligible[0]!]);
    const before = await auditRows(caseId);

    const again = await recordAlternates(TEST_CTX, caseId, [eligible[0]!]);
    expect(again.added).toEqual([]);
    expect(again.removed).toEqual([]);
    // An audit row per save of an unchanged form is noise in an append-only table.
    expect(await auditRows(caseId)).toBe(before);
  });

  it('ignores a repeated identifier rather than naming somebody twice', async () => {
    const { caseId, eligible } = await caseWithEligible(1);
    await remember(caseId);

    const written = await recordAlternates(
      TEST_CTX, caseId, [eligible[0]!, eligible[0]!]);
    expect(written.standing).toHaveLength(1);
    expect(await recordedOn(caseId)).toEqual([eligible[0]!]);
  });
});

describe('the target is declared once', () => {
  /*
   * Two constants holding 2 is how `/today` and `/match` come to disagree about what
   * enough cover means. The number belongs to `lib/domain/buckets.ts`, which is where
   * the bucketing that uses it lives; migration 0001 writes the same figure as a comment
   * on the column.
   */
  it('is not redeclared anywhere under lib or app', () => {
    const { readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry)) files.push(path);
      }
    };
    walk(join(process.cwd(), 'lib'));
    walk(join(process.cwd(), 'app'));

    const offenders = files.filter((f) => {
      if (f.endsWith(join('lib', 'domain', 'buckets.ts'))) return false;
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      return /(ALTERNATE_TARGET|THIN_BENCH_TARGET)\s*=\s*\d/.test(src);
    });

    expect(offenders.map((f) => f.replace(process.cwd(), '')), 'a second copy of the target')
      .toEqual([]);
    expect(THIN_BENCH_TARGET).toBe(2);
  });
});
