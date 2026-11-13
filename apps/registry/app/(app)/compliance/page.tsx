import Link from 'next/link';
import { requireOperator } from '@/lib/operator';
import { getCompliance } from '@/lib/queries/compliance';
import {
  earliestEffectiveFrom, feeScheduleHistory, nurseDeliveries,
} from '@/lib/queries/feeSchedule';
import { postFeeScheduleAction, recordFeeDeliveryAction } from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import { Banner } from '@/components/ui';
import { civilLA, formatISODate, LABEL, REVERIFY_AFTER_DAYS } from '@h-hallows/core/domain';
import { dueWording } from '@/lib/domain/buckets';
import {
  CredentialPill, Empty, RowLink, Section, shortDate, shortDateTime,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function CompliancePage() {
  const { ctx } = await requireOperator();
  const now = new Date();
  const [c, schedules, nurses] = await Promise.all([
    getCompliance(ctx, now),
    feeScheduleHistory(ctx),
    nurseDeliveries(ctx),
  ]);
  const inForce = schedules.find((s) => s.inForce) ?? null;
  const missing = nurses.filter((n) => n.missingCurrent && n.status !== 'do_not_refer');
  const earliest = earliestEffectiveFrom(now);
  const todayISO = formatISODate(civilLA(now));
  const late = c.disclosureLog.filter((d) => d.onTime === false).length;
  const outstanding = c.disclosureLog.filter((d) => d.onTime === null).length;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Compliance</h1>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {c.rosterStanding.eligible} of {c.rosterStanding.total} referred providers eligible ·{' '}
            {c.credentialQueue.length} credential item{c.credentialQueue.length === 1 ? '' : 's'} ·{' '}
            {outstanding} written statement{outstanding === 1 ? '' : 's'} outstanding
            {late > 0 ? ` · ${late} sent late` : ''}
          </p>
        </div>
        <Link href="/api/export/disclosures" className="btn btn-primary" prefetch={false}>
          Export disclosure log (CSV)
        </Link>
      </div>

      <Section
        title="Credential queue"
        blurb="Required credentials that are expired, missing, or expiring within ninety days. Renew from the provider's vault."
      >
        {c.credentialQueue.length === 0 ? (
          <Empty>No required credential needs attention.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Provider</th><th>Type</th><th>Credential</th><th>State</th>
                  <th>Expires</th><th /></tr>
              </thead>
              <tbody>
                {c.credentialQueue.map((r, i) => (
                  <tr key={`${r.providerId}-${r.type}-${i}`}>
                    <td><RowLink href={`/roster/${r.providerId}`}>{r.providerName}</RowLink></td>
                    <td style={{ color: 'var(--ink-faint)' }}>{r.providerType}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>{LABEL[r.type] ?? r.type}</td>
                    <td>
                      <CredentialPill
                        status={r.status}
                        label={r.credentialId === null ? 'Never recorded' : undefined}
                      />
                    </td>
                    <td className="nums" style={{ color: 'var(--ink-soft)' }}>
                      {r.expiresOn ? shortDate(r.expiresOn) : '—'}
                    </td>
                    <td className="text-right">
                      <RowLink href={`/roster/${r.providerId}#vault`}>
                        {r.credentialId === null ? 'Record' : 'Renew'}
                      </RowLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Re-verification queue"
        blurb={`Credentials last verified more than ${REVERIFY_AFTER_DAYS} days ago. The credential may still be current; the verification is stale.`}
      >
        {c.reverifyQueue.length === 0 ? (
          <Empty>Every credential has been verified within the last {REVERIFY_AFTER_DAYS} days.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr><th>Provider</th><th>Credential</th><th>Last verified</th><th>Source used</th><th /></tr>
              </thead>
              <tbody>
                {c.reverifyQueue.map((r) => (
                  <tr key={r.credentialId}>
                    <td><RowLink href={`/roster/${r.providerId}`}>{r.providerName}</RowLink></td>
                    <td style={{ color: 'var(--ink-soft)' }}>{r.label}</td>
                    <td className="nums" style={{ color: 'var(--color-soon)' }}>
                      {shortDate(r.verifiedOn)}
                    </td>
                    <td style={{ color: 'var(--ink-faint)' }}>{r.verificationSource}</td>
                    <td className="text-right">
                      <RowLink href={`/roster/${r.providerId}#vault`}>Re-verify</RowLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Disclosure log"
        blurb="Every spoken disclosure, and whether its written statement went out within three California business days. § 1812.5095(f)."
      >
        {c.disclosureLog.length === 0 ? (
          <Empty>No disclosure recorded.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Household</th><th>Providers referred</th><th>Disclosed to</th>
                  <th>By</th><th>How</th><th>When</th><th>Written due</th><th>Written sent</th>
                </tr>
              </thead>
              <tbody>
                {c.disclosureLog.map((d) => (
                  <tr key={d.disclosureId}>
                    <td><RowLink href={`/cases/${d.caseId}`}>{d.householdName}</RowLink></td>
                    <td style={{ color: 'var(--ink-soft)' }}>{d.providerNames.join(', ') || '—'}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>{d.disclosedTo}</td>
                    <td style={{ color: 'var(--ink-faint)' }}>{d.disclosedBy}</td>
                    <td style={{ color: 'var(--ink-faint)' }}>
                      {d.method === 'phone' ? 'phone' : 'in person'}
                    </td>
                    <td className="nums" style={{ color: 'var(--ink-faint)' }}>
                      {shortDateTime(d.disclosedAt)}
                    </td>
                    <td className="nums" style={{ color: 'var(--ink-soft)' }}>
                      {shortDate(d.writtenDueOn)}
                    </td>
                    <td className="nums" style={{
                      color: d.onTime === null ? 'var(--color-critical)'
                        : d.onTime ? 'var(--color-ok)' : 'var(--color-expired)',
                    }}>
                      {d.writtenSentOn
                        ? `${shortDate(d.writtenSentOn)}${d.onTime ? '' : ' — late'}`
                        : dueWording(d.writtenDueOn, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Provider paperwork gaps"
        blurb="What § 1812.5095 requires on file for each referred provider: the referral agreement, the written notice acknowledgement, and work authorisation."
      >
        {c.paperworkGaps.length === 0 ? (
          <Empty>Every referred provider has complete registry paperwork on file.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead><tr><th>Provider</th><th>Missing</th></tr></thead>
              <tbody>
                {c.paperworkGaps.map((g) => (
                  <tr key={g.providerId}>
                    <td><RowLink href={`/roster/${g.providerId}`}>{g.providerName}</RowLink></td>
                    <td style={{ color: 'var(--color-critical)' }}>{g.gaps.join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Roster standing">
        <div className="scroller">
          <table>
            <thead><tr><th>Type</th><th>On the roster</th><th>Eligible</th><th>Blocked</th></tr></thead>
            <tbody>
              {c.rosterStanding.byType.map((t) => (
                <tr key={t.type}>
                  <td>{t.type}</td>
                  <td className="nums" style={{ color: 'var(--ink-soft)' }}>{t.total}</td>
                  <td className="nums" style={{ color: 'var(--color-ok)' }}>{t.eligible}</td>
                  <td className="nums" style={{
                    color: t.total - t.eligible > 0 ? 'var(--color-expired)' : 'var(--ink-faint)',
                  }}>
                    {t.total - t.eligible}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="font-semibold">All</td>
                <td className="nums font-semibold">{c.rosterStanding.total}</td>
                <td className="nums font-semibold" style={{ color: 'var(--color-ok)' }}>
                  {c.rosterStanding.eligible}
                </td>
                <td className="nums font-semibold" style={{ color: 'var(--color-expired)' }}>
                  {c.rosterStanding.ineligible}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="border-t hair px-4 py-3 text-[0.6875rem] leading-relaxed"
          style={{ color: 'var(--ink-faint)' }}>
          {c.rosterStanding.inactive} marked inactive · {c.rosterStanding.doNotRefer} not
          being referred. Neither state ends an engagement a household has already made.
        </p>
      </Section>

      {/*
        * § 1812.527. Two obligations, and the second is the one that is auditable per
        * person: post a schedule, and give it to each nurse BEFORE the interview.
        * Neither could be met at all until this screen existed — the provider portal
        * read these tables and nothing wrote them.
        */}
      <Section
        title="Fee schedule — § 1812.527"
        blurb="A nurses' registry posts its schedule and gives it to each nurse before the interview. A change needs seven days' notice, which the database refuses to store without."
      >
        <div className="divide-y hair-soft">
          <div className="px-4 py-4">
            {!inForce ? (
              <Banner tone="alert" title="No fee schedule is in force">
                Nothing has been posted, so there is nothing to give a nurse and
                nothing on their own screen. § 1812.527 expects a posted schedule.
              </Banner>
            ) : (
              <>
                <p className="text-sm">
                  <strong>Version {inForce.version}</strong> &middot;{' '}
                  <span className="nums">{inForce.maxFeePct}%</span> maximum, covering
                  all charges &middot; {inForce.paymentTerms}
                </p>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  posted {shortDate(inForce.postedOn)} · in force since{' '}
                  {shortDate(inForce.effectiveFrom)} · recorded as given to{' '}
                  <span className="nums">{inForce.deliveredTo}</span>
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm"
                  style={{ color: 'var(--ink-soft)' }}>
                  {inForce.body}
                </p>
              </>
            )}
          </div>

          <div className="px-4 py-4">
            <h3 className="label mb-2">
              Nurses on the roster — {missing.length} without the current version
            </h3>
            {nurses.length === 0 ? (
              <Empty>No RN or LVN is on the roster, so § 1812.527 has nobody to reach.</Empty>
            ) : (
              <div className="scroller">
                <table>
                  <thead>
                    <tr>
                      <th>Nurse</th><th>Type</th><th>Standing</th>
                      <th>Given</th><th>Before the interview</th><th>Record</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nurses.map((n) => (
                      <tr key={n.providerId}>
                        <td><RowLink href={`/roster/${n.providerId}`}>{n.fullName}</RowLink></td>
                        <td style={{ color: 'var(--ink-soft)' }}>{n.type}</td>
                        <td style={{ color: 'var(--ink-soft)' }}>
                          {n.status.replace(/_/g, ' ')}
                        </td>
                        <td style={{
                          color: n.missingCurrent ? 'var(--color-critical)' : 'var(--ink-soft)',
                        }}>
                          {n.deliveredVersion === null
                            ? 'never'
                            : `v${n.deliveredVersion}, ${shortDate(n.deliveredOn!)}`}
                        </td>
                        <td style={{
                          color: n.beforeInterview === false
                            ? 'var(--color-expired)' : 'var(--ink-soft)',
                        }}>
                          {n.beforeInterview === null
                            ? '—' : n.beforeInterview ? 'yes' : 'no'}
                        </td>
                        <td>
                          {inForce && n.missingCurrent ? (
                            <Disclose summary="Record it" tone="quiet">
                              <ActionForm
                                action={recordFeeDeliveryAction}
                                submitLabel="Record"
                              >
                                <input type="hidden" name="providerId" value={n.providerId} />
                                <input type="hidden" name="scheduleId" value={inForce.id} />
                                <label className="label" htmlFor={`on-${n.providerId}`}>
                                  Given on
                                </label>
                                <input id={`on-${n.providerId}`} name="deliveredOn"
                                  type="date" className="input" required
                                  defaultValue={todayISO} />
                                <label className="label mt-2" htmlFor={`bi-${n.providerId}`}>
                                  Before their interview
                                </label>
                                <select id={`bi-${n.providerId}`} name="beforeInterview"
                                  className="select" required defaultValue="yes">
                                  <option value="yes">Yes</option>
                                  <option value="no">No — it was afterwards</option>
                                </select>
                                <p className="mt-2 text-[0.6875rem] leading-relaxed"
                                  style={{ color: 'var(--ink-faint)' }}>
                                  Answer honestly. A record that only ever says yes is
                                  a record of nothing; the statute asks for before, and
                                  an after is the evidence of a gap.
                                </p>
                              </ActionForm>
                            </Disclose>
                          ) : (
                            <span style={{ color: 'var(--ink-faint)' }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {schedules.length > 1 ? (
            <div className="px-4 py-3">
              <Disclose summary={`${schedules.length} versions posted`} tone="quiet">
                <ul className="space-y-1.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  {schedules.map((s) => (
                    <li key={s.id}>
                      v{s.version} · <span className="nums">{s.maxFeePct}%</span> ·{' '}
                      {s.paymentTerms} · posted {shortDate(s.postedOn)}, effective{' '}
                      {shortDate(s.effectiveFrom)}
                      {s.inForce ? ' · in force' : s.upcoming ? ' · upcoming' : ''}
                      {' · given to '}<span className="nums">{s.deliveredTo}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[0.6875rem] leading-relaxed">
                  Prior versions stay. A schedule that quietly replaced its predecessor
                  would leave nobody able to say what the terms were when they signed.
                </p>
              </Disclose>
            </div>
          ) : null}

          <div className="px-4 py-4">
            <Disclose summary="Post a new version">
              <ActionForm
                action={postFeeScheduleAction}
                submitLabel="Post it"
                confirm="A posted schedule cannot be edited or withdrawn, only superseded. Continue?"
              >
                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
                  <div>
                    <label className="label" htmlFor="maxFeePct">
                      Maximum fee, all charges
                    </label>
                    <input id="maxFeePct" name="maxFeePct" type="number" step="0.01"
                      min="0.01" max="100" className="input" required
                      defaultValue={inForce?.maxFeePct ?? ''} />
                  </div>
                  <div>
                    <label className="label" htmlFor="paymentTerms">Payment terms</label>
                    <input id="paymentTerms" name="paymentTerms" className="input" required
                      defaultValue={inForce?.paymentTerms ?? ''} placeholder="Net 15" />
                  </div>
                  <div>
                    <label className="label" htmlFor="effectiveFrom">Takes effect</label>
                    <input id="effectiveFrom" name="effectiveFrom" type="date"
                      className="input" required min={earliest} defaultValue={earliest} />
                  </div>
                </div>
                <div className="mt-3">
                  <label className="label" htmlFor="body">The schedule itself</label>
                  <textarea id="body" name="body" className="textarea" rows={5} required
                    defaultValue={inForce?.body ?? ''} />
                </div>
                <p className="mt-3 text-[0.6875rem] leading-relaxed"
                  style={{ color: 'var(--ink-faint)' }}>
                  The earliest date offered is {earliest}, seven days out. § 1812.527
                  requires that notice and the database refuses a shorter one, so a
                  schedule that would take effect sooner cannot be stored at all.
                  Posting supersedes the current version rather than replacing it.
                </p>
              </ActionForm>
            </Disclose>
          </div>
        </div>
      </Section>
    </>
  );
}
