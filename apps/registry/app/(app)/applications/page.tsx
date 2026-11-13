import { requireOperator } from '@/lib/operator';
import {
  recentlyDecidedApplications, unhandledApplications,
} from '@/lib/queries/applications';
import { declineApplicantAction, onboardApplicantAction } from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import { Banner, Empty, RowLink, Section, shortDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

const TYPES = ['RN', 'LVN', 'CNA', 'HCA', 'companion'] as const;

/**
 * Who wants to work here. Spec § 4.2.
 *
 * The supply side of the same gap the enquiries screen closed: `/for-providers` wrote
 * to `provider_applications` and nothing read it, and nothing created a `providers`
 * row — so the roster could not grow at all and every provider came from the seed.
 *
 * ONBOARDING VERIFIES NOTHING, and the screen says so twice because it is the part
 * that matters. A new provider arrives inactive with no credential rows, which means
 * `eligibility()` excludes them from every shortlist until each document has been
 * checked against the body that issued it. What they typed about their own licence is
 * a claim; migration 0008 exists because a provider inserting their own Live Scan was
 * enough to make them eligible.
 */
export default async function Applications() {
  const { ctx } = await requireOperator();
  const [waiting, decided] = await Promise.all([
    unhandledApplications(ctx),
    recentlyDecidedApplications(ctx),
  ]);

  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Applications</h1>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Oldest first. Putting somebody on the roster is what creates a provider —
          inactive, with nothing verified, until you record their documents.
        </p>
      </div>

      {waiting.length === 0 ? (
        <Section title="Nothing waiting">
          <Empty>
            No application is unanswered. They arrive here from the page for nurses and
            caregivers the moment somebody sends one.
          </Empty>
        </Section>
      ) : null}

      {waiting.map((a) => (
        <Section
          key={a.id}
          title={a.fullName}
          blurb={[
            a.type ?? 'type not stated',
            a.areas.length > 0 ? a.areas.join(', ') : 'no areas given',
            `applied ${shortDateTime(a.receivedAt)}`,
          ].join(' · ')}
        >
          <div className="divide-y hair-soft">
            <div className="px-4 py-4">
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="label">How to reach them</dt>
                  <dd className="text-sm">
                    {[a.phone, a.email].filter(Boolean).join(' · ') || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="label">Licence number, as claimed</dt>
                  <dd className="text-sm">
                    {a.licenseNumber ?? '—'}
                    {a.licenseNumber ? (
                      <span className="ml-1.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
                        unverified
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt className="label">Languages</dt>
                  <dd className="text-sm">{a.languages.join(', ') || '—'}</dd>
                </div>
                <div className="sm:col-span-2 lg:col-span-3">
                  <dt className="label">What they say they have done</dt>
                  <dd className="text-sm">{a.specialties.join(', ') || '—'}</dd>
                </div>
              </dl>

              {a.experienceNote ? (
                <div className="mt-4">
                  <dt className="label">Experience, in their words</dt>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{a.experienceNote}</p>
                </div>
              ) : null}
              {a.message ? (
                <p className="mt-3 whitespace-pre-wrap text-sm"
                  style={{ color: 'var(--ink-soft)' }}>
                  {a.message}
                </p>
              ) : null}
            </div>

            <div className="px-4 py-4">
              {a.possibleDuplicateId ? (
                <div className="mb-4">
                  <Banner tone="alert" title="Somebody on the roster looks like this person">
                    <RowLink href={`/roster/${a.possibleDuplicateId}`}>
                      {a.possibleDuplicateName}
                    </RowLink>
                    {' '}has the same {a.licenseNumber ? 'licence number' : 'name'}.
                    Onboarding a second record means their credentials are checked
                    against neither — open the existing one first.
                  </Banner>
                </div>
              ) : null}

              <ActionForm
                action={onboardApplicantAction}
                submitLabel="Put them on the roster"
                primary
                confirm="This creates the provider, inactive and with nothing verified. Continue?"
              >
                <input type="hidden" name="applicationId" value={a.id} />
                {a.areas.map((area) => (
                  <input key={area} type="hidden" name="areas" value={area} />
                ))}
                {a.languages.map((lang) => (
                  <input key={lang} type="hidden" name="languages" value={lang} />
                ))}
                {a.specialties.map((s) => (
                  <input key={s} type="hidden" name="specialties" value={s} />
                ))}

                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <label className="label" htmlFor={`name-${a.id}`}>Their name</label>
                    <input id={`name-${a.id}`} name="fullName" className="input" required
                      defaultValue={a.fullName} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`type-${a.id}`}>Type</label>
                    <select id={`type-${a.id}`} name="type" className="select" required
                      defaultValue={a.type ?? ''}>
                      <option value="" disabled>Choose one</option>
                      {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor={`lic-${a.id}`}>Licence number</label>
                    <input id={`lic-${a.id}`} name="licenseNumber" className="input"
                      defaultValue={a.licenseNumber ?? ''} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`ph-${a.id}`}>Phone</label>
                    <input id={`ph-${a.id}`} name="phone" className="input"
                      defaultValue={a.phone ?? ''} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`em-${a.id}`}>Email</label>
                    <input id={`em-${a.id}`} name="email" className="input"
                      defaultValue={a.email ?? ''} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`tr-${a.id}`}>Drives clients</label>
                    <select id={`tr-${a.id}`} name="transports" className="select"
                      defaultValue="no">
                      <option value="no">No</option>
                      <option value="yes">Yes</option>
                    </select>
                  </div>
                </div>

                <div className="mt-3">
                  <label className="label" htmlFor={`note-${a.id}`}>
                    Your note about them
                  </label>
                  <input id={`note-${a.id}`} name="notes" className="input"
                    placeholder="How you know them, who referred them, anything from the call" />
                </div>

                <p className="mt-3 text-[0.6875rem] leading-relaxed"
                  style={{ color: 'var(--ink-faint)' }}>
                  They arrive <strong>inactive, with no documents on file</strong>, so
                  they reach no shortlist until each one has been checked against the
                  body that issued it. What they wrote about their own experience goes
                  into your notes rather than into the fields a household sees beside
                  verified documents.
                </p>
              </ActionForm>

              <div className="mt-4">
                <Disclose summary="Not somebody we would refer" tone="quiet">
                  <ActionForm action={declineApplicantAction} submitLabel="Record it">
                    <input type="hidden" name="applicationId" value={a.id} />
                    <label className="label" htmlFor={`dec-${a.id}`}>Why</label>
                    <input id={`dec-${a.id}`} name="reason" className="input" required
                      placeholder="Outside the area, wrong level, no response" />
                  </ActionForm>
                </Disclose>
              </div>
            </div>
          </div>
        </Section>
      ))}

      <Section title="Recently decided">
        {decided.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Applicant</th><th>Applied</th><th>Decided</th>
                  <th>By</th><th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((a) => (
                  <tr key={a.id}>
                    <td>{a.fullName}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {shortDateTime(a.receivedAt)}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {a.handledAt ? shortDateTime(a.handledAt) : '—'}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>{a.handledBy ?? '—'}</td>
                    <td>
                      {a.providerId ? (
                        <RowLink href={`/roster/${a.providerId}`}>on the roster</RowLink>
                      ) : (
                        <span style={{ color: 'var(--ink-faint)' }}>not taken on</span>
                      )}
                    </td>
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
