/**
 * The console asks California what day it is, everywhere.
 *
 * The rule, and the four times this has gone wrong, are in
 * `@h-hallows/core/testing/sqlClock`. Two of the four were in this application: the fee
 * schedule's "in force" date on the screen that exists to make the § 1812.527 seven-day
 * embargo auditable, and the § 8 capacity series, which grew a row for a month that had
 * not started in California and marked it as the month in progress.
 *
 * The sweep is over every TypeScript file under `app/` and `lib/`, tests excluded —
 * a test may write `current_date` deliberately, to prove something is refused.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clockReport, clockViolations } from '@h-hallows/core/testing/sqlClock';

const APP = join(import.meta.dirname, '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

function scanned(): { path: string; text: string }[] {
  return sources(join(APP, 'app'))
    .concat(sources(join(APP, 'lib')))
    .concat(sources(join(APP, 'components')))
    .map((p) => ({ path: p.replace(APP, ''), text: readFileSync(p, 'utf8') }));
}

describe('no calendar date comes from the server clock', () => {
  it('has files to check, so a silent empty sweep cannot pass', () => {
    expect(scanned().length).toBeGreaterThan(40);
  });

  it('finds none in the console', () => {
    const found = clockViolations(scanned());
    expect(found, clockReport(found)).toEqual([]);
  });

  it('covers the measure queries by name, where two of the four were', () => {
    /*
     * Named rather than left to the sweep. `lib/queries/measure.ts` carried the defect
     * twice over — the capacity month series and the leakage window — and it is the
     * module most likely to grow another date decision, because every figure on that
     * screen is an aggregate over a period.
     */
    const measure = join(APP, 'lib/queries/measure.ts');
    const text = readFileSync(measure, 'utf8');
    expect(clockViolations([{ path: 'measure.ts', text }])).toEqual([]);
    // And it still decides its dates in California rather than not deciding them at all.
    expect(text).toMatch(/now\(\) AT TIME ZONE 'America\/Los_Angeles'/);
  });
});
