import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { getDb } from '@h-hallows/core/db';
import { getPortalSession, hashToken, newToken } from '@/lib/session';
import { rateLimit } from '@/lib/rateLimit';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function Login({
  searchParams,
}: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const existing = await getPortalSession();
  if (existing) redirect(existing.role === 'provider' ? '/pro' : '/portal');
  const params = await searchParams;

  async function sendLink(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const h = await headers();

    const fake = new Request('http://localhost/login', {
      headers: { 'x-forwarded-for': h.get('x-forwarded-for') ?? 'unknown' },
    });
    if (await rateLimit(fake, { key: 'login', max: 5, windowSec: 600 })) {
      redirect('/login?sent=1');
    }

    const { query } = await getDb();
    // Only an existing portal user. There is no signup here, and the response never
    // says whether the address is known — a login form that distinguishes is a way to
    // find out which families use us.
    const [user] = await query<{ id: string }>(
      `SELECT id FROM users
        WHERE email = $1 AND disabled_at IS NULL AND role <> 'operator'`,
      [email],
    );

    if (user) {
      const token = newToken();
      await query(
        `INSERT INTO portal_invites (email, role, token_hash, issued_by, expires_at)
         SELECT $1, role, $2, 'self-service', now() + interval '15 minutes'
           FROM users WHERE id = $3`,
        [email, hashToken(token), user.id],
      );
      const host = h.get('host') ?? 'localhost:3003';
      const proto = h.get('x-forwarded-proto') ?? 'http';
      console.log(`\n[portal login] link for ${email}:\n${proto}://${host}/invite/${token}\n`);
    }

    redirect('/login?sent=1');
  }

  return (
    <div className="wrap" style={{ maxWidth: '30rem', paddingBlock: '5rem' }}>
      <h1 style={{ fontSize: 'var(--step-2)' }}>Sign in</h1>

      {params.error === 'invite' ? (
        <p style={{ color: 'var(--crit)', fontSize: 'var(--step--1)' }}>
          That link is no longer valid. Links work once and expire after fifteen minutes.
        </p>
      ) : null}

      {params.sent ? (
        <p style={{
          border: '1px solid var(--line)', padding: '.85rem 1rem',
          fontSize: 'var(--step--1)', color: 'var(--ink-2)',
        }}>
          If that address has access, we have sent a link. It works once and expires
          after fifteen minutes.
        </p>
      ) : null}

      <form action={sendLink} style={{ marginTop: '1.5rem' }}>
        <label className="label" htmlFor="email">Your email</label>
        <input id="email" name="email" type="email" required autoComplete="email"
          style={{
            display: 'block', width: '100%', marginTop: '.35rem', padding: '.6rem .7rem',
            border: '1px solid var(--line-2)', borderRadius: '6px', font: 'inherit',
          }} />
        <button type="submit" className="btn btn-primary" style={{ marginTop: '1rem' }}>
          Send a sign-in link
        </button>
      </form>

      <p style={{ marginTop: '2rem', fontSize: 'var(--step--1)', color: 'var(--ink-3)' }}>
        Access is by invitation. If you are arranging care for the first time, please
        call us instead.
      </p>
    </div>
  );
}
