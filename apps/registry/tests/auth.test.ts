/**
 * The console's one authorization decision.
 *
 * `getOperator()` checked that a live session row existed and nothing else. `role`
 * was selected and never compared to anything; `disabled_at` was not read at all —
 * while `users` and `sessions` are ONE table shared by all four audiences and both
 * applications. So the gate was satisfied by any user of any role holding any live
 * session, and `disabled_at`, the documented way to withdraw access, had no effect on
 * the console whatsoever.
 *
 * These run the query the function runs, against the real schema, because that is
 * where the predicates live.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb } from '@h-hallows/core/testing';
import { createHash } from 'node:crypto';

let db: DbHandle;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/** Exactly the lookup in apps/registry/lib/auth.ts getOperator(). */
const LOOKUP = `
  SELECT u.id, u.email, u.display_name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = $1
     AND s.expires_at > now()
     AND u.role = 'operator'
     AND u.disabled_at IS NULL`;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture returned no rows: ${sql}`);
  return row;
}

async function sessionFor(email: string, role: string, token: string, disabled = false) {
  const u = await one<{ id: string }>(
    `INSERT INTO users (email, display_name, role, disabled_at)
     VALUES ($1, $1, $2::user_role, $3)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, disabled_at = EXCLUDED.disabled_at
     RETURNING id`,
    [email, role, disabled ? new Date().toISOString() : null]);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 day')`, [u.id, hash(token)]);
  return u.id;
}

beforeAll(async () => { db = await seededDb(); });

describe('only an enabled operator gets in', () => {
  it('lets a live operator session through', async () => {
    await sessionFor('auth-operator@example.com', 'operator', 'tok-operator');
    const rows = await db.query(LOOKUP, [hash('tok-operator')]);
    expect(rows).toHaveLength(1);
  });

  it('turns away a household session, which shares the same tables', async () => {
    await sessionFor('auth-household@example.com', 'household', 'tok-household');
    const rows = await db.query(LOOKUP, [hash('tok-household')]);
    expect(rows).toEqual([]);
  });

  it('turns away a provider session', async () => {
    await sessionFor('auth-provider@example.com', 'provider', 'tok-provider');
    expect(await db.query(LOOKUP, [hash('tok-provider')])).toEqual([]);
  });

  it('turns away a disabled operator, which is what disabling is for', async () => {
    await sessionFor('auth-disabled@example.com', 'operator', 'tok-disabled', true);
    expect(await db.query(LOOKUP, [hash('tok-disabled')])).toEqual([]);
  });

  it('turns away an expired session', async () => {
    const u = await one<{ id: string }>(
      `INSERT INTO users (email, display_name, role)
       VALUES ('auth-expired@example.com', 'x', 'operator') RETURNING id`);
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() - interval '1 day')`, [u.id, hash('tok-expired')]);
    expect(await db.query(LOOKUP, [hash('tok-expired')])).toEqual([]);
  });

  it('the old lookup would have let all of them in, so this is not vacuous', async () => {
    const OLD = `SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
                  WHERE s.token_hash = $1 AND s.expires_at > now()`;
    for (const t of ['tok-household', 'tok-provider', 'tok-disabled']) {
      expect(await db.query(OLD, [hash(t)]), `${t} was already refused`).toHaveLength(1);
    }
  });
});
