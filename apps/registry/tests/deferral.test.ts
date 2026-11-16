/**
 * The nine-factor deferral, asserted instead of described.
 *
 * `DEFERRED.md` blocks the scheduling and coverage surface until the § 0.5 item 2 audit
 * is done with counsel, because coordinating cover is the activity § 1812.5095(b)(5) and
 * § 687.2(e) constrain — and a database turns coordination into a timestamped per-case
 * written record of it. A notebook is ambiguous; a database is evidence.
 *
 * WHY THIS FILE EXISTS. The deferral was held in prose, and prose went out of date. The
 * document stated that no query, server action or component touched `coverage_gaps`;
 * `CCN-external/lib/schedule.ts` had been reading it and rendering the result on the
 * household's own portal for weeks. Nobody noticed, because nothing writes the table, so
 * the screen renders nothing, and an empty screen is indistinguishable from an absent
 * one — the same shape as the two statutory registers found empty this month.
 *
 * So the half of the gate that matters is now a test. The WRITING half: nothing may
 * create, resolve or assign a coverage gap. That is the coordination, and that is what
 * the audit blocks. The reading half is the "record-only coverage view" the deferral
 * itself anticipates as the permitted end state, and `CCN-external/tests/deferral.test.ts`
 * holds its boundary — one named reader, no writers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(import.meta.dirname, '..');
const REPO = join(APP, '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

function consoleSources(): string[] {
  return sources(join(APP, 'app'))
    .concat(sources(join(APP, 'lib')))
    .concat(sources(join(APP, 'components')));
}

/** Comments stripped: a table named in a note explaining why it is untouched is fine. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the coverage surface is not built in this console', () => {
  it('writes to coverage_gaps from nowhere', () => {
    const offenders = consoleSources().filter((f) =>
      /(INSERT INTO|UPDATE|DELETE FROM)\s+coverage_gaps\b/i.test(code(f)));
    expect(
      offenders.map((f) => f.replace(APP, '')),
      'Creating, resolving or assigning a coverage gap IS the coordination the § 0.5 '
      + 'item 2 audit blocks. See /DEFERRED.md.',
    ).toEqual([]);
  });

  it('reads coverage_gaps from nowhere either', () => {
    /*
     * Stricter than the writing rule, and deliberately so. The console is where the
     * § 5 "coverage gaps in the next 7 days" bucket would go, and that bucket is the
     * operator's work queue — a list of holes to fill, which is the roster workflow
     * under another name. The household's own portal is a different question and is
     * governed in the other repository.
     */
    const offenders = consoleSources().filter((f) => /\bcoverage_gaps\b/i.test(code(f)));
    expect(offenders.map((f) => f.replace(APP, ''))).toEqual([]);
  });

  it('ships seven Today buckets, not eight', () => {
    const buckets = readFileSync(join(APP, 'lib/domain/buckets.ts'), 'utf8');
    const shape = buckets.match(/export interface Today \{[\s\S]*?\n\}/)?.[0];
    expect(shape, 'the Today shape moved').toBeDefined();

    const fields = [...shape!.matchAll(/^\s{2}(\w+): TodayBucket</gm)].map((m) => m[1]!);
    // `ordered` is the same buckets again as a list, so it is not one of them.
    expect(fields, 'the ordered list is how the screen renders counts').toContain('ordered');
    const named = fields.filter((n) => n !== 'ordered');
    expect(named).toHaveLength(7);
    expect(named.some((n) => /coverage|gap/i.test(n)),
      'the eighth bucket is blocked; see /DEFERRED.md').toBe(false);
  });
});

describe('the deferral document says what is true', () => {
  it('no longer claims nothing touches the table', () => {
    /*
     * The exact sentence that was false. Asserted by absence because it is the claim
     * itself that was the problem — a reader who believed it would have concluded the
     * gate was held in both repositories, which is the conclusion that went unchecked
     * for weeks.
     */
    const doc = readFileSync(join(REPO, 'DEFERRED.md'), 'utf8');
    const stale = doc.split('### What this said until')[0]!;
    expect(stale).not.toMatch(/No query, server action, or component touches the table/);
  });

  it('names the reader that exists, so the correction cannot be quietly dropped', () => {
    const doc = readFileSync(join(REPO, 'DEFERRED.md'), 'utf8');
    expect(doc).toMatch(/CCN-external\/lib\/schedule\.ts/);
    expect(doc).toMatch(/portal\/schedule/);
  });

  it('still blocks the surface rather than quietly reclassifying it as shipped', () => {
    const doc = readFileSync(join(REPO, 'DEFERRED.md'), 'utf8');
    expect(doc).toMatch(/Blocked by the nine-factor audit/);
    expect(doc).toMatch(/No gap-filling, substitute-suggestion, or roster workflow/);
  });
});
