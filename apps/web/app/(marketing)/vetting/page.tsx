import type { Metadata } from 'next';
import { Prose, Section, Stack } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Vetting',
  description:
    'What we check before anyone is put forward, how we check it, and what we do when '
    + 'something lapses.',
};

export default function Vetting() {
  return (
    <Stack gap="lg">
      <Section>
        <h1>What we check</h1>
        <Prose>
          <p style={{ fontSize: 'var(--step-1)', color: 'var(--ink-2)' }}>
            Every credential is verified against the body that issued it, not against a
            copy handed to us. We record what was checked, when, and where it was checked.
          </p>
        </Prose>
      </Section>

      <Section title="Before anyone joins the roster" as="h2">
        <Prose>
          <ul>
            <li>
              <strong>Licence or certification</strong>, confirmed with the issuing board
              or registry, with the expiry recorded. For nurses we also inspect the
              licence itself and note its expiry on the application.
            </li>
            <li>
              <strong>Background screening</strong> through the California Department of
              Justice, with ongoing notification rather than a one-off check.
            </li>
            <li><strong>Tuberculosis clearance</strong>, with the renewal date tracked.</li>
            <li>
              <strong>CPR and basic life support</strong> where the role calls for it,
              confirmed against the issuing body&rsquo;s own lookup.
            </li>
            <li>
              <strong>Driving documents</strong> where someone will be carrying a client.
            </li>
            <li>
              <strong>Experience, verified in writing</strong> and kept on file.
            </li>
          </ul>
        </Prose>
      </Section>

      <Section title="And then we keep checking" as="h2">
        <Prose>
          <p>
            A credential that was current in March can lapse in September. Every expiry is
            tracked, and anyone whose required credential has lapsed is excluded from
            every short list until it is current again. There is no override for that — not
            for a favourite, not for an urgent discharge.
          </p>
          <p>
            We also re-confirm each verification periodically, because a check from two
            years ago tells you about two years ago.
          </p>
        </Prose>
      </Section>

      <Section title="What we do not do" as="h2">
        <Prose>
          <p>
            We do not score, rank or rate the people on our roster, and we do not publish
            reviews of them. What we can tell you is factual: what is verified, when it was
            verified, how long they have worked with the households we have referred them
            to, and what they have said about the work they will and will not take.
          </p>
          <p>
            Judgement about fit is the conversation we have with you. It is not a number.
          </p>
        </Prose>
      </Section>
    </Stack>
  );
}
