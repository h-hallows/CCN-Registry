import Link from 'next/link';
import { requireOperator } from '@/lib/operator';
import { pendingRequests } from '@/lib/queries/bench';
import { makeReferralAction, resolveRequestAction } from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import { Banner, CARE_LABEL, Empty, Section, RowLink, shortDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The queue of households who have asked about somebody on their bench.
 *
 * Oldest first, and the age is on the row. A request is a person waiting for a call, and
 * § 1812.533(b)(5) measures how long they waited.
 *
 * Asking is not referring. A request sitting here has produced no referral and no
 * disclosure, and the only way out of it towards one is the form on the row, which
 * carries the same un-prechecked § 1812.5095(f) confirmation as every other referral
 * path. The other way out records what the household said and nothing more.
 */
export default async function RequestsPage() {
  const { ctx } = await requireOperator();
  const queue = await pendingRequests(ctx);

  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Requests</h1>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Households who have asked about someone on their bench. Oldest first.
        </p>
      </div>

      {queue.length === 0 ? (
        <Section title="Nothing waiting">
          <Empty>
            No household is waiting on an answer. Requests arrive here from the client
            portal the moment someone asks about a provider on their bench.
          </Empty>
        </Section>
      ) : null}

      {queue.map((r) => (
        <Section
          key={r.requestId}
          title={`${r.householdName} asked about ${r.providerName}`}
          blurb={`${CARE_LABEL[r.care as keyof typeof CARE_LABEL] ?? r.care} in ${r.crArea} · asked ${shortDateTime(r.requestedAt)}`}
        >
          <div className="px-4 py-4">
            <p className="text-sm">
              <RowLink href={`/cases/${r.caseId}`}>Open the case</RowLink>
              {' · '}
              <RowLink href={`/roster/${r.providerId}`}>{r.providerName}</RowLink>
              {' · '}
              <Link href={`/match/${r.caseId}`} className="underline underline-offset-4">
                the bench
              </Link>
            </p>
            {r.note ? (
              <p className="mt-2 text-sm" style={{ color: 'var(--ink-soft)' }}>
                They wrote: {r.note}
              </p>
            ) : null}
            {r.alreadyReferred ? (
              <p className="mt-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                This provider has already been referred on this case. A second referral is
                a second disclosure.
              </p>
            ) : null}

            {r.physicianMissing ? (
              <div className="mt-3">
                <Banner tone="alert" title="No ordering physician on the household record">
                  A referral on this skilled case will be refused until one is recorded —
                  by the application and by the database. Add it on the case first.
                </Banner>
              </div>
            ) : null}

            <div className="mt-4">
              <ActionForm
                action={makeReferralAction}
                submitLabel="Record referral and disclosure"
                primary
                confirm="This writes the disclosure and the referral together, permanently, and answers the household's request. Continue?"
              >
                <input type="hidden" name="caseId" value={r.caseId} />
                <input type="hidden" name="providerId" value={r.providerId} />
                <input type="hidden" name="fromRequestId" value={r.requestId} />
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <label className="label" htmlFor={`to-${r.requestId}`}>
                      Disclosure given to
                    </label>
                    <input id={`to-${r.requestId}`} name="disclosedTo" className="input"
                      required defaultValue={r.dmName} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`how-${r.requestId}`}>How</label>
                    <select id={`how-${r.requestId}`} name="method" className="select" required>
                      <option value="phone">By phone</option>
                      <option value="in_person">In person</option>
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor={`note-${r.requestId}`}>
                      Note for the timeline
                    </label>
                    <input id={`note-${r.requestId}`} name="note" className="input"
                      placeholder="Optional" />
                  </div>
                </div>

                <label
                  className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-xs leading-relaxed hair"
                  style={{ background: 'var(--accent-soft)' }}
                >
                  <input type="checkbox" name="confirm" value="yes" required className="mt-0.5" />
                  <span>
                    I gave the spoken disclosure to the person named above, live, by phone
                    or in person, before recording this referral. I explained that the
                    provider is a referred provider and not the registry&rsquo;s own, the
                    fee charged to the household, and that the rate is set by the provider
                    and negotiable. The written statement follows within three California
                    business days, as § 1812.5095(f) requires.
                  </span>
                </label>
              </ActionForm>
            </div>

            <div className="mt-4">
              <Disclose summary="Close this request without a referral" tone="quiet">
                <ActionForm action={resolveRequestAction} submitLabel="Record it">
                  <input type="hidden" name="requestId" value={r.requestId} />
                  <input type="hidden" name="caseId" value={r.caseId} />
                  <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                    <div>
                      <label className="label" htmlFor={`out-${r.requestId}`}>What happened</label>
                      <select id={`out-${r.requestId}`} name="outcome" className="select" required>
                        <option value="declined_by_household">
                          The household decided against it
                        </option>
                        <option value="withdrawn">It is not going ahead</option>
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor={`why-${r.requestId}`}>
                        What was said
                      </label>
                      <input id={`why-${r.requestId}`} name="note" className="input" required
                        placeholder="In their words where you can" />
                    </div>
                  </div>
                  <p className="mt-2 text-[0.6875rem] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                    This records the household&rsquo;s decision. It reaches no
                    provider&rsquo;s record and changes nothing about their standing on
                    the roster.
                  </p>
                </ActionForm>
              </Disclose>
            </div>
          </div>
        </Section>
      ))}
    </>
  );
}
