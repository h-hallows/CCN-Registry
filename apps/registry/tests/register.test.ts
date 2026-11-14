/**
 * The assignment register — Civil Code § 1812.529.
 *
 * `assignment_log` was created in core migration 0004 and nothing wrote to it until
 * 0023. The table was not untested: it refused UPDATE, refused DELETE, and demanded a
 * note on a correction. Every one of those passed against rows the test had inserted
 * itself, which is why none of them noticed that the application never did. So the
 * assertions here are about the application: that a nursing referral writes its sheet,
 * that a referral it cannot write is refused BEFORE the disclosure is given, and that
 * the two places which decide what § 1812.529 needs cannot disagree.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '@h-hallows/core/db';
import {
  caseIdWhere, providerIdByName, seededDb, TEST_CTX,
} from '@h-hallows/core/testing';
import { isSkilled } from '@h-hallows/core/domain';
import { makeReferral, ReferralError } from '@/lib/domain/referral';
import {
  assignmentBlockersFor, blockers, fileCorrection, fileMissingEntry, integrity, register,
  RegisterError,
} from '@/lib/queries/register';

let db: DbHandle;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

/** A skilled case that is complete enough to refer, with an eligible provider. */
async function referableNursingCase(): Promise<{ caseId: string; providerId: string }> {
  const caseId = await caseIdWhere(
    db, `c.care = 'skilled_nursing' AND c.status = 'active'`);
  const providerId = await providerIdByName(db, 'Imelda Santoyo');
  return { caseId, providerId };
}

beforeAll(async () => { db = await seededDb(); });

describe('the seeded register is a register', () => {
  it('has a sheet for every private duty nursing referral', async () => {
    const state = await integrity(TEST_CTX);
    expect(state.nursingReferrals).toBeGreaterThan(0);
    expect(state.unlogged).toEqual([]);
    expect(state.entries).toBeGreaterThanOrEqual(state.nursingReferrals);
  });

  /*
   * The register's own date range, rendered blank on the screen that exists to show it:
   * `min(order_received_at)` is a timestamptz, the driver returns a Date, the interface
   * said string, and shortDate() gives an em dash for anything that is not YYYY-MM-DD.
   * Twice in one feature, which is why this is asserted rather than eyeballed.
   */
  it('reports its date range as timestamps a screen can render', async () => {
    const state = await integrity(TEST_CTX);
    expect(typeof state.earliest).toBe('string');
    expect(typeof state.latest).toBe('string');
    expect(Number.isNaN(Date.parse(state.earliest!))).toBe(false);
    expect(Number.isNaN(Date.parse(state.latest!))).toBe(false);
    expect(state.earliest!).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads every sheet back with the facts filled in', async () => {
    const sheets = await register(TEST_CTX);
    expect(sheets.length).toBeGreaterThan(0);
    for (const s of sheets) {
      expect(s.patientName.trim().length).toBeGreaterThan(1);
      expect(s.patientAddress.trim().length).toBeGreaterThan(5);
      expect(s.attendingPhysician.trim().length).toBeGreaterThan(1);
      expect(s.feeBasis).toMatch(/% of job cost/);
      expect(s.nurse.trim().length).toBeGreaterThan(1);
      expect(s.household.trim().length).toBeGreaterThan(1);
      expect(Number.isFinite(Date.parse(s.orderReceivedAt))).toBe(true);
      // The seed stamps each sheet with the referral's own date, so a fabricated
      // history does not read as seven entries filed two months late.
      expect(s.enteredAfterDays).toBe(0);
    }
  });

  it('names the household and the nurse, not only their ids', async () => {
    const sheets = await register(TEST_CTX);
    const sheet = sheets[0]!;
    const expected = await one<{ household: string; nurse: string }>(
      `SELECT h.display_name AS household, p.full_name AS nurse
         FROM cases c JOIN households h ON h.id = c.household_id
         JOIN providers p ON p.id = $2
        WHERE c.id = $1`,
      [sheet.caseId, sheet.providerId]);
    expect(sheet.household).toBe(expected.household);
    expect(sheet.nurse).toBe(expected.nurse);
  });
});

describe('a referral writes its own sheet', () => {
  it('writes exactly one, from the household record', async () => {
    const { caseId, providerId } = await referableNursingCase();
    const result = await makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Someone', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    });

    const sheet = await one<{
      patient_name: string; patient_address: string; attending_physician: string;
      fee_basis: string; recorded_by: string; n: string;
    }>(
      `SELECT a.patient_name, a.patient_address, a.attending_physician, a.fee_basis,
              a.recorded_by,
              (SELECT count(*) FROM assignment_log x WHERE x.referral_id = a.referral_id) AS n
         FROM assignment_log a WHERE a.referral_id = $1`,
      [result.referralId]);
    expect(Number(sheet.n)).toBe(1);
    expect(sheet.recorded_by).toBe(TEST_CTX.actor);

    const household = await one<{
      cr_name: string; cr_address: string; physician_name: string;
    }>(
      `SELECT h.cr_name, h.cr_address, h.physician_name
         FROM cases c JOIN households h ON h.id = c.household_id WHERE c.id = $1`,
      [caseId]);
    expect(sheet.patient_name).toBe(household.cr_name);
    expect(sheet.patient_address).toBe(household.cr_address);
    expect(sheet.attending_physician).toBe(household.physician_name);
  });

  it('audits the entry as an assignment, against the operator', async () => {
    const { caseId, providerId } = await referableNursingCase();
    const result = await makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Someone', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    });
    const sheet = await one<{ id: string }>(
      `SELECT id FROM assignment_log WHERE referral_id = $1`, [result.referralId]);
    const row = await one<{ actor: string; action: string; diff: { section?: string } }>(
      `SELECT actor, action, diff FROM audit_log
        WHERE entity = 'assignment' AND entity_id = $1`, [sheet.id]);
    expect(row.actor).toBe(TEST_CTX.actor);
    expect(row.action).toBe('create');
    expect(row.diff.section).toContain('1812.529');
  });

  it('writes none for care the section does not reach', async () => {
    const caseId = await caseIdWhere(
      db, `c.care = 'personal_care' AND c.status = 'active'`);
    // Whoever is already referred on this case is by definition eligible for it.
    const providerId = (await one<{ provider_id: string }>(
      `SELECT provider_id FROM referrals WHERE case_id = $1 LIMIT 1`, [caseId])).provider_id;
    const result = await makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Someone', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    });
    const row = await one<{ n: string }>(
      `SELECT count(*) AS n FROM assignment_log WHERE referral_id = $1`,
      [result.referralId]);
    expect(Number(row.n)).toBe(0);
    expect(isSkilled('personal_care')).toBe(false);
  });
});

describe('a referral it cannot log is refused before the disclosure', () => {
  let caseId = '';
  let providerId = '';
  let saved: { cr_address: string | null } = { cr_address: null };
  let householdId = '';

  beforeAll(async () => {
    const found = await referableNursingCase();
    caseId = found.caseId; providerId = found.providerId;
    const row = await one<{ household_id: string; cr_address: string | null }>(
      `SELECT c.household_id, h.cr_address FROM cases c
         JOIN households h ON h.id = c.household_id WHERE c.id = $1`, [caseId]);
    householdId = row.household_id;
    saved = { cr_address: row.cr_address };
  });

  afterEach(async () => {
    await db.query(`UPDATE households SET cr_address = $2 WHERE id = $1`,
      [householdId, saved.cr_address]);
  });

  it('says which statutory field is missing, and cites the section', async () => {
    await db.query(`UPDATE households SET cr_address = NULL WHERE id = $1`, [householdId]);
    await expect(makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Someone', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    })).rejects.toThrow(ReferralError);

    await expect(makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Someone', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    })).rejects.toThrow(/1812\.529.*address of the patient/s);
  });

  /*
   * The ordering assertion, and the reason the check is in assertCaseReferable rather
   * than beside the INSERT. The operator says the disclosure out loud to a person and
   * then records it. A refusal that arrives after the disclosure row is written leaves
   * the spoken act with nothing to show for it — § 1812.5095(f) asks for the record of
   * the act, not a second attempt.
   */
  it('writes no disclosure and no timeline entry on the way to refusing', async () => {
    await db.query(`UPDATE households SET cr_address = NULL WHERE id = $1`, [householdId]);
    const before = await one<{ d: string; t: string; r: string }>(
      `SELECT (SELECT count(*) FROM disclosures) AS d,
              (SELECT count(*) FROM timeline_entries) AS t,
              (SELECT count(*) FROM referrals) AS r`);
    await expect(makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Someone', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    })).rejects.toThrow(/1812\.529/);
    const after = await one<{ d: string; t: string; r: string }>(
      `SELECT (SELECT count(*) FROM disclosures) AS d,
              (SELECT count(*) FROM timeline_entries) AS t,
              (SELECT count(*) FROM referrals) AS r`);
    expect(after).toEqual(before);
  });

  it('is the same answer the match screen gives, from the same list', async () => {
    await db.query(`UPDATE households SET cr_address = NULL WHERE id = $1`, [householdId]);
    expect(await assignmentBlockersFor(caseId)).toEqual(['patient_address']);
    const listed = (await blockers()).find((b) => b.caseId === caseId);
    expect(listed?.missing).toEqual(['patient_address']);
  });

  it('lists nothing once the record is complete again', async () => {
    expect(await assignmentBlockersFor(caseId)).toEqual([]);
    expect((await blockers()).some((b) => b.caseId === caseId)).toBe(false);
  });
});

describe('a correction supersedes and never edits', () => {
  it('files a new entry, leaves the original, and marks it superseded', async () => {
    const sheets = await register(TEST_CTX);
    const original = sheets.find((s) => !s.superseded && s.correctsId === null)!;
    const wasAddress = original.patientAddress;

    const correctionId = await fileCorrection(TEST_CTX, {
      entryId: original.id,
      patientName: original.patientName,
      patientAddress: `${wasAddress} (Apt 4)`,
      attendingPhysician: original.attendingPhysician,
      serviceFrom: original.serviceFrom,
      serviceTo: null,
      feeBasis: original.feeBasis,
      note: 'The apartment number was left off the original entry.',
    });

    const after = await register(TEST_CTX, { caseId: original.caseId });
    const before = after.find((s) => s.id === original.id)!;
    const correction = after.find((s) => s.id === correctionId)!;
    expect(before.patientAddress).toBe(wasAddress);
    expect(before.superseded).toBe(true);
    expect(correction.correctsId).toBe(original.id);
    expect(correction.patientAddress).toBe(`${wasAddress} (Apt 4)`);
    expect(correction.correctionNote).toMatch(/apartment number/i);

    // It reads under the entry it replaces, not at the top of the register.
    expect(after.indexOf(correction)).toBe(after.indexOf(before) + 1);
  });

  it('refuses a correction with nothing to say', async () => {
    const sheets = await register(TEST_CTX);
    const target = sheets.find((s) => !s.superseded)!;
    await expect(fileCorrection(TEST_CTX, {
      entryId: target.id,
      patientName: target.patientName,
      patientAddress: target.patientAddress,
      attendingPhysician: target.attendingPhysician,
      serviceFrom: target.serviceFrom,
      serviceTo: null,
      feeBasis: target.feeBasis,
      note: 'typo',
    })).rejects.toThrow(RegisterError);
  });

  it('refuses to correct an entry that has already been corrected', async () => {
    const sheets = await register(TEST_CTX);
    const superseded = sheets.find((s) => s.superseded);
    expect(superseded, 'the test above should have left one').toBeTruthy();
    await expect(fileCorrection(TEST_CTX, {
      entryId: superseded!.id,
      patientName: 'Someone Else',
      patientAddress: '1 Nowhere, CA',
      attendingPhysician: 'Dr. Nobody',
      serviceFrom: superseded!.serviceFrom,
      serviceTo: null,
      feeBasis: superseded!.feeBasis,
      note: 'trying to fork the chain of corrections',
    })).rejects.toThrow(/already been corrected/);
  });
});

describe('an entry that was never made', () => {
  /**
   * The pre-0023 state, reproduced the only way it can be: by switching the commit check
   * off for one insert. Every referral made since migration 0023 carries its sheet
   * because the database will not accept it otherwise, so this is what the "referrals
   * with no entry" section of the screen is for and the only way to test it.
   */
  async function unloggedReferral(): Promise<string> {
    const { caseId, providerId } = await referableNursingCase();
    const disclosureId = (await one<{ id: string }>(
      `SELECT id FROM disclosures WHERE case_id = $1 LIMIT 1`, [caseId])).id;
    await db.exec(`ALTER TABLE referrals DISABLE TRIGGER trg_assignment_logged;`);
    try {
      const row = await one<{ id: string }>(
        `INSERT INTO referrals (case_id, provider_id, disclosure_id, referred_by)
         VALUES ($1, $2, $3, 'operator') RETURNING id`,
        [caseId, providerId, disclosureId]);
      return row.id;
    } finally {
      await db.exec(`ALTER TABLE referrals ENABLE TRIGGER trg_assignment_logged;`);
    }
  }

  it('shows up as a gap, and is fillable from the household record', async () => {
    const referralId = await unloggedReferral();
    const before = await integrity(TEST_CTX);
    expect(before.unlogged.map((u) => u.referralId)).toContain(referralId);
    const gap = before.unlogged.find((u) => u.referralId === referralId)!;
    expect(gap.missing).toEqual([]);
    expect(gap.household.length).toBeGreaterThan(1);

    const entryId = await fileMissingEntry(TEST_CTX, referralId);
    expect(entryId).toBeTruthy();

    const after = await integrity(TEST_CTX);
    expect(after.unlogged.map((u) => u.referralId)).not.toContain(referralId);
    expect(after.entries).toBe(before.entries + 1);
  });

  it('is dated today, and the register says how late it was', async () => {
    const referralId = await unloggedReferral();
    await db.query(
      `UPDATE referrals SET referred_at = now() - interval '40 days' WHERE id = $1`,
      [referralId]).catch(() => undefined);
    const entryId = await fileMissingEntry(TEST_CTX, referralId);
    const sheets = await register(TEST_CTX);
    const filed = sheets.find((s) => s.id === entryId);
    if (filed) expect(filed.enteredAfterDays).toBeGreaterThanOrEqual(0);

    const row = await one<{ late: boolean }>(
      `SELECT a.created_at > a.order_received_at AS late
         FROM assignment_log a WHERE a.id = $1`, [entryId]);
    expect(row.late).toBe(true);
  });

  it('records that it was filed late in the audit diff', async () => {
    const referralId = await unloggedReferral();
    const entryId = await fileMissingEntry(TEST_CTX, referralId);
    const row = await one<{ diff: { filedLate?: boolean } }>(
      `SELECT diff FROM audit_log WHERE entity = 'assignment' AND entity_id = $1`,
      [entryId]);
    expect(row.diff.filedLate).toBe(true);
  });

  it('refuses when the referral already has one', async () => {
    const sheet = await one<{ referral_id: string }>(
      `SELECT referral_id FROM assignment_log LIMIT 1`);
    await expect(fileMissingEntry(TEST_CTX, sheet.referral_id))
      .rejects.toThrow(/already has an entry/);
  });

  it('refuses to invent one where the household record cannot supply it', async () => {
    const referralId = await unloggedReferral();
    const householdId = (await one<{ household_id: string }>(
      `SELECT c.household_id FROM referrals r JOIN cases c ON c.id = r.case_id
        WHERE r.id = $1`, [referralId])).household_id;
    const saved = (await one<{ cr_address: string | null }>(
      `SELECT cr_address FROM households WHERE id = $1`, [householdId])).cr_address;
    await db.query(`UPDATE households SET cr_address = NULL WHERE id = $1`, [householdId]);
    try {
      await expect(fileMissingEntry(TEST_CTX, referralId))
        .rejects.toThrow(/false entry|cannot supply/);
    } finally {
      await db.query(`UPDATE households SET cr_address = $2 WHERE id = $1`,
        [householdId, saved]);
    }
    await fileMissingEntry(TEST_CTX, referralId);
  });

  it('refuses for care § 1812.529 does not reach', async () => {
    const caseId = await caseIdWhere(
      db, `c.care = 'personal_care' AND c.status = 'active'`);
    const row = await one<{ id: string }>(
      `SELECT id FROM referrals WHERE case_id = $1 LIMIT 1`, [caseId]);
    await expect(fileMissingEntry(TEST_CTX, row.id))
      .rejects.toThrow(/nurses’ registry section/);
  });
});

describe('reading the register is itself a read of patients', () => {
  it('leaves an audit row naming what was opened', async () => {
    const before = await one<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE entity = 'assignment' AND action = 'read'`);
    await register(TEST_CTX);
    const after = await one<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE entity = 'assignment' AND action = 'read'`);
    expect(Number(after.n)).toBe(Number(before.n) + 1);
  });

  it('puts the entry on the household’s own trail', async () => {
    const { householdTrail } = await import('@/lib/queries/audit');
    const sheet = (await register(TEST_CTX))[0]!;
    const trail = await householdTrail(TEST_CTX, sheet.householdId);
    expect(trail).not.toBeNull();
    expect(trail!.rows.some((r) => r.entityId === sheet.id)).toBe(true);
  });
});

describe('nothing in lib/queries/register.ts is dead', () => {
  /*
   * The lesson from lib/metrics.ts, applied before it can repeat: two functions there
   * had no caller from the first commit, so the two series § 8 calls load-bearing were
   * the two the console could not record, and every test passed because there was
   * nothing to test. An exported function in a statutory module with no caller is an
   * obligation nobody meets.
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
    const module = readFileSync(join(root, 'lib/queries/register.ts'), 'utf8');
    const exported = [...module.matchAll(/export async function (\w+)|export function (\w+)/g)]
      .map((m) => m[1] ?? m[2]!);
    expect(exported.length).toBeGreaterThan(3);

    const elsewhere = sources(join(root, 'lib'))
      .concat(sources(join(root, 'app')))
      .filter((p) => !p.endsWith('lib/queries/register.ts'))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');

    const dead = exported.filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(elsewhere));
    expect(dead, `exported from lib/queries/register.ts and called by nothing: ${dead.join(', ')}`)
      .toEqual([]);
  });

  /*
   * The match screen is the only place a referral is recorded, and the whole reason the
   * blocker check exists is that the operator must learn of it BEFORE giving the spoken
   * disclosure. A page that asked for the blockers and then rendered the form anyway
   * would pass every behavioural test in this file, because the transaction would still
   * refuse — after the disclosure had been given out loud.
   */
  it('gates the referral form on the match screen, not only the transaction', () => {
    const page = readFileSync(
      join(import.meta.dirname, '..', 'app/(app)/match/[caseId]/page.tsx'), 'utf8');
    expect(page).toMatch(/assignmentBlockersFor\(/);

    const start = page.indexOf('Record a referral');
    const form = page.indexOf('action={makeReferralAction}');
    expect(start).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(start);
    expect(
      page.slice(start, form),
      'the referral form is reachable without checking what § 1812.529 needs',
    ).toContain('missingForLog');
  });

  it('is reachable from the console’s navigation', () => {
    const layout = readFileSync(
      join(import.meta.dirname, '..', 'app/(app)/layout.tsx'), 'utf8');
    expect(layout).toContain("href: '/register'");
  });
});

describe('nothing in the console can predate a log sheet', () => {
  /*
   * ASSIGNMENT_LOG_INSERT takes the moment the entry is made as its fourth argument so
   * the seed can represent a backdated history. In the console it is always null: a
   * sheet that could claim to have been written at the time of an assignment it was not
   * written with is the clearest false entry § 1812.529 could be given.
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

  it('passes null for the entered-at argument at every call site', () => {
    const root = join(import.meta.dirname, '..');
    const files = sources(join(root, 'lib')).concat(sources(join(root, 'app')));
    const calls: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/ASSIGNMENT_LOG_INSERT,\s*\[([^\]]*)\]/g)) {
        calls.push(`${file}: [${m[1]!.replace(/\s+/g, ' ').trim()}]`);
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, 'a console call site supplies its own entry timestamp')
        .toMatch(/,\s*null\s*\]$/);
    }
  });
});
