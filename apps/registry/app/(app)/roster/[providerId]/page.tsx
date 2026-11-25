import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CareType } from '@h-hallows/core/schema';
import { requireOperator } from '@/lib/operator';
import { asDate, asTimestamp, getProviderWithStanding } from '@/lib/queries/providers';
import { getDb } from '@h-hallows/core/db';
import { AREAS, areaLabel, LABEL, requiredFor } from '@h-hallows/core/domain';
import { civilLA, formatISODate } from '@h-hallows/core/domain';
import {
  recordProviderFactsAction, recordStatedRateAction, setReferralStatusAction,
  upsertCredentialAction,
} from '@/app/(app)/actions';
import {
  AVAILABILITY_BLOCKS, PROVIDER_TYPES, SHIFT_BLOCKS, SHIFT_DAYS,
} from '@/lib/queries/providerEdits';
import { portalUsersFor } from '@/lib/domain/portalAccess';
import { documentsFor } from '@/lib/queries/documents';
import { Documents } from '@/components/Documents';
import { PortalAccess } from '@/components/PortalAccess';
import { ActionForm, Disclose } from '@/components/ActionForm';
import { CredentialVaultFields } from '@/components/CredentialVaultFields';
import {
  Banner, CARE_LABEL, CredentialPill, Eligibility, Empty, Field, formatBlocks, Rate,
  RowLink, Section, shortDate, shortDateTime,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

const ALL_TYPES = [
  'rn_license', 'lvn_license', 'cna_cert', 'hca_registry', 'live_scan', 'tb_clearance',
  'cpr_bls', 'auto_insurance', 'drivers_license', 'immunization', 'other',
] as const;

export default async function ProviderPage({
  params,
}: { params: Promise<{ providerId: string }> }) {
  const { providerId } = await params;
  const { ctx } = await requireOperator();
  const today = new Date();
  // Three independent reads; they were serial.
  const [standing, portalUsers, docs] = await Promise.all([
    getProviderWithStanding(ctx, providerId, today),
    portalUsersFor(ctx, 'provider', providerId),
    documentsFor(ctx, { kind: 'provider', id: providerId }),
  ]);
  if (!standing) notFound();

  const { provider, credentials, eligibility, placements, avgEngagementWeeks } = standing;
  const required = requiredFor(provider);
  const todayISO = formatISODate(civilLA(today));

  const { query } = await getDb();
  const history = await query<{
    case_id: string; display_name: string; care: string; status: string;
    referred_at: string; outcome: string | null; ended_on: string | null;
  }>(
    `SELECT r.case_id, h.display_name, c.care, c.status, r.referred_at, r.outcome, c.ended_on
       FROM referrals r
       JOIN cases c ON c.id = r.case_id
       JOIN households h ON h.id = c.household_id
      WHERE r.provider_id = $1
      ORDER BY r.referred_at DESC`,
    [providerId],
  );
  const renewals = await query<{
    at: string; label: string; actor: string; prev_expires_on: string | null;
    new_expires_on: string | null; note: string | null;
  }>(
    `SELECT e.at, c.type AS label, e.actor, e.prev_expires_on, e.new_expires_on, e.note
       FROM credential_events e JOIN credentials c ON c.id = e.credential_id
      WHERE c.provider_id = $1
      ORDER BY e.at DESC
      LIMIT 40`,
    [providerId],
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {provider.fullName}
            {provider.preferredName ? (
              <span className="ml-2 text-sm font-normal" style={{ color: 'var(--ink-faint)' }}>
                goes by {provider.preferredName}
              </span>
            ) : null}
          </h1>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {provider.type}
            {provider.licenseNumber ? ` · ${provider.licenseNumber}` : ''}
            {' · referred provider'}
          </p>
        </div>
        <Eligibility eligible={eligibility.eligible} reason={eligibility.reason} />
      </div>

      {!eligibility.eligible && provider.status === 'active' ? (
        <Banner tone="alert" title="Excluded from every shortlist">
          {eligibility.reason}. There is no override. Record the credential below and the
          provider becomes eligible immediately.
        </Banner>
      ) : null}

      <Section
        title="Profile"
        right={
          <Link
            href={`/audit?provider=${provider.id}`}
            className="text-xs underline underline-offset-4"
            style={{ color: 'var(--ink-faint)' }}
            title="Everything recorded about this provider, their credentials, their submissions and the referrals they were named in."
          >
            Who has looked at this provider
          </Link>
        }
      >
        <div className="grid gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Phone">{provider.phone ?? '—'}</Field>
          <Field label="Email">{provider.email ?? '—'}</Field>
          <Field label="Rate">
            <Rate hourly={provider.rateHourly} notes={provider.rateNotes} />
          </Field>
          <Field label="Areas">{provider.areas.join(', ') || '—'}</Field>
          <Field label="Travels up to">
            {provider.maxTravelMin ? `${provider.maxTravelMin} min` : '—'}
          </Field>
          <Field label="Transports clients">{provider.transports ? 'Yes' : 'No'}</Field>
          <Field label="Languages">{provider.languages.join(', ') || '—'}</Field>
          <Field label="Specialties">
            {provider.specialties.map((s) => s.replace(/_/g, ' ')).join(', ') || '—'}
          </Field>
          <Field label="Stated restrictions">{provider.restrictions ?? '—'}</Field>
          <Field label="Stated availability" wide>
            <span className="nums">{formatBlocks(provider.availability)}</span>
          </Field>
          {provider.notes ? <Field label="Internal notes" wide>{provider.notes}</Field> : null}
        </div>

        <div className="border-t hair px-4 py-4">
          {/*
            * WHY THIS FORM EXISTS AT ALL. Everything above it was read-only, and six of
            * those fields are the ones `screenCase` reads: the type and whether they
            * drive decide which credentials § 3.3 requires, and the areas and the shifts
            * decide which households the filters will offer them to. `/applications`
            * creates the row and nothing could correct it afterwards, so an admitted
            * provider could be left unreferable with no console path to fix it.
            *
            * Collapsed, like the referral-status write below it, because the record is
            * what this screen is for and the form is what you reach for when the record
            * is wrong.
            */}
          <Disclose summary="Correct these facts — these are the ones the match filters read">
            <ActionForm
              action={recordProviderFactsAction}
              submitLabel="Record these facts"
              confirm={'These are the facts the match filters read. A change can take '
                + 'this provider off every shortlist, including on a case they are '
                + 'standing on — no engagement is ended either way. Continue?'}
            >
              <input type="hidden" name="providerId" value={provider.id} />

              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="label" htmlFor="type">Type</label>
                  <select id="type" name="type" className="select" defaultValue={provider.type}>
                    {PROVIDER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                    Decides which credentials are required and which care types they are
                    referred for.
                  </p>
                </div>
                <div>
                  <label className="label" htmlFor="transports">Drives clients</label>
                  <select id="transports" name="transports" className="select"
                    defaultValue={provider.transports ? 'yes' : 'no'}>
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                  <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                    Yes also requires auto insurance and a driver’s licence on file.
                  </p>
                </div>
                <div>
                  <label className="label" htmlFor="maxTravelMin">Travels up to (minutes)</label>
                  <input id="maxTravelMin" name="maxTravelMin" type="number" min="1" max="240"
                    className="input" defaultValue={provider.maxTravelMin ?? ''} />
                </div>
                <div>
                  <label className="label" htmlFor="preferredName">Goes by</label>
                  <input id="preferredName" name="preferredName" className="input"
                    defaultValue={provider.preferredName ?? ''} autoComplete="off" />
                </div>
                <div>
                  <label className="label" htmlFor="phone">Phone</label>
                  <input id="phone" name="phone" className="input"
                    defaultValue={provider.phone ?? ''} autoComplete="off" />
                </div>
                <div>
                  <label className="label" htmlFor="email">Email</label>
                  <input id="email" name="email" className="input"
                    defaultValue={provider.email ?? ''} autoComplete="off" />
                </div>
              </div>

              {/*
                * EVERY CURRENT VALUE RENDERS TICKED, including one that is not in the
                * vocabulary. The save is a replace, so an area an operator typed —
                * `src/domain/areas.ts` is explicit that recording a household two
                * streets outside the usual patch matters more than a tidy list — would
                * be dropped by a form built from the vocabulary alone. That is the same
                * mistake `standingAlternates` exists to prevent one screen along.
                */}
              <fieldset className="mt-4">
                <legend className="label">Areas they cover</legend>
                <p className="mb-2 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                  Matched against the household’s area by exact text, and the first one
                  ticked is the one the match screen ranks as their own patch.
                </p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                  {areaChoices(provider.areas).map((area) => (
                    <label key={area} className="flex items-start gap-1.5 text-sm">
                      <input type="checkbox" name="areas" value={area} className="mt-0.5"
                        defaultChecked={provider.areas.includes(area)} />
                      <span>{area}</span>
                    </label>
                  ))}
                </div>
                <input name="areas" className="input mt-2"
                  placeholder="Somewhere else — write it as a person would, and separate several with commas"
                  autoComplete="off" />
              </fieldset>

              {/*
                * A closed vocabulary, offered as boxes rather than typed, because
                * `overlap` compares these strings to the case's requested pattern by set
                * membership — so `Mon:am` is not a near miss, it is a value that matches
                * no case for as long as it is on the record. The writer refuses one
                * anyway; this is so the operator never produces one.
                */}
              <fieldset className="mt-4">
                <legend className="label">Shifts they have said they can work</legend>
                <p className="mb-2 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                  AM 07–15, PM 15–23, NOC 23–07. A provider with nothing ticked is
                  offered for no case that states a pattern — and onboarding ticks none.
                </p>
                <div className="scroller">
                  <table>
                    <thead>
                      <tr>
                        <th>Day</th>
                        {SHIFT_BLOCKS.map((b) => <th key={b}>{b}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {SHIFT_DAYS.map((day) => (
                        <tr key={day}>
                          <td className="font-medium">{day}</td>
                          {SHIFT_BLOCKS.map((block) => {
                            const slot = `${day}:${block}`;
                            return (
                              <td key={block}>
                                <label className="flex items-center gap-1.5">
                                  <input type="checkbox" name="availability" value={slot}
                                    defaultChecked={provider.availability.includes(slot)} />
                                  <span className="sr-only">{`${day} ${block}`}</span>
                                </label>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </fieldset>

              <div className="mt-4 grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="languages">Languages</label>
                  <input id="languages" name="languages" className="input"
                    defaultValue={provider.languages.join(', ')} autoComplete="off"
                    placeholder="English, Spanish" />
                  <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                    Separate with commas. Matched against the household’s stated
                    preference, which never excludes anybody.
                  </p>
                </div>
                <div>
                  <label className="label" htmlFor="specialties">Specialties</label>
                  <input id="specialties" name="specialties" className="input"
                    defaultValue={provider.specialties.join(', ')} autoComplete="off"
                    placeholder="post_surgical, wound_care" />
                  <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                    Written the way the needs list writes them, with underscores — the
                    match screen counts the overlap, so a spelling that differs counts
                    as no overlap.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="restrictions">
                    What they have said they will not do — § 1812.5095(b)(2)
                  </label>
                  <input id="restrictions" name="restrictions" className="input"
                    defaultValue={provider.restrictions ?? ''} autoComplete="off" />
                  <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                    Their words, shown to the household beside their name.
                  </p>
                </div>
              </div>
            </ActionForm>
          </Disclose>
        </div>
      </Section>

      <Section
        title="The rate they stated"
        blurb="Their figure, in their words. The registry does not set it, suggest it, cap it or take a share of it — our fee is charged to the household as a percentage of the job."
      >
        <div className="px-4 py-4">
          <Field label="On the record">
            <Rate hourly={provider.rateHourly} notes={provider.rateNotes} />
          </Field>

          {/*
            * I5, § 1812.5095(b)(3), § 1812.530 and § 1812.531. No default, no range, no
            * suggestion, no cap — every one of those would be this registry setting a
            * rate it has no business setting, and § 1812.530 and § 1812.531 are the
            * reason it has none: it may not charge a nurse anything and may not take a
            * share of what she charges. The provider's own screen at `/pro/rate` writes
            * the same column from their own session. This is here because most of the
            * roster has no portal account and states a rate down a telephone, and the
            * confirmation is what keeps a transcription from reading, afterwards, like
            * the registry's own figure.
            */}
          <div className="mt-4">
            <Disclose summary="Record what they said">
              <ActionForm
                action={recordStatedRateAction}
                submitLabel="Record the stated rate"
                confirm={'Record this as the rate the provider stated? It is shown to '
                  + 'households beside their name and stays negotiable with them. '
                  + 'Continue?'}
              >
                <input type="hidden" name="providerId" value={provider.id} />
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
                  <div>
                    <label className="label" htmlFor="rateHourly">Their hourly rate</label>
                    <input id="rateHourly" name="rateHourly" type="text" inputMode="decimal"
                      className="input nums" defaultValue={provider.rateHourly ?? ''}
                      autoComplete="off" />
                    <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                      Leave it empty if they would rather talk about it. That is a normal
                      answer and we say so when they are put forward.
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor="rateNotes">
                      Anything they want said alongside it
                    </label>
                    <input id="rateNotes" name="rateNotes" className="input"
                      defaultValue={provider.rateNotes ?? ''} autoComplete="off"
                      placeholder="Overnights are different — happy to discuss." />
                  </div>
                </div>
                {/* Un-prechecked, like the § 1812.5095(f) confirmation on the referral,
                    and for the same reason: it asserts something that happened outside
                    the software, so it has to be made rather than assumed. */}
                <label className="mt-3 flex items-start gap-2 text-sm">
                  <input type="checkbox" name="stated" value="yes" required className="mt-0.5" />
                  <span>
                    The provider stated this figure. Nothing in this registry set it,
                    suggested it or takes a share of it.
                  </span>
                </label>
              </ActionForm>
            </Disclose>
          </div>
        </div>
      </Section>

      <Section
        id="vault"
        title="Credential vault"
        blurb="Required credentials for this provider type, plus anything else on file. Adding or renewing one takes a single form."
      >
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>Credential</th><th>State</th><th>Expires</th><th>Verified</th>
                <th>Source</th><th>Identifier</th>
              </tr>
            </thead>
            <tbody>
              {required.map((type) => {
                const held = credentials.find((c) => c.type === type);
                return (
                  <tr key={type}>
                    <td>
                      <span className="font-medium">{LABEL[type]}</span>
                      <span className="ml-1.5 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                        required
                      </span>
                    </td>
                    <td>
                      {held
                        ? <CredentialPill status={held.status} />
                        : <CredentialPill status="expired" label="Never recorded" />}
                    </td>
                    <td className="nums" style={{ color: 'var(--ink-soft)' }}>
                      {held ? shortDate(held.expiresOn) : '—'}
                    </td>
                    <td className="nums" style={{ color: 'var(--ink-soft)' }}>
                      {held ? shortDate(held.verifiedOn) : '—'}
                      {held?.needsReverify ? (
                        <span className="ml-1.5 text-[0.6875rem]" style={{ color: 'var(--color-soon)' }}>
                          re-verify
                        </span>
                      ) : null}
                    </td>
                    <td style={{ color: 'var(--ink-faint)' }}>{held?.verificationSource ?? '—'}</td>
                    <td style={{ color: 'var(--ink-faint)' }}>{held?.identifier ?? '—'}</td>
                  </tr>
                );
              })}
              {credentials.filter((c) => !required.includes(c.type)).map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td><CredentialPill status={c.status} /></td>
                  <td className="nums" style={{ color: 'var(--ink-soft)' }}>{shortDate(c.expiresOn)}</td>
                  <td className="nums" style={{ color: 'var(--ink-soft)' }}>{shortDate(c.verifiedOn)}</td>
                  <td style={{ color: 'var(--ink-faint)' }}>{c.verificationSource}</td>
                  <td style={{ color: 'var(--ink-faint)' }}>{c.identifier ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t hair px-4 py-4">
          <ActionForm
            action={upsertCredentialAction}
            submitLabel="Record credential"
            primary
            resetOnSuccess
          >
            <input type="hidden" name="providerId" value={provider.id} />
            <CredentialVaultFields
              allTypes={ALL_TYPES}
              required={required}
              defaultType={eligibility.blocking[0] ?? required[0]!}
              todayISO={todayISO}
            />
          </ActionForm>
        </div>
      </Section>

      <Section title="Registry paperwork" blurb="What § 1812.5095 requires on file for a referred provider.">
        <div className="grid gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Referral agreement signed — (b)(1)">
            {dateOrGap(provider.agreementSignedOn)}
          </Field>
          <Field label="Written notice acknowledged — (d)">
            {dateOrGap(provider.writtenNoticeAckOn)}
          </Field>
          <Field label="Work authorisation verified — (e)">
            {dateOrGap(provider.workAuthVerifiedOn)}
          </Field>
          <Field label="Orientation — voluntary, administrative only">
            {provider.orientationOn ? shortDate(provider.orientationOn) : 'Not recorded'}
          </Field>
        </div>
        <p className="border-t hair px-4 py-3 text-[0.6875rem] leading-relaxed"
          style={{ color: 'var(--ink-faint)' }}>
          The orientation record covers administrative procedures and the referral
          agreement only. There is no instructional content anywhere in this system.
        </p>
      </Section>

      <Section
        title="Placement history"
        blurb={`${placements} engagement${placements === 1 ? '' : 's'}${
          avgEngagementWeeks ? ` · ${avgEngagementWeeks} weeks on average` : ''
        }`}
      >
        {history.length === 0 ? (
          <Empty>No referral has been recorded for this provider.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr><th>Household</th><th>Care</th><th>Referred</th><th>Outcome</th><th>Case status</th></tr>
              </thead>
              <tbody>
                {history.map((r, i) => (
                  <tr key={`${r.case_id}-${i}`}>
                    <td><RowLink href={`/cases/${r.case_id}`}>{r.display_name}</RowLink></td>
                    <td style={{ color: 'var(--ink-soft)' }}>{CARE_LABEL[r.care as CareType] ?? r.care}</td>
                    <td className="nums" style={{ color: 'var(--ink-faint)' }}>
                      {shortDateTime(asTimestamp(r.referred_at))}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {r.outcome ? r.outcome.replace(/_/g, ' ') : 'no outcome recorded'}
                    </td>
                    <td style={{ color: 'var(--ink-faint)' }}>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Credential history" blurb="Append-only. Renewals cannot be rewritten or removed.">
        {renewals.length === 0 ? (
          <Empty>No credential events recorded.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr><th>When</th><th>Credential</th><th>Expiry change</th><th>By</th><th>Note</th></tr>
              </thead>
              <tbody>
                {renewals.map((e, i) => (
                  <tr key={i}>
                    <td className="nums" style={{ color: 'var(--ink-faint)' }}>
                      {shortDateTime(asTimestamp(e.at))}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {LABEL[e.label as keyof typeof LABEL] ?? e.label}
                    </td>
                    <td className="nums" style={{ color: 'var(--ink-soft)' }}>
                      {shortDate(asDate(e.prev_expires_on))}
                      {' → '}
                      {shortDate(asDate(e.new_expires_on))}
                    </td>
                    <td style={{ color: 'var(--ink-faint)' }}>{e.actor}</td>
                    <td style={{ color: 'var(--ink-faint)' }}>{e.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Documents on file"
        blurb="The paperwork § 1812.5095 expects to exist. A signed-on date with nothing behind it cannot produce what was signed."
      >
        <Documents
          subject={{ kind: 'provider', id: providerId }}
          documents={docs}
          defaultKind="registry_agreement"
          shareLabel="them"
        />
      </Section>

      <Section
        title="Their own screen"
        blurb="Where this provider hands in a renewed document, states what they are available for, and sees what they have been put forward for. Nothing they enter there becomes a credential until it is checked here."
      >
        <PortalAccess
          kind="provider"
          subjectId={providerId}
          users={portalUsers}
          defaultName={provider.fullName}
        />
      </Section>

      <Section
        title="Referral status"
        blurb="The registry's only lever is whether it refers this provider in future. It cannot end an engagement a household has already made."
      >
        <div className="px-4 py-4">
          <Disclose summary={`Change referral status — currently ${provider.status.replace(/_/g, ' ')}`}>
            <ActionForm
              action={setReferralStatusAction}
              submitLabel="Update referral status"
              confirm="This changes future referrals only. It does not end any engagement. Continue?"
            >
              <input type="hidden" name="providerId" value={provider.id} />
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="status">Status</label>
                  <select id="status" name="status" className="select" defaultValue={provider.status}>
                    <option value="active">Active — refer as normal</option>
                    <option value="inactive">Inactive — not currently available</option>
                    <option value="do_not_refer">Do not refer — forward-only stop</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="note">Why</label>
                  <input id="note" name="note" className="input" required
                    placeholder="Recorded on the provider's internal notes" />
                </div>
              </div>
            </ActionForm>
          </Disclose>
        </div>
      </Section>
    </>
  );
}

/**
 * The boxes to offer for areas: the vocabulary, then anything this provider already has
 * that is not in it.
 *
 * The second half is the part that matters. `providers.areas` is free text on purpose,
 * the save is a replace, and a form offering only the canonical nine would render an
 * operator-typed area unticked — so saving the form would quietly stop serving a
 * household two streets outside the usual patch.
 */
function areaChoices(current: readonly string[]): string[] {
  return [...new Set([
    ...AREAS.filter((slug) => slug !== 'other').map((slug) => areaLabel(slug)),
    ...current,
  ])];
}

function dateOrGap(iso: string | null) {
  if (iso) return <span className="nums">{shortDate(iso)}</span>;
  return <span style={{ color: 'var(--color-expired)' }}>Not on file</span>;
}
