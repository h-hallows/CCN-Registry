import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { EndReasonValue } from '@ccn/core/schema';
import { requireOperator } from '@/lib/operator';
import { getCase } from '@/lib/queries/cases';
import { getProviderWithStanding } from '@/lib/queries/providers';
import { dueWording, URGENCY_LABEL } from '@/lib/domain/buckets';
import { civilLA, formatISODate } from '@ccn/core/domain';
import { SKILLED_CARE_TYPES } from '@/lib/domain/referral';
import {
  addNoteAction, endEngagementAction, logCallAction, markWrittenSentAction,
} from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import { CopyBox } from '@/components/CopyBox';
import {
  Banner, CARE_LABEL, Eligibility, Empty, END_REASON_LABEL, Field, formatBlocks, Rate,
  RowLink, Section, shortDate, shortDateTime, STATUS_LABEL,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

const END_REASONS = Object.keys(END_REASON_LABEL) as EndReasonValue[];

export default async function CasePage({
  params,
}: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const { ctx } = await requireOperator();
  const now = new Date();
  const found = await getCase(ctx, caseId);
  if (!found) notFound();

  const { kase, timeline, referrals } = found;
  const h = kase.household;
  const todayISO = formatISODate(civilLA(now));

  const isSkilled = (SKILLED_CARE_TYPES as readonly string[]).includes(kase.care);
  const physicianMissing = isSkilled && !h.physicianName?.trim();

  const primary = kase.primaryProviderId
    ? await getProviderWithStanding(ctx, kase.primaryProviderId, now)
    : null;
  const alternates = await Promise.all(
    kase.alternateProviderIds.map((id) => getProviderWithStanding(ctx, id, now)),
  );
  const eligibleAlternates = alternates.filter((a) => a?.eligibility.eligible).length;

  const dmLocal = h.dmTimezone
    ? now.toLocaleString('en-GB', {
        timeZone: h.dmTimezone, hour: '2-digit', minute: '2-digit', weekday: 'short',
      })
    : null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{h.displayName}</h1>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {CARE_LABEL[kase.care] ?? kase.care} · {STATUS_LABEL[kase.status]} ·{' '}
            {URGENCY_LABEL[kase.urgency]} · opened {shortDate(kase.createdAt.slice(0, 10))}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/match/${kase.id}`} className="btn btn-primary">Build a shortlist</Link>
        </div>
      </div>

      {physicianMissing ? (
        <Banner tone="alert" title="No ordering physician on the household record">
          This is a skilled case. Under Civil Code § 1812.524 it cannot reach referred
          status until an ordering physician is recorded. The database refuses the status
          change, so this is not advisory.
        </Banner>
      ) : null}

      {kase.status !== 'ended' && (kase.status === 'active' || kase.status === 'referred')
        && eligibleAlternates < 2 ? (
        <Banner tone="note" title="Thin bench">
          {eligibleAlternates === 0
            ? 'No eligible alternate is recorded for this case.'
            : 'One eligible alternate is recorded for this case.'}
          {' '}Two is the target. One illness away from a service failure.
        </Banner>
      ) : null}

      <Section title="Household">
        <div className="grid gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Person engaging care">
            {h.dmName}
            {h.dmRelationship ? (
              <span style={{ color: 'var(--ink-faint)' }}> · {h.dmRelationship}</span>
            ) : null}
          </Field>
          <Field label="Their phone">{h.dmPhone ?? '—'}</Field>
          <Field label="Their email">{h.dmEmail ?? '—'}</Field>
          <Field label="Where they are">
            {h.dmLocation ?? '—'}
            {dmLocal ? (
              <span className="nums block text-xs" style={{ color: 'var(--color-upcoming)' }}>
                their local time now: {dmLocal}
              </span>
            ) : null}
          </Field>
          <Field label="Care recipient">
            {h.crName ?? '—'}{h.crAge ? `, ${h.crAge}` : ''}
          </Field>
          <Field label="Area">{h.crArea}</Field>
          <Field label="Address">{h.crAddress ?? '—'}</Field>
          <Field label="Access notes">{h.crAccessNotes ?? '—'}</Field>
          <Field label="NDA on file">{h.ndaOnFile ? 'Yes' : 'No'}</Field>
          <Field label="Source">{h.source ?? '—'}</Field>
          <Field label="Payment">
            {h.paymentMethod === 'ltc_policy'
              ? `Long-term care policy — ${h.ltcCarrier ?? 'carrier not recorded'}${
                  h.ltcPolicyNumber ? ` · ${h.ltcPolicyNumber}` : ''}`
              : h.paymentMethod === 'va' ? 'VA'
              : h.paymentMethod === 'private' ? 'Private pay' : 'Other'}
          </Field>
          <Field label="Physician of record">
            {h.physicianName ? (
              <>
                {h.physicianName}
                <span className="block text-xs" style={{ color: 'var(--ink-faint)' }}>
                  {[h.physicianPractice, h.physicianPhone, h.physicianFax && `fax ${h.physicianFax}`]
                    .filter(Boolean).join(' · ')}
                </span>
              </>
            ) : (
              <span style={{ color: physicianMissing ? 'var(--color-expired)' : 'var(--ink-faint)' }}>
                Not recorded
              </span>
            )}
          </Field>
        </div>
      </Section>

      <Section title="Engagement terms">
        <div className="grid gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Requested pattern" wide>
            <span className="nums">{formatBlocks(kase.schedule)}</span>
          </Field>
          <Field label="Hours per week">{kase.hoursPerWeek ?? '—'}</Field>
          <Field label="Starts">{shortDate(kase.startsOn)}</Field>
          <Field label="Ends">{shortDate(kase.endsOn)}</Field>
          <Field label="Rate agreed">
            <Rate hourly={kase.rateAgreed} notes="Agreed between the household and the provider." />
          </Field>
          <Field label="Referral fee">
            {kase.feePct ? (
              <>
                <span className="nums">{Number(kase.feePct).toFixed(1)}%</span> of job cost
                <span className="block text-xs" style={{ color: 'var(--ink-faint)' }}>
                  charged to the household
                </span>
              </>
            ) : '—'}
          </Field>
          <Field label="Rate band discussed">
            {kase.rateBandLow && kase.rateBandHigh ? (
              <span className="nums">
                ${Number(kase.rateBandLow).toFixed(0)}–${Number(kase.rateBandHigh).toFixed(0)}/hr
              </span>
            ) : '—'}
          </Field>
          <Field label="Language preference">{kase.languagePref ?? 'None stated'}</Field>
          <Field label="Stated needs">
            {kase.adlNeeds.map((a) => a.replace(/_/g, ' ')).join(', ') || '—'}
          </Field>
        </div>
      </Section>

      <Section
        title="Needs, in the household's own words"
        blurb="Recorded as stated. The system does not generate, suggest or template clinical content."
      >
        <p className="whitespace-pre-wrap px-4 py-4 text-sm leading-relaxed">
          {kase.needsProfile ?? 'Not yet recorded.'}
        </p>
      </Section>

      {kase.householdProfile ? (
        <Section
          title="Household profile"
          blurb="Routine, access and preferences. This is what travels to a substitute."
        >
          <div className="px-4 py-4">
            <CopyBox label="Copy for a substitute" text={kase.householdProfile} />
          </div>
        </Section>
      ) : null}

      <Section
        title="Cover"
        blurb={`Primary and alternates. ${eligibleAlternates} of 2 alternates currently eligible.`}
      >
        <div className="scroller">
          <table>
            <thead>
              <tr><th>Role</th><th>Provider</th><th>Type</th><th>Rate</th><th>Standing</th></tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ color: 'var(--ink-faint)' }}>Primary</td>
                <td>
                  {primary
                    ? <RowLink href={`/roster/${primary.provider.id}`}>{primary.provider.fullName}</RowLink>
                    : <span style={{ color: 'var(--ink-faint)' }}>None referred</span>}
                </td>
                <td style={{ color: 'var(--ink-soft)' }}>{primary?.provider.type ?? '—'}</td>
                <td>{primary ? <Rate hourly={primary.provider.rateHourly} /> : '—'}</td>
                <td>
                  {primary ? (
                    <Eligibility
                      eligible={primary.eligibility.eligible}
                      reason={primary.eligibility.reason}
                    />
                  ) : '—'}
                </td>
              </tr>
              {alternates.map((a, i) => (
                <tr key={a?.provider.id ?? i}>
                  <td style={{ color: 'var(--ink-faint)' }}>Alternate</td>
                  <td>
                    {a ? <RowLink href={`/roster/${a.provider.id}`}>{a.provider.fullName}</RowLink> : '—'}
                  </td>
                  <td style={{ color: 'var(--ink-soft)' }}>{a?.provider.type ?? '—'}</td>
                  <td>{a ? <Rate hourly={a.provider.rateHourly} /> : '—'}</td>
                  <td>
                    {a ? <Eligibility eligible={a.eligibility.eligible} reason={a.eligibility.reason} /> : '—'}
                  </td>
                </tr>
              ))}
              {alternates.length === 0 ? (
                <tr>
                  <td style={{ color: 'var(--ink-faint)' }}>Alternate</td>
                  <td colSpan={4} style={{ color: 'var(--color-critical)' }}>
                    None recorded. <RowLink href={`/match/${kase.id}`}>Build a shortlist</RowLink>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        id="disclosures"
        title="Referrals and disclosures"
        blurb="Every referral carries the spoken disclosure it was made under. These records are permanent."
      >
        {referrals.length === 0 ? (
          <Empty>No referral has been recorded for this case.</Empty>
        ) : (
          <div className="divide-y hair-soft">
            {referrals.map((r) => (
              <div key={r.id} className="px-4 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <RowLink href={`/roster/${r.providerId}`}>{r.providerName}</RowLink>
                    <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                      referred {shortDateTime(r.referredAt)} by {r.referredBy}
                      {r.outcome ? ` · ${r.outcome.replace(/_/g, ' ')}` : ' · no outcome recorded'}
                    </span>
                  </div>
                  <span className="nums text-xs" style={{
                    color: r.writtenSentOn ? 'var(--color-ok)' : 'var(--color-critical)',
                  }}>
                    {r.writtenSentOn
                      ? `written statement sent ${shortDate(r.writtenSentOn)}`
                      : `written statement ${dueWording(r.writtenDueOn, now)}`}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
                  Spoken disclosure given to <strong>{r.disclosedTo}</strong> by{' '}
                  {r.method === 'phone' ? 'phone' : 'in person'} on {shortDateTime(r.disclosedAt)}.
                  Written statement due {shortDate(r.writtenDueOn)} — three California
                  business days, per § 1812.5095(f).
                </p>

                {!r.writtenSentOn ? (
                  <div className="mt-3">
                    <ActionForm action={markWrittenSentAction} submitLabel="Record as sent">
                      <input type="hidden" name="disclosureId" value={r.disclosureId} />
                      <input type="hidden" name="caseId" value={kase.id} />
                      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div>
                          <label className="label" htmlFor={`sentOn-${r.id}`}>Sent on</label>
                          <input id={`sentOn-${r.id}`} name="sentOn" type="date" className="input"
                            required defaultValue={todayISO} />
                        </div>
                        <div>
                          <label className="label" htmlFor={`method-${r.id}`}>How</label>
                          <input id={`method-${r.id}`} name="method" className="input" required
                            placeholder="post, email, both" />
                        </div>
                      </div>
                    </ActionForm>
                  </div>
                ) : (
                  <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                    Sent by {r.writtenMethod ?? 'method not recorded'}.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Timeline" blurb="Append-only. Entries cannot be edited or removed, by anyone.">
        <div className="border-b hair px-4 py-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <ActionForm action={logCallAction} submitLabel="Log call" primary resetOnSuccess>
              <input type="hidden" name="caseId" value={kase.id} />
              <label className="label" htmlFor="call-body">Log a call</label>
              <textarea id="call-body" name="body" className="textarea" rows={3} required
                placeholder="Who you spoke to and what was agreed." />
            </ActionForm>
            <ActionForm action={addNoteAction} submitLabel="Add note" resetOnSuccess>
              <input type="hidden" name="caseId" value={kase.id} />
              <label className="label" htmlFor="note-body">Add a note</label>
              <textarea id="note-body" name="body" className="textarea" rows={3} required
                placeholder="Anything else worth the record." />
            </ActionForm>
          </div>
        </div>
        {timeline.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <ol className="divide-y hair-soft">
            {timeline.map((t) => (
              <li key={t.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--ink-faint)' }}>
                    {t.type.replace(/_/g, ' ')}
                  </span>
                  <span className="nums text-xs" style={{ color: 'var(--ink-faint)' }}>
                    {shortDateTime(t.at)}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>{t.author}</span>
                  {t.providerName ? (
                    <RowLink href={`/roster/${t.providerId}`}>{t.providerName}</RowLink>
                  ) : null}
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed">{t.body}</p>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {kase.status === 'ended' ? (
        <Section title="Engagement ended">
          <div className="grid gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Ended on">{shortDate(kase.endedOn)}</Field>
            <Field label="Ended by">{kase.endedBy ?? '—'}</Field>
            <Field label="Reason">
              {kase.endReason ? END_REASON_LABEL[kase.endReason] ?? kase.endReason : '—'}
            </Field>
            {kase.endReasonNote ? <Field label="Note" wide>{kase.endReasonNote}</Field> : null}
          </div>
        </Section>
      ) : (
        <Section
          title="Record the end of an engagement"
          blurb="Only the household ending it, the provider declining, or a mutual end. The registry cannot end a household–provider relationship."
        >
          <div className="px-4 py-4">
            <Disclose summary="Record that this engagement has ended" tone="quiet">
              <ActionForm
                action={endEngagementAction}
                submitLabel="Record the end"
                confirm="This records that the engagement ended. It cannot be undone from the timeline, which is append-only. Continue?"
              >
                <input type="hidden" name="caseId" value={kase.id} />
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className="label" htmlFor="endedOn">Ended on</label>
                    <input id="endedOn" name="endedOn" type="date" className="input" required
                      defaultValue={todayISO} />
                  </div>
                  <div>
                    <label className="label" htmlFor="endedBy">Ended by</label>
                    <select id="endedBy" name="endedBy" className="select" required>
                      <option value="household">The household</option>
                      <option value="provider">The provider declined</option>
                      <option value="mutual">Mutual</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor="endReason">Reason</label>
                    <select id="endReason" name="endReason" className="select" required>
                      {END_REASONS.map((r) => (
                        <option key={r} value={r}>{END_REASON_LABEL[r]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-4">
                    <label className="label" htmlFor="end-note">Note</label>
                    <input id="end-note" name="note" className="input" placeholder="Optional" />
                  </div>
                </div>
                <p className="mt-2 text-[0.6875rem] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                  The reason is required and comes from a fixed list. It is the only
                  measure of whether households are moving to direct arrangements.
                </p>
              </ActionForm>
            </Disclose>
          </div>
        </Section>
      )}
    </>
  );
}
