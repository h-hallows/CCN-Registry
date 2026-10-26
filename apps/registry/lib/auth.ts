/**
 * Single-operator authentication by email magic link. Spec § 2.
 *
 * Only addresses listed in OPERATOR_EMAILS may request a link, so this is not an open
 * sign-up surface. Tokens and session identifiers are stored as SHA-256 hashes: a stolen
 * database backup does not yield a usable session.
 *
 * In development the link is printed to the server console rather than emailed. Wiring a
 * mail provider is a deployment step, not a code change here.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { getDb } from '@ccn/core/db';
import { audit } from '@/lib/audit';

export const SESSION_COOKIE = 'ccn_session';
const TOKEN_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 14;

export interface Operator {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function permittedEmails(): string[] {
  return (process.env.OPERATOR_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isPermittedOperator(email: string): boolean {
  const allowed = permittedEmails();
  const candidate = email.trim().toLowerCase();
  return allowed.some((a) => {
    // Constant-time compare so the response does not leak which addresses are listed.
    const x = Buffer.from(a);
    const y = Buffer.from(candidate);
    return x.length === y.length && timingSafeEqual(x, y);
  });
}

/**
 * Issue a magic link. Returns the URL so a development caller can print it. The caller
 * must not reveal to the browser whether the address was permitted.
 */
export async function requestMagicLink(
  email: string,
  origin: string,
): Promise<{ url: string } | null> {
  if (!isPermittedOperator(email)) return null;

  const { query } = await getDb();
  const normalised = email.trim().toLowerCase();
  const [user] = await query<{ id: string }>(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [normalised, normalised.split('@')[0] ?? 'operator'],
  );
  if (!user) return null;

  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO auth_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [user.id, hash(token), String(TOKEN_TTL_MINUTES)],
  );

  return { url: `${origin}/login/verify?token=${token}` };
}

/** Consume a magic-link token and start a session. Single use. */
export async function consumeMagicLink(token: string): Promise<Operator | null> {
  const { query } = await getDb();
  const [row] = await query<{ user_id: string; email: string; display_name: string; role: string }>(
    `UPDATE auth_tokens t
        SET consumed_at = now()
      WHERE t.token_hash = $1 AND t.consumed_at IS NULL AND t.expires_at > now()
      RETURNING t.user_id,
                (SELECT email FROM users WHERE id = t.user_id)        AS email,
                (SELECT display_name FROM users WHERE id = t.user_id) AS display_name,
                (SELECT role FROM users WHERE id = t.user_id)         AS role`,
    [hash(token)],
  );
  if (!row) return null;

  const sessionToken = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [row.user_id, hash(sessionToken), String(SESSION_TTL_DAYS)],
  );

  const jar = await cookies();
  jar.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86_400,
  });

  const operator: Operator = {
    id: row.user_id, email: row.email, displayName: row.display_name, role: row.role,
  };
  await audit({ actor: operator.email, action: 'create', entity: 'session', entityId: operator.id });
  return operator;
}

export async function getOperator(): Promise<Operator | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const { query } = await getDb();
  const [row] = await query<{ id: string; email: string; display_name: string; role: string }>(
    `SELECT u.id, u.email, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash(token)],
  );
  return row ? { id: row.id, email: row.email, displayName: row.display_name, role: row.role } : null;
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const { query } = await getDb();
    await query(`DELETE FROM sessions WHERE token_hash = $1`, [hash(token)]);
  }
  jar.delete(SESSION_COOKIE);
}
