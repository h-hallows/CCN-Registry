/**
 * Magic-link verification.
 *
 * A route handler rather than a page: setting the session cookie is only permitted in a
 * server action or a route handler, and this is the one place a GET legitimately starts a
 * session. The token is single-use and expires after fifteen minutes.
 */
import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { consumeMagicLink } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<void> {
  const token = request.nextUrl.searchParams.get('token');
  const operator = token ? await consumeMagicLink(token) : null;
  redirect(operator ? '/today' : '/login?error=link');
}
