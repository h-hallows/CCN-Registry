import Link from 'next/link';
import type { Metadata } from 'next';
import { Prose, Section, Stack } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Century City Concierge Nursing',
  description:
    'A private nursing and caregiver referral registry serving Century City and West '
    + 'Los Angeles. We refer; you engage directly.',
};

/**
 * LocalBusiness only. Never MedicalBusiness, HomeHealthCareService, Physician or
 * Hospital — those imply licensed clinical provision and run at § 1726(b) and
 * § 1812.533(b)(4). No aggregateRating, because there are no public ratings. No
 * priceRange, which would go stale. No award, licence or accreditation property.
 */
const JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'LocalBusiness',
  name: 'Century City Concierge Nursing',
  description:
    'A private nursing and caregiver referral registry serving Century City and West '
    + 'Los Angeles.',
  address: { '@type': 'PostalAddress', addressLocality: 'Los Angeles', addressRegion: 'CA' },
  areaServed: [
    'Century City', 'Beverly Hills', 'Westwood', 'Brentwood', 'Bel Air',
    'Holmby Hills', 'Santa Monica', 'Pacific Palisades', 'Malibu',
  ],
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      <Stack gap="lg">
        <Section>
          <p className="label">Century City and West Los Angeles</p>
          <h1>Care at home, arranged by someone who answers the phone.</h1>
          <Prose>
            <p style={{ fontSize: 'var(--step-1)', color: 'var(--ink-2)' }}>
              We are a referral registry. We keep a small roster of experienced nurses and
              caregivers, we check their credentials against the issuing source, and when
              you call we put forward the two or three who actually fit — not a directory
              to search.
            </p>
            <p>
              You engage the provider directly and agree the rate with them. We make the
              introduction, hold the paperwork, and stay reachable when something changes
              at eight on a Sunday morning.
            </p>
            <p>
              <Link href="/how-it-works" className="btn btn-primary">How it works</Link>
            </p>
          </Prose>
        </Section>

        <Section title="What we are asked for most" as="h2">
          <Prose>
            <ul>
              <li>Going home after surgery, and the first two weeks are the hard ones.</li>
              <li>A parent who is managing, but not quite, and nobody local to notice.</li>
              <li>Overnight cover so the person doing it all can sleep.</li>
              <li>A nurse for a condition that needs one, under a physician&rsquo;s direction.</li>
            </ul>
          </Prose>
        </Section>

        <Section title="What we are not" as="h2">
          <Prose>
            <p>
              We are a referral registry, not an agency that sends staff. The provider is
              not ours; they are referred to you, and the working relationship is between
              you and them. That distinction is the whole legal shape of this business and
              we would rather be plain about it than have it surface later.
            </p>
            <p>
              We do not provide home care agency services, and we do not direct or
              supervise how a referred provider does their work.
            </p>
          </Prose>
        </Section>
      </Stack>
    </>
  );
}
