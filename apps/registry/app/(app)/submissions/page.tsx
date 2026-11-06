/**
 * The credential submission queue. Migration 0008; web build spec § 4.2, W8.
 *
 * Providers hand documents in through the provider portal. They land here, and nothing
 * in them counts for anything until an operator checks the document against the issuing
 * body and accepts it. Eligibility is computed from `credentials` only, never from a
 * submission, so a row on this screen moves nobody onto a shortlist.
 *
 * The accept form starts empty on purpose. See the comment above the form.
 */
import { requireOperator } from '@/lib/operator';
import { civilLA, formatISODate } from '@h-hallows/core/domain';
import { requiresInspection } from '@/lib/domain/licenceInspection';
import { listPendingSubmissions, listReviewedSubmissions } from '@/lib/queries/submissions';
import { acceptSubmissionAction, rejectSubmissionAction } from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import { Empty, RowLink, Section, shortDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function SubmissionsPage() {
  const { ctx } = await requireOperator();
  const now = new Date();
  const todayISO = formatISODate(civilLA(now));
  const [pending, reviewed] = await Promise.all([
    listPendingSubmissions(ctx),
    listReviewedSubmissions(ctx),
  ]);

  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Credential submissions</h1>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          {pending.length} waiting on review. A submission is what a provider sent in. It
          is not a credential and it changes nobody&rsquo;s eligibility until it is
          checked against the issuing body and accepted here.
        </p>
      </div>

      <Section
        title="Waiting for review"
        blurb="Oldest first. Open the document, verify it at the source, then record what you found."
      >
        {pending.length === 0 ? (
          <Empty>Nothing is waiting for review.</Empty>
        ) : (
          <ul>
            {pending.map((s) => (
              <li key={s.id} className="border-b hair px-4 py-4 last:border-b-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0">
                    <RowLink href={`/roster/${s.providerId}`}>{s.providerName}</RowLink>
                    <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                      {s.providerType}
                    </span>
                    <span className="ml-2 text-sm" style={{ color: 'var(--ink-soft)' }}>
                      {s.label}
                    </span>
                    {s.renewsExisting ? (
                      <span className="ml-2 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                        renews a credential already on file
                      </span>
                    ) : null}
                  </div>
                  <span className="nums text-xs" style={{ color: 'var(--ink-faint)' }}>
                    sent {shortDateTime(s.submittedAt)}
                  </span>
                </div>

                <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="label">Identifier as stated</dt>
                    <dd style={{ color: 'var(--ink-soft)' }}>
                      {s.claimedIdentifier ?? '—'}
                      <span className="ml-1.5 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                        unverified
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="label">Document</dt>
                    <dd>
                      {s.documentUrl ? (
                        <a
                          href={s.documentUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline underline-offset-2"
                        >
                          Open the document
                        </a>
                      ) : (
                        <span style={{ color: 'var(--ink-faint)' }}>None attached</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="label">Their note</dt>
                    <dd style={{ color: 'var(--ink-soft)' }}>{s.note ?? '—'}</dd>
                  </div>
                </dl>

                {/*
                  Every field below is blank. It is not an oversight and it is not a
                  convenience worth adding: the expiry and the verification source are
                  the operator's finding, read off the issuing body's own record, and
                  prefilling them from the submission would turn the provider's claim
                  about their own document back into the thing the registry relies on.
                  Migration 0008 exists to stop exactly that.
                */}
                <div className="mt-3">
                  <ActionForm
                    action={acceptSubmissionAction}
                    submitLabel="Accept and record the credential"
                    primary
                  >
                    <input type="hidden" name="submissionId" value={s.id} />
                    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <label className="label" htmlFor={`expiresOn-${s.id}`}>Expires</label>
                        <input
                          id={`expiresOn-${s.id}`}
                          name="expiresOn"
                          type="date"
                          className="input"
                        />
                        <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                          As the issuing body has it. Blank if it does not expire.
                        </p>
                      </div>
                      <div>
                        <label className="label" htmlFor={`verificationSource-${s.id}`}>
                          Verified how
                        </label>
                        <input
                          id={`verificationSource-${s.id}`}
                          name="verificationSource"
                          className="input"
                          required
                          placeholder="BRN license verification"
                        />
                        <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                          The source you checked, not the document you were sent.
                        </p>
                      </div>
                      <div>
                        <label className="label" htmlFor={`verifiedOn-${s.id}`}>Verified on</label>
                        <input
                          id={`verifiedOn-${s.id}`}
                          name="verifiedOn"
                          type="date"
                          className="input"
                          required
                          defaultValue={todayISO}
                        />
                      </div>
                      <div>
                        <label className="label" htmlFor={`identifier-${s.id}`}>Identifier</label>
                        <input
                          id={`identifier-${s.id}`}
                          name="identifier"
                          className="input"
                          placeholder="As the issuing body has it"
                        />
                      </div>
                      <div>
                        <label className="label" htmlFor={`issuedOn-${s.id}`}>Issued</label>
                        <input
                          id={`issuedOn-${s.id}`}
                          name="issuedOn"
                          type="date"
                          className="input"
                        />
                      </div>
                      {requiresInspection(s.type) ? (
                        <>
                          <div>
                            <label className="label" htmlFor={`inspectedExpiryNoted-${s.id}`}>
                              Expiry on the licence
                            </label>
                            <input
                              id={`inspectedExpiryNoted-${s.id}`}
                              name="inspectedExpiryNoted"
                              type="date"
                              className="input"
                              required
                            />
                            <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                              § 1812.528 — the date printed on the licence you inspected.
                            </p>
                          </div>
                          <div>
                            <label className="label" htmlFor={`inspectedOn-${s.id}`}>
                              Inspected on
                            </label>
                            <input
                              id={`inspectedOn-${s.id}`}
                              name="inspectedOn"
                              type="date"
                              className="input"
                              defaultValue={todayISO}
                            />
                          </div>
                        </>
                      ) : null}
                      <div className="sm:col-span-2 lg:col-span-3">
                        <label className="label" htmlFor={`reviewNote-${s.id}`}>Review note</label>
                        <input
                          id={`reviewNote-${s.id}`}
                          name="reviewNote"
                          className="input"
                          placeholder="Optional"
                        />
                      </div>
                    </div>
                  </ActionForm>
                </div>

                <div className="mt-3">
                  <Disclose summary="Reject this submission" tone="quiet">
                    <ActionForm
                      action={rejectSubmissionAction}
                      submitLabel="Reject"
                      confirm="Reject this submission? No credential will be recorded."
                    >
                      <input type="hidden" name="submissionId" value={s.id} />
                      <label className="label" htmlFor={`rejectNote-${s.id}`}>
                        Why it was not accepted
                      </label>
                      <input
                        id={`rejectNote-${s.id}`}
                        name="reviewNote"
                        className="input"
                        required
                        placeholder="Illegible scan; asked for a clearer copy"
                      />
                      <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                        Rejecting records no credential, and leaves this provider&rsquo;s
                        standing exactly as it was.
                      </p>
                    </ActionForm>
                  </Disclose>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Reviewed"
        blurb="What was decided, by whom, and the credential each accepted submission produced."
      >
        {reviewed.length === 0 ? (
          <Empty>Nothing has been reviewed yet.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Provider</th><th>Credential</th><th>Decision</th>
                  <th>Reviewed</th><th>By</th><th>Note</th>
                </tr>
              </thead>
              <tbody>
                {reviewed.map((s) => (
                  <tr key={s.id}>
                    <td><RowLink href={`/roster/${s.providerId}`}>{s.providerName}</RowLink></td>
                    <td style={{ color: 'var(--ink-soft)' }}>{s.label}</td>
                    <td style={{
                      color: s.state === 'accepted' ? 'var(--color-ok)' : 'var(--ink-faint)',
                    }}>
                      {s.state === 'accepted' ? 'Accepted' : 'Rejected'}
                    </td>
                    <td className="nums" style={{ color: 'var(--ink-faint)' }}>
                      {shortDateTime(s.reviewedAt)}
                    </td>
                    <td style={{ color: 'var(--ink-faint)' }}>{s.reviewedBy}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>{s.reviewNote ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
