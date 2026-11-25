/**
 * § 1812.5095(f): the written statement, and the one state three surfaces must agree on.
 *
 * The screen and the export disagreed about the same row. `getCompliance` carried
 * `onTime: boolean | null`, and `null` stood for two opposite things — a statement that
 * is overdue and was never sent, which is the breach, and one that is not yet due, which
 * is lawful. The screen told them apart by calling `dueWording` on the stored deadline;
 * `disclosureLogToCsv` wrote "not sent" for both. So the auditable artifact, the one
 * thing that leaves the system and is read by somebody who cannot ask a follow-up
 * question, was the one place a missed statutory deadline was invisible. The counter at
 * the top of the screen added the two together, and the cell was painted critical red
 * whether or not anything was wrong.
 *
 * What is asserted here is the rule and not the row that was wrong: the state is decided
 * once, in the query layer, and for EVERY row in the log the screen's wording, the
 * screen's colour, the counter the row lands in and the exported cell describe that same
 * state — with all four states present, so none of the four can be the one nobody looks
 * at. An assertion about a single example would leave the next consumer free to
 * re-derive the distinction from a null and a date, which is exactly how these three
 * came apart.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '@h-hallows/core/db';
import { caseIdWhere, seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  addDays, formatISODate, parseISODate, writtenStatementDueOn,
} from '@h-hallows/core/domain';
import {
  countWrittenStatements, disclosureLogToCsv, getCompliance, writtenStatementCell,
  writtenStatementState, type DisclosureLogRow, type WrittenStatementState,
} from '@/lib/queries/compliance';

let db: DbHandle;

/**
 * What each state looks like in all three places, as data.
 *
 * Keyed by the union, so a fifth state cannot be added without an entry here, and the
 * tests below walk every key — a state the fixture never reaches fails rather than going
 * quietly unasserted. That is this codebase's recorded failure mode: a control that is
 * present, correct, tested, green and never reached.
 */
const AGREEMENT: Record<WrittenStatementState, {
  /** The cell an auditor filters the exported file on. */
  csvCell: string;
  /** What the screen's "Written sent" column says. */
  wording: RegExp;
  color: string;
  /** Whether the cell names the day the statement went out. */
  namesTheDay: boolean;
}> = {
  sent_on_time: {
    csvCell: 'sent_on_time',
    wording: /^sent on time$/,
    color: 'var(--color-ok)',
    namesTheDay: true,
  },
  sent_late: {
    csvCell: 'sent_late',
    wording: /^sent late$/,
    color: 'var(--color-expired)',
    namesTheDay: true,
  },
  overdue: {
    csvCell: 'overdue',
    wording: /^\d+ days? overdue$/,
    color: 'var(--color-critical)',
    namesTheDay: false,
  },
  not_yet_due: {
    csvCell: 'not_yet_due',
    wording: /^due (today|tomorrow|in \d+ days)$/,
    color: 'var(--ink-soft)',
    namesTheDay: false,
  },
};

const EVERY_STATE = Object.keys(AGREEMENT) as WrittenStatementState[];

/** Noon in California on `iso`, whichever side of a daylight-saving change it falls. */
function laNoon(iso: string): Date {
  return new Date(`${iso}T20:00:00Z`);
}

function shift(iso: string, days: number): string {
  return formatISODate(addDays(parseISODate(iso), days));
}

/**
 * A real parse of the exported file, not a split on commas.
 *
 * `csvCell` quotes any cell holding a comma, a quote or a newline, and a household
 * display name is free to hold one. A test that took the column by position after a
 * naive split would pass for the wrong reason until the day a name had a comma in it.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [[]];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { rows.at(-1)!.push(cell); cell = ''; continue; }
    if (ch === '\r' && text[i + 1] === '\n') {
      rows.at(-1)!.push(cell);
      cell = '';
      rows.push([]);
      i += 1;
      continue;
    }
    cell += ch;
  }
  rows.at(-1)!.push(cell);
  return rows;
}

/** The exported file's own verdict on each row, keyed by disclosure. */
function exportedStates(rows: DisclosureLogRow[]): Map<string, string> {
  const parsed = parseCsv(disclosureLogToCsv(rows));
  const header = parsed[0]!;
  const id = header.indexOf('disclosure_id');
  const state = header.indexOf('written_state');
  expect(id, 'the export no longer identifies the row').toBeGreaterThan(-1);
  expect(state, 'the export no longer carries the statutory state').toBeGreaterThan(-1);
  return new Map(parsed.slice(1).map((r) => [r[id]!, r[state]!]));
}

/*
 * The day every state below is measured against, and the three dates the four rows are
 * built around. Fixed rather than taken from the system clock: `getCompliance` takes an
 * injectable clock precisely so a test does not have to be run on the right afternoon to
 * mean anything, and a suite that drifts into a different set of states every week will
 * eventually stop reaching one of the four.
 */
const WHEN = '2026-06-16';
const SPOKEN = '2026-06-05';
const SPOKEN_RECENTLY = '2026-06-15';

/**
 * The four states, written as disclosure rows.
 *
 * Two of them are not in the seed at all: it writes six statements sent exactly on their
 * deadline and one not yet sent, so nothing is ever late and nothing is ever overdue.
 * They are inserted rather than written onto the seeded rows because the database will
 * not have it either way round — `disclosure_guard` refuses a DELETE outright and makes
 * `written_sent_on` settable once, so a delivery date cannot be moved, cleared, or put
 * back afterwards. Which is also why they are inserted ONCE, in `beforeAll`, and no test
 * here mutates a disclosure: there is no restore that could follow one.
 *
 * Every deadline comes from `writtenStatementDueOn`, the same function `makeReferral`
 * uses, so no date here is a business-day count done by hand in a test.
 */
const DUE_ON = writtenStatementDueOn(SPOKEN);
const DUE_LATER = writtenStatementDueOn(SPOKEN_RECENTLY);

const FIXTURE: {
  state: WrittenStatementState;
  disclosedTo: string;
  disclosedOn: string;
  dueOn: string;
  sentOn: string | null;
}[] = [
  {
    state: 'sent_on_time',
    disclosedTo: 'Fixture — statement sent inside the three days',
    disclosedOn: SPOKEN,
    dueOn: DUE_ON,
    sentOn: shift(DUE_ON, -1),
  },
  {
    state: 'sent_late',
    disclosedTo: 'Fixture — statement sent the day after the deadline',
    disclosedOn: SPOKEN,
    dueOn: DUE_ON,
    sentOn: shift(DUE_ON, 1),
  },
  {
    state: 'overdue',
    disclosedTo: 'Fixture — deadline passed and nothing sent',
    disclosedOn: SPOKEN,
    dueOn: DUE_ON,
    sentOn: null,
  },
  {
    state: 'not_yet_due',
    disclosedTo: 'Fixture — spoken yesterday, statement not yet due',
    disclosedOn: SPOKEN_RECENTLY,
    dueOn: DUE_LATER,
    sentOn: null,
  },
];

/** disclosure id -> the state it was written to be in. */
const declared = new Map<string, WrittenStatementState>();

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

beforeAll(async () => {
  db = await seededDb();
  const caseId = await caseIdWhere(db, `c.status = 'active'`);

  for (const row of FIXTURE) {
    const at = `${row.disclosedOn}T19:00:00Z`;
    const timeline = await one<{ id: string }>(
      `INSERT INTO timeline_entries (case_id, type, author, body, at)
       VALUES ($1, 'disclosure', 'operator', $2, $3) RETURNING id`,
      [caseId, `Spoken disclosure given. Written statement due ${row.dueOn}.`, at],
    );
    const disclosure = await one<{ id: string }>(
      `INSERT INTO disclosures
         (case_id, timeline_id, disclosed_to, disclosed_by, method, disclosed_at,
          written_due_on, written_sent_on, written_method)
       VALUES ($1, $2, $3, 'operator', 'phone', $4, $5::date, $6::date, $7)
       RETURNING id`,
      [caseId, timeline.id, row.disclosedTo, at, row.dueOn, row.sentOn,
        row.sentOn === null ? null : 'email and post'],
    );
    declared.set(disclosure.id, row.state);
  }

  expect(new Set(declared.values()), 'the fixture does not write all four states')
    .toEqual(new Set(EVERY_STATE));
});

describe('the state the statute measures, computed once', () => {
  it('reads the same in the wording, the colour, the counter and the export', async () => {
    const at = laNoon(WHEN);
    const rows = (await getCompliance(TEST_CTX, at)).disclosureLog;
    const counts = countWrittenStatements(rows);
    const exported = exportedStates(rows);
    expect(rows.length).toBeGreaterThan(declared.size);

    const reached = new Set<WrittenStatementState>();

    // Every row in the log, not only the four this file wrote. The defect was a
    // consumer deriving the state for itself, and it would be back the moment one row
    // in the log were allowed to disagree.
    for (const row of rows) {
      const state = row.writtenState;
      const look = AGREEMENT[state];
      expect(look, `${state} has no agreed rendering`).toBeDefined();

      const cell = writtenStatementCell(row, at);
      expect(cell.wording, `the screen's wording for ${state}`).toMatch(look.wording);
      expect(cell.color, `the colour for ${state}`).toBe(look.color);
      expect(cell.sentOn !== null, `whether ${state} names the day it went out`)
        .toBe(look.namesTheDay);
      expect(exported.get(row.disclosureId), `the exported cell for ${state}`)
        .toBe(look.csvCell);

      /*
       * Critical means the § 1812.5095(f) breach and nothing else. A statement that was
       * unsent but not yet due wore the same red, which is what made the colour on this
       * screen say nothing at all.
       */
      expect(cell.color === 'var(--color-critical)', `critical for ${state}`)
        .toBe(state === 'overdue');

      // And the state is what the row was written to be in, where this file wrote it.
      const wanted = declared.get(row.disclosureId);
      if (wanted) expect(state, `the state of "${row.disclosedTo}"`).toBe(wanted);

      reached.add(state);
    }

    // Asserted over all four states, not over the one row that was wrong.
    expect([...reached].sort()).toEqual([...EVERY_STATE].sort());

    for (const state of EVERY_STATE) {
      expect(counts[state], `the ${state} counter`)
        .toBe(rows.filter((r) => r.writtenState === state).length);
      expect(counts[state], `nothing is in the ${state} state`).toBeGreaterThan(0);
    }
  });

  it('puts every row in exactly one state, whatever the clock', async () => {
    for (const on of [shift(WHEN, -400), WHEN, shift(WHEN, 400)]) {
      const rows = (await getCompliance(TEST_CTX, laNoon(on))).disclosureLog;
      const counts = countWrittenStatements(rows);
      const total = EVERY_STATE.reduce((n, s) => n + counts[s], 0);
      // A row in no state at all would drop out of the headline figures entirely, which
      // is how a breach goes missing from a screen that is otherwise correct.
      expect(total, `every row accounted for on ${on}`).toBe(rows.length);
    }
  });
});

describe('the overdue statement the export could not show', () => {
  it('exports the breach as a cell that cannot be read as the lawful state', async () => {
    const rows = (await getCompliance(TEST_CTX, laNoon(WHEN))).disclosureLog;
    const exported = exportedStates(rows);

    const cellsFor = (state: WrittenStatementState): Set<string | undefined> => new Set(
      [...declared].filter(([, s]) => s === state).map(([id]) => exported.get(id)),
    );
    const breach = cellsFor('overdue');
    const lawful = cellsFor('not_yet_due');
    expect(breach.size, 'no overdue statement was exported').toBe(1);
    expect(lawful.size, 'no not-yet-due statement was exported').toBe(1);

    // The defect, as an assertion: these two were the same cell.
    expect([...breach][0]).not.toBe([...lawful][0]);
    expect([...breach][0]).toBe('overdue');

    /*
     * And the sentinel that collapsed them is gone. 'not sent' was written for a missed
     * statutory deadline and for a statement that had not fallen due yet alike, so the
     * one row an auditor opens this file to find read exactly like a lawful one.
     */
    expect(disclosureLogToCsv(rows)).not.toContain('not sent');
  });

  it('moves one row from not yet due to overdue in all three places at once', async () => {
    /*
     * One disclosure, read either side of its own deadline. Nothing about the row
     * changes; only the day does. The middle reading is the deadline itself, which is
     * not yet a breach — the statement may still go out before the day ends — and that
     * is the line the screen drew and the export did not.
     */
    const entry = [...declared].find(([, state]) => state === 'not_yet_due');
    expect(entry, 'the fixture wrote no statement that is not yet due').toBeDefined();
    const id = entry![0];
    const dueOn = FIXTURE.find((f) => f.state === 'not_yet_due')!.dueOn;

    const timeline: [string, WrittenStatementState][] = [
      [shift(dueOn, -1), 'not_yet_due'],
      [dueOn, 'not_yet_due'],
      [shift(dueOn, 1), 'overdue'],
    ];

    for (const [on, state] of timeline) {
      const at = laNoon(on);
      const rows = (await getCompliance(TEST_CTX, at)).disclosureLog;
      const mine = rows.find((r) => r.disclosureId === id);
      expect(mine, `the disclosure vanished from the log on ${on}`).toBeDefined();

      const look = AGREEMENT[state];
      const cell = writtenStatementCell(mine!, at);
      expect(mine!.writtenState, `the state on ${on}`).toBe(state);
      expect(cell.wording, `the wording on ${on}`).toMatch(look.wording);
      expect(cell.color, `the colour on ${on}`).toBe(look.color);
      expect(exportedStates(rows).get(id), `the exported cell on ${on}`)
        .toBe(look.csvCell);
      expect(countWrittenStatements(rows)[state], `the ${state} counter on ${on}`)
        .toBeGreaterThan(0);
    }
  });
});

/*
 * Named files rather than a sweep, for the same reason `tests/sqlClock.test.ts` names
 * `lib/queries/measure.ts`: these two are the consumers that came apart, and they are
 * where a third rendering of the state would be added next.
 */
const CONSUMERS = [
  'app/(app)/compliance/page.tsx',
  'app/api/export/disclosures/route.ts',
];

describe('no consumer decides the state for itself', () => {
  it('leaves it to the query layer on every surface that renders it', () => {
    const app = join(import.meta.dirname, '..');
    for (const relative of CONSUMERS) {
      /*
       * Comments stripped first. A file that explains in prose which derivation it no
       * longer performs would otherwise fail this test for containing the word, and the
       * explanation is the thing most worth keeping — the compliance page carries one
       * saying what `onTime === null` used to be read as and why that was wrong.
       */
      const text = readFileSync(join(app, relative), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(text, `${relative} does not read the compliance query layer`)
        .toMatch(/from '@\/lib\/queries\/compliance'/);

      /*
       * `onTime` was the boolean-or-null itself; `writtenSentOn` and `dueWording` are
       * the two halves a consumer needs to re-derive the distinction from a null and a
       * date. A screen holding any of them has started deciding the statutory state
       * again, which is how the export and the screen came to disagree about the same
       * row, and the agreement asserted above would say nothing about the rendering an
       * operator or an auditor actually sees.
       */
      for (const derivation of ['onTime', 'writtenSentOn', 'dueWording']) {
        expect(text, `${relative} derives the state itself, via ${derivation}`)
          .not.toContain(derivation);
      }
    }
  });
});

describe('the rule the state follows', () => {
  it('compares the sent date against the stored deadline, and nothing else', () => {
    /*
     * `written_due_on` is counted once, by `writtenStatementDueOn`, when the disclosure
     * is recorded. It is compared against here and never recomputed: a deadline worked
     * out again later moves whenever the California holiday table or the counting rule
     * changes, and the date the operator was given is the date they are held to.
     */
    for (const on of [shift(DUE_ON, -3), DUE_ON, shift(DUE_ON, 3)]) {
      const at = laNoon(on);
      expect(writtenStatementState(DUE_ON, shift(DUE_ON, -1), at)).toBe('sent_on_time');
      expect(writtenStatementState(DUE_ON, DUE_ON, at)).toBe('sent_on_time');
      expect(writtenStatementState(DUE_ON, shift(DUE_ON, 1), at)).toBe('sent_late');
    }
  });

  it('calls an unsent statement a breach only once its deadline has passed', () => {
    expect(writtenStatementState(DUE_ON, null, laNoon(shift(DUE_ON, -1))))
      .toBe('not_yet_due');
    // Due today is not yet a breach. It may still go out before the day ends.
    expect(writtenStatementState(DUE_ON, null, laNoon(DUE_ON))).toBe('not_yet_due');
    expect(writtenStatementState(DUE_ON, null, laNoon(shift(DUE_ON, 1)))).toBe('overdue');
  });

  it('asks California what day it is, not the server', () => {
    /*
     * 11pm Pacific on the deadline is already tomorrow in UTC. A state decided from the
     * server's date would call this statement a breach seven hours before it was one,
     * every evening — the defect `tests/sqlClock.test.ts` sweeps the console for, here
     * in the one comparison that decides whether a statutory deadline was missed.
     */
    expect(writtenStatementState('2026-03-10', null, new Date('2026-03-11T06:00:00Z')))
      .toBe('not_yet_due');
    // An hour later it is the eleventh in California too, and now it is a breach.
    expect(writtenStatementState('2026-03-10', null, new Date('2026-03-11T08:00:00Z')))
      .toBe('overdue');
  });
});
