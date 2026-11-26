/**
 * The guarded writer that makes an admitted provider referable, and what it refuses.
 *
 * WHAT STOOD HERE. A file named `tests/providerEdits.test.ts` containing one `it` called
 * "describes the fixture", which ran `screenCase` over every seeded case, printed the
 * result to the console and ended `expect(true).toBe(true)`. It never imported
 * `lib/queries/providerEdits.ts`. It was a probe left behind by the pass that wrote the
 * module — green, counted in the suite total, and incapable of failing for any reason
 * including the module being deleted. This codebase's recorded failure mode is a control
 * that is present, correct, tested, green and never reached; a probe is the same thing
 * with the control absent as well.
 *
 * WHY THE GUARDS NEED THEIR OWN TEST RATHER THAN THE DATABASE'S. Migration 0003's
 * `providers_provider_update_guard` divides the provider row in two, and this module's
 * two allow-lists are read off it — but that trigger returns NEW untouched unless
 * `current_role_name()` is `'provider'`. The operator console is not that role. So
 * nothing in the database stops this writer from moving `status`, `notes`,
 * `license_number`, `rate_hourly` or the § 1812.5095 paperwork dates: the only thing
 * that does is the eleven-column UPDATE in `recordProviderFacts`, and the only thing
 * that can notice if a twelfth column joins it is here.
 *
 * WHAT IS ASSERTED AS A RULE RATHER THAN AS AN INSTANCE. The allow-list is not retyped
 * below. `EDITABLE_COLUMNS` is read from the module, every column in it is written in one
 * save, and every OTHER column on `providers` — enumerated from `information_schema`, so
 * a column a later migration adds is covered without a line changing here — is required
 * to be untouched. The vocabularies are checked against the database's own enums rather
 * than against a copy, and the audit diff's registry-confirmed / provider-stated split
 * is required to account for every column that moved rather than for the eight it knows
 * about today.
 *
 * FIXTURE DISCIPLINE. Every test here writes to a seeded provider row, and the suite
 * shares one in-memory database across files, so each restores the row it moved in a
 * `finally` — including `rate_hourly` and `rate_notes`, which `recordStatedRate` reaches
 * through a writer that audits outside this module's transaction. The audit log is
 * append-only by design and the rows these tests add cannot be taken back, which is why
 * every assertion about it is a delta rather than a total.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { expectRejection, providerIdByName, seededDb, TEST_CTX } from '@h-hallows/core/testing';
import type { ProviderType } from '@h-hallows/core/schema';
import {
  AVAILABILITY_BLOCKS, EDITABLE_COLUMNS, PROVIDER_STATED, PROVIDER_TYPES,
  REGISTRY_CONFIRMED, SHIFT_BLOCKS, SHIFT_DAYS, recordProviderFacts, recordStatedRate,
  type ProviderFactsInput,
} from '@/lib/queries/providerEdits';

let db: DbHandle;

/**
 * The provider every column-level assertion is made against.
 *
 * Chosen because she stands on no live case and no other test file names her, so a save
 * here moves no other suite's shortlist even for the moment before the restore. She is
 * a CNA who drives, holding Live Scan, TB clearance, auto insurance and a licence — so
 * the one type change that keeps her eligible is to `companion`, whose § 3.3 row is the
 * shortest, and the full-column write below can therefore assert the columns without
 * also having to be about eligibility.
 */
const SUBJECT = 'Nadia Haddad';

/** Standing on a live companion case in Brentwood, as its primary and its engagement. */
const STANDING = 'Bea Villanueva';

/** A provider the registry has stopped referring (I4), used to prove a stop is editable. */
const STOPPED = 'Walter Nkemdirim';

/** Soft-deleted inside one test and put back, so no other file sees her missing. */
const DELETABLE = 'Corinne Adeyemi';

/** Rate tests go here: `Jean Mbeki` states 24.00 and stands on nothing. */
const RATED = 'Jean Mbeki';

type Row = Record<string, unknown>;

const ids = new Map<string, string>();
const snapshots = new Map<string, Row>();

/** The whole row, every column, so what a save did NOT touch is as readable as what it did. */
async function wholeRow(providerId: string): Promise<Row> {
  const [row] = await db.query<{ row: Row }>(
    `SELECT to_jsonb(p) AS row FROM providers p WHERE id = $1`, [providerId],
  );
  if (!row) throw new Error(`no provider row for ${providerId}`);
  return row.row;
}

/**
 * The columns a restore has to put back: the writer's own, plus the two the rate writer
 * reaches, plus the two that are not anybody's to edit but move anyway.
 */
const RESTORED = [...EDITABLE_COLUMNS, 'rate_hourly', 'rate_notes'];

const CAST: Record<string, string> = {
  type: '::provider_type',
  areas: '::text[]',
  availability: '::text[]',
  languages: '::text[]',
  specialties: '::text[]',
  max_travel_min: '::int',
  transports: '::boolean',
  rate_hourly: '::numeric',
};

async function restore(name: string): Promise<void> {
  const providerId = ids.get(name)!;
  const snap = snapshots.get(name)!;
  const sets = RESTORED.map((c, i) => `${c} = $${i + 2}${CAST[c] ?? ''}`);
  await db.query(
    `UPDATE providers SET ${sets.join(', ')},
            deleted_at = $${RESTORED.length + 2}::timestamptz,
            updated_at = $${RESTORED.length + 3}::timestamptz
      WHERE id = $1`,
    [providerId, ...RESTORED.map((c) => snap[c] ?? null), snap.deleted_at ?? null,
      snap.updated_at],
  );
}

/** How many audit rows this provider has, so every claim about the log is a delta. */
async function auditCount(providerId: string): Promise<number> {
  const [row] = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log WHERE entity = 'provider' AND entity_id = $1`,
    [providerId],
  );
  return Number(row!.n);
}

async function lastAudit(providerId: string): Promise<{ action: string; diff: Row }> {
  const [row] = await db.query<{ action: string; diff: Row }>(
    `SELECT action::text AS action, diff FROM audit_log
      WHERE entity = 'provider' AND entity_id = $1
      ORDER BY at DESC, id DESC LIMIT 1`,
    [providerId],
  );
  if (!row) throw new Error('no audit row for that provider');
  return row;
}

/** The submission that changes nothing: the row as it stands, in the writer's shape. */
function asInput(row: Row): ProviderFactsInput {
  return {
    type: row.type as ProviderType,
    transports: Boolean(row.transports),
    areas: (row.areas as string[]) ?? [],
    maxTravelMin: (row.max_travel_min as number | null) ?? null,
    availability: (row.availability as string[]) ?? [],
    languages: (row.languages as string[]) ?? [],
    specialties: (row.specialties as string[]) ?? [],
    restrictions: (row.restrictions as string | null) ?? null,
    preferredName: (row.preferred_name as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
  };
}

beforeAll(async () => {
  db = await seededDb();
  for (const name of [SUBJECT, STANDING, STOPPED, DELETABLE, RATED]) {
    const providerId = await providerIdByName(db, name);
    ids.set(name, providerId);
    snapshots.set(name, await wholeRow(providerId));
  }
});

afterAll(async () => {
  // Belt as well as braces: each test restores in its own `finally`, and this catches a
  // test that threw somewhere the `finally` could not reach.
  for (const name of ids.keys()) await restore(name);
});

describe('the columns this writer may move, as a rule', () => {
  it('splits every editable column onto exactly one side of migration 0003’s line', () => {
    expect(EDITABLE_COLUMNS.length).toBe(REGISTRY_CONFIRMED.length + PROVIDER_STATED.length);
    expect(new Set(EDITABLE_COLUMNS).size, 'a column on both sides of the split')
      .toBe(EDITABLE_COLUMNS.length);
    // Neither list may be empty, which is the shape a filter takes when it stops
    // filtering: `changed.filter(() => true)` would also satisfy a size check.
    expect(REGISTRY_CONFIRMED.length).toBeGreaterThan(0);
    expect(PROVIDER_STATED.length).toBeGreaterThan(0);
  });

  it('names columns that exist, so a typo cannot read as a column that never changes', async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'providers'`,
    );
    const live = new Set(cols.map((c) => c.column_name));
    for (const column of EDITABLE_COLUMNS) {
      expect(live.has(column), `providers has no column ${column}`).toBe(true);
    }
  });

  it('writes every column on the list and no other column on the row', async () => {
    const providerId = ids.get(SUBJECT)!;
    const before = await wholeRow(providerId);
    const audits = await auditCount(providerId);

    try {
      const written = await recordProviderFacts(TEST_CTX, providerId, {
        // Every one of the eleven differs from the seeded row, so a column missing from
        // the UPDATE shows up as a column missing from `changed` or from the stored row
        // rather than as a value that happened to match.
        type: 'companion',
        transports: false,
        // Trimmed, de-duplicated, blanks dropped, ORDER KEPT — `screen` reports
        // `areaRank` as the index of the household's area in this list and the match
        // screen sorts on it, so a writer that sorted these would reorder every
        // shortlist in the console.
        areas: ['  Westwood  ', 'Westwood', '', 'Santa Monica'],
        maxTravelMin: 45,
        availability: ['Sun:NOC', 'Mon:AM'],
        languages: ['English'],
        specialties: ['companion'],
        restrictions: '  no lifting over 20 lbs  ',
        preferredName: 'Nadia-sentinel',
        phone: '(310) 555-0000-sentinel',
        email: 'sentinel@example.invalid',
      });

      expect([...written.changed].sort(), 'the columns the writer says it moved')
        .toEqual([...EDITABLE_COLUMNS].sort());

      const after = await wholeRow(providerId);

      /*
       * The rule, stated against the database rather than against a second copy of the
       * allow-list: every column that is not on the list, and is not the row's own
       * bookkeeping, holds exactly what it held. `status`, `notes`, `full_name`,
       * `license_number`, `rate_hourly`, `bio`, `photo_url`, `photo_consent_on` and the
       * three § 1812.5095 paperwork dates are all covered by this without being named,
       * and so is whatever a later migration adds.
       */
      for (const column of Object.keys(after)) {
        if (EDITABLE_COLUMNS.includes(column) || column === 'updated_at') continue;
        expect(after[column], `${column} is not this writer's to change`)
          .toEqual(before[column]);
      }

      // And the columns that ARE on the list hold what was submitted, normalised. A
      // column reported in `changed` but dropped from the UPDATE fails here.
      expect(after.type).toBe('companion');
      expect(after.transports).toBe(false);
      expect(after.areas).toEqual(['Westwood', 'Santa Monica']);
      expect(after.max_travel_min).toBe(45);
      expect(after.availability).toEqual(['Sun:NOC', 'Mon:AM']);
      expect(after.languages).toEqual(['English']);
      expect(after.specialties).toEqual(['companion']);
      expect(after.restrictions).toBe('no lifting over 20 lbs');
      expect(after.preferred_name).toBe('Nadia-sentinel');
      expect(after.phone).toBe('(310) 555-0000-sentinel');
      expect(after.email).toBe('sentinel@example.invalid');

      // Exactly one audit row, not none and not two.
      expect(await auditCount(providerId)).toBe(audits + 1);
    } finally {
      await restore(SUBJECT);
    }
  });

  it('attributes every column it moved to one side or the other in the log', async () => {
    const providerId = ids.get(SUBJECT)!;
    try {
      const written = await recordProviderFacts(TEST_CTX, providerId, {
        ...asInput(snapshots.get(SUBJECT)!),
        type: 'companion',
        transports: false,
        areas: ['Westwood'],
        maxTravelMin: 45,
        restrictions: 'sentinel-restriction',
        preferredName: 'sentinel-preferred',
        phone: 'sentinel-phone',
        email: 'sentinel-email@example.invalid',
      });

      const entry = await lastAudit(providerId);
      expect(entry.action).toBe('update');
      const diff = entry.diff as {
        wrote: string[]; registryConfirmed: string[]; providerStated: string[];
        eligible: { from: boolean; to: boolean };
        type?: { from: string; to: string };
        casesNoLongerCleared: string[]; notes: string[];
      };

      expect([...diff.wrote].sort()).toEqual([...written.changed].sort());

      /*
       * The split accounts for everything that moved. A column written but on neither
       * list is recorded as written and attributed to nobody, which is the one question
       * the split exists to answer — whether a stated fact was stated by the person it
       * is about. Asserted over the union rather than over the eight names, so a column
       * added to `PROVIDER_STATED` tomorrow inherits this.
       */
      expect([...diff.registryConfirmed, ...diff.providerStated].sort())
        .toEqual([...diff.wrote].sort());
      for (const column of diff.registryConfirmed) {
        expect(diff.providerStated, `${column} is attributed to both sides`)
          .not.toContain(column);
      }

      expect(diff.type, 'a type change is recorded with its values')
        .toEqual({ from: snapshots.get(SUBJECT)!.type, to: 'companion' });
      expect(typeof diff.eligible.from).toBe('boolean');
      expect(typeof diff.eligible.to).toBe('boolean');

      /*
       * And the diff carries no VALUES except the type. The log is append-only, so a
       * diff holding a provider's telephone number or address puts that number in a
       * second permanent place — the reason the module records column names. Asserted
       * against the sentinels actually written, so a writer that started logging values
       * fails on the value it logged.
       */
      const serialised = JSON.stringify(diff);
      for (const value of ['sentinel-restriction', 'sentinel-preferred', 'sentinel-phone',
        'sentinel-email@example.invalid']) {
        expect(serialised, `the audit diff carries the value ${value}`)
          .not.toContain(value);
      }
    } finally {
      await restore(SUBJECT);
    }
  });

  it('writes nothing and logs nothing when the form comes back unchanged', async () => {
    const providerId = ids.get(SUBJECT)!;
    const before = await wholeRow(providerId);
    const audits = await auditCount(providerId);

    const written = await recordProviderFacts(TEST_CTX, providerId, asInput(before));

    expect(written.changed).toEqual([]);
    // The append-only log must not grow for a write that moved nothing.
    expect(await auditCount(providerId)).toBe(audits);
    expect(await wholeRow(providerId)).toEqual(before);

    /*
     * And it still answers the question the form was asked. A save that reports only
     * "nothing had changed" about a provider who cannot be referred is the screen
     * agreeing with itself instead of answering, which is why eligibility is computed
     * before the early return rather than after it.
     */
    expect(typeof written.eligible).toBe('boolean');
    expect(Array.isArray(written.standingCaseIds)).toBe(true);
  });
});

describe('the vocabularies, taken from the database rather than copied', () => {
  it('offers exactly the provider types the enum holds', async () => {
    const rows = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'provider_type'`,
    );
    expect([...PROVIDER_TYPES].sort()).toEqual(rows.map((r) => r.label).sort());
  });

  it('builds every shift block from the enum and the seven days', async () => {
    const rows = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'shift_block'`,
    );
    expect([...SHIFT_BLOCKS].sort()).toEqual(rows.map((r) => r.label).sort());
    expect(SHIFT_DAYS.length).toBe(7);
    expect(AVAILABILITY_BLOCKS.length).toBe(SHIFT_DAYS.length * SHIFT_BLOCKS.length);
    expect(new Set(AVAILABILITY_BLOCKS).size).toBe(AVAILABILITY_BLOCKS.length);
  });

  it('accepts every block it offers, so the vocabulary is not narrower than the form', async () => {
    const providerId = ids.get(SUBJECT)!;
    try {
      // Every block the roster screen can tick, in one save. A vocabulary that refused
      // one of its own values would take a provider off every case stating that shift.
      const written = await recordProviderFacts(TEST_CTX, providerId, {
        ...asInput(snapshots.get(SUBJECT)!),
        availability: [...AVAILABILITY_BLOCKS],
      });
      expect(written.changed).toContain('availability');
      const after = await wholeRow(providerId);
      expect(after.availability).toEqual([...AVAILABILITY_BLOCKS]);
    } finally {
      await restore(SUBJECT);
    }
  });
});

/**
 * Each refusal, and the thing that makes it a refusal rather than a message: the row is
 * untouched and the append-only log has not grown.
 *
 * Table-driven so a guard added to the writer is one row here, and so no case can be the
 * one that quietly stops being exercised — every entry runs the same three assertions.
 */
const REFUSALS: {
  what: string;
  change: Partial<ProviderFactsInput>;
  says: RegExp;
}[] = [
  {
    what: 'a type the roster does not refer',
    change: { type: 'MD' as unknown as ProviderType },
    says: /is not a provider type this registry refers/,
  },
  {
    what: 'a travel limit of nothing',
    change: { maxTravelMin: 0 },
    says: /number of minutes above nothing/,
  },
  {
    what: 'a negative travel limit',
    change: { maxTravelMin: -30 },
    says: /number of minutes above nothing/,
  },
  {
    what: 'a fractional travel limit',
    change: { maxTravelMin: 22.5 },
    says: /number of minutes above nothing/,
  },
  {
    what: 'a shift block the filters would never match',
    change: { availability: ['Mon:am'] },
    says: /not a shift this registry schedules against/,
  },
  {
    what: 'a day written out in full',
    change: { availability: ['Monday:AM'] },
    says: /not a shift this registry schedules against/,
  },
  {
    what: 'a day with no window',
    change: { availability: ['Mon'] },
    says: /not a shift this registry schedules against/,
  },
  {
    what: 'an area left as an untranslated slug',
    change: { areas: ['santa_monica'] },
    says: /Write an area as a person would/,
  },
  {
    what: 'a slug hiding among real area names',
    change: { areas: ['Westwood', 'pacific_palisades'] },
    says: /Write an area as a person would/,
  },
];

describe('what the writer refuses, and refuses without writing', () => {
  for (const refusal of REFUSALS) {
    it(`refuses ${refusal.what}`, async () => {
      const providerId = ids.get(SUBJECT)!;
      const before = await wholeRow(providerId);
      const audits = await auditCount(providerId);

      try {
        const message = await expectRejection(
          () => recordProviderFacts(TEST_CTX, providerId, {
            ...asInput(before), ...refusal.change,
          }),
          refusal.says,
        );
        // The operator has to be able to act on it, so the refusal says what to do.
        expect(message.length).toBeGreaterThan(40);

        expect(await wholeRow(providerId), 'the row moved despite the refusal')
          .toEqual(before);
        expect(await auditCount(providerId), 'the refusal appended to the audit log')
          .toBe(audits);
      } finally {
        /*
         * A refusal should leave nothing to restore — that is what the assertion above
         * says. The restore is here for the run in which the guard has been BROKEN: the
         * write then lands, and without this it would leak into the tests that follow
         * and fail them too, so the suite would report a cascade instead of naming the
         * guard that went. A sabotage run is only evidence if its failure message points
         * at the right thing.
         */
        await restore(SUBJECT);
      }
    });
  }

  it('refuses a provider that is not on the roster, and logs nothing against the id', async () => {
    const stranger = '00000000-0000-4000-8000-000000000000';
    await expectRejection(
      () => recordProviderFacts(TEST_CTX, stranger, asInput(snapshots.get(SUBJECT)!)),
      /not on the roster/,
    );
    const [row] = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity_id = $1`, [stranger],
    );
    expect(Number(row!.n), 'an audit row against a provider that was never changed')
      .toBe(0);
  });

  it('refuses a soft-deleted provider rather than reviving the row', async () => {
    const providerId = ids.get(DELETABLE)!;
    try {
      await db.query(`UPDATE providers SET deleted_at = now() WHERE id = $1`, [providerId]);
      const before = await wholeRow(providerId);
      const audits = await auditCount(providerId);

      await expectRejection(
        () => recordProviderFacts(TEST_CTX, providerId, {
          ...asInput(before), areas: ['Westwood'],
        }),
        /not on the roster/,
      );

      const after = await wholeRow(providerId);
      expect(after.deleted_at, 'the soft delete was undone').not.toBeNull();
      expect(after).toEqual(before);
      expect(await auditCount(providerId)).toBe(audits);
    } finally {
      await restore(DELETABLE);
      expect((await wholeRow(providerId)).deleted_at).toBeNull();
    }
  });
});

describe('the dangerous save the module allows on purpose', () => {
  it('tells the operator which live households the save took the provider off', async () => {
    const providerId = ids.get(STANDING)!;
    const snap = snapshots.get(STANDING)!;
    const before = await wholeRow(providerId);
    try {
      /*
       * `Bea Villanueva` is the primary and the engagement on a live companion case in
       * Brentwood, and she clears its filters today. Dropping Brentwood from her areas
       * is the write the module says out loud that it allows: the record has to be
       * correctable while it matters, so the refusal is replaced by the operator's
       * attention.
       */
      const seeded = (snap.areas as string[]) ?? [];
      expect(seeded, 'the fixture provider no longer covers Brentwood')
        .toContain('Brentwood');

      const written = await recordProviderFacts(TEST_CTX, providerId, {
        ...asInput(before),
        areas: seeded.filter((a) => a !== 'Brentwood'),
      });

      expect(written.changed).toEqual(['areas']);
      expect(written.standingCaseIds.length, 'the caller cannot revalidate what it is not told')
        .toBeGreaterThan(0);

      const lost = written.notes.find((n) => n.concern === 'ineligible_while_standing');
      expect(lost, 'the operator was not told a live household lost its provider')
        .toBeDefined();
      // Named, with the filter's own words for why, rather than a count.
      expect(lost!.message).toMatch(/Brentwood/);
      expect(lost!.message).toMatch(/no engagement has been changed/i);

      // The write landed, and the engagement it endangered is untouched — I4 leaves the
      // registry one lever and this is not it.
      expect((await wholeRow(providerId)).areas).not.toContain('Brentwood');
      const [kase] = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM cases
          WHERE primary_provider_id = $1 AND deleted_at IS NULL AND status <> 'ended'`,
        [providerId],
      );
      expect(Number(kase!.n)).toBeGreaterThan(0);
      const [engaged] = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM referrals WHERE provider_id = $1 AND outcome = 'engaged'`,
        [providerId],
      );
      expect(Number(engaged!.n)).toBeGreaterThan(0);

      const diff = (await lastAudit(providerId)).diff as {
        casesNoLongerCleared: string[]; notes: string[];
      };
      expect(diff.casesNoLongerCleared.length).toBeGreaterThan(0);
      expect(diff.notes).toContain('ineligible_while_standing');
    } finally {
      await restore(STANDING);
      expect((await wholeRow(providerId)).areas).toEqual(before.areas);
    }
  });

  it('says what the save leaves blocking when it makes a provider unreferable', async () => {
    const providerId = ids.get(SUBJECT)!;
    try {
      // CNA to RN adds an RN licence to `requiredFor`, which she does not hold. The
      // operator should read that from the form they just submitted, not from a badge
      // on another screen.
      const written = await recordProviderFacts(TEST_CTX, providerId, {
        ...asInput(snapshots.get(SUBJECT)!), type: 'RN',
      });
      expect(written.changed).toEqual(['type']);
      expect(written.eligible).toBe(false);
      const blocked = written.notes.find((n) => n.concern === 'not_eligible');
      expect(blocked, 'the save did not say why the provider is now on no shortlist')
        .toBeDefined();
      expect(blocked!.message).toMatch(/RN license/);
      // There is no override, and the note must not imply one.
      expect(blocked!.message).toMatch(/no override/i);

      const diff = (await lastAudit(providerId)).diff as {
        eligible: { from: boolean; to: boolean };
      };
      expect(diff.eligible).toEqual({ from: true, to: false });
    } finally {
      await restore(SUBJECT);
    }
  });

  it('corrects the record of a provider the registry has stopped referring', async () => {
    const providerId = ids.get(STOPPED)!;
    const before = await wholeRow(providerId);
    try {
      expect(before.status, 'the fixture provider is no longer stopped').toBe('do_not_refer');

      const written = await recordProviderFacts(TEST_CTX, providerId, {
        ...asInput(before), phone: 'sentinel-corrected',
      });

      // The correction lands — a record that cannot be fixed while it matters is a
      // record that has to stay wrong — and the stop is untouched, because `status` is
      // `setProviderReferralStatus`'s and demands a reason this form does not collect.
      expect(written.changed).toEqual(['phone']);
      const after = await wholeRow(providerId);
      expect(after.phone).toBe('sentinel-corrected');
      expect(after.status).toBe('do_not_refer');
      expect(after.notes, 'the save overwrote the dated history of the stop')
        .toEqual(before.notes);

      /*
       * The same whole-row rule as above, on a row whose `status` is NOT the column
       * default. A writer that set `status = 'active'` outright is invisible against an
       * active provider and visible here, so the rule is asserted on both sides of that
       * default rather than only on the convenient one.
       */
      for (const column of Object.keys(after)) {
        if (column === 'phone' || column === 'updated_at') continue;
        expect(after[column], `${column} is not this writer's to change`)
          .toEqual(before[column]);
      }
      expect(written.eligible).toBe(false);
      expect(written.notes.some((n) => n.concern === 'not_eligible')).toBe(true);
    } finally {
      await restore(STOPPED);
    }
  });
});

describe('the rate the provider stated, and the attestation that lets it through', () => {
  it('refuses to record a rate the operator will not say the provider stated', async () => {
    const providerId = ids.get(RATED)!;
    const before = await wholeRow(providerId);
    const audits = await auditCount(providerId);

    const message = await expectRejection(
      () => recordStatedRate(TEST_CTX, providerId, {
        rateHourly: '99.00', rateNotes: 'typed by the registry', statedByProvider: false,
      }),
      /because the provider stated it/,
    );
    // The refusal cites the sections, because the reason is the point: § 1812.530 bars
    // charging a nurse anything and § 1812.531 bars taking a share of what she charges.
    expect(message).toMatch(/1812\.530/);
    expect(message).toMatch(/1812\.531/);

    expect(await wholeRow(providerId), 'the rate moved without the attestation')
      .toEqual(before);
    expect(await auditCount(providerId)).toBe(audits);
  });

  it('refuses an id that is not on the roster before anything is logged against it', async () => {
    const stranger = '00000000-0000-4000-8000-000000000001';
    await expectRejection(
      () => recordStatedRate(TEST_CTX, stranger, {
        rateHourly: '55.00', rateNotes: null, statedByProvider: true,
      }),
      /not on the roster/,
    );
    /*
     * The bug this check exists for: `setProviderStatedRate` reads, updates and audits,
     * so on an id that is not on the roster the UPDATE matches nothing and the audit row
     * still goes in — permanently, because the log is append-only — recording a rate
     * change against a provider that was not changed.
     */
    const [row] = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity_id = $1`, [stranger],
    );
    expect(Number(row!.n)).toBe(0);
  });

  it('reads a re-posted rate as a number, not as the text the form rendered', async () => {
    const providerId = ids.get(RATED)!;
    const stored = (await wholeRow(providerId)).rate_hourly as string;
    const audits = await auditCount(providerId);

    // `rate_hourly` is numeric(6,2) and comes back as '24.00'; the form renders and
    // re-posts '24'. Compared as text, every save would write an audit row for a write
    // that moved nothing.
    const bare = String(Number(stored));
    expect(bare).not.toBe(stored);

    const written = await recordStatedRate(TEST_CTX, providerId, {
      rateHourly: bare,
      rateNotes: (await wholeRow(providerId)).rate_notes as string,
      statedByProvider: true,
    });
    expect(written.changed).toBe(false);
    expect(await auditCount(providerId)).toBe(audits);
  });

  it('records the figure, once, when it really moved', async () => {
    const providerId = ids.get(RATED)!;
    const audits = await auditCount(providerId);
    try {
      const written = await recordStatedRate(TEST_CTX, providerId, {
        rateHourly: '31.5', rateNotes: 'Stated by telephone.', statedByProvider: true,
      });
      expect(written.changed).toBe(true);
      const after = await wholeRow(providerId);
      expect(Number(after.rate_hourly)).toBe(31.5);
      expect(after.rate_notes).toBe('Stated by telephone.');
      expect(await auditCount(providerId)).toBe(audits + 1);
      // And nothing else on the row went with it.
      for (const column of Object.keys(after)) {
        if (['rate_hourly', 'rate_notes', 'updated_at'].includes(column)) continue;
        expect(after[column], `${column} is not the rate writer's to change`)
          .toEqual(snapshots.get(RATED)![column]);
      }
    } finally {
      await restore(RATED);
    }
  });

  it('records that a provider has not stated one, which is a normal answer', async () => {
    const providerId = ids.get(RATED)!;
    try {
      const written = await recordStatedRate(TEST_CTX, providerId, {
        rateHourly: null, rateNotes: null, statedByProvider: true,
      });
      expect(written.changed).toBe(true);
      expect(written.rateHourly).toBeNull();
      expect((await wholeRow(providerId)).rate_hourly).toBeNull();
    } finally {
      await restore(RATED);
    }
  });
});

describe('what the writer normalises before it stores', () => {
  it('turns a field holding only whitespace into no answer at all', async () => {
    const providerId = ids.get(SUBJECT)!;
    try {
      const written = await recordProviderFacts(TEST_CTX, providerId, {
        ...asInput(snapshots.get(SUBJECT)!),
        restrictions: '   ',
        preferredName: '\t\n ',
        phone: ' ',
        email: '',
      });
      // `phone` and `email` were set in the seed, so they changed; the other two were
      // already null and must NOT be reported as changes.
      expect(written.changed).toEqual(['phone', 'email']);
      const after = await wholeRow(providerId);
      for (const column of ['restrictions', 'preferred_name', 'phone', 'email']) {
        expect(after[column], `${column} stored whitespace as an answer`).toBeNull();
      }
    } finally {
      await restore(SUBJECT);
    }
  });

  it('keeps the order of areas, because the match screen sorts on it', async () => {
    const providerId = ids.get(SUBJECT)!;
    try {
      const reversed = [...((snapshots.get(SUBJECT)!.areas as string[]) ?? [])].reverse();
      const written = await recordProviderFacts(TEST_CTX, providerId, {
        ...asInput(snapshots.get(SUBJECT)!), areas: reversed,
      });
      // Same values, different order: a writer comparing these as sets would report no
      // change, and one sorting them would store the wrong order.
      expect(written.changed).toEqual(['areas']);
      expect((await wholeRow(providerId)).areas).toEqual(reversed);
    } finally {
      await restore(SUBJECT);
    }
  });
});
