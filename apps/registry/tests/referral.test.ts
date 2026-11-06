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
import { makeReferral, ReferralError } from '@/lib/domain/referral';
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
      await expect(makeReferral({
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
    const ok = await makeReferral({
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
    await expect(makeReferral({
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
