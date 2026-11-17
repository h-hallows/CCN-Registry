/**
 * Published rate bands — Civil Code § 1812.533(b)(1).
 *
 * `rate_ranges` was written by the seed and read by the public pricing page. Nothing in
 * this console had ever written it, so the bands the public have been reading were
 * demonstration data an operator could not correct.
 *
 * Core's suite proves the table refuses what it should. What is asserted here is the
 * console's half: that the screen can tell a band that is live from one that is dated
 * ahead from one that has been superseded, that it names the seeded bands as seeded
 * rather than quietly presenting them as posted, and — the part that matters most — that
 * it never fills a band in for the operator.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import { addDays, formatISODate, parseISODate } from '@h-hallows/core/domain';
import { postBand, rateBands, RateBandError } from '@/lib/queries/rates';

let db: DbHandle;
const ROOT = join(import.meta.dirname, '..');

beforeAll(async () => { db = await seededDb(); });

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await db.query<{ n: string }>(sql, params);
  return Number(row!.n);
}

const newBand = (over: Partial<Parameters<typeof postBand>[1]> = {}) => ({
  serviceKey: 'respite',
  level: 'hca',
  low: 38,
  high: 52,
  effectiveFrom: '2039-04-01',
  note: 'Provider-set and negotiated directly with the household.',
  ...over,
});


describe('what the screen reads back', () => {
  it('marks what is on the page now, what is coming, and what is gone', async () => {
    const state = await rateBands(TEST_CTX);
    expect(state.bands.length).toBeGreaterThan(0);
    for (const b of state.bands) {
      // Exactly one of the three, always. A band that is neither live, upcoming nor
      // superseded is a band the screen has no sentence for.
      expect([b.inForce, b.upcoming, b.superseded].filter(Boolean)).toHaveLength(1);
      expect(b.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(b.low).toBeLessThanOrEqual(b.high);
      expect(b.levelLabel.length).toBeGreaterThan(5);
    }
    expect(state.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts the seeded bands as seeded', async () => {
    /*
     * The finding this screen exists for. These are the registry's published prices and
     * nobody posted them — presenting them as posted would make the pricing page look
     * maintained, which is the drift the whole exercise is about.
     */
    const state = await rateBands(TEST_CTX);
    expect(state.seeded).toBeGreaterThan(0);
    expect(state.seeded).toBe(
      state.bands.filter((b) => b.inForce && b.postedBy === 'seed').length);
  });

  it('shows one live band per service and level, never two', async () => {
    const state = await rateBands(TEST_CTX);
    const live = state.bands.filter((b) => b.inForce)
      .map((b) => `${b.serviceKey}:${b.level}`);
    expect(new Set(live).size).toBe(live.length);
  });

  it('names the services with no band in force', async () => {
    const state = await rateBands(TEST_CTX);
    const priced = new Set(state.bands.filter((b) => b.inForce).map((b) => b.serviceKey));
    for (const u of state.unpriced) expect(priced.has(u.serviceKey)).toBe(false);
  });

  it('is audited as a rate band read, naming the subdivision', async () => {
    const before = await count(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE entity = 'rate_band' AND action = 'read'`);
    await rateBands(TEST_CTX);
    expect(await count(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE entity = 'rate_band' AND action = 'read'`)).toBe(before + 1);

    const [row] = await db.query<{ diff: Record<string, unknown> | null }>(
      `SELECT diff FROM audit_log WHERE entity = 'rate_band' AND action = 'read'
        ORDER BY at DESC LIMIT 1`);
    expect(JSON.stringify(row!.diff)).toContain('1812.533(b)(1)');
  });
});


describe('what the roster charges', () => {
  /*
   * Read through `rateBands` rather than directly. The observation is module-private —
   * an export with no caller outside the module is an obligation nobody meets, and the
   * dead-export test below is what pointed that out — so what is asserted here is
   * exactly the shape the screen receives.
   */
  const observedRates = async () => (await rateBands(TEST_CTX)).observed;

  it('reports every credential level, including the empty ones', async () => {
    const observed = await observedRates();
    expect(observed.map((o) => o.level))
      .toEqual(['companion', 'hca', 'cna', 'lvn', 'rn']);
    for (const o of observed) {
      if (o.low !== null && o.high !== null) expect(o.low).toBeLessThanOrEqual(o.high);
      if (o.median !== null) {
        expect(o.median).toBeGreaterThanOrEqual(o.low!);
        expect(o.median).toBeLessThanOrEqual(o.high!);
      }
    }
  });

  it('counts a provider with no rate on file as present, not as absent', async () => {
    /*
     * "Nobody at this level" and "nobody at this level has stated a rate" are different
     * sentences on the screen, and the second is actionable. The rate query filters out
     * the rateless, so the headcount is taken separately — this is what notices if that
     * second query is dropped as redundant.
     */
    const observed = await observedRates();
    for (const level of ['companion', 'hca', 'cna', 'lvn', 'rn'] as const) {
      const heads = await count(
        `SELECT count(*)::text AS n FROM providers
          WHERE deleted_at IS NULL AND status = 'active' AND lower(type::text) = $1`,
        [level]);
      expect(observed.find((o) => o.level === level)!.count, level).toBe(heads);
    }
  });

  it('takes the middle rather than the mean', async () => {
    /*
     * One provider at two hundred dollars an hour should not move the number an operator
     * reads. Asserted against the database's own percentile rather than recomputed,
     * because recomputing it here would be the same arithmetic twice and agree with
     * itself whatever it did.
     */
    const observed = await observedRates();
    for (const o of observed) {
      if (o.median === null) continue;
      const [row] = await db.query<{ med: string }>(
        `SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY rate_hourly))::text AS med
           FROM providers
          WHERE deleted_at IS NULL AND status = 'active' AND rate_hourly IS NOT NULL
            AND lower(type::text) = $1`, [o.level]);
      expect(Number(row!.med)).toBeCloseTo(o.median, 2);
    }
  });
});


describe('posting a band', () => {
  it('writes one row and audits it', async () => {
    const before = await count(`SELECT count(*)::text AS n FROM rate_ranges`);
    const { id } = await postBand(TEST_CTX, newBand());
    expect(await count(`SELECT count(*)::text AS n FROM rate_ranges`)).toBe(before + 1);

    expect(await count(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE entity = 'rate_band' AND action = 'create' AND entity_id = $1`, [id])).toBe(1);

    const [row] = await db.query<{ posted_by: string }>(
      `SELECT posted_by FROM rate_ranges WHERE id = $1`, [id]);
    expect(row!.posted_by).toBe(TEST_CTX.actor);
  });

  it('refuses a service no page quotes', async () => {
    await expect(postBand(TEST_CTX, newBand({ serviceKey: 'dog_walking' })))
      .rejects.toThrow(/published, invisible/);
  });

  it('refuses a band whose top is below its bottom', async () => {
    await expect(postBand(TEST_CTX, newBand({ low: 60, high: 40 })))
      .rejects.toThrow(/below the bottom/);
  });

  it('refuses a second band for the same service, level and date', async () => {
    const at = { serviceKey: 'companion', level: 'companion', effectiveFrom: '2039-09-09' };
    await postBand(TEST_CTX, newBand(at));
    await expect(postBand(TEST_CTX, newBand(at))).rejects.toThrow(/append-only/);
  });

  it('writes nothing on the way to refusing', async () => {
    const bands = await count(`SELECT count(*)::text AS n FROM rate_ranges`);
    const audits = await count(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity = 'rate_band'`);

    await expect(postBand(TEST_CTX, newBand({ low: 99, high: 10 })))
      .rejects.toThrow(RateBandError);

    expect(await count(`SELECT count(*)::text AS n FROM rate_ranges`)).toBe(bands);
    expect(await count(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity = 'rate_band'`)).toBe(audits);
  });

  it('posts a band the roster does not support, and records that it said so', async () => {
    /*
     * The judgement call, asserted as a judgement. A band far above what every provider
     * at that level charges is a question, not a provable falsehood — the roster records
     * what a nurse charges, not what they charge for hospice support — so it posts, and
     * the audit row carries the concern so the decision is on the record.
     */
    const { id, notes } = await postBand(TEST_CTX, newBand({
      serviceKey: 'hospice_support', level: 'rn',
      low: 400, high: 500, effectiveFrom: '2039-11-11',
    }));
    /*
     * Handed back, not only recorded. The first version computed these, wrote them to
     * the audit diff and told the operator nothing — a warning nobody reads is worse
     * than no warning, because the record says they were told.
     */
    expect(notes.map((n) => n.concern)).toContain('outside_observed');
    expect(notes[0]!.message).toMatch(/1812\.533\(b\)\(1\)/);
    const [row] = await db.query<{ diff: Record<string, unknown> | null }>(
      `SELECT diff FROM audit_log WHERE entity_id = $1 AND action = 'create'`, [id]);
    expect(JSON.stringify(row!.diff)).toContain('outside_observed');
  });

  it('takes effect on the day it says, and not before', async () => {
    const state = await rateBands(TEST_CTX);
    for (const b of state.bands) {
      if (b.upcoming) expect(b.effectiveFrom > state.today).toBe(true);
      if (b.inForce) expect(b.effectiveFrom <= state.today).toBe(true);
    }
  });
});


describe('live, coming, and gone', () => {
  /*
   * The three states need a fixture, because the seed has exactly one band per service
   * and level dated a month ago — so nothing is superseded, nothing is upcoming, and
   * every assertion about telling them apart passes against data where there is nothing
   * to tell apart. Hardcoding `superseded: false` in the module passed the whole file.
   *
   * These post around today's date rather than at a fixed year, so the test says the
   * same thing whenever it runs.
   */
  const day = (from: string, n: number) => formatISODate(addDays(parseISODate(from), n));

  it('supersedes an older band and keeps it in the record', async () => {
    const before = await rateBands(TEST_CTX);
    const old = before.bands.find((b) => b.inForce && b.postedBy === 'seed')!;
    expect(old, 'the seed has no live band to supersede').toBeDefined();

    await postBand(TEST_CTX, {
      serviceKey: old.serviceKey,
      level: old.level,
      low: old.low + 2,
      high: old.high + 2,
      effectiveFrom: day(before.today, -1),
      note: 'a correction',
    });

    const after = await rateBands(TEST_CTX);
    const wasLive = after.bands.find((b) => b.id === old.id)!;
    expect(wasLive.inForce, 'the old band is still on the page').toBe(false);
    expect(wasLive.superseded, 'the old band is not marked superseded').toBe(true);
    // Still in the record, which is what answers "what did the page say in March".
    expect(wasLive.low).toBe(old.low);

    const nowLive = after.bands.filter(
      (b) => b.inForce && b.serviceKey === old.serviceKey && b.level === old.level);
    expect(nowLive).toHaveLength(1);
    expect(nowLive[0]!.low).toBe(old.low + 2);
  });

  it('does not put a band dated ahead on the page yet', async () => {
    const before = await rateBands(TEST_CTX);
    const live = before.bands.find((b) => b.inForce)!;

    const { id } = await postBand(TEST_CTX, {
      serviceKey: live.serviceKey,
      level: live.level,
      low: live.low + 5,
      high: live.high + 5,
      effectiveFrom: day(before.today, 3),
      note: 'a planned change',
    });

    const after = await rateBands(TEST_CTX);
    const planned = after.bands.find((b) => b.id === id)!;
    expect(planned.upcoming).toBe(true);
    expect(planned.inForce, 'a band dated ahead is already on the page').toBe(false);

    // And the one it will replace is still the live one until then.
    const stillLive = after.bands.filter(
      (b) => b.inForce && b.serviceKey === live.serviceKey && b.level === live.level);
    expect(stillLive).toHaveLength(1);
    expect(stillLive[0]!.id).not.toBe(id);
  });

  it('puts a band on the page on the day it says, not before', async () => {
    const before = await rateBands(TEST_CTX);
    const { id } = await postBand(TEST_CTX, {
      serviceKey: 'skilled_nursing',
      level: 'lvn',
      low: 60,
      high: 80,
      effectiveFrom: before.today,
      note: 'today',
    });
    const after = await rateBands(TEST_CTX);
    expect(after.bands.find((b) => b.id === id)!.inForce).toBe(true);
  });
});

describe('a provider with no rate on file', () => {
  it('is counted as present at their level, not as absent', async () => {
    /*
     * "Nobody at this level" and "nobody at this level has stated a rate" are different
     * sentences on the screen, and only the second is actionable. The seed gives every
     * active provider a rate, so the second query that takes the headcount separately
     * looked redundant — deleting it passed every test in this file.
     *
     * Rolled back: the seeded roster is what the rest of the suite asserts against.
     */
    const level = 'lvn';
    const before = (await rateBands(TEST_CTX)).observed.find((o) => o.level === level)!;
    expect(before.count, 'the seed has no LVN to work with').toBeGreaterThan(0);
    expect(before.low).not.toBeNull();

    await db.query('BEGIN');
    try {
      await db.query(
        `UPDATE providers SET rate_hourly = NULL
          WHERE deleted_at IS NULL AND status = 'active' AND type = 'LVN'`);

      const after = (await rateBands(TEST_CTX)).observed.find((o) => o.level === level)!;
      expect(after.count, 'they stopped existing when their rate did').toBe(before.count);
      expect(after.low).toBeNull();
      expect(after.high).toBeNull();
      expect(after.median).toBeNull();
    } finally {
      await db.query('ROLLBACK');
    }
  });
});

describe('the console never proposes a price', () => {
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sources(path, out);
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
    return out;
  }

  it('leaves the band fields empty rather than defaulting them', () => {
    /*
     * I5. A provider sets their own rate and it stays negotiable with the household, and
     * nothing in this system computes, suggests, caps or defaults it. A `defaultValue`
     * on the band inputs — even one taken from the roster — would be the registry
     * proposing a price, which is the thing the whole rate design avoids.
     */
    const page = readFileSync(join(ROOT, 'app/(app)/rates/page.tsx'), 'utf8');
    const lowField = page.match(/<input[^>]*name="low"[\s\S]*?\/>/)?.[0];
    const highField = page.match(/<input[^>]*name="high"[\s\S]*?\/>/)?.[0];
    expect(lowField, 'the band fields moved').toBeDefined();
    expect(lowField!, 'the bottom of the band is pre-filled').not.toMatch(/defaultValue/);
    expect(highField!, 'the top of the band is pre-filled').not.toMatch(/defaultValue/);
  });

  it('has no code that derives a band from what the roster charges', () => {
    const module = readFileSync(join(ROOT, 'lib/queries/rates.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // `observedRates` may be read beside the form; it may not become the form's value.
    expect(module).not.toMatch(/suggested|recommendedBand|defaultBand|deriveBand/i);
  });

  it('shows a band as a range, with the negotiable wording beside it', () => {
    const page = readFileSync(join(ROOT, 'app/(app)/rates/page.tsx'), 'utf8');
    expect(page).toMatch(/negotiable/);
    // A single figure would read as a price list, which this is not.
    expect(page).toMatch(/\{money\(band\.low\)\}–\{money\(band\.high\)\}/);
  });

  it('has a caller outside the module for every exported function', () => {
    const module = readFileSync(join(ROOT, 'lib/queries/rates.ts'), 'utf8');
    const exported = [...module.matchAll(/export async function (\w+)|export function (\w+)/g)]
      .map((m) => m[1] ?? m[2]!);
    expect(exported.length, "the module lost its exports").toBeGreaterThanOrEqual(2);

    const elsewhere = sources(join(ROOT, 'lib'))
      .concat(sources(join(ROOT, 'app')))
      .filter((p) => !p.endsWith('lib/queries/rates.ts'))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');

    const dead = exported.filter((name) => !new RegExp(`\\b${name}\\b`).test(elsewhere));
    expect(dead, `exported and never called: ${dead.join(', ')}`).toEqual([]);
  });

  it('is reachable from the console', () => {
    expect(readFileSync(join(ROOT, 'app/(app)/layout.tsx'), 'utf8'))
      .toContain("href: '/rates'");
  });
});


describe('the operator is told what the system noticed', () => {
  it('says nothing about a band the roster supports', async () => {
    const observed = (await rateBands(TEST_CTX)).observed.find((o) => o.level === 'cna')!;
    if (observed.low === null) return;
    const { notes } = await postBand(TEST_CTX, newBand({
      serviceKey: 'personal_care', level: 'cna',
      low: observed.low, high: observed.high!, effectiveFrom: '2045-02-02',
    }));
    expect(notes).toEqual([]);
  });

  it('hands back every concern, with the sentence the operator reads', async () => {
    const { notes } = await postBand(TEST_CTX, newBand({
      serviceKey: 'overnight_newborn', level: 'cna',
      low: 900, high: 950, effectiveFrom: '2045-03-03',
    }));
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.blocking).toBe(false);
      expect(n.message.length, n.concern).toBeGreaterThan(40);
    }
  });

  it('is surfaced by the action rather than left in the audit log', () => {
    /*
     * The gap the dead-export test found. `postBand` returns the notes; this is the
     * assertion that the action still says them out loud at the moment of posting.
     */
    const actions = readFileSync(join(ROOT, 'app/(app)/actions.ts'), 'utf8');
    const body = actions.match(/postRateBandAction[\s\S]*?\n}/)?.[0];
    expect(body, 'the action moved').toBeDefined();
    expect(body!).toMatch(/posted\.notes/);
    expect(body!).toMatch(/n\.message/);
  });
});
