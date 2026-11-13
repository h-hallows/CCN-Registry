/**
 * What a household has agreed the registry may share. Architecture spec § 3.5.
 *
 * `household_shares_outcome_with_partner()` reads these rows and nothing wrote one, so
 * the partner portal's outcome column was NULL for every referral ever sent — and the
 * sentence on that screen promising "where a family has told us we may share how it
 * went, you will see that here" described something that could not happen.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { asClaims, seededDb, TEST_CTX } from '@h-hallows/core/testing';
import { ConsentError, consentsFor, recordConsent, revokeConsent } from '@/lib/queries/consent';

let db: DbHandle;
let householdId: string;

beforeAll(async () => {
  db = await seededDb();
  const [row] = await db.query<{ id: string }>(
    `SELECT id FROM households WHERE deleted_at IS NULL ORDER BY id LIMIT 1`);
  householdId = row!.id;
});

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

describe('recording one', () => {
  it('names who agreed, and when', async () => {
    await recordConsent(TEST_CTX, {
      householdId, kind: 'photo', grantedBy: 'Claire Abernathy',
      scopeNote: 'Not her father’s face.',
    });

    const row = (await consentsFor(TEST_CTX, householdId))
      .find((c) => c.kind === 'photo');
    expect(row!.grantedBy).toBe('Claire Abernathy');
    expect(row!.scopeNote).toBe('Not her father’s face.');
    expect(row!.revokedAt).toBeNull();
  });

  it('refuses a consent nobody is named as giving', async () => {
    /*
     * Consent is given by a person. A row that records only that permission exists
     * answers neither of the questions asked a year later — who agreed, and when.
     */
    await expect(recordConsent(TEST_CTX, {
      householdId, kind: 'testimonial', grantedBy: ' ',
    })).rejects.toThrow(ConsentError);
  });

  it('refuses a second live grant of the same thing', async () => {
    await recordConsent(TEST_CTX, {
      householdId, kind: 'case_study', grantedBy: 'Claire Abernathy',
    });
    await expect(recordConsent(TEST_CTX, {
      householdId, kind: 'case_study', grantedBy: 'Somebody Else',
    })).rejects.toThrow(/already agreed/);
  });

  it('writes it to the household timeline, so it is readable without the audit log', async () => {
    await recordConsent(TEST_CTX, {
      householdId, kind: 'testimonial', grantedBy: 'Claire Abernathy',
    });
    const entry = await one<{ body: string }>(
      `SELECT body FROM timeline_entries WHERE household_id = $1
        ORDER BY at DESC LIMIT 1`, [householdId]);
    expect(entry.body).toContain('Claire Abernathy');
  });
});

describe('the gate it opens', () => {
  it('a partner sees an outcome only once the family has agreed', async () => {
    /*
     * The whole point, end to end: `household_shares_outcome_with_partner()` is what
     * `partner_referrals()` consults, so this is the difference between a partner
     * seeing "care arranged" and seeing nothing at all.
     */
    const partner = await one<{ id: string }>(
      `SELECT id FROM referral_partners ORDER BY name LIMIT 1`);
    const user = await one<{ id: string }>(
      `INSERT INTO users (email, display_name, role)
       VALUES ('consent-partner@example.com', 'P', 'partner') RETURNING id`);
    await db.query(
      `INSERT INTO partner_users (partner_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [partner.id, user.id]);

    const inquiry = await one<{ id: string }>(
      `INSERT INTO inquiries (name, phone, relationship, source_path, partner_id,
                              household_id, referrer)
       VALUES ('Ruth Keating','(310) 555-1', 'professional', '/refer', $1, $2,
               '{"patientInitials":"R.K."}'::jsonb)
       RETURNING id`, [partner.id, householdId]);

    const claims = {
      ccn_role: 'partner', ccn_partner_id: partner.id, ccn_user_id: user.id,
    };
    const read = () => asClaims(db, claims, (tx) =>
      tx.query<{ inquiry_id: string; outcome: string | null }>(
        `SELECT inquiry_id, outcome FROM partner_referrals()`));

    const before = (await read()).find((r) => r.inquiry_id === inquiry.id);
    expect(before, 'the partner should see their own referral').toBeTruthy();
    expect(before!.outcome).toBeNull();

    await recordConsent(TEST_CTX, {
      householdId, kind: 'partner_outcome', grantedBy: 'Claire Abernathy',
    });

    const after = (await read()).find((r) => r.inquiry_id === inquiry.id);
    expect(after!.outcome).toBe('care_arranged');
  });

  it('and stops seeing it the moment they withdraw', async () => {
    const consent = (await consentsFor(TEST_CTX, householdId))
      .find((c) => c.kind === 'partner_outcome' && !c.revokedAt);
    expect(consent, 'the previous test should have left one').toBeTruthy();

    await expect(revokeConsent(TEST_CTX, consent!.id, ' '))
      .rejects.toThrow(/what they said/i);
    await revokeConsent(TEST_CTX, consent!.id, 'They would rather we did not.');

    const partner = await one<{ id: string }>(
      `SELECT id FROM referral_partners ORDER BY name LIMIT 1`);
    const user = await one<{ id: string }>(
      `SELECT user_id AS id FROM partner_users WHERE partner_id = $1 LIMIT 1`,
      [partner.id]);
    const rows = await asClaims(
      db,
      { ccn_role: 'partner', ccn_partner_id: partner.id, ccn_user_id: user.id },
      (tx) => tx.query<{ outcome: string | null }>(
        `SELECT outcome FROM partner_referrals()`));
    for (const row of rows) expect(row.outcome).toBeNull();

    // The grant stays, so the record shows permission existed and ended.
    const after = (await consentsFor(TEST_CTX, householdId))
      .find((c) => c.id === consent!.id);
    expect(after!.revokedAt).not.toBeNull();
    expect(after!.grantedBy).toBe('Claire Abernathy');
  });

  it('refuses to withdraw the same one twice', async () => {
    const consent = (await consentsFor(TEST_CTX, householdId))
      .find((c) => c.kind === 'partner_outcome');
    await expect(revokeConsent(TEST_CTX, consent!.id, 'again'))
      .rejects.toThrow(/already withdrawn/);
  });
});
