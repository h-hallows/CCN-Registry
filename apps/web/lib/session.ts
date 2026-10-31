/**
 * Portal sessions for the three signed-in audiences.
 *
 * Architecture spec § 4 puts these on Supabase Auth. Supabase is not provisioned, so
 * this uses the same mechanism the console already has — a single-use invite token, a
 * hashed session row, an httpOnly cookie — and produces the same JWT-shaped claims the
 * RLS policies in migration 0003 read.
 *
 * That is the point of having made the policies read `request.jwt.claims` rather than
 * calling Supabase's auth.jwt() directly: the authority that issues a claim is
 * swappable, and nothing in the database layer changes when it is swapped.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { getDb } from '@h-hallows/core/db';

export const PORTAL_COOKIE = 'ccn_portal';
const SESSION_TTL_DAYS = 14;

export type PortalRole = 'household' | 'provider' | 'partner';

export interface PortalSession {
  userId: string;
  email: string;
  displayName: string;
  role: PortalRole;
  householdId: string | null;
  providerId: string | null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time compare, so a near-miss token cannot be found by timing. */
export function tokensMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The claims this session carries into the database. Shape matches what
 * `current_role_name()`, `current_household()` and `current_provider()` read.
 */
export function claimsFor(session: PortalSession): Record<string, string> {
  const claims: Record<string, string> = {
    ccn_role: session.role,
    ccn_user_id: session.userId,
  };
  if (session.householdId) claims.ccn_household_id = session.householdId;
  if (session.providerId) claims.ccn_provider_id = session.providerId;
  return claims;
}

/**
 * The current session, or null.
 *
 * Reads as the operator because it has to look across tables a household cannot see —
 * which is exactly why it returns nothing but identity, and why every query that
 * touches real data goes through `asPortalUser` instead.
 */
export async function getPortalSession(): Promise<PortalSession | null> {
  const jar = await cookies();
  const token = jar.get(PORTAL_COOKIE)?.value;
  if (!token) return null;

  const { query } = await getDb();
  const [row] = await query<{
    user_id: string; email: string; display_name: string; role: string;
    household_id: string | null; provider_id: string | null; disabled_at: string | null;
  }>(
    `SELECT u.id AS user_id, u.email, u.display_name, u.role::text AS role, u.disabled_at,
            hu.household_id, pu.provider_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN household_users hu ON hu.user_id = u.id
       LEFT JOIN provider_users pu ON pu.user_id = u.id
      WHERE s.token_hash = $1 AND s.expires_at > now()
      LIMIT 1`,
    [hashToken(token)],
  );

  if (!row || row.disabled_at) return null;
  if (row.role === 'operator') return null;   // the console is a different application

  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role as PortalRole,
    householdId: row.household_id,
    providerId: row.provider_id,
  };
}

export async function startSession(userId: string): Promise<void> {
  const token = newToken();
  const { query } = await getDb();
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [userId, hashToken(token), String(SESSION_TTL_DAYS)],
  );
  await query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]);

  const jar = await cookies();
  jar.set(PORTAL_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(PORTAL_COOKIE)?.value;
  if (token) {
    const { query } = await getDb();
    await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
  }
  jar.delete(PORTAL_COOKIE);
}
