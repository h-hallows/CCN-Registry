import { requireOperator } from '@/lib/operator';
import { recentlyHandled, unhandledInquiries } from '@/lib/queries/intake';
import { convertInquiryAction, turnAwayInquiryAction } from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import {
  Banner, CARE_LABEL, Empty, RowLink, Section, shortDateTime,
} from '@/components/ui';
import { URGENCY_LABEL } from '@/lib/domain/buckets';

export const dynamic = 'force-dynamic';

const CARE_OPTIONS = [
  'companion', 'personal_care', 'skilled_nursing', 'post_surgical',
  'overnight_newborn', 'respite', 'hospice_support',
] as const;

const PAYMENT_LABEL: Record<string, string> = {
  private: 'Private pay',
  ltc_policy: 'Long-term care policy',
  va: 'VA',
  other: 'Other',
};

/**
 * The front door, from this side. Spec § 4.1.
 *
 * Every enquiry the public forms take lands here, and this is the only screen in the
 * system that creates a household. Until it existed the three intake routes wrote to a
 * table nothing displayed — a family filled in the form and arrived nowhere, and every
 * household in the database came from the seed.
 *
 * WHAT THE FAMILY TYPED IS SHOWN BESIDE WHAT THE OPERATOR IS ABOUT TO RECORD, and the
 * two are kept apart. The enquiry row is never edited. The form below it is what the
 * registry believes after a conversation, and the fields are filled in from the enquiry
 * as a starting point rather than as an answer — a family that asks for "a nurse"
 * routinely needs a caregiver, and the person who makes that call is the one on the
 * phone.
 */
export default async function Intake() {
  const { ctx } = await requireOperator();
  const [waiting, handled] = await Promise.all([
    unhandledInquiries(ctx),
    recentlyHandled(ctx),
  ]);

  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Enquiries</h1>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Most urgent first, then oldest. Opening one as a case is what creates a
          household — nothing else in the system does.
        </p>
      </div>

      {waiting.length === 0 ? (
        <Section title="Nothing waiting">
          <Empty>
            No enquiry is unanswered. They arrive here from the website, the provider
            form and the partner form the moment somebody sends one.
          </Empty>
        </Section>
      ) : null}

      {waiting.map((q) => (
        <Section
          key={q.id}
          title={q.name}
          blurb={[
            q.urgency ? URGENCY_LABEL[q.urgency] ?? q.urgency : 'No urgency given',
            q.careType ? CARE_LABEL[q.careType] ?? q.careType : 'Care type not stated',
            q.areaLabel || 'area not stated',
            `received ${shortDateTime(q.receivedAt)}`,
          ].join(' · ')}
        >
          <div className="divide-y hair-soft">
            {/* What they typed, unedited and kept that way. */}
            <div className="px-4 py-4">
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="label">How to reach them</dt>
                  <dd className="text-sm">
                    {[q.phone, q.email].filter(Boolean).join(' · ') || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="label">Who they are to the patient</dt>
                  <dd className="text-sm">{q.relationship ?? '—'}</dd>
                </div>
                <div>
                  <dt className="label">How they would pay</dt>
                  <dd className="text-sm">
                    {q.paymentMethod ? PAYMENT_LABEL[q.paymentMethod] ?? q.paymentMethod : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="label">Pattern asked for</dt>
                  <dd className="text-sm">{q.patternNote ?? '—'}</dd>
                </div>
                <div>
                  <dt className="label">When it starts</dt>
                  <dd className="text-sm">{q.startNote ?? '—'}</dd>
                </div>
                <div>
                  <dt className="label">Came from</dt>
                  <dd className="text-sm" style={{ color: 'var(--ink-soft)' }}>
                    {q.sourcePath ?? '—'}
                    {q.partnerName ? ` · ${q.partnerName}` : null}
                  </dd>
                </div>
              </dl>

              {q.message ? (
                <div className="mt-4">
                  <dt className="label">In their words</dt>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{q.message}</p>
                </div>
              ) : null}

              {q.referrer ? (
                <p className="mt-3 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  Sent by a professional on the family&rsquo;s behalf.
                  {' '}
                  {String(q.referrer.partnerName ?? 'Somebody')}
                  {q.referrer.partnerOrg ? ` at ${String(q.referrer.partnerOrg)}` : null}
                  {q.referrer.patientInitials
                    ? `, about ${String(q.referrer.patientInitials)}` : null}
                  . They confirmed the family agreed.
                </p>
              ) : null}
            </div>

            {/* What the registry will record, which is a different thing. */}
            <div className="px-4 py-4">
              {q.providersCoveringArea === 0 ? (
                <div className="mb-4">
                  <Banner
                    tone="note"
                    title={q.areaLabel
                      ? `Nobody on the roster covers ${q.areaLabel}`
                      : 'No area was given'}
                  >
                    You can still open it — an area is a starting point and the roster
                    changes. But if this is outside where you work, turning it away now
                    is kinder than a household with a case nobody can be matched to.
                  </Banner>
                </div>
              ) : null}
              <ActionForm
                action={convertInquiryAction}
                submitLabel="Open as a case"
                primary
                confirm="This creates the household and its first case. Continue?"
              >
                <input type="hidden" name="inquiryId" value={q.id} />
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <label className="label" htmlFor={`display-${q.id}`}>
                      Household, as it appears on every screen
                    </label>
                    <input id={`display-${q.id}`} name="displayName" className="input"
                      required defaultValue={lastName(q.name)}
                      placeholder="Okafor — Pasadena" />
                  </div>
                  <div>
                    <label className="label" htmlFor={`dm-${q.id}`}>
                      Person engaging care
                    </label>
                    <input id={`dm-${q.id}`} name="dmName" className="input" required
                      defaultValue={q.name} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`rel-${q.id}`}>
                      Their relationship
                    </label>
                    <input id={`rel-${q.id}`} name="dmRelationship" className="input"
                      defaultValue={q.relationship ?? ''} placeholder="Son, daughter…" />
                  </div>
                  <div>
                    <label className="label" htmlFor={`phone-${q.id}`}>Phone</label>
                    <input id={`phone-${q.id}`} name="dmPhone" className="input"
                      defaultValue={q.phone ?? ''} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`email-${q.id}`}>Email</label>
                    <input id={`email-${q.id}`} name="dmEmail" className="input"
                      defaultValue={q.email ?? ''} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`crname-${q.id}`}>
                      Who the care is for
                    </label>
                    <input id={`crname-${q.id}`} name="crName" className="input"
                      placeholder="Ask on the call" />
                  </div>
                  <div>
                    <label className="label" htmlFor={`area-${q.id}`}>Area</label>
                    {/*
                      * The label, not the slug the form submitted. `cr_area` is
                      * compared to `providers.areas` by string equality, so a
                      * household stored as `santa_monica` matches nobody, ever — and
                      * an empty shortlist is a legitimate answer, so nothing would
                      * distinguish that from "we have no one there".
                      */}
                    <input id={`area-${q.id}`} name="crArea" className="input" required
                      defaultValue={q.areaLabel} />
                  </div>
                  <div>
                    <label className="label" htmlFor={`care-${q.id}`}>Care</label>
                    <select id={`care-${q.id}`} name="care" className="select" required
                      defaultValue={q.careType ?? ''}>
                      <option value="" disabled>Choose one</option>
                      {CARE_OPTIONS.map((c) => (
                        <option key={c} value={c}>{CARE_LABEL[c] ?? c}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor={`urg-${q.id}`}>Urgency</label>
                    <select id={`urg-${q.id}`} name="urgency" className="select" required
                      defaultValue={q.urgency ?? 'routine'}>
                      <option value="discharge">Discharge</option>
                      <option value="same_day">Same day</option>
                      <option value="next_day">Next day</option>
                      <option value="routine">Routine</option>
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor={`pay-${q.id}`}>Payment</label>
                    <select id={`pay-${q.id}`} name="paymentMethod" className="select"
                      required defaultValue={q.paymentMethod ?? 'private'}>
                      <option value="private">Private pay</option>
                      <option value="ltc_policy">Long-term care policy</option>
                      <option value="va">VA</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                </div>

                <div className="mt-3">
                  <label className="label" htmlFor={`needs-${q.id}`}>
                    What they need, in their words
                  </label>
                  <textarea id={`needs-${q.id}`} name="needsNote" className="textarea"
                    rows={3} defaultValue={q.message ?? ''} />
                  <p className="mt-2 text-[0.6875rem] leading-relaxed"
                    style={{ color: 'var(--ink-faint)' }}>
                    Recorded as stated. Nothing here is generated or templated, and it
                    is not a care plan — it is what the family said they wanted.
                  </p>
                </div>

                <p className="mt-3 text-[0.6875rem] leading-relaxed"
                  style={{ color: 'var(--ink-faint)' }}>
                  Filled in from the enquiry as a starting point, not as an answer. A
                  family that asks for a nurse often needs a caregiver, and the person
                  on the phone is the one who can tell. What they originally typed is
                  kept above, unchanged, whatever you record here.
                </p>
              </ActionForm>

              <div className="mt-4">
                <Disclose summary="We cannot help with this one" tone="quiet">
                  <ActionForm action={turnAwayInquiryAction} submitLabel="Record it">
                    <input type="hidden" name="inquiryId" value={q.id} />
                    <label className="label" htmlFor={`away-${q.id}`}>Why</label>
                    <input id={`away-${q.id}`} name="reason" className="input" required
                      placeholder="Outside the area, wrong level of care, nobody available" />
                    <p className="mt-2 text-[0.6875rem] leading-relaxed"
                      style={{ color: 'var(--ink-faint)' }}>
                      Counted, not deleted. Turn-aways are half of knowing whether the
                      constraint is capacity or demand, and that decides what gets built
                      next.
                    </p>
                  </ActionForm>
                </Disclose>
              </div>
            </div>
          </div>
        </Section>
      ))}

      <Section
        title="Recently dealt with"
        blurb="So a wrong call is findable without opening the audit log."
      >
        {handled.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Enquiry</th><th>Received</th><th>Dealt with</th>
                  <th>By</th><th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {handled.map((q) => (
                  <tr key={q.id}>
                    <td>{q.name}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {shortDateTime(q.receivedAt)}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {q.handledAt ? shortDateTime(q.handledAt) : '—'}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>{q.handledBy ?? '—'}</td>
                    <td>
                      {q.householdId ? (
                        <RowLink href={`/cases`}>opened as a case</RowLink>
                      ) : (
                        <span style={{ color: 'var(--ink-faint)' }}>turned away</span>
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

/**
 * A first guess at the household name, which the operator will usually rewrite.
 *
 * Households are referred to by surname and area throughout — "Okafor — Pasadena" —
 * and the enquiry has a full name and sometimes an area. Guessing the surname from the
 * last word is wrong often enough that this is a default in a text field and not a
 * value anything stores on its own.
 */
function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1]! : full.trim();
}
