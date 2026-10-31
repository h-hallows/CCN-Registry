import type { Metadata } from 'next';
import { Prose, Section, Stack } from '@/components/layout';
import {
  CREDENTIAL_LABEL, CREDENTIAL_ORDER, currentRateRanges, formatRange, type RateRange,
} from '@/lib/rates';

export const metadata: Metadata = {
  title: 'Rates',
  description:
    'What care costs in Century City and West Los Angeles, by credential level, and how '
    + 'our fee works.',
};

/**
 * Hourly. The ranges come from the table the operator maintains, never from this file.
 * A literal because Next analyses this statically — it cannot follow an imported
 * constant. RATE_REVALIDATE_SECONDS in lib/rates.ts holds the same number, and a test
 * asserts the two agree.
 */
export const revalidate = 3600;

const SERVICE_LABEL: Record<string, string> = {
  companion: 'Companionship',
  personal_care: 'Personal care',
  post_surgical: 'Post-surgical recovery',
  skilled_nursing: 'Skilled nursing',
  overnight_newborn: 'Overnight newborn care',
  respite: 'Respite',
  hospice_support: 'Hospice support',
};

const SERVICE_ORDER = [
  'companion', 'personal_care', 'post_surgical', 'overnight_newborn',
  'skilled_nursing', 'hospice_support', 'respite',
];

export default async function Pricing() {
  const ranges = await currentRateRanges();
  const byService = new Map<string, RateRange[]>();
  for (const r of ranges) {
    byService.set(r.serviceKey, [...(byService.get(r.serviceKey) ?? []), r]);
  }
  const services = SERVICE_ORDER.filter((s) => byService.has(s));

  return (
    <Stack gap="lg">
      <Section>
        <h1>Rates</h1>
        <Prose>
          <p style={{ fontSize: 'var(--step-1)', color: 'var(--ink-2)' }}>
            The provider sets their rate and agrees it with you directly. These are the
            ranges we are seeing now, so you are not negotiating blind.
          </p>
          <p>
            We neither set nor cap what anyone charges. A provider whose rate sits above a
            range is not excluded from a short list — experience is priced, and sometimes
            the right person costs more.
          </p>
        </Prose>
      </Section>

      <Section title="By credential level" as="h2">
        {services.length === 0 ? (
          <Prose>
            <p>
              Our current ranges are being updated. Call and we will tell you what we are
              seeing this week.
            </p>
          </Prose>
        ) : (
          <div className="scroller">
            <table className="nums">
              <thead>
                <tr>
                  <th scope="col">Care</th>
                  {CREDENTIAL_ORDER.map((level) => (
                    <th key={level} scope="col">{CREDENTIAL_LABEL[level]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {services.map((service) => {
                  const rows = byService.get(service) ?? [];
                  return (
                    <tr key={service}>
                      <th scope="row" style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--ink)' }}>
                        {SERVICE_LABEL[service] ?? service}
                      </th>
                      {CREDENTIAL_ORDER.map((level) => {
                        const r = rows.find((x) => x.credentialLevel === level);
                        return (
                          <td key={level} style={{ color: r ? 'var(--ink)' : 'var(--ink-3)' }}>
                            {r ? formatRange(r) : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="label" style={{ marginTop: '1rem' }}>
          Provider-set and negotiated directly with the provider. Updated from our own roster.
        </p>
      </Section>

      <Section title="Our fee" as="h2">
        <Prose>
          <p>
            A fixed percentage of the cost of the engagement, charged to the household and
            agreed before any referral is made. It is never taken out of what the provider
            earns, and there is no charge to a provider of any kind.
          </p>
          <p>
            There is no joining fee, no minimum term and no charge for replacing someone
            who turns out not to fit.
          </p>
        </Prose>
      </Section>

      <Section title="Paying for it" as="h2">
        <Prose>
          <p>
            Most of our households pay privately. Some have a long-term care policy, and
            we will put together what the carrier needs — the hours, the dates, the kind
            of care — though whether a policy pays is between you and them.
          </p>
        </Prose>
      </Section>
    </Stack>
  );
}
