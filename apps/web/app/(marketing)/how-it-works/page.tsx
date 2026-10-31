import type { Metadata } from 'next';
import { Prose, Section, Stack } from '@/components/layout';

export const metadata: Metadata = {
  title: 'How it works',
  description:
    'A call, a short list of two or three people, and an introduction. What we do, what '
    + 'you do, and who the provider works for.',
};

const QUESTIONS = [
  {
    q: 'Who does the provider work for?',
    a: 'You. We make the referral; the working relationship is between you and the '
      + 'provider. Depending on how the arrangement runs, you may have responsibilities '
      + 'that come with that, and we give you the written statement the law requires so '
      + 'you can take advice on it.',
  },
  {
    q: 'How quickly can someone start?',
    a: 'For a discharge we aim to call back within the hour and put names forward the '
      + 'same day. For anything less urgent, a short list usually takes a day or two — '
      + 'the constraint is finding people who genuinely fit, not finding people.',
  },
  {
    q: 'How many people will you put forward?',
    a: 'Two or three. A list of twenty is a directory, and sorting it is the work you '
      + 'came to us to avoid. If none of them is right, we say so and keep looking.',
  },
  {
    q: 'Who sets the rate?',
    a: 'The provider does, and it stays negotiable between you and them. We publish the '
      + 'ranges we see so you are not negotiating blind, but we neither set nor cap what '
      + 'anyone charges.',
  },
  {
    q: 'What do you charge?',
    a: 'A fixed percentage of the cost of the engagement, charged to the household. It '
      + 'is never taken out of what the provider earns.',
  },
  {
    q: 'What happens if it is not working?',
    a: 'Tell us and we will put other people forward. You can end the arrangement with a '
      + 'provider at any time — that is yours to decide, not ours.',
  },
  {
    q: 'Do you check credentials?',
    a: 'Yes, against the issuing source rather than a copy handed to us, and we re-check '
      + 'as they come up for renewal. Anyone whose required credential has lapsed is not '
      + 'put forward until it is current.',
  },
];

const FAQ_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: QUESTIONS.map(({ q, a }) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  })),
};

export default function HowItWorks() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />
      <Stack gap="lg">
        <Section>
          <h1>How it works</h1>
          <Prose>
            <ol>
              <li>
                <strong>You call.</strong> We ask what the days actually look like, who is
                involved, and what has already been tried. Fifteen minutes, usually.
              </li>
              <li>
                <strong>We put forward two or three people.</strong> Chosen against what
                you described — the pattern, the area, the languages spoken at home, what
                the person will and will not accept help with.
              </li>
              <li>
                <strong>You meet them.</strong> We arrange it. You decide.
              </li>
              <li>
                <strong>We make the referral.</strong> Before we do, we go through the
                disclosure the law requires and confirm it in writing afterwards.
              </li>
              <li>
                <strong>We stay reachable.</strong> Cover for a missed shift, a second
                person when the hours grow, a different fit if the first one is not right.
              </li>
            </ol>
          </Prose>
        </Section>

        <Section title="Questions we are asked" as="h2">
          <Prose>
            <dl>
              {QUESTIONS.map(({ q, a }) => (
                <div key={q} style={{ marginBottom: '1.75rem' }}>
                  <dt style={{ fontFamily: 'var(--display)', fontSize: 'var(--step-1)', marginBottom: '.35rem' }}>
                    {q}
                  </dt>
                  <dd style={{ margin: 0, color: 'var(--ink-2)', maxWidth: 'var(--measure)' }}>{a}</dd>
                </div>
              ))}
            </dl>
          </Prose>
        </Section>
      </Stack>
    </>
  );
}
