import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { mailConfigured, sendMail } from '@h-hallows/core/mail';
import { getOperator, requestMagicLink } from '@/lib/auth';

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const existing = await getOperator();
  if (existing) redirect('/today');
  const params = await searchParams;

  async function sendLink(formData: FormData) {
    'use server';

    /*
     * Configuration is checked BEFORE the address is looked up, and it has to stay that
     * way. Whether a mailer exists is the same fact for every address; whether a link
     * was issued is not. Branching after the lookup would turn this form into a way for
     * an unauthenticated visitor to find out which addresses are on file.
     */
    if (!mailConfigured()) redirect('/login?error=mail');

    const email = String(formData.get('email') ?? '');
    const h = await headers();
    const host = h.get('host') ?? 'localhost:3000';
    const proto = h.get('x-forwarded-proto') ?? 'http';
    const result = await requestMagicLink(email, `${proto}://${host}`);

    /*
     * The outcome of the send is deliberately not inspected. This page must not say
     * whether the address was permitted, and a delivery failure is address-specific.
     * Locally sendMail prints the link because there is nowhere else for it to go; in a
     * deployment it is sent, and in neither case does it reach the server log.
     */
    if (result) {
      await sendMail({
        to: email,
        subject: 'Your sign-in link',
        text:
          'Someone asked for a sign-in link to the registry console.\n\n'
          + `${result.url}\n\n`
          + 'It works once and expires after fifteen minutes. If this was not you, '
          + 'nothing has happened and you can ignore this.',
      });
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

        {params.error === 'mail' ? (
          <p
            className="mt-4 rounded-md border px-3 py-2 text-xs leading-relaxed"
            style={{ borderColor: 'var(--color-expired)', color: 'var(--color-expired)' }}
          >
            Signing in is unavailable: this deployment has no mail provider configured, so
            a link cannot be sent. Set <code>RESEND_API_KEY</code> and{' '}
            <code>MAIL_FROM</code>. Sign-in links are deliberately never written to the
            server log.
          </p>
        ) : null}

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
