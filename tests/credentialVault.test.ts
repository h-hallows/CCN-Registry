/**
 * M2: renewing a credential from the vault flips eligibility and writes a
 * credential_events row. The round trip must stay under twenty seconds for the operator;
 * the code path is one call, so what this test pins down is that one call is enough.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db/client';
import { getProviderWithStanding, upsertCredential } from '@/lib/queries/providers';
import { providerIdByName, seededDb, TEST_CTX } from './helpers/db';
import { addDays, civilLA, formatISODate } from '@/lib/domain/dates';

let db: DbHandle;
const d = (n: number) => formatISODate(addDays(civilLA(new Date()), n));

beforeAll(async () => { db = await seededDb(); });

describe('credential vault round trip', () => {
  it('renewing a lapsed credential flips the provider to eligible in one call', async () => {
    const providerId = await providerIdByName(db, 'Grace Okonkwo');

    const before = await getProviderWithStanding(TEST_CTX, providerId);
    expect(before!.eligibility.eligible).toBe(false);
    expect(before!.eligibility.reason).toContain('TB clearance expired');

    const result = await upsertCredential(TEST_CTX, {
      providerId,
      type: 'tb_clearance',
      expiresOn: d(365),
      verifiedOn: d(0),
      verificationSource: 'Clearance letter from issuing clinic',
    });
    expect(result.renewed).toBe(true);

    const after = await getProviderWithStanding(TEST_CTX, providerId);
    expect(after!.eligibility.eligible).toBe(true);
    expect(after!.eligibility.reason).toBeNull();
  });

  it('writes the renewal history to credential_events, with both the old and new expiry', async () => {
    const providerId = await providerIdByName(db, 'Grace Okonkwo');
    const rows = await db.query<{
      prev_expires_on: string | null; new_expires_on: string | null; actor: string;
    }>(
      `SELECT e.prev_expires_on, e.new_expires_on, e.actor
         FROM credential_events e JOIN credentials c ON c.id = e.credential_id
        WHERE c.provider_id = $1 AND c.type = 'tb_clearance'
        ORDER BY e.at DESC`,
      [providerId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);     // initial record, then the renewal
    expect(rows[0]!.prev_expires_on).not.toBeNull();
    expect(rows[0]!.new_expires_on).not.toBeNull();
    expect(rows[0]!.actor).toBe(TEST_CTX.actor);
  });

  it('adding a never-recorded credential clears the only thing blocking the provider', async () => {
    const providerId = await providerIdByName(db, 'Tomás Beltrán');

    const before = await getProviderWithStanding(TEST_CTX, providerId);
    expect(before!.eligibility.eligible).toBe(false);
    expect(before!.missing).toContain('live_scan');

    const result = await upsertCredential(TEST_CTX, {
      providerId,
      type: 'live_scan',
      expiresOn: null,
      verifiedOn: d(0),
      verificationSource: 'CA DOJ subsequent arrest notification',
    });
    expect(result.renewed).toBe(false);

    const after = await getProviderWithStanding(TEST_CTX, providerId);
    expect(after!.eligibility.eligible).toBe(true);
    expect(after!.missing).toEqual([]);
  });

  it('records the renewal as an audited write', async () => {
    const rows = await db.query<{ action: string; entity: string }>(
      `SELECT action, entity FROM audit_log
        WHERE entity = 'credential' ORDER BY at DESC LIMIT 5`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.action)).toContain('update');
  });

  it('keeps one live row per credential type', async () => {
    const providerId = await providerIdByName(db, 'Grace Okonkwo');
    const rows = await db.query(
      `SELECT 1 FROM credentials
        WHERE provider_id = $1 AND type = 'tb_clearance' AND deleted_at IS NULL`,
      [providerId],
    );
    expect(rows).toHaveLength(1);
  });
});
