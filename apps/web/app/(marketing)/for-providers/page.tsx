import type { Metadata } from 'next';
import { Prose, Section, Stack } from '@/components/layout';

export const metadata: Metadata = {
  title: 'For nurses and caregivers',
  description:
    'How referrals work here: you set your rate, you choose what you take, and we never '
    + 'charge you anything.',
};

export default function ForProviders() {
  return (
    <Stack gap="lg">
      <Section>
        <h1>For nurses and caregivers</h1>
        <Prose>
          <p style={{ fontSize: 'var(--step-1)', color: 'var(--ink-2)' }}>
            We refer work to experienced people in West Los Angeles. You set your rate,
            you say what you will and will not take, and you are never charged a fee of
            any kind.
          </p>
        </Prose>
      </Section>

      <Section title="What you can expect" as="h2">
        <Prose>
          <ul>
            <li>
              <strong>You set your rate.</strong> We do not suggest one, cap one or tell
              you what others charge. It stays negotiable with the household.
            </li>
            <li>
              <strong>You say when you are available</strong>, and change it whenever you
              like. We record what you tell us; we do not build you a roster.
            </li>
            <li>
              <strong>Declining costs you nothing.</strong> There is no acceptance rate,
              no response-time target, no ranking and no record anywhere of how often you
              said no. We did not build the field.
            </li>
            <li>
              <strong>No fee, ever.</strong> No registration fee, no joining fee, nothing
              deducted from what you earn. Our fee is charged to the household.
            </li>
            <li>
              <strong>We tell you what the work actually is</strong> before you decide —
              the pattern, the household, what they have asked for in their own words.
            </li>
          </ul>
        </Prose>
      </Section>

      <Section title="What we ask of you" as="h2">
        <Prose>
          <p>
            Current credentials, verified by us against the body that issued them. A
            background check through the California Department of Justice. Experience we
            can confirm in writing.
          </p>
          <p>
            You send us a document; we do the verifying and record the expiry. You cannot
            set your own expiry date or verification in our system, and that is
            deliberate — it is what makes the record worth anything to the households who
            rely on it.
          </p>
        </Prose>
      </Section>

      <Section title="What we are not asking of you" as="h2">
        <Prose>
          <p>
            No coursework to complete, no continuing-education tracking, no skills tests,
            nothing to wear, no equipment to buy, no app to clock into, and no list of
            jobs to tick off. The household directs the work; we introduce you and then
            get out of the way.
          </p>
        </Prose>
      </Section>
    </Stack>
  );
}
