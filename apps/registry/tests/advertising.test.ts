/**
 * The advertising record — Civil Code § 1812.533(c).
 *
 * `advertising_log` was created in core migration 0004 and nothing wrote to it until
 * 0025. The same shape of failure as the assignment log, with one addition: the table
 * was also the wrong SHAPE for the obligation, holding a single date where the section
 * asks a question about every day of a year. A register can be empty, and it can be
 * unanswerable, and this one was both while reading as compliance in the schema.
 *
 * So these assertions are about the application rather than the table. Core's suite
 * proves the constraints refuse what they should; this proves the console reaches them —
 * that the refusals carry an explanation the operator can act on, that a refusal writes
 * nothing on its way out, and that the screen's arithmetic is the domain's arithmetic.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  addDays, advertisingCoverage, formatISODate, parseISODate,
} from '@h-hallows/core/domain';
import {
  AdvertisingError, correctEntry, record, recordAdvertisement, withdrawAdvertisement,
} from '@/lib/queries/advertising';
import { householdTrail } from '@/lib/queries/audit';

let db: DbHandle;

const ROOT = join(import.meta.dirname, '..');

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ n: string }>(sql, params);
  return Number(row.n);
}

/**
 * The window every fixture advertisement in this file sits in, and the reason it is
 * computed rather than written down.
 *
 * THESE DATES READ `2026-02-01` AND `2026-02-28`, AND THE FILE WAS GREEN FOR WEEKS
 * BEFORE IT WASN'T. The seed's advertising record leaves a deliberate nine-day hole —
 * the first website retired 300 days before today, the current one going up 290 days
 * before today, so days 299 to 291 back are uncovered, and that hole is the whole point
 * of `counts the correction and not the entry it replaced`. The hole moves with today.
 * February 2026 did not. Around 2026-11-19 the hole slid onto 2026-01-31..2026-02-08,
 * where `appearedFrom: '2026-02-01'` covered all but the first day of it. The fixture
 * that did the swallowing is the one in `leaves a continuous medium open when no end
 * date is given`: a continuous medium with no end date runs from its start to today, so
 * a single fixture pinned one day inside the hole covered the rest of it outright. A
 * print fixture could not have — the application closes a dated medium on the day it
 * ran, which is the test two above — and that distinction is why the sabotage run for
 * this fix had to be redone. The record ended up with a single uncovered day,
 * the test asked for a stretch longer than two, and the failure said
 * `expected 1 to be greater than 2`: nothing whatever about advertising.
 *
 * This is the fifth time a fixture in these repositories has been pinned to a literal
 * date while the thing it was written against moved — after the UTC-versus-California
 * date bug four times over, and `tests/alternates.test.ts`, which was green the day it
 * was written and red the next morning. So: thirty to twenty days back, which is inside
 * the trailing year the record is answerable for and inside the stretch the seed's
 * current website already covers, so these fixtures change the coverage arithmetic by
 * nothing at all and cannot overlap the hole for any value of today.
 *
 * AND TODAY COMES FROM `coverage.windowTo`, NOT FROM `new Date()`. That field is
 * documented as "today, in California", and it is the same clock the assertions are
 * read against. Taking today from the system clock here would have been the sixth
 * instance of the bug this comment is about.
 */
let AD_FROM: string;
let AD_TO: string;
/** `n` days after AD_FROM, for the corrections that move a start date. */
let adFromPlus: (n: number) => string;
/**
 * The day a withdrawn advertisement came down: inside the window it ran in.
 *
 * This read '2026-03-15', which was after the old pinned start of '2026-02-01' and is
 * nine months after the window above. Moving the fixtures without moving this closed
 * three advertisements before they began, which the advertising_log_interval check
 * refuses outright — so a date pinned in one place had quietly made a date pinned in
 * another place load-bearing. That is the second half of why none of them are written
 * down any more.
 */
let CAME_DOWN: string;

/** A lawful entry, so each test varies one thing. */
function newAd(over: Partial<Parameters<typeof recordAdvertisement>[1]> = {}) {
  return {
    medium: 'website',
    publication: `t-${Math.random().toString(36).slice(2, 10)}.example`,
    appearedFrom: AD_FROM,
    appearedTo: AD_TO,
    reference: null,
    carriedName: 'CCN',
    carriedContact: '(310) 555-0147',
    ...over,
  };
}

beforeAll(async () => {
  db = await seededDb();
  const { coverage } = await record(TEST_CTX);
  const today = parseISODate(coverage.windowTo);
  AD_FROM = formatISODate(addDays(today, -30));
  AD_TO = formatISODate(addDays(today, -20));
  adFromPlus = (n) => formatISODate(addDays(parseISODate(AD_FROM), n));
  CAME_DOWN = adFromPlus(5);
});


describe('the record reads back', () => {
  it('holds the seeded entries, each with the contact line it carried', async () => {
    const state = await record(TEST_CTX);
    expect(state.entries.length).toBeGreaterThan(0);
    for (const e of state.entries) {
      expect(e.publication).not.toBe('');
      expect(e.carriedName).not.toBe('');
      expect(e.carriedContact).not.toBe('');
      expect(e.mediumLabel.length).toBeGreaterThan(3);
    }
  });

  it('gives the screen dates it can render', async () => {
    /*
     * The register screen shipped with two date columns reading as em dashes, because a
     * `date` column arrives from the driver as a Date and the interface said string.
     * `shortDate` takes 'YYYY-MM-DD' and nothing else, by design — a wrong-looking date
     * on a compliance screen is worse than a visible blank — so it is the normalising
     * that has to be right.
     */
    const state = await record(TEST_CTX);
    for (const e of state.entries) {
      expect(e.appearedFrom, 'appearedFrom is not a renderable ISO date')
        .toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (e.appearedTo !== null) expect(e.appearedTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isFinite(e.days)).toBe(true);
      expect(e.days).toBeGreaterThan(0);
    }
    expect(state.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.coverage.windowFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('separates what is still appearing from what has ended', async () => {
    const state = await record(TEST_CTX);
    for (const e of state.open) expect(e.appearedTo).toBeNull();
    expect(state.open.length).toBeGreaterThan(0);
    expect(state.entries.filter((e) => e.appearedTo === null).length)
      .toBeGreaterThanOrEqual(state.open.length);
  });

  it('counts the trailing year the same way the domain does', async () => {
    const state = await record(TEST_CTX);
    const rows = state.entries.filter((e) => e.correctsId === null && !e.superseded);
    const direct = advertisingCoverage(
      rows.map((e) => ({ from: e.appearedFrom, to: e.appearedTo })), state.today);
    expect(state.coverage.uncoveredDays).toBe(direct.uncoveredDays);
    expect(state.coverage.coveredDays).toBe(direct.coveredDays);
  });

  it('shows the gap the seed leaves rather than smoothing over it', async () => {
    const state = await record(TEST_CTX);
    expect(state.coverage.empty).toBe(false);
    expect(state.coverage.uncoveredDays).toBeGreaterThan(0);
    expect(state.coverage.stretches.length).toBeGreaterThan(0);
    for (const s of state.coverage.stretches) {
      expect(s.days).toBeGreaterThan(0);
      expect(s.from <= s.to).toBe(true);
    }
  });
});


describe('recording an advertisement', () => {
  it('writes one entry and audits it as an advertisement', async () => {
    const before = await count(`SELECT count(*)::text AS n FROM advertising_log`);
    const id = await recordAdvertisement(TEST_CTX, newAd());
    expect(await count(`SELECT count(*)::text AS n FROM advertising_log`)).toBe(before + 1);

    const audited = await count(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE entity = 'advertisement' AND action = 'create' AND entity_id = $1`, [id]);
    expect(audited).toBe(1);
  });

  it('refuses the two values this deployment serves, and says which half is wrong', async () => {
    await expect(recordAdvertisement(TEST_CTX, newAd({ carriedName: 'PENDING_LEGAL_NAME' })))
      .rejects.toThrow(AdvertisingError);
    await expect(recordAdvertisement(TEST_CTX, newAd({ carriedContact: 'Telephone pending' })))
      .rejects.toThrow(/placeholder/);
  });

  it('cites the subdivision when the contact line is missing rather than wrong', async () => {
    await expect(recordAdvertisement(TEST_CTX, newAd({ carriedName: '   ' })))
      .rejects.toThrow(/1812\.533\(b\)\(2\)/);
  });

  it('writes nothing on the way to refusing', async () => {
    /*
     * The refusal happens before the insert, so there is no row — but there is also no
     * audit row, and that is the part worth asserting. A create audited for a write that
     * did not happen is a register that disagrees with its own trail.
     */
    const ads = await count(`SELECT count(*)::text AS n FROM advertising_log`);
    const audits = await count(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity = 'advertisement'`);

    await expect(recordAdvertisement(TEST_CTX, newAd({ carriedName: 'TBD' })))
      .rejects.toThrow(AdvertisingError);

    expect(await count(`SELECT count(*)::text AS n FROM advertising_log`)).toBe(ads);
    expect(await count(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity = 'advertisement'`)).toBe(audits);
  });

  it('refuses a medium outside the vocabulary', async () => {
    await expect(recordAdvertisement(TEST_CTX, newAd({ medium: 'skywriting' })))
      .rejects.toThrow(/not one of the media/);
  });

  it('closes a dated medium on the day it ran, whatever the form said', async () => {
    const id = await recordAdvertisement(TEST_CTX, newAd({
      medium: 'print', appearedFrom: AD_FROM, appearedTo: null,
    }));
    const row = await one<{ appeared_from: string; appeared_to: string }>(
      `SELECT appeared_from::text, appeared_to::text FROM advertising_log WHERE id = $1`, [id]);
    expect(row.appeared_to).toBe(row.appeared_from);
  });

  it('leaves a continuous medium open when no end date is given', async () => {
    const id = await recordAdvertisement(TEST_CTX, newAd({ appearedTo: null }));
    const row = await one<{ appeared_to: string | null }>(
      `SELECT appeared_to::text FROM advertising_log WHERE id = $1`, [id]);
    expect(row.appeared_to).toBeNull();
  });
});


describe('withdrawing one', () => {
  it('records the day it came down, once', async () => {
    const id = await recordAdvertisement(TEST_CTX, newAd({ appearedTo: null }));
    await withdrawAdvertisement(TEST_CTX, id, CAME_DOWN);

    const row = await one<{ appeared_to: string }>(
      `SELECT appeared_to::text FROM advertising_log WHERE id = $1`, [id]);
    expect(row.appeared_to).toBe(CAME_DOWN);

    const audited = await count(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE entity = 'advertisement' AND action = 'update' AND entity_id = $1`, [id]);
    expect(audited).toBe(1);
  });

  it('explains the second attempt instead of overwriting the first', async () => {
    const id = await recordAdvertisement(TEST_CTX, newAd({ appearedTo: null }));
    await withdrawAdvertisement(TEST_CTX, id, CAME_DOWN);

    await expect(withdrawAdvertisement(TEST_CTX, id, adFromPlus(9)))
      .rejects.toThrow(/already closed/);

    const row = await one<{ appeared_to: string }>(
      `SELECT appeared_to::text FROM advertising_log WHERE id = $1`, [id]);
    expect(row.appeared_to, 'the first answer stands').toBe(CAME_DOWN);
  });

  it('audits nothing when the withdrawal is refused', async () => {
    const id = await recordAdvertisement(TEST_CTX, newAd({ appearedTo: null }));
    await withdrawAdvertisement(TEST_CTX, id, CAME_DOWN);
    const audits = await count(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity_id = $1`, [id]);

    await expect(withdrawAdvertisement(TEST_CTX, id, adFromPlus(9))).rejects.toThrow();
    expect(await count(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity_id = $1`, [id])).toBe(audits);
  });
});


describe('corrections', () => {
  it('supersedes the original, which stays exactly as it was', async () => {
    const id = await recordAdvertisement(TEST_CTX, newAd());
    const fixId = await correctEntry(TEST_CTX, {
      entryId: id,
      appearedFrom: adFromPlus(2),
      appearedTo: AD_TO,
      reference: null,
      carriedName: 'CCN',
      carriedContact: '(310) 555-0147',
      note: 'the site went up on the third, not the first',
    });

    const original = await one<{ appeared_from: string }>(
      `SELECT appeared_from::text FROM advertising_log WHERE id = $1`, [id]);
    expect(original.appeared_from).toBe(AD_FROM);

    const fix = await one<{ appeared_from: string; corrects_id: string; publication: string }>(
      `SELECT appeared_from::text, corrects_id, publication FROM advertising_log WHERE id = $1`,
      [fixId]);
    expect(fix.appeared_from).toBe(adFromPlus(2));
    expect(fix.corrects_id).toBe(id);

    const state = await record(TEST_CTX);
    const shown = state.entries.find((e) => e.id === id)!;
    expect(shown.superseded, 'the original must render struck through').toBe(true);
  });

  it('cannot move an advertisement to a different publication', async () => {
    const id = await recordAdvertisement(TEST_CTX, newAd());
    const before = await one<{ publication: string; medium: string }>(
      `SELECT publication, medium::text FROM advertising_log WHERE id = $1`, [id]);

    const fixId = await correctEntry(TEST_CTX, {
      entryId: id,
      appearedFrom: adFromPlus(1),
      appearedTo: AD_TO,
      reference: 'a corrected reference',
      carriedName: 'CCN',
      carriedContact: '(310) 555-0147',
      note: 'the start date was a day early',
    });
    const after = await one<{ publication: string; medium: string }>(
      `SELECT publication, medium::text FROM advertising_log WHERE id = $1`, [fixId]);

    expect(after.publication).toBe(before.publication);
    expect(after.medium).toBe(before.medium);
  });

  it('refuses a correction that says nothing about what was wrong', async () => {
    const id = await recordAdvertisement(TEST_CTX, newAd());
    await expect(correctEntry(TEST_CTX, {
      entryId: id,
      appearedFrom: adFromPlus(1),
      appearedTo: AD_TO,
      reference: null,
      carriedName: 'CCN',
      carriedContact: '(310) 555-0147',
      note: '   ',
    })).rejects.toThrow(/says what was wrong/);
  });

  it('cannot launder a placeholder into the record', async () => {
    const id = await recordAdvertisement(TEST_CTX, newAd());
    await expect(correctEntry(TEST_CTX, {
      entryId: id,
      appearedFrom: AD_FROM,
      appearedTo: AD_TO,
      reference: null,
      carriedName: 'PENDING_LEGAL_NAME',
      carriedContact: '(310) 555-0147',
      note: 'the name was recorded wrongly',
    })).rejects.toThrow(/placeholder/);
  });

  it('counts the correction and not the entry it replaced', async () => {
    /*
     * Asserted against the trailing-year figures rather than against the filter that
     * produces them, because the first version of this test recomputed the same filter
     * the module uses and would have passed with superseded originals counted twice.
     *
     * The seed leaves a real hole in the record. Fill it exactly, then correct the entry
     * to start two days later. If the superseded original still counted, those two days
     * would stay covered by an entry the record itself says was wrong — which is the
     * failure worth catching: an advertisement that never ran on those days going on
     * accounting for them.
     */
    const before = await record(TEST_CTX);
    /*
     * The WIDEST stretch, not the first. `stretches` is chronological, so `[0]` was a
     * second positional assumption sitting on top of the pinned dates above: it happens
     * to be the seed's hole only while nothing else in the trailing year is uncovered,
     * and it would have silently become a one-day sliver at the window's start rather
     * than failing honestly.
     */
    const gap = [...before.coverage.stretches].sort((a, b) => b.days - a.days)[0];
    expect(gap, 'the seed is meant to leave a gap to work with').toBeDefined();
    expect(
      gap!.days,
      'the widest hole in the trailing year is too narrow to correct inside. The seed '
      + "leaves nine days; if that has shrunk, something in this file's own fixtures is "
      + 'covering it — see the comment on AD_FROM.',
    ).toBeGreaterThan(2);

    const id = await recordAdvertisement(TEST_CTX, newAd({
      publication: `gapfill-${Date.now()}.example`,
      appearedFrom: gap!.from,
      appearedTo: gap!.to,
    }));

    const filled = await record(TEST_CTX);
    expect(filled.coverage.uncoveredDays).toBe(before.coverage.uncoveredDays - gap!.days);

    const twoDaysLater = formatISODate(addDays(parseISODate(gap!.from), 2));
    await correctEntry(TEST_CTX, {
      entryId: id,
      appearedFrom: twoDaysLater,
      appearedTo: gap!.to,
      reference: null,
      carriedName: 'CCN',
      carriedContact: '(310) 555-0147',
      note: 'it did not go up for another two days',
    });

    const after = await record(TEST_CTX);
    expect(after.coverage.uncoveredDays)
      .toBe(before.coverage.uncoveredDays - gap!.days + 2);

    const shown = after.entries.find((e) => e.id === id)!;
    expect(shown.superseded).toBe(true);
  });
});


describe('reading it is recorded', () => {
  it('writes an audit row naming the section and what was found', async () => {
    const before = await count(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE entity = 'advertisement' AND action = 'read'`);
    await record(TEST_CTX);
    const after = await one<{ diff: Record<string, unknown> | null }>(
      `SELECT diff FROM audit_log
        WHERE entity = 'advertisement' AND action = 'read'
        ORDER BY at DESC LIMIT 1`);

    expect(await count(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE entity = 'advertisement' AND action = 'read'`)).toBe(before + 1);
    expect(JSON.stringify(after.diff)).toContain('1812.533(c)');
  });

  it('does not attach to a household, because it is not about one', async () => {
    /*
     * Every other register in this console holds facts about a family. This one holds
     * what the business said about itself in public, so the household trail must stay
     * clean of it — an advertising read appearing on a family's trail would be a false
     * statement about who looked at their record.
     */
    const household = await one<{ id: string }>(
      `SELECT id FROM households WHERE deleted_at IS NULL LIMIT 1`);
    await record(TEST_CTX);
    const trail = await householdTrail(TEST_CTX, household.id);
    expect(trail).not.toBeNull();
    expect(trail!.rows.some((r) => r.entity === 'advertisement')).toBe(false);
  });
});


describe('the module and the screen', () => {
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
    const module = readFileSync(join(ROOT, 'lib/queries/advertising.ts'), 'utf8');
    const exported = [...module.matchAll(/export async function (\w+)|export function (\w+)/g)]
      .map((m) => m[1] ?? m[2]!);
    expect(exported.length).toBeGreaterThan(2);

    const elsewhere = sources(join(ROOT, 'lib'))
      .concat(sources(join(ROOT, 'app')))
      .filter((p) => !p.endsWith('lib/queries/advertising.ts'))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');

    const dead = exported.filter((name) => !new RegExp(`\\b${name}\\b`).test(elsewhere));
    expect(dead, `exported and never called: ${dead.join(', ')}`).toEqual([]);
  });

  it('is reachable from the console', () => {
    const layout = readFileSync(join(ROOT, 'app/(app)/layout.tsx'), 'utf8');
    expect(layout).toContain("href: '/advertising'");
  });

  it('never supplies its own entry timestamp', () => {
    /*
     * ADVERTISING_LOG_INSERT takes the moment the ENTRY is made as its eleventh
     * argument, so the seed can represent a year of advertisements recorded as they ran.
     * In the console it is always null. An entry that could claim to have been written
     * earlier than it was is the false record § 1812.533(b)(1) is about, written into
     * the register that exists to disprove it.
     */
    const files = sources(join(ROOT, 'lib')).concat(sources(join(ROOT, 'app')));
    const calls: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/ADVERTISING_LOG_INSERT,\s*\[([\s\S]*?)\]\)/g)) {
        calls.push(`${file}: [${m[1]!.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim()}]`);
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, 'a console call site supplies its own entry timestamp')
        .toMatch(/,\s*null,?\s*\]$/);
    }
  });

  it('deletes from the record nowhere', () => {
    const files = sources(join(ROOT, 'lib')).concat(sources(join(ROOT, 'app')));
    const offenders = files.filter((f) =>
      /DELETE\s+FROM\s+advertising_log/i.test(
        readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
    expect(offenders).toEqual([]);
  });
});
