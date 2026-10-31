/**
 * Invite acceptance. Architecture spec § 3.4 — there is no public signup for either
 * portal. The bench is curated and the referral requires a call; provider applications
 * are reviewed first.
 *
 * A route handler rather than a page: accepting an invite sets a session cookie, and
 * that is only permitted in a route handler or a server action.
 */
import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { getDb } from '@ccn/core/db';
import { hashToken, startSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<void> {
  const { token } = await params;
  const { query } = await getDb();

  // Single use, unexpired, unrevoked. Claimed in the same statement that reads it, so
  // two simultaneous clicks cannot both succeed.
  const [invite] = await query<{
    id: string; email: string; role: string;
    household_id: string | null; provider_id: string | null;
  }>(
    `UPDATE portal_invites
        SET accepted_at = now()
      WHERE token_hash = $1
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id, email, role::text AS role, household_id, provider_id`,
    [hashToken(token)],
  );

  if (!invite) redirect('/login?error=invite');

  const [user] = await query<{ id: string }>(
    `INSERT INTO users (email, display_name, role)
     VALUES ($1, $2, $3::user_role)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, disabled_at = NULL
     RETURNING id`,
    [invite.email, invite.email.split('@')[0] ?? 'member', invite.role],
  );
  if (!user) redirect('/login?error=invite');

  if (invite.household_id) {
    await query(
      `INSERT INTO household_users (user_id, household_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [user.id, invite.household_id],
    );
  }
  if (invite.provider_id) {
    await query(
      `INSERT INTO provider_users (user_id, provider_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET provider_id = EXCLUDED.provider_id`,
      [user.id, invite.provider_id],
    );
  }

  await startSession(user.id);
  redirect(invite.role === 'provider' ? '/pro' : '/portal');
}
