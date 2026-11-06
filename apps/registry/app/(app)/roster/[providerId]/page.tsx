import { notFound } from 'next/navigation';
import type { CareType } from '@h-hallows/core/schema';
import { requireOperator } from '@/lib/operator';
import { asDate, asTimestamp, getProviderWithStanding } from '@/lib/queries/providers';
import { getDb } from '@h-hallows/core/db';
import { LABEL, requiredFor } from '@h-hallows/core/domain';
import { civilLA, formatISODate } from '@h-hallows/core/domain';
import { setReferralStatusAction, upsertCredentialAction } from '@/app/(app)/actions';
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

      <Section title="Profile">
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

function dateOrGap(iso: string | null) {
  if (iso) return <span className="nums">{shortDate(iso)}</span>;
  return <span style={{ color: 'var(--color-expired)' }}>Not on file</span>;
}
