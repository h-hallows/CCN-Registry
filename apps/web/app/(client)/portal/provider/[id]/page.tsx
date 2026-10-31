import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getPortalSession } from '@/lib/session';
import { benchProvider } from '@/lib/portal';
import { Prose, Section, Stack } from '@/components/layout';

export const dynamic = 'force-dynamic';

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BLOCK_LABEL: Record<string, string> = {
  AM: 'Mornings', PM: 'Afternoons and evenings', NOC: 'Overnight',
};

function openAvailability(blocks: string[]): string[] {
  const byBlock = new Map<string, string[]>();
  for (const b of blocks) {
    const [day, block] = b.split(':');
    if (!day || !block) continue;
    byBlock.set(block, [...(byBlock.get(block) ?? []), day]);
  }
  return [...byBlock.entries()].map(([block, days]) => {
    const ordered = DAY_ORDER.filter((d) => days.includes(d));
    return `${BLOCK_LABEL[block] ?? block}: ${ordered.join(', ')}`;
  });
}

export default async function ProviderProfile({
  params,
}: { params: Promise<{ id: string }> }) {
  const session = await getPortalSession();
  if (!session) redirect('/login');

  const { id } = await params;
  // Scoped to this household's own non-withdrawn shortlists. A provider on somebody
  // else's bench is not found, not forbidden — the distinction leaks less.
  const p = await benchProvider(session, id);
  if (!p) notFound();

  return (
    <Stack gap="lg">
      <Section>
        <Link href="/portal" style={{ fontSize: 'var(--step--1)' }}>&larr; Your short list</Link>
        <h1 style={{ marginTop: '.75rem' }}>{p.fullName}</h1>
        <p className="label">{p.type}</p>

        {!p.available ? (
          <p style={{
            border: '1px solid var(--line-2)', padding: '.85rem 1rem',
            color: 'var(--ink-2)', fontSize: 'var(--step--1)', maxWidth: 'var(--measure)',
          }}>
            Temporarily unavailable — we&rsquo;re confirming a credential. We will let you
            know as soon as that is done.
          </p>
        ) : null}
      </Section>

      {p.available && p.rateHourly ? (
        <Section title="Rate" as="h2">
          <Prose>
            <p className="nums" style={{ fontSize: 'var(--step-1)', marginBottom: '.25rem' }}>
              ${Number(p.rateHourly).toFixed(0)} an hour
            </p>
            <p style={{ color: 'var(--ink-3)', fontSize: 'var(--step--1)' }}>
              Negotiated directly with the provider. They set it; we neither set nor cap it.
            </p>
          </Prose>
        </Section>
      ) : null}

      {p.specialties.length > 0 ? (
        <Section title="Experience" as="h2">
          <Prose>
            <p>{p.specialties.map((s) => s.replace(/_/g, ' ')).join(' · ')}</p>
          </Prose>
        </Section>
      ) : null}

      {p.languages.length > 0 ? (
        <Section title="Languages" as="h2">
          <Prose><p>{p.languages.join(', ')}</p></Prose>
        </Section>
      ) : null}

      {p.restrictions ? (
        <Section title="What they have told us they will not take on" as="h2">
          <Prose>
            {/* The provider's own words, shown verbatim. Not our paraphrase of them. */}
            <p>{p.restrictions}</p>
          </Prose>
        </Section>
      ) : null}

      {p.availabilityBlocks.length > 0 ? (
        <Section title="When they are open to work" as="h2">
          <Prose>
            <ul>
              {openAvailability(p.availabilityBlocks).map((line) => <li key={line}>{line}</li>)}
            </ul>
          </Prose>
        </Section>
      ) : null}

      <Section title="What we have verified" as="h2">
        <Prose>
          {p.verified.length === 0 ? (
            <p>Verification details are not available for this provider.</p>
          ) : (
            <>
              <ul className="nums">
                {p.verified.map((v) => (
                  <li key={v.label}>{v.label} — confirmed {v.verifiedOn}</li>
                ))}
              </ul>
              <p style={{ fontSize: 'var(--step--1)', color: 'var(--ink-3)' }}>
                Each confirmed against the body that issued it, not against a copy handed
                to us, and re-checked as it comes up for renewal.
              </p>
            </>
          )}
        </Prose>
      </Section>

      <Section>
        <Prose>
          {p.available ? (
            <p>
              If you would like to meet them, ask us and we will arrange it. We will go
              through a few things with you on the phone before making the referral.
            </p>
          ) : (
            <p>
              You can still ask us to call. We will tell you where this stands and put
              other people forward if that would help.
            </p>
          )}
        </Prose>
      </Section>
    </Stack>
  );
}
