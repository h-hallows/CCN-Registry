import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getOperator, requestMagicLink } from '@/lib/auth';

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const existing = await getOperator();
  if (existing) redirect('/today');
  const params = await searchParams;

  async function sendLink(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const h = await headers();
    const host = h.get('host') ?? 'localhost:3000';
    const proto = h.get('x-forwarded-proto') ?? 'http';
    const result = await requestMagicLink(email, `${proto}://${host}`);

    // The response never says whether the address was permitted. In development the link
    // is printed to the server console; in deployment this is where a mail provider goes.
    if (result) {
      console.log(`\n[login] sign-in link for ${email}:\n${result.url}\n`);
    }
    redirect('/login?sent=1');
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-base font-semibold">CCN Registry</h1>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
          Internal operations tool. Sign in with the operator address on file.
        </p>

        {params.error === 'link' ? (
          <p
            className="mt-4 rounded-md border px-3 py-2 text-xs leading-relaxed"
            style={{ borderColor: 'var(--color-expired)', color: 'var(--color-expired)' }}
          >
            That sign-in link is no longer valid. A link works once and expires after
            fifteen minutes. Request a new one.
          </p>
        ) : null}

        {params.sent ? (
          <p
            className="mt-4 rounded-md border px-3 py-2 text-xs leading-relaxed hair"
            style={{ color: 'var(--ink-soft)' }}
          >
            If that address is on file, a sign-in link has been sent. The link is valid for
            fifteen minutes and can be used once.
          </p>
        ) : null}

        <form action={sendLink} className="mt-4">
          <label className="label" htmlFor="email">Operator email</label>
          <input
            id="email" name="email" type="email" required autoComplete="email"
            className="input" placeholder="operator@example.com"
          />
          <button type="submit" className="btn btn-primary mt-3 w-full justify-center">
            Send sign-in link
          </button>
        </form>
      </div>
    </div>
  );
}
