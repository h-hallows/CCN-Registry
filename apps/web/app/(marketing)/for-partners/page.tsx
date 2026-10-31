import type { Metadata } from 'next';
import { Prose, Section, Stack } from '@/components/layout';

export const metadata: Metadata = {
  title: 'For discharge planners and advisers',
  description:
    'Hand us a referral in one step and get a same-day acknowledgement with a named '
    + 'person and a direct line.',
};

export default function ForPartners() {
  return (
    <Stack gap="lg">
      <Section>
        <h1>For discharge planners and advisers</h1>
        <Prose>
          <p style={{ fontSize: 'var(--step-1)', color: 'var(--ink-2)' }}>
            If you are placing somebody going home and you need to know a person will
            actually pick up, this is what we are for. One step to refer, no account, and
            a same-day acknowledgement from a named person with a direct line.
          </p>
        </Prose>
      </Section>

      <Section title="How to refer" as="h2">
        <Prose>
          <p>
            Give us the patient&rsquo;s initials, the kind of care, the area and how urgent
            it is, plus a family member we should call. <strong>Not a full name and not a
            diagnosis</strong> — you should not be sending those to a third party before
            the family has engaged anyone, and we do not need them to make the call.
          </p>
          <p>
            We take the rest from the family directly. You will hear back the same day
            with who we spoke to and what happened.
          </p>
        </Prose>
      </Section>

      <Section title="What we do not offer" as="h2">
        <Prose>
          <p>
            There is no commission, no referral payment, no rewards tier and nothing of
            value that flows back to you or your organisation for sending us work. Civil
            Code § 1812.531 prohibits a nurses&rsquo; registry from dividing fees with a
            physician, surgeon, nurse, hospital or patient, or with their agents or the
            people who work for them &mdash; so we have not built the mechanism, and
            there is no field in our system that could hold one.
          </p>
          <p>
            What you get instead is a short list that fits, a callback that happens, and
            somebody who tells you when a placement has not worked rather than letting you
            find out from the family.
          </p>
        </Prose>
      </Section>

      <Section title="Who we work with" as="h2">
        <Prose>
          <ul>
            <li>Hospital and surgical-centre discharge planning</li>
            <li>Geriatric care managers</li>
            <li>Concierge and private-practice physicians</li>
            <li>Estate and elder law attorneys</li>
            <li>Family offices and private trustees</li>
          </ul>
        </Prose>
      </Section>
    </Stack>
  );
}
