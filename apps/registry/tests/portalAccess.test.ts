/**
 * Who may sign in to a portal.
 *
 * The console is the only issuer of portal access — the public `/login` page writes a
 * link only for an address that already holds a membership row, and nothing creates
 * those but this. So the refusals here are the whole of the access control, and each one
 * below is constructed to fail if its rule were removed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { expectRejection, seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  AccessError, grantPortalAccess, portalUsersFor, reissuePortalLink,
  restorePortalAccess, revokePortalAccess,
} from '@/lib/domain/portalAccess';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

async function aHousehold(): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `SELECT id FROM households WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
  );
  return row!.id;
}

async function anotherHousehold(not: string): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `SELECT id FROM households WHERE deleted_at IS NULL AND id <> $1 ORDER BY id LIMIT 1`,
    [not],
  );
  return row!.id;
}

async function aProvider(): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `SELECT id FROM providers WHERE deleted_at IS NULL ORDER BY id LIMIT 1`,
  );
  return row!.id;
}

let n = 0;
const freshEmail = () => `grant-${Date.now()}-${n++}@example.com`;

describe('granting access', () => {
  it('creates the account, the membership and a single-use link', async () => {
    const householdId = await aHousehold();
    const email = freshEmail();

    const result = await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email, displayName: 'Dana Okonjo',
    });

    expect(result.existing).toBe(false);
    expect(result.url).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);

    const [user] = await db.query<{ id: string; role: string; display_name: string }>(
      `SELECT id, role::text AS role, display_name FROM users WHERE email = $1`, [email],
    );
    // users.role DEFAULTS to 'operator'. An upsert that forgot to name the role would
    // mint an operator account from a household invite.
    expect(user!.role).toBe('household');
    expect(user!.display_name).toBe('Dana Okonjo');

    const membership = await db.query(
      `SELECT 1 FROM household_users WHERE user_id = $1 AND household_id = $2`,
      [user!.id, householdId],
    );
    expect(membership).toHaveLength(1);

    const invites = await db.query<{ role: string; household_id: string; token_hash: string }>(
      `SELECT role::text AS role, household_id, token_hash FROM portal_invites
        WHERE email = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [email],
    );
    expect(invites).toHaveLength(1);
    expect(invites[0]!.household_id).toBe(householdId);
    // The link itself is never stored.
    expect(result.url).not.toContain(invites[0]!.token_hash);
    expect(invites[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes a household timeline entry, and nothing to the audit log but the fact', async () => {
    const householdId = await aHousehold();
    const email = freshEmail();
    await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email, displayName: 'Ira Vance',
    });

    const timeline = await db.query<{ body: string }>(
      `SELECT body FROM timeline_entries
        WHERE household_id = $1 ORDER BY at DESC LIMIT 1`,
      [householdId],
    );
    expect(timeline[0]!.body).toContain(email);

    const logs = await db.query<{ diff: unknown }>(
      `SELECT diff FROM audit_log WHERE entity = 'portal_access' ORDER BY at DESC LIMIT 1`,
    );
    const diff = JSON.stringify(logs[0]!.diff);
    expect(diff).toContain(email);
    // A log that contains the token is a log that is a credential store.
    expect(diff).not.toMatch(/invite\//);
  });

  it('refuses to re-point an address that holds another role', async () => {
    const householdId = await aHousehold();
    const providerId = await aProvider();
    const email = freshEmail();

    await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email, displayName: 'Jo Marsden',
    });

    await expect(grantPortalAccess(TEST_CTX, {
      kind: 'provider', subjectId: providerId, email, displayName: 'Jo Marsden',
    })).rejects.toThrow(/already a household account/);

    const [still] = await db.query<{ role: string }>(
      `SELECT role::text AS role FROM users WHERE email = $1`, [email],
    );
    expect(still!.role).toBe('household');
    expect(await db.query(
      `SELECT 1 FROM provider_users pu JOIN users u ON u.id = pu.user_id WHERE u.email = $1`,
      [email],
    )).toHaveLength(0);
  });

  it('refuses an operator address outright', async () => {
    const householdId = await aHousehold();
    const [operator] = await db.query<{ email: string }>(
      `SELECT email FROM users WHERE role = 'operator' LIMIT 1`,
    );
    expect(operator).toBeTruthy();

    await expect(grantPortalAccess(TEST_CTX, {
      kind: 'household',
      subjectId: householdId,
      email: operator!.email,
      displayName: 'Operator',
    })).rejects.toThrow(/already an operator account/);

    const [unchanged] = await db.query<{ role: string }>(
      `SELECT role::text AS role FROM users WHERE email = $1`, [operator!.email],
    );
    expect(unchanged!.role).toBe('operator');
  });

  it('refuses a second household for the same address', async () => {
    const first = await aHousehold();
    const second = await anotherHousehold(first);
    const email = freshEmail();

    await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: first, email, displayName: 'Sam Reyes',
    });
    await expect(grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: second, email, displayName: 'Sam Reyes',
    })).rejects.toThrow(/another household/);

    // One membership, so current_household() can only resolve one way.
    const memberships = await db.query(
      `SELECT 1 FROM household_users hu JOIN users u ON u.id = hu.user_id
        WHERE u.email = $1`,
      [email],
    );
    expect(memberships).toHaveLength(1);
  });

  it('gives a referral partner access, naming the partner on the invite', async () => {
    const [partner] = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM referral_partners ORDER BY name LIMIT 1`,
    );
    expect(partner).toBeTruthy();
    const email = freshEmail();

    const result = await grantPortalAccess(TEST_CTX, {
      kind: 'partner', subjectId: partner!.id, email, displayName: partner!.name,
    });
    expect(result.url).toMatch(/\/invite\//);

    const [invite] = await db.query<{
      role: string; partner_id: string | null; household_id: string | null;
    }>(
      `SELECT role::text AS role, partner_id, household_id FROM portal_invites
        WHERE email = $1 AND revoked_at IS NULL`,
      [email],
    );
    expect(invite!.role).toBe('partner');
    expect(invite!.partner_id).toBe(partner!.id);
    expect(invite!.household_id).toBeNull();

    // A partner is not a household, and granting one writes no case timeline entry.
    const listed = await portalUsersFor(TEST_CTX, 'partner', partner!.id);
    expect(listed.some((u) => u.email === email)).toBe(true);
  });

  it('refuses a household that does not exist', async () => {
    await expect(grantPortalAccess(TEST_CTX, {
      kind: 'household',
      subjectId: '00000000-0000-0000-0000-000000000000',
      email: freshEmail(),
      displayName: 'Nobody',
    })).rejects.toThrow(AccessError);
  });

  it('issuing a second link kills the first', async () => {
    const householdId = await aHousehold();
    const email = freshEmail();

    const first = await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email, displayName: 'Kit Alder',
    });
    const second = await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email, displayName: 'Kit Alder',
    });
    expect(second.existing).toBe(true);
    expect(second.url).not.toBe(first.url);

    const live = await db.query(
      `SELECT 1 FROM portal_invites
        WHERE email = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [email],
    );
    expect(live).toHaveLength(1);
  });
});

describe('revoking access', () => {
  it('disables the account, deletes the session and kills the link', async () => {
    const householdId = await aHousehold();
    const email = freshEmail();
    const granted = await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email, displayName: 'Noor Haddad',
    });
    expect(granted.url).toBeTruthy();

    // A live portal session, the thing a revocation has to actually reach.
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '14 days')`,
      [granted.userId, `hash-${granted.userId}`],
    );

    await expect(revokePortalAccess(TEST_CTX, granted.userId, '  '))
      .rejects.toThrow(/why/i);

    await revokePortalAccess(TEST_CTX, granted.userId, 'They asked us to close it.');

    const [user] = await db.query<{ disabled_at: string | null }>(
      `SELECT disabled_at::text FROM users WHERE id = $1`, [granted.userId],
    );
    expect(user!.disabled_at).not.toBeNull();
    expect(await db.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [granted.userId]))
      .toHaveLength(0);
    expect(await db.query(
      `SELECT 1 FROM portal_invites
        WHERE email = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [email],
    )).toHaveLength(0);

    // The record of who held access is kept.
    expect(await db.query(
      `SELECT 1 FROM household_users WHERE user_id = $1`, [granted.userId],
    )).toHaveLength(1);
  });

  it('a grant never quietly un-revokes — it refuses, and a restore is deliberate', async () => {
    const householdId = await aHousehold();
    const email = freshEmail();
    const granted = await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email, displayName: 'Bo Nakamura',
    });
    await revokePortalAccess(TEST_CTX, granted.userId, 'Left the family.');

    await expect(grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email, displayName: 'Bo Nakamura',
    })).rejects.toThrow(/revoked/);
    await expect(reissuePortalLink(TEST_CTX, granted.userId)).rejects.toThrow(/revoked/);

    const [stillOff] = await db.query<{ disabled_at: string | null }>(
      `SELECT disabled_at::text FROM users WHERE id = $1`, [granted.userId],
    );
    expect(stillOff!.disabled_at).not.toBeNull();

    await expect(restorePortalAccess(TEST_CTX, granted.userId, ' '))
      .rejects.toThrow(/why/i);
    await restorePortalAccess(TEST_CTX, granted.userId, 'Back with the family.');

    const [back] = await db.query<{ disabled_at: string | null }>(
      `SELECT disabled_at::text FROM users WHERE id = $1`, [granted.userId],
    );
    expect(back!.disabled_at).toBeNull();

    // Restoring does not hand out a link. That is a separate, recorded act.
    expect(await db.query(
      `SELECT 1 FROM portal_invites
        WHERE email = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [email],
    )).toHaveLength(0);

    const fresh = await reissuePortalLink(TEST_CTX, granted.userId);
    expect(fresh.url).toMatch(/\/invite\//);
  });

  it('refuses to revoke or restore an operator from this path', async () => {
    const [operator] = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'operator' AND disabled_at IS NULL LIMIT 1`,
    );
    await expect(revokePortalAccess(TEST_CTX, operator!.id, 'nope'))
      .rejects.toThrow(/Operator accounts/);
    await expect(restorePortalAccess(TEST_CTX, operator!.id, 'nope'))
      .rejects.toThrow(/Operator accounts/);
  });

  it('refuses to revoke twice, and to restore what is not revoked', async () => {
    const householdId = await aHousehold();
    const granted = await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email: freshEmail(), displayName: 'Ada Pike',
    });
    await expect(restorePortalAccess(TEST_CTX, granted.userId, 'x'))
      .rejects.toThrow(/not revoked/);
    await revokePortalAccess(TEST_CTX, granted.userId, 'Closed.');
    await expect(revokePortalAccess(TEST_CTX, granted.userId, 'again'))
      .rejects.toThrow(/already revoked/);
  });
});

describe('the invite constraint the console must satisfy', () => {
  it('a household invite naming no household is refused by the database', async () => {
    await expectRejection(
      () => db.query(
        `INSERT INTO portal_invites (email, role, token_hash, issued_by, expires_at)
         VALUES ($1, 'household', $2, 'test', now() + interval '1 day')`,
        [freshEmail(), `hash-${Date.now()}`],
      ),
      /portal_invite_names_its_subject|violates check/i,
    );
  });

  it('every invite this console issues names its subject', async () => {
    const householdId = await aHousehold();
    const providerId = await aProvider();
    await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email: freshEmail(), displayName: 'Ren Diaz',
    });
    await grantPortalAccess(TEST_CTX, {
      kind: 'provider', subjectId: providerId, email: freshEmail(), displayName: 'Mo Tran',
    });

    const bad = await db.query(
      `SELECT 1 FROM portal_invites
        WHERE (role = 'household' AND household_id IS NULL)
           OR (role = 'provider'  AND provider_id  IS NULL)
           OR (role = 'partner'   AND partner_id   IS NULL)`,
    );
    expect(bad).toHaveLength(0);
  });
});

describe('listing who can sign in', () => {
  it('reports the account, the live link and the revocation', async () => {
    const householdId = await aHousehold();
    const email = freshEmail();
    const granted = await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: householdId, email, displayName: 'Vic Oyelaran',
    });

    const listed = await portalUsersFor(TEST_CTX, 'household', householdId);
    const mine = listed.find((u) => u.email === email);
    expect(mine).toBeTruthy();
    expect(mine!.role).toBe('household');
    expect(mine!.disabledAt).toBeNull();
    expect(mine!.liveInviteExpiresAt).not.toBeNull();

    await revokePortalAccess(TEST_CTX, granted.userId, 'Closed.');
    const after = (await portalUsersFor(TEST_CTX, 'household', householdId))
      .find((u) => u.email === email);
    expect(after!.disabledAt).not.toBeNull();
    expect(after!.liveInviteExpiresAt).toBeNull();
  });

  it('does not list one household\'s users under another', async () => {
    const first = await aHousehold();
    const second = await anotherHousehold(first);
    const email = freshEmail();
    await grantPortalAccess(TEST_CTX, {
      kind: 'household', subjectId: first, email, displayName: 'Tam Brook',
    });
    const theirs = await portalUsersFor(TEST_CTX, 'household', second);
    expect(theirs.some((u) => u.email === email)).toBe(false);
  });
});
