/**
 * W5 gates: a household sees only its own case's shortlist, and an ineligible provider
 * renders unavailable with no reason given.
 *
 * These run through `asPortalUser`, which drops to the non-owning `ccn_app` role before
 * every query. Without that the policies would be present and inert — the local
 * connection owns every table — and each assertion below would pass for the wrong
 * reason.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@ccn/core/db';
import { seededDb } from '@ccn/core/testing';
import { benchProvider, currentBenches } from '@/lib/portal';
import type { PortalSession } from '@/lib/session';

let db: DbHandle;
let ours: PortalSession;
let theirs: PortalSession;
let shortlistId: string;
let eligibleId: string;
let lapsedId: string;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

async function makeHousehold(email: string, householdId: string): Promise<PortalSession> {
  const user = await one<{ id: string }>(
    `INSERT INTO users (email, display_name, role) VALUES ($1, $2, 'household')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
    [email, email.split('@')[0]],
  );
  await db.query(
    `INSERT INTO household_users (user_id, household_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [user.id, householdId],
  );
  return {
    userId: user.id, email, displayName: email, role: 'household',
    householdId, providerId: null,
  };
}

beforeAll(async () => {
  db = await seededDb();

  const kase = await one<{ id: string; household_id: string }>(
    `SELECT id, household_id FROM cases WHERE status = 'active' ORDER BY created_at LIMIT 1`);
  const other = await one<{ id: string }>(
    `SELECT id FROM households WHERE id <> $1 LIMIT 1`, [kase.household_id]);

  ours = await makeHousehold('ours@example.com', kase.household_id);
  theirs = await makeHousehold('theirs@example.com', other.id);

  eligibleId = (await one<{ id: string }>(
    `SELECT id FROM providers WHERE full_name = 'Imelda Santoyo'`)).id;
  // Grace Okonkwo's TB clearance lapsed yesterday in the seed.
  lapsedId = (await one<{ id: string }>(
    `SELECT id FROM providers WHERE full_name = 'Grace Okonkwo'`)).id;

  shortlistId = (await one<{ id: string }>(
    `INSERT INTO published_shortlists (case_id, published_by, note)
     VALUES ($1, 'operator', 'Two people we would send.') RETURNING id`, [kase.id])).id;
  await db.query(
    `INSERT INTO published_shortlist_items (shortlist_id, provider_id, position)
     VALUES ($1,$2,1), ($1,$3,2)`,
    [shortlistId, eligibleId, lapsedId]);
});

describe('a household sees its own bench and nobody else\'s', () => {
  it('returns the bench published to its own case', async () => {
    const benches = await currentBenches(ours);
    expect(benches).toHaveLength(1);
    expect(benches[0]!.shortlistId).toBe(shortlistId);
    expect(benches[0]!.providers).toHaveLength(2);
  });

  it('returns nothing to a different household', async () => {
    expect(await currentBenches(theirs)).toEqual([]);
  });

  it('will not open a provider on another household\'s bench', async () => {
    expect(await benchProvider(theirs, eligibleId)).toBeNull();
  });

  it('disappears when the operator withdraws it', async () => {
    await db.query(`UPDATE published_shortlists SET withdrawn_at = now() WHERE id = $1`,
      [shortlistId]);
    expect(await currentBenches(ours)).toEqual([]);
    await db.query(`UPDATE published_shortlists SET withdrawn_at = NULL WHERE id = $1`,
      [shortlistId]);
  });
});

describe('staleness is re-checked at render, and the reason never leaves', () => {
  it('marks a provider with a lapsed credential unavailable', async () => {
    const bench = (await currentBenches(ours))[0]!;
    const lapsed = bench.providers.find((p) => p.providerId === lapsedId)!;
    expect(lapsed.available).toBe(false);
  });

  it('leaves an eligible provider available', async () => {
    const bench = (await currentBenches(ours))[0]!;
    const fine = bench.providers.find((p) => p.providerId === eligibleId)!;
    expect(fine.available).toBe(true);
  });

  it('carries no credential reason anywhere in what the page receives', async () => {
    const bench = (await currentBenches(ours))[0]!;
    const serialised = JSON.stringify(bench).toLowerCase();
    for (const leak of ['expired', 'lapsed', 'missing', 'tb clearance', 'live scan', 'not eligible']) {
      expect(serialised, `the bench leaks "${leak}"`).not.toContain(leak);
    }
    const detail = await benchProvider(ours, lapsedId);
    const detailJson = JSON.stringify(detail).toLowerCase();
    for (const leak of ['expired', 'lapsed', 'missing', 'not eligible']) {
      expect(detailJson, `the profile leaks "${leak}"`).not.toContain(leak);
    }
  });

  it('catches a credential that lapses after publication, which the view alone would not', async () => {
    // The view covers an EXPIRED credential. A MISSING required one needs the per-type
    // matrix, so only the eligibility() call at render catches this.
    await db.query(
      `UPDATE credentials SET deleted_at = now()
        WHERE provider_id = $1 AND type = 'cpr_bls'`, [eligibleId]);
    const bench = (await currentBenches(ours))[0]!;
    expect(bench.providers.find((p) => p.providerId === eligibleId)!.available).toBe(false);
    await db.query(
      `UPDATE credentials SET deleted_at = NULL
        WHERE provider_id = $1 AND type = 'cpr_bls'`, [eligibleId]);
  });
});

describe('what a household may be shown about a provider', () => {
  it('never includes the background screening — counsel question 13 is open', async () => {
    const detail = await benchProvider(ours, eligibleId);
    expect(detail!.verified.some((v) => /background|live scan/i.test(v.label))).toBe(false);
  });

  it('never includes a licence number', async () => {
    const detail = await benchProvider(ours, eligibleId);
    const [row] = await db.query<{ license_number: string | null }>(
      `SELECT license_number FROM providers WHERE id = $1`, [eligibleId]);
    if (row?.license_number) {
      expect(JSON.stringify(detail)).not.toContain(row.license_number);
    }
  });

  it('says what was verified and when, which is the part that is useful', async () => {
    const detail = await benchProvider(ours, eligibleId);
    expect(detail!.verified.length).toBeGreaterThan(0);
    for (const v of detail!.verified) {
      expect(v.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('withholds a photo that has no recorded consent', async () => {
    await db.query(
      `UPDATE providers SET photo_consent_on = NULL, photo_url = NULL WHERE id = $1`,
      [eligibleId]);
    const detail = await benchProvider(ours, eligibleId);
    expect(detail!.photoUrl).toBeNull();
  });

  it('offers no rating, review or score of any kind', async () => {
    const detail = await benchProvider(ours, eligibleId);
    const keys = Object.keys(detail!).join(' ').toLowerCase();
    for (const banned of ['rating', 'review', 'score', 'rank', 'star', 'badge']) {
      expect(keys, `the profile exposes "${banned}"`).not.toContain(banned);
    }
  });
});
