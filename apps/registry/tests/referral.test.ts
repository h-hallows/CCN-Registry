/**
 * Invariants that live in the console rather than in the schema.
 *
 * The database-level half of this — append-only triggers, check constraints, enum
 * membership, the physician trigger — is in @h-hallows/core's own suite, so it cannot be
 * weakened in one app without the other noticing. What is here is the behaviour of the
 * code that writes through those constraints: the referral transaction, and the query
 * layer that must never hand an ineligible provider to the UI.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { caseIdWhere, expectRejection, providerIdByName, seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  endEngagement, makeReferral, markWrittenStatementSent, ReferralError,
} from '@/lib/domain/referral';
import { shortlistFor } from '@/lib/queries/match';

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
        // Every expiry comparison in this system runs in California. `current_date` is
        // the server's date, which on a UTC host is a day ahead of Pacific between 5pm
        // and midnight — enough to call a credential expiring today 'expired' and fail
        // this test against an application that correctly calls it 'critical'.
        const blocking = await db.query(
          `SELECT 1 FROM credentials
            WHERE provider_id = $1 AND deleted_at IS NULL
              AND expires_on IS NOT NULL
              AND expires_on < (now() AT TIME ZONE 'America/Los_Angeles')::date`,
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

describe('I3 — no referral without a disclosure, through the sanctioned path', () => {
  it('refuses to record a referral unless the spoken disclosure is confirmed', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'matching' AND c.care = 'overnight_newborn'`);
    const providerId = await providerIdByName(db, 'Rosalind Pham');
    await expect(makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Edith Shaw', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: false,
    })).rejects.toThrow(ReferralError);
  });

  it('refuses to record a referral with no named recipient of the disclosure', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'matching' AND c.care = 'overnight_newborn'`);
    const providerId = await providerIdByName(db, 'Rosalind Pham');
    await expect(makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: '   ', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    })).rejects.toThrow(/name of the person/i);
  });

  it('writes the disclosure and the referral in one transaction, or neither', async () => {
    const caseId = await caseIdWhere(db, `c.status = 'matching' AND c.care = 'overnight_newborn'`);
    const providerId = await providerIdByName(db, 'Rosalind Pham');
    const before = await db.query<{ n: string }>(`SELECT count(*) AS n FROM disclosures`);

    const result = await makeReferral(TEST_CTX, {
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
    /*
     * This used to pass an all-zeros provider id, which fails in
     * assertProviderEligible BEFORE the disclosure is ever inserted — so the
     * assertion that the count was unchanged was satisfied trivially and would have
     * passed against an implementation with no transaction at all. That is the
     * failure mode INVARIANTS.md records from the 0008 post-mortem: an invariant is
     * only as good as the assertion actually written.
     *
     * The real test makes the LAST statement fail, which is the only way to learn
     * whether the earlier writes come back. The submissions suite in 38e0185 uses the
     * same technique; I3 is the older and more load-bearing of the two and had none.
     */
    const caseId = await caseIdWhere(db, `c.status = 'active'`);
    const providerId = await providerIdByName(db, 'Imelda Santoyo');

    await db.exec(`
      CREATE OR REPLACE FUNCTION i3_rollback_probe() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'i3 probe: referral insert refused'; END $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_i3_rollback_probe BEFORE INSERT ON referrals
        FOR EACH ROW EXECUTE FUNCTION i3_rollback_probe();
    `);

    const beforeD = await db.query<{ n: string }>(`SELECT count(*) AS n FROM disclosures`);
    const beforeT = await db.query<{ n: string }>(`SELECT count(*) AS n FROM timeline_entries`);
    try {
      await expect(makeReferral(TEST_CTX, {
        caseId, providerId,
        disclosedTo: 'Someone', disclosedBy: 'operator', method: 'phone',
        spokenDisclosureGiven: true,
      })).rejects.toThrow(/i3 probe/);

      const afterD = await db.query<{ n: string }>(`SELECT count(*) AS n FROM disclosures`);
      const afterT = await db.query<{ n: string }>(`SELECT count(*) AS n FROM timeline_entries`);
      // The disclosure and its timeline entry were both written before the referral.
      // If the transaction is real, neither survives.
      expect(afterD[0]!.n).toBe(beforeD[0]!.n);
      expect(afterT[0]!.n).toBe(beforeT[0]!.n);
    } finally {
      await db.exec(`DROP TRIGGER IF EXISTS trg_i3_rollback_probe ON referrals;`);
    }

    // And the same call succeeds once the probe is gone, so the failure above was the
    // trigger and not something the function refuses anyway.
    const ok = await makeReferral(TEST_CTX, {
      caseId, providerId,
      disclosedTo: 'Someone', disclosedBy: 'operator', method: 'phone',
      spokenDisclosureGiven: true,
    });
    expect(ok.referralId).toBeTruthy();
    expect(ok.disclosureId).toBeTruthy();
  });
});

describe('I11 — a skilled case cannot be referred without an ordering physician', () => {
  it('rejects the referral through the sanctioned path', async () => {
    const caseId = await caseIdWhere(
      db, `c.care = 'hospice_support' AND h.physician_name IS NULL`,
    );
    const providerId = await providerIdByName(db, 'Priya Raghunathan');
    await expect(makeReferral(TEST_CTX, {
      caseId, providerId, disclosedTo: 'Ken Tanaka', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    })).rejects.toThrow(/ordering physician/i);
  });
});

describe('I4 — the registry cannot end a relationship', () => {
  it('exports no function that terminates a provider', async () => {
    const referral = await import('@/lib/domain/referral');
    const providers = await import('@/lib/queries/providers');
    for (const name of [...Object.keys(referral), ...Object.keys(providers)]) {
      expect(name).not.toMatch(/terminate|fire|dismiss|remove_provider/i);
    }
  });
});

/**
 * § 3.8: audit every write.
 *
 * The three mutations that carry the statutory record — the referral with its spoken
 * disclosure, the written statement going out, and the engagement ending — wrote no
 * audit_log row at all. `makeReferralAction` went as far as taking the audit context and
 * discarding it with `void ctx`. The credential vault was audited, so "who touched this"
 * answered for a TB clearance and not for the § 1812.5095(f) disclosure.
 *
 * Each row goes in inside the transaction that writes what it describes, so the log
 * cannot record a referral that rolled back, or miss one that did not.
 */
describe('§ 3.8 — the writes that carry the record are audited', () => {
  /**
   * Referable, chosen from the database rather than named: a case that has not ended,
   * whose household has an ordering physician so the I11 branch is satisfied whatever
   * its care type is. Nothing stops a case being referred more than once — the code
   * supports referring an alternate mid-engagement — so these need not be distinct.
   */
  async function referableCases(n: number): Promise<string[]> {
    const rows = await db.query<{ id: string }>(
      `SELECT c.id FROM cases c JOIN households h ON h.id = c.household_id
        WHERE c.status <> 'ended' AND c.deleted_at IS NULL
          AND h.physician_name IS NOT NULL
        LIMIT $1`,
      [n],
    );
    if (rows.length < n) throw new Error(`need ${n} referable cases, found ${rows.length}`);
    return rows.map((r) => r.id);
  }

  it('records the referral and its disclosure against the operator', async () => {
    const [caseId] = await referableCases(1);
    const providerId = await providerIdByName(db, 'Rosalind Pham');

    const result = await makeReferral(TEST_CTX, {
      caseId: caseId!, providerId, disclosedTo: 'Audited Household',
      disclosedBy: 'operator', method: 'in_person', spokenDisclosureGiven: true,
    });

    const [row] = await db.query<{ actor: string; action: string; diff: unknown }>(
      `SELECT actor, action, diff FROM audit_log
        WHERE entity = 'referral' AND entity_id = $1`,
      [result.referralId],
    );
    expect(row).toBeDefined();
    expect(row!.actor).toBe(TEST_CTX.actor);
    expect(row!.action).toBe('create');
    const diff = typeof row!.diff === 'string' ? JSON.parse(row!.diff) : row!.diff;
    expect(diff.disclosureId).toBe(result.disclosureId);
    expect(diff.disclosedTo).toBe('Audited Household');
    expect(diff.writtenDueOn).toBe(result.writtenDueOn);
  });

  it('writes no audit row for a referral that rolled back', async () => {
    const [caseId] = await referableCases(1);
    const before = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE entity = 'referral'`);

    await expect(makeReferral(TEST_CTX, {
      caseId: caseId!, providerId: '00000000-0000-0000-0000-000000000000',
      disclosedTo: 'Nobody', disclosedBy: 'operator', method: 'phone',
      spokenDisclosureGiven: true,
    })).rejects.toThrow();

    const after = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE entity = 'referral'`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('records the written statement going out', async () => {
    const [caseId] = await referableCases(1);
    const providerId = await providerIdByName(db, 'Rosalind Pham');
    const { disclosureId } = await makeReferral(TEST_CTX, {
      caseId: caseId!, providerId, disclosedTo: 'Someone', disclosedBy: 'operator',
      method: 'phone', spokenDisclosureGiven: true,
    });

    await markWrittenStatementSent(TEST_CTX, disclosureId, '2026-11-05', 'email', 'operator');

    const [row] = await db.query<{ actor: string; action: string }>(
      `SELECT actor, action FROM audit_log
        WHERE entity = 'disclosure' AND entity_id = $1`,
      [disclosureId],
    );
    expect(row).toBeDefined();
    expect(row!.actor).toBe(TEST_CTX.actor);
    expect(row!.action).toBe('update');
  });

  it('records the engagement ending, and who recorded it', async () => {
    const [caseId] = await db.query<{ id: string }>(
      `SELECT id FROM cases WHERE status = 'active' AND deleted_at IS NULL LIMIT 1`,
    );

    await endEngagement(TEST_CTX, {
      caseId: caseId!.id, endedBy: 'household', endReason: 'care_no_longer_needed',
      endedOn: '2026-11-05', actor: 'Operator Name',
    });

    const [row] = await db.query<{ actor: string; diff: unknown }>(
      `SELECT actor, diff FROM audit_log WHERE entity = 'case' AND entity_id = $1
        ORDER BY at DESC LIMIT 1`,
      [caseId!.id],
    );
    expect(row).toBeDefined();
    expect(row!.actor).toBe(TEST_CTX.actor);
    const diff = typeof row!.diff === 'string' ? JSON.parse(row!.diff) : row!.diff;
    expect(diff.endedBy).toBe('household');
    expect(diff.recordedBy).toBe('Operator Name');
  });
});
