import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPortalSession } from '@/lib/session';
import { currentBenches } from '@/lib/portal';
import { Prose, Section, Stack } from '@/components/layout';

export const dynamic = 'force-dynamic';

const CARE_LABEL: Record<string, string> = {
  companion: 'Companionship',
  personal_care: 'Personal care',
  skilled_nursing: 'Skilled nursing',
  post_surgical: 'Post-surgical recovery',
  overnight_newborn: 'Overnight newborn care',
  respite: 'Respite',
  hospice_support: 'Hospice support',
};

export default async function Portal() {
  const session = await getPortalSession();
  if (!session) redirect('/login');
  const benches = await currentBenches(session);

  if (benches.length === 0) {
    return (
      <Section>
        <h1>Your short list</h1>
        <Prose>
          <p>
            We are putting a short list together. We will call you when it is ready —
            usually within a day or two, and the same day if someone is being discharged.
          </p>
        </Prose>
      </Section>
    );
  }

  return (
    <Stack gap="lg">
      {benches.map((bench) => (
        <Section key={bench.shortlistId} label={CARE_LABEL[bench.care] ?? bench.care} title="Your short list">
          {bench.note ? (
            <Prose><p style={{ color: 'var(--ink-2)' }}>{bench.note}</p></Prose>
          ) : null}

          <div style={{
            display: 'grid', gap: '1rem', marginTop: '1.5rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
          }}>
            {bench.providers.map((p) => (
              <article key={p.providerId} className="bench-card" style={{ padding: '1.25rem' }}>
                <h3 style={{ marginBottom: '.25rem' }}>{p.fullName}</h3>
                <p className="label" style={{ margin: '0 0 .75rem' }}>{p.type}</p>

                {p.available ? (
                  <>
                    {p.rateHourly ? (
                      <p className="nums" style={{ margin: '0 0 .5rem' }}>
                        ${Number(p.rateHourly).toFixed(0)} an hour
                        <span style={{ display: 'block', fontSize: 'var(--step--1)', color: 'var(--ink-3)' }}>
                          negotiated directly with the provider
                        </span>
                      </p>
                    ) : null}
                    {p.specialties.length > 0 ? (
                      <p style={{ fontSize: 'var(--step--1)', color: 'var(--ink-2)', margin: '0 0 .5rem' }}>
                        {p.specialties.map((s) => s.replace(/_/g, ' ')).join(' · ')}
                      </p>
                    ) : null}
                    <Link href={`/portal/provider/${p.providerId}`} className="btn" style={{ marginTop: '.5rem' }}>
                      Read more
                    </Link>
                  </>
                ) : (
                  /*
                   * Never the reason. A household has no business seeing a provider's
                   * credential problem, and the provider has every interest in it not
                   * being broadcast to the people they might work for.
                   */
                  <p style={{ fontSize: 'var(--step--1)', color: 'var(--ink-3)', margin: 0 }}>
                    Temporarily unavailable — we&rsquo;re confirming a credential.
                  </p>
                )}
              </article>
            ))}
          </div>

          <Prose>
            <p style={{ marginTop: '1.5rem', fontSize: 'var(--step--1)', color: 'var(--ink-2)' }}>
              Not quite right? Ask us for other options, or ask us to call — either is
              normal and neither is a problem.
            </p>
          </Prose>
        </Section>
      ))}
    </Stack>
  );
}
