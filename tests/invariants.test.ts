/**
 * § 7.3 — the CI gate.
 *
 * These are the tests that keep a future contributor from quietly dismantling the legal
 * position. Every one maps to an invariant in /INVARIANTS.md. Do not weaken them, skip
 * them, or add an override path.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db/client';
import { makeReferral, ReferralError } from '@/lib/domain/referral';
import { shortlistFor } from '@/lib/queries/match';
import {
  caseIdWhere, expectRejection, providerIdByName, seededDb, TEST_CTX,
} from './helpers/db';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

describe('I12 — an ineligible provider never reaches a shortlist', () => {
  it('excludes every ineligible provider at the query layer, for every case', async () => {
    const cases = await db.query<{ id: string }>(`SELECT id FROM cases WHERE status <> 'ended'`);
    expect(cases.length).toBeGreaterThan(5);

    const ineligible = new Set(
      (await db.query<{ id: string }>(
        `SELECT id FROM providers WHERE status <> 'active'`,
      )).map((r) => r.id),
    );
    expect(ineligible.size).toBeGreaterThan(0);

    for (const { id } of cases) {
      const shortlist = await shortlistFor(TEST_CTX, id);
      expect(shortlist).not.toBeNull();
      for (const entry of shortlist!.eligible) {
        expect(ineligible.has(entry.providerId)).toBe(false);
      }
      // Whatever else is true, nothing with a blocking credential may be in the list.
      for (const entry of shortlist!.eligible) {
        const blocking = await db.query(
          `SELECT 1 FROM credentials
            WHERE provider_id = $1 AND deleted_at IS NULL
              AND expires_on IS NOT NULL AND expires_on < current_date`,
          [entry.providerId],
        );
        expect(blocking).toHaveLength(0);
      }
    }
  });

  it('gives a specific reason for each excluded provider', async () => {
    const caseId = await caseIdWhere(db, `c.care = 'skilled_nursing' AND c.status = 'active'`);
    const shortlist = await shortlistFor(TEST_CTX, caseId);
    expect(shortlist!.excluded.length).toBeGreaterThan(0);
    for (const e of shortlist!.excluded) {
      expect(e.exclusion.detail.length).toBeGreaterThan(5);
      expect(e.exclusion.code).toBeTruthy();
    }
  });

  it('never exposes credential detail for an excluded provider', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    const shortlist = await shortlistFor(TEST_CTX, caseId);
    for (const e of shortlist!.excluded) {
      expect(Object.keys(e).sort()).toEqual(['exclusion', 'fullName', 'providerId', 'type']);
    }
  });
});

describe('I3 — no referral without a disclosure', () => {
  it('rejects a referral row with no disclosure_id', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    const providerId = await providerIdByName(db, 'Imelda Santoyo');
    await expectRejection(
      () => db.query(
        `INSERT INTO referrals (case_id, provider_id, referred_by) VALUES ($1,$2,'test')`,
        [caseId, providerId],
      ),
      /disclosure_id|not-null|null value/i,
    );
  });

  it('refuses to record a referral unless the spoken disclosure is confirmed', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'matching' AND c.care = 'overnight_newborn'`);
    const providerId = await providerIdByName(db, 'Rosalind Pham');
    await expect(makeReferral({
      caseId, providerId, disclosedTo: 'Edith Shaw', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: false,
    })).rejects.toThrow(ReferralError);
  });

  it('refuses to record a referral with no named recipient of the disclosure', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'matching' AND c.care = 'overnight_newborn'`);
    const providerId = await providerIdByName(db, 'Rosalind Pham');
    await expect(makeReferral({
      caseId, providerId, disclosedTo: '   ', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    })).rejects.toThrow(/name of the person/i);
  });

  it('writes the disclosure and the referral in one transaction, or neither', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'matching' AND c.care = 'overnight_newborn'`);
    const providerId = await providerIdByName(db, 'Rosalind Pham');
    const before = await db.query<{ n: string }>(`SELECT count(*) AS n FROM disclosures`);

    const result = await makeReferral({
      caseId, providerId, disclosedTo: 'Edith Shaw', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true, now: new Date('2026-10-24T17:00:00Z'),
    });

    expect(result.writtenDueOn).toBe('2026-10-28');     // three CA business days, over a weekend
    const after = await db.query<{ n: string }>(`SELECT count(*) AS n FROM disclosures`);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n) + 1);

    const [ref] = await db.query<{ disclosure_id: string }>(
      `SELECT disclosure_id FROM referrals WHERE id = $1`, [result.referralId],
    );
    expect(ref!.disclosure_id).toBe(result.disclosureId);
  });

  it('rolls back the disclosure when the referral cannot be written', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    const before = await db.query<{ n: string }>(`SELECT count(*) AS n FROM disclosures`);
    await expect(makeReferral({
      caseId, providerId: '00000000-0000-0000-0000-000000000000',
      disclosedTo: 'Someone', disclosedBy: 'operator', method: 'phone',
      spokenDisclosureGiven: true,
    })).rejects.toThrow();
    const after = await db.query<{ n: string }>(`SELECT count(*) AS n FROM disclosures`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

describe('I11 — a skilled case cannot be referred without an ordering physician', () => {
  it('rejects the referral through the sanctioned path', async () => {
    const caseId = await caseIdWhere(
      db, `c.care = 'hospice_support' AND h.physician_name IS NULL`,
    );
    const providerId = await providerIdByName(db, 'Priya Raghunathan');
    await expect(makeReferral({
      caseId, providerId, disclosedTo: 'Ken Tanaka', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    })).rejects.toThrow(/ordering physician/i);
  });

  it('rejects the status transition at the database, even bypassing the application', async () => {
    const caseId = await caseIdWhere(
      db, `c.care = 'hospice_support' AND h.physician_name IS NULL`,
    );
    await expectRejection(
      () => db.query(`UPDATE cases SET status = 'referred' WHERE id = $1`, [caseId]),
      /no ordering physician/i,
    );
  });

  it('still allows a skilled case with no physician to be edited, so the gap can be filled', async () => {
    const caseId = await caseIdWhere(
      db, `c.care = 'hospice_support' AND h.physician_name IS NULL`,
    );
    await db.query(`UPDATE cases SET hours_per_week = 48 WHERE id = $1`, [caseId]);
    const [row] = await db.query<{ hours_per_week: number }>(
      `SELECT hours_per_week FROM cases WHERE id = $1`, [caseId],
    );
    expect(row!.hours_per_week).toBe(48);
  });
});

describe('append-only compliance record', () => {
  it('UPDATE on timeline_entries raises', async () => {
    await expectRejection(
      () => db.query(`UPDATE timeline_entries SET body = 'rewritten'`),
      /append-only/i,
    );
  });

  it('DELETE on timeline_entries raises', async () => {
    await expectRejection(() => db.query(`DELETE FROM timeline_entries`), /append-only/i);
  });

  it('DELETE on disclosures raises', async () => {
    await expectRejection(
      () => db.query(`DELETE FROM disclosures`),
      /permanent records and cannot be deleted/i,
    );
  });

  it('UPDATE disclosures SET disclosed_to raises', async () => {
    await expectRejection(
      () => db.query(`UPDATE disclosures SET disclosed_to = 'someone else'`),
      /immutable/i,
    );
  });

  it('UPDATE disclosures SET written_sent_on succeeds', async () => {
    const [row] = await db.query<{ id: string }>(
      `SELECT id FROM disclosures WHERE written_sent_on IS NULL LIMIT 1`,
    );
    expect(row).toBeDefined();
    await db.query(
      `UPDATE disclosures SET written_sent_on = current_date, written_method = 'post'
        WHERE id = $1`,
      [row!.id],
    );
    const [after] = await db.query<{ written_method: string }>(
      `SELECT written_method FROM disclosures WHERE id = $1`, [row!.id],
    );
    expect(after!.written_method).toBe('post');
  });

  it('DELETE on referrals raises', async () => {
    await expectRejection(() => db.query(`DELETE FROM referrals`), /append-only/i);
  });

  it('a referral cannot be reassigned to another provider after the fact', async () => {
    await expectRejection(
      () => db.query(
        `UPDATE referrals SET provider_id = (SELECT id FROM providers ORDER BY id LIMIT 1)`,
      ),
      /immutable/i,
    );
  });

  it('DELETE on audit_log raises', async () => {
    await expectRejection(() => db.query(`DELETE FROM audit_log`), /append-only/i);
  });

  it('DELETE on credential_events raises', async () => {
    await expectRejection(() => db.query(`DELETE FROM credential_events`), /append-only/i);
  });

  it('a disclosure method outside phone or in person is rejected', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    const [tl] = await db.query<{ id: string }>(
      `SELECT id FROM timeline_entries WHERE case_id = $1 LIMIT 1`, [caseId],
    );
    await expectRejection(
      () => db.query(
        `INSERT INTO disclosures (case_id, timeline_id, disclosed_to, disclosed_by, method, written_due_on)
         VALUES ($1,$2,'x','y','automated_voicemail',current_date)`,
        [caseId, tl!.id],
      ),
      /disclosures_method_live|check constraint/i,
    );
  });
});

describe('I4 — the registry cannot end a relationship', () => {
  it("ended_by cannot be set to 'registry'", async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    await expectRejection(
      () => db.query(`UPDATE cases SET ended_by = 'registry' WHERE id = $1`, [caseId]),
      /invalid input value for enum|registry/i,
    );
  });

  it('the ended_by enum has exactly three members, none of them the registry', async () => {
    const rows = await db.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'ended_by' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(['household', 'provider', 'mutual']);
  });

  it('exports no function that terminates a provider', async () => {
    const referral = await import('@/lib/domain/referral');
    const providers = await import('@/lib/queries/providers');
    for (const name of [...Object.keys(referral), ...Object.keys(providers)]) {
      expect(name).not.toMatch(/terminate|fire|dismiss|remove_provider/i);
    }
  });
});

describe('I6 — the fee is charged to the household', () => {
  it("fee_charged_to cannot be set to 'provider'", async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    await expectRejection(
      () => db.query(`UPDATE cases SET fee_charged_to = 'provider' WHERE id = $1`, [caseId]),
      /fee_charged_to|check constraint/i,
    );
  });

  it('no column anywhere deducts from provider earnings', async () => {
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (column_name LIKE '%deduction%' OR column_name LIKE '%withhold%'
               OR column_name LIKE '%provider_pay%')`,
    );
    expect(rows).toEqual([]);
  });
});

describe('I10 — needs profiles are the household\'s own words', () => {
  it("needs_authored_by cannot be anything but 'household'", async () => {
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    await expectRejection(
      () => db.query(`UPDATE cases SET needs_authored_by = 'registry' WHERE id = $1`, [caseId]),
      /needs_authored_by|check constraint/i,
    );
  });
});

describe('I7 — feedback informs referral decisions only', () => {
  it('use_restriction cannot be widened', async () => {
    const [ref] = await db.query<{ id: string }>(`SELECT id FROM referrals LIMIT 1`);
    await expectRejection(
      () => db.query(
        `INSERT INTO referral_feedback (referral_id, referral_service_rating, use_restriction)
         VALUES ($1, 4, 'performance_management')`,
        [ref!.id],
      ),
      /use_restriction|check constraint/i,
    );
  });

  it('accepts feedback about the referral service itself', async () => {
    const [ref] = await db.query<{ id: string }>(`SELECT id FROM referrals LIMIT 1`);
    await db.query(
      `INSERT INTO referral_feedback (referral_id, referral_service_rating, would_refer_again, notes)
       VALUES ($1, 5, true, 'Good fit, arranged quickly.')`,
      [ref!.id],
    );
    const [row] = await db.query<{ use_restriction: string }>(
      `SELECT use_restriction FROM referral_feedback WHERE referral_id = $1`, [ref!.id],
    );
    expect(row!.use_restriction).toBe('referral_decisions_only');
  });
});

describe('I1, I2, I7, I8 — the forbidden surfaces do not exist', () => {
  it('no table implies training, work direction, correction or issued equipment', async () => {
    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND (table_name LIKE 'training%' OR table_name LIKE 'course%'
            OR table_name LIKE 'module%'   OR table_name LIKE 'curriculum%'
            OR table_name LIKE 'competenc%'
            OR table_name LIKE 'task%'     OR table_name LIKE 'care_plan%'
            OR table_name LIKE 'duty%'     OR table_name LIKE 'duties%'
            OR table_name LIKE 'checklist%'
            OR table_name LIKE 'coaching%' OR table_name LIKE 'performance_review%'
            OR table_name LIKE 'corrective%'
            OR table_name LIKE 'inventory%' OR table_name LIKE 'uniform%'
            OR table_name LIKE 'equipment%' OR table_name LIKE 'badge%')`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('the coverage table records confirmation only, never task completion', async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'coverage_gaps'`,
    );
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual([
      'block', 'case_id', 'created_at', 'id', 'note', 'on_date',
      'resolved_at', 'resolved_provider_id',
    ]);
  });
});

describe('I9 — copy lint is a build gate', () => {
  it('passes on the current tree', () => {
    const out = execFileSync('node', ['scripts/copy-lint.mjs'], { encoding: 'utf8' });
    expect(out).toMatch(/clean/);
  });

  it('fails on a planted forbidden string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccn-copy-lint-'));
    const planted = join(process.cwd(), 'components', '__copy_lint_probe__.tsx');
    try {
      writeFileSync(planted, 'export const Probe = () => <p>Meet our caregivers</p>;\n');
      let failed = false;
      let output = '';
      try {
        execFileSync('node', ['scripts/copy-lint.mjs'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        failed = true;
        output = String((err as { stderr?: string }).stderr ?? '');
      }
      expect(failed).toBe(true);
      expect(output).toMatch(/our caregivers/);
      expect(output).toMatch(/I9/);
    } finally {
      rmSync(planted, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag the statutory words inside an explanatory comment', () => {
    const planted = join(process.cwd(), 'components', '__copy_lint_comment_probe__.tsx');
    try {
      writeFileSync(planted,
        '// I9 forbids calling a referred provider an employee or an independent contractor.\n'
        + 'export const Probe = () => <p>Referred provider</p>;\n');
      const out = execFileSync('node', ['scripts/copy-lint.mjs'], { encoding: 'utf8' });
      expect(out).toMatch(/clean/);
    } finally {
      rmSync(planted, { force: true });
    }
  });
});

describe('RLS is on from the first migration', () => {
  it('enables row level security on every table', async () => {
    const rows = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

afterAll(async () => {
  // The in-memory database goes with the process; nothing to clean up on disk.
});
