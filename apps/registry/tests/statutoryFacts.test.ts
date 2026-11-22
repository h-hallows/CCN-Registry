/**
 * The writer for the facts a referral cannot be made without — §§ 1812.524, 1812.529.
 *
 * The gate these facts feed was built, tested and green. `assertCaseReferable` refuses a
 * private duty nursing referral that cannot produce a log sheet; `assert_physician_for_skilled`
 * refuses the status change; `tests/register.test.ts` proves both. What none of it noticed
 * is that three of the five facts had no writer anywhere in the application — the only
 * INSERT into `households` names eleven columns and those are not among them, and no
 * UPDATE of that table existed — so no referral the console originated could ever be
 * made. Every assertion about the gate passed against rows the tests had inserted
 * themselves, which is exactly the shape of the other five mechanisms in this codebase
 * that were present, correct and unreachable.
 *
 * So the first test here is the one that was missing: start from a record with nothing on
 * it, write the facts the way the operator writes them, and make the referral.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '@h-hallows/core/db';
import { caseIdWhere, providerIdByName, seededDb, TEST_CTX } from '@h-hallows/core/testing';
import { makeReferral, ReferralError } from '@/lib/domain/referral';
import {
  postedFeeMaximum, recordCaseTerms, recordHouseholdFacts, StatutoryFactsError,
} from '@/lib/queries/statutoryFacts';

let db: DbHandle;
let caseId: string;
let householdId: string;
let providerId: string;

/** Everything these tests touch, so each one starts from the seed it was written against. */
interface Saved {
  household: Record<string, unknown>;
  kase: Record<string, unknown>;
}
let saved: Saved;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

async function householdRow(): Promise<Record<string, unknown>> {
  const r = await one<{ j: Record<string, unknown> }>(
    `SELECT to_jsonb(h) AS j FROM households h WHERE id = $1`, [householdId]);
  return r.j;
}

async function caseRow(): Promise<Record<string, unknown>> {
  const r = await one<{ j: Record<string, unknown> }>(
    `SELECT to_jsonb(c) AS j FROM cases c WHERE id = $1`, [caseId]);
  return r.j;
}

/** Put the household and case back exactly as the seed left them. */
async function restore(): Promise<void> {
  await db.query(
    `UPDATE households
        SET cr_name = $2, cr_age = $3, cr_address = $4, cr_access_notes = $5,
            physician_name = $6, physician_practice = $7, physician_phone = $8,
            physician_fax = $9
      WHERE id = $1`,
    [
      householdId, saved.household.cr_name, saved.household.cr_age,
      saved.household.cr_address, saved.household.cr_access_notes,
      saved.household.physician_name, saved.household.physician_practice,
      saved.household.physician_phone, saved.household.physician_fax,
    ],
  );
  await db.query(
    `UPDATE cases
        SET starts_on = $2::date, ends_on = $3::date, hours_per_week = $4,
            fee_pct = $5::numeric, rate_agreed = $6::numeric
      WHERE id = $1`,
    [
      caseId, saved.kase.starts_on, saved.kase.ends_on, saved.kase.hours_per_week,
      saved.kase.fee_pct, saved.kase.rate_agreed,
    ],
  );
}

beforeAll(async () => {
  db = await seededDb();
  // The same pair tests/register.test.ts proves is referable, so a refusal here is this
  // record's doing and not the fixture's.
  caseId = await caseIdWhere(db, `c.care = 'skilled_nursing' AND c.status = 'active'`);
  const h = await one<{ household_id: string }>(
    `SELECT household_id FROM cases WHERE id = $1`, [caseId]);
  householdId = h.household_id;
  providerId = await providerIdByName(db, 'Imelda Santoyo');
  saved = { household: await householdRow(), kase: await caseRow() };
});

/*
 * Every test starts from the seed. Said once here rather than as a trailing restore in
 * each test, because a restore at the END of a test does not run when the test fails —
 * and the first version of this file had exactly that shape, so a failure in one test
 * silently changed what the next two were asserting against. Two of them then passed,
 * and two failed, for reasons that had nothing to do with the code under test.
 */
beforeEach(restore);
afterAll(restore);

describe('the referral the console could not complete', () => {
  it('is refused on an empty record and goes through once the facts are written', async () => {
    // Nothing on the record, which is the state `convertInquiry` leaves every household
    // it opens in: it writes neither of the two household facts, and no code could.
    await db.query(
      `UPDATE households SET cr_name = NULL, cr_address = NULL, physician_name = NULL
        WHERE id = $1`, [householdId]);
    await db.query(
      `UPDATE cases SET starts_on = NULL, fee_pct = NULL WHERE id = $1`, [caseId]);

    await expect(makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Someone', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    })).rejects.toThrow(ReferralError);

    await recordHouseholdFacts(TEST_CTX, householdId, {
      crName: 'Marguerite Oyelaran', crAge: 81,
      crAddress: '1180 Shadow Hill Way, Beverly Hills, CA 90210',
      crAccessNotes: 'Gate code at the Hillcrest entrance; park on the apron.',
      physicianName: 'Dr Anneliese Fournier', physicianPractice: 'Cedars Internal Medicine',
      physicianPhone: '(310) 555-0144', physicianFax: null,
    });
    await recordCaseTerms(TEST_CTX, caseId, {
      startsOn: '2026-11-25', endsOn: null, hoursPerWeek: 36,
      feePct: 18, rateAgreed: 82,
    });

    const result = await makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Marguerite Oyelaran', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    });

    // The log sheet § 1812.529 asks for, stating what was typed above.
    const sheet = await one<{
      patient_name: string; patient_address: string; attending_physician: string;
      starts_as_written: boolean; fee_basis: string;
    }>(
      /*
       * `service_from` is a timestamptz that ASSIGNMENT_LOG_INSERT fills from a date
       * column, so it reads back as '2026-11-25 00:00:00+00' and casting it to a date
       * on the way out would depend on the session TimeZone. Compared through the same
       * cast the insert used, which is the only comparison that holds under UTC.
       */
      `SELECT patient_name, patient_address, attending_physician, fee_basis,
              (service_from = $2::date::timestamptz) AS starts_as_written
         FROM assignment_log WHERE referral_id = $1`,
      [result.referralId, '2026-11-25']);
    expect(sheet.patient_name).toBe('Marguerite Oyelaran');
    expect(sheet.patient_address).toContain('Shadow Hill Way');
    expect(sheet.attending_physician).toBe('Dr Anneliese Fournier');
    expect(sheet.starts_as_written).toBe(true);
    expect(sheet.fee_basis).toMatch(/18% of job cost, billed to the household/);
  });

  it('says what a case still cannot supply instead of reporting a clean save', async () => {
    await db.query(`UPDATE households SET physician_name = NULL WHERE id = $1`,
      [householdId]);
    const written = await recordCaseTerms(TEST_CTX, caseId, {
      startsOn: '2026-11-25', endsOn: null, hoursPerWeek: 36, feePct: 18, rateAgreed: 82,
    });
    expect(written.notes.map((n) => n.concern)).toContain('still_unreferable');
    expect(written.notes.find((n) => n.concern === 'still_unreferable')!.message)
      .toMatch(/attending physician/i);
  });
});

describe('what it refuses to take away', () => {
  /*
   * The hole this closes is in the trigger, not in the application, and the trigger's
   * shape is deliberate: `assert_physician_for_skilled` fires on a TRANSITION of `cases`
   * because firing on every update would permanently lock a legacy skilled case that has
   * no physician, so that it could never be edited even to add one. The cost is that an
   * UPDATE of `households` is outside its reach entirely.
   *
   * The sabotage: remove the guard in statutoryFacts.ts and this test fails while the
   * database still accepts the write. That is what makes it worth having.
   */
  it('refuses to clear the ordering physician under a live private duty nursing case', async () => {
    const status = await one<{ status: string; care: string }>(
      `SELECT status::text AS status, care::text AS care FROM cases WHERE id = $1`,
      [caseId]);
    expect(['referred', 'active']).toContain(status.status);
    expect(status.care).toBe('skilled_nursing');

    await expect(recordHouseholdFacts(TEST_CTX, householdId, {
      crName: 'Marguerite Oyelaran', crAge: 81, crAddress: '1180 Shadow Hill Way',
      crAccessNotes: null,
      physicianName: '   ', physicianPractice: null, physicianPhone: null,
      physicianFax: null,
    })).rejects.toThrow(StatutoryFactsError);

    const after = await householdRow();
    expect(after.physician_name).toBe(saved.household.physician_name);

    // And the database would have allowed it, which is the point of refusing here.
    await db.query(`UPDATE households SET physician_name = NULL WHERE id = $1`,
      [householdId]);
    const bypassed = await householdRow();
    expect(bypassed.physician_name).toBeNull();
  });

  it('refuses to empty a patient name the register has already stated', async () => {
    const sheets = await one<{ n: string }>(
      `SELECT count(*) AS n FROM assignment_log a JOIN cases c ON c.id = a.case_id
        WHERE c.household_id = $1`, [householdId]);
    expect(Number(sheets.n)).toBeGreaterThan(0);

    await expect(recordHouseholdFacts(TEST_CTX, householdId, {
      crName: null, crAge: null, crAddress: String(saved.household.cr_address ?? 'x'),
      crAccessNotes: null,
      physicianName: String(saved.household.physician_name), physicianPractice: null,
      physicianPhone: null, physicianFax: null,
    })).rejects.toThrow(/register already names this patient/i);
  });

  it('refuses to empty an address the register has already stated', async () => {
    await expect(recordHouseholdFacts(TEST_CTX, householdId, {
      crName: String(saved.household.cr_name), crAge: null, crAddress: '  ',
      crAccessNotes: null,
      physicianName: String(saved.household.physician_name), physicianPractice: null,
      physicianPhone: null, physicianFax: null,
    })).rejects.toThrow(/register already states the address/i);

    const after = await householdRow();
    expect(after.cr_address).toBe(saved.household.cr_address);
  });

  it('refuses an end date before the start, and an end date with no start', async () => {
    await expect(recordCaseTerms(TEST_CTX, caseId, {
      startsOn: '2026-11-25', endsOn: '2026-11-01', hoursPerWeek: null,
      feePct: null, rateAgreed: null,
    })).rejects.toThrow(/cannot end before it begins/i);

    await expect(recordCaseTerms(TEST_CTX, caseId, {
      startsOn: null, endsOn: '2026-12-01', hoursPerWeek: null,
      feePct: null, rateAgreed: null,
    })).rejects.toThrow(/no beginning/i);
  });

  it('refuses to rewrite the terms of an ended engagement', async () => {
    const ended = await db.query<{ id: string }>(
      `SELECT id FROM cases WHERE status = 'ended' AND deleted_at IS NULL LIMIT 1`);
    expect(ended.length).toBe(1);
    await expect(recordCaseTerms(TEST_CTX, ended[0]!.id, {
      startsOn: '2026-11-25', endsOn: null, hoursPerWeek: 20, feePct: 18, rateAgreed: 70,
    })).rejects.toThrow(/has ended/i);
  });
});

describe('what it says rather than refuses', () => {
  /*
   * A correction has to be possible — a record that cannot be corrected is a record that
   * has to be wrong forever — and `ASSIGNMENT_LOG_CORRECTION` exists so the register can
   * follow one. What must not happen is the correction landing silently, leaving a filed
   * sheet stating an address the household record no longer does. § 1812.529 forbids a
   * false entry; this is how one would be made.
   */
  it('names the register entries a corrected address has put out of step', async () => {
    const written = await recordHouseholdFacts(TEST_CTX, householdId, {
      crName: String(saved.household.cr_name),
      crAge: saved.household.cr_age as number | null,
      crAddress: '44 Quite Different Road, Los Angeles, CA 90024',
      crAccessNotes: saved.household.cr_access_notes as string | null,
      physicianName: String(saved.household.physician_name),
      physicianPractice: saved.household.physician_practice as string | null,
      physicianPhone: saved.household.physician_phone as string | null,
      physicianFax: saved.household.physician_fax as string | null,
    });

    expect(written.changed).toContain('cr_address');
    const note = written.notes.find((n) => n.concern === 'register_disagrees');
    expect(note, 'a filed sheet now states an address the record does not').toBeTruthy();
    expect(note!.message).toMatch(/§ 1812\.529/);

    // The write happened. Refusing it would make the record uncorrectable.
    const after = await householdRow();
    expect(after.cr_address).toBe('44 Quite Different Road, Los Angeles, CA 90024');

    // And the audit row names the entries, so the gap is answerable later too.
    const audited = await one<{ diff: { registerEntriesNowStale: string[] } }>(
      `SELECT diff FROM audit_log
        WHERE entity = 'household' AND entity_id = $1 AND action = 'update'
        ORDER BY at DESC LIMIT 1`, [householdId]);
    expect(audited.diff.registerEntriesNowStale.length).toBeGreaterThan(0);
  });

  it('says when a fee is above the posted schedule, and records it anyway', async () => {
    const before = await postedFeeMaximum();
    expect(before, 'the seed posts no fee schedule, so the note had nothing to compare to')
      .toBeNull();

    /*
     * Posted through SQL rather than postFeeSchedule, because § 1812.527's seven-day
     * embargo is a CHECK on the row: anything posted now cannot be in force now, and a
     * schedule not in force is one this note correctly ignores. Backdating `posted_at`
     * is the only way to reach the case at all.
     */
    await db.query(
      `INSERT INTO fee_schedules (version, max_fee_pct, payment_terms, body,
                                  posted_at, effective_from)
       VALUES (99, 15.00, 'Net 15 from the household.', 'Posted for this test.',
               now() - interval '60 days',
               (now() AT TIME ZONE 'America/Los_Angeles')::date - 30)`);
    expect(await postedFeeMaximum()).toEqual({ version: 99, maxFeePct: 15 });

    const written = await recordCaseTerms(TEST_CTX, caseId, {
      startsOn: '2026-11-25', endsOn: null, hoursPerWeek: 36, feePct: 22, rateAgreed: 82,
    });
    const note = written.notes.find((n) => n.concern === 'above_posted_schedule');
    expect(note, '22% against a posted maximum of 15%').toBeTruthy();
    expect(note!.message).toMatch(/15% maximum|15%/);

    const after = await caseRow();
    expect(Number(after.fee_pct)).toBe(22);

    /*
     * Not cleaned up, because it cannot be: `fee_schedules` is append-only and refuses
     * the DELETE — "a posted fee schedule is a permanent record". Which is correct, and
     * is why this is the last test to touch the fee: everything after it would see a
     * posted maximum the seed does not have.
     */
  });
});

describe('it writes only the columns it names', () => {
  /*
   * On a case and a household nothing else in this file touches, and compared on the
   * whole row rather than on the columns the module names.
   *
   * Both halves of that were learned the hard way. Comparing the named columns would
   * only ever confirm that the UPDATE lists what it lists; the point is the columns it
   * does NOT list, including one a later migration adds. And the first version of this
   * test took its baseline from the case the other tests use, where the referral made
   * in the first test had already moved `referred_on` and `written_due_on` — so the
   * diff carried two columns this module never wrote, and would have carried a column
   * it wrongly did write just as quietly.
   *
   * What it is guarding against: migration 0013's own subject is two column guards that
   * were deny-lists with gaps in them, and an `UPDATE households SET ...` assembled from
   * whatever a form posted is how the referral partner on a record changes because a
   * field was left blank.
   */
  let spareCaseId: string;
  let spareHouseholdId: string;

  beforeAll(async () => {
    spareCaseId = await caseIdWhere(
      db, `c.care = 'overnight_newborn' AND c.status = 'matching'`);
    const r = await one<{ household_id: string }>(
      `SELECT household_id FROM cases WHERE id = $1`, [spareCaseId]);
    spareHouseholdId = r.household_id;
  });

  async function rowOf(table: 'households' | 'cases', id: string): Promise<Record<string, unknown>> {
    const r = await one<{ j: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS j FROM ${table} t WHERE t.id = $1`, [id]);
    return r.j;
  }

  function moved(
    before: Record<string, unknown>, after: Record<string, unknown>,
  ): string[] {
    return Object.keys(before)
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .sort();
  }

  it('leaves every other household column alone', async () => {
    const before = await rowOf('households', spareHouseholdId);
    await recordHouseholdFacts(TEST_CTX, spareHouseholdId, {
      crName: 'Renamed Patient', crAge: 77, crAddress: '9 Somewhere Else',
      crAccessNotes: 'Side door.',
      physicianName: 'Dr Someone Else', physicianPractice: 'Another Practice',
      physicianPhone: '(310) 555-0101', physicianFax: '(310) 555-0102',
    });
    const after = await rowOf('households', spareHouseholdId);

    expect(moved(before, after)).toEqual([
      'cr_access_notes', 'cr_address', 'cr_age', 'cr_name',
      'physician_fax', 'physician_name', 'physician_phone', 'physician_practice',
    ]);
  });

  it('leaves every other case column alone', async () => {
    const before = await rowOf('cases', spareCaseId);
    await recordCaseTerms(TEST_CTX, spareCaseId, {
      startsOn: '2026-12-01', endsOn: '2027-03-01', hoursPerWeek: 44,
      feePct: 17.5, rateAgreed: 91,
    });
    const after = await rowOf('cases', spareCaseId);

    expect(moved(before, after)).toEqual([
      'ends_on', 'fee_pct', 'hours_per_week', 'rate_agreed', 'starts_on',
    ]);
  });

  it('records nothing and reports nothing when the form comes back unchanged', async () => {
    const h = await rowOf('households', spareHouseholdId);
    const written = await recordHouseholdFacts(TEST_CTX, spareHouseholdId, {
      crName: h.cr_name as string | null,
      crAge: h.cr_age as number | null,
      crAddress: h.cr_address as string | null,
      crAccessNotes: h.cr_access_notes as string | null,
      physicianName: h.physician_name as string | null,
      physicianPractice: h.physician_practice as string | null,
      physicianPhone: h.physician_phone as string | null,
      physicianFax: h.physician_fax as string | null,
    });
    expect(written.changed).toEqual([]);
    expect(written.notes).toEqual([]);
  });

  it('writes no audit row for a form that changed nothing', async () => {
    const auditRows = async (): Promise<number> => {
      const r = await one<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE entity = 'household' AND entity_id = $1 AND action = 'update'`,
        [spareHouseholdId]);
      return Number(r.n);
    };
    const before = await auditRows();
    const h = await rowOf('households', spareHouseholdId);
    await recordHouseholdFacts(TEST_CTX, spareHouseholdId, {
      crName: h.cr_name as string | null,
      crAge: h.cr_age as number | null,
      crAddress: h.cr_address as string | null,
      crAccessNotes: h.cr_access_notes as string | null,
      physicianName: h.physician_name as string | null,
      physicianPractice: h.physician_practice as string | null,
      physicianPhone: h.physician_phone as string | null,
      physicianFax: h.physician_fax as string | null,
    });
    expect(await auditRows()).toBe(before);
  });
});

describe('the form proposes nothing', () => {
  /*
   * I5 and § 1812.529 in the same assertion. A start date defaulted to today, or a fee
   * defaulted to the posted maximum, is a value the household never agreed to arriving
   * in a statutory record by way of a pre-filled field — which is the false entry the
   * section names, made by the screen rather than by anyone. So the only thing any of
   * these fields may default to is what the record already says.
   */
  const page = readFileSync(
    join(process.cwd(), 'app/(app)/cases/[caseId]/page.tsx'), 'utf8');

  for (const name of ['crName', 'crAddress', 'physicianName', 'startsOn', 'feePct']) {
    it(`defaults ${name} to the record and to nothing else`, () => {
      const at = page.indexOf(`name="${name}"`);
      expect(at, `no input named ${name} on the case screen`).toBeGreaterThan(-1);
      const window = page.slice(at, at + 260);
      const found = /defaultValue=\{([^}]*)\}/.exec(window);
      expect(found, `${name} has no defaultValue to check`).toBeTruthy();
      expect(found![1]!.trim()).toMatch(/^(h|kase)\./);
    });
  }

  /*
   * Scoped to the section rather than to the file. Elsewhere on this screen a date
   * defaulted to today is right — the month an hours figure is recorded against is this
   * month, and the operator is recording what already happened. In this section it is
   * the opposite: a start date is a thing the household said, and a field pre-filled
   * with today is the screen answering for them.
   */
  it('defaults nothing in the facts section to today or to the posted maximum', () => {
    const from = page.indexOf('id="facts"');
    expect(from).toBeGreaterThan(-1);
    const section = page.slice(from, page.indexOf('</Section>', from));
    expect(section).toMatch(/name="startsOn"/);
    expect(section).not.toMatch(/defaultValue=\{\s*(todayISO|thisMonth|feeMax)/);
  });
});
