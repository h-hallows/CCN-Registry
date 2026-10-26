import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOperator } from '@/lib/operator';
import { getCase } from '@/lib/queries/cases';
import { shortlistFor } from '@/lib/queries/match';
import { SKILLED_CARE_TYPES } from '@/lib/domain/referral';
import { PERMITTED } from '@ccn/core/domain';
import { makeReferralAction, saveShortlistAction } from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import {
  Banner, CARE_LABEL, Empty, formatBlocks, Rate, RowLink, Section,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function MatchCasePage({
  params,
}: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const { ctx } = await requireOperator();
  const now = new Date();

  const found = await getCase(ctx, caseId);
  if (!found) notFound();
  const { kase } = found;
  const shortlist = await shortlistFor(ctx, caseId, now);
  if (!shortlist) notFound();

  const isSkilled = (SKILLED_CARE_TYPES as readonly string[]).includes(kase.care);
  const physicianMissing = isSkilled && !kase.household.physicianName?.trim();
  const alreadyReferred = new Set(found.referrals.map((r) => r.providerId));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Match — {kase.household.displayName}
          </h1>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {CARE_LABEL[kase.care] ?? kase.care} in {kase.household.crArea} ·{' '}
            {PERMITTED[kase.care].join(', ')} may be referred ·{' '}
            <span className="nums">{formatBlocks(kase.schedule)}</span>
          </p>
        </div>
        <Link href={`/cases/${kase.id}`} className="btn">Open the case</Link>
      </div>

      {physicianMissing ? (
        <Banner tone="alert" title="No ordering physician on the household record">
          A referral on this skilled case will be refused until an ordering physician is
          recorded — by the application and by the database.
        </Banner>
      ) : null}

      <Section
        title={`Eligible — ${shortlist.eligible.length}`}
        blurb="Hard filters only: eligibility, scope of practice, area, stated availability, and the household's own exclusions. The columns are the raw observations; the judgment is yours."
      >
        {shortlist.eligible.length === 0 ? (
          <Empty>
            No provider on the roster clears the filters for this case. Check the excluded
            list below — the reason is given for each.
          </Empty>
        ) : (
          <ActionForm action={saveShortlistAction} submitLabel="Save shortlist to the timeline" className="px-4 py-4">
            <input type="hidden" name="caseId" value={kase.id} />
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>Shortlist</th><th>Provider</th><th>Type</th><th>Rate</th>
                    <th>Pattern cover</th><th>Specialty overlap</th><th>Language</th>
                    <th>Prior here</th><th>Avg weeks</th><th>Area rank</th>
                  </tr>
                </thead>
                <tbody>
                  {shortlist.eligible.map((e) => (
                    <tr key={e.providerId}>
                      <td>
                        <input type="checkbox" name="providerId" value={e.providerId}
                          aria-label={`Shortlist ${e.fullName}`} />
                      </td>
                      <td>
                        <RowLink href={`/roster/${e.providerId}`}>{e.fullName}</RowLink>
                        {alreadyReferred.has(e.providerId) ? (
                          <span className="ml-1.5 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                            already referred
                          </span>
                        ) : null}
                        {e.restrictions ? (
                          <span className="block text-[0.6875rem]" style={{ color: 'var(--color-soon)' }}>
                            stated restriction: {e.restrictions}
                          </span>
                        ) : null}
                      </td>
                      <td style={{ color: 'var(--ink-soft)' }}>{e.type}</td>
                      <td>
                        <Rate hourly={e.rateHourly} notes={e.rateNotes} />
                        {e.signals.rateVsBand === 'over' || e.signals.rateVsBand === 'slightly_over' ? (
                          <span className="block text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                            above the band discussed — negotiable
                          </span>
                        ) : null}
                      </td>
                      <td className="nums" style={{
                        color: e.signals.blocksRequired > 0
                          && e.signals.blocksCovered < e.signals.blocksRequired
                          ? 'var(--color-soon)' : 'var(--ink-soft)',
                      }}>
                        {e.signals.blocksCovered} of {e.signals.blocksRequired}
                      </td>
                      <td style={{ color: 'var(--ink-soft)' }}>
                        {e.signals.specialtyMatches.length > 0
                          ? e.signals.specialtyMatches.map((s) => s.replace(/_/g, ' ')).join(', ')
                          : '—'}
                      </td>
                      <td style={{ color: 'var(--ink-soft)' }}>
                        {e.signals.languageMet === null
                          ? 'none asked'
                          : e.signals.languageMet ? 'met' : 'not met'}
                      </td>
                      <td className="nums" style={{ color: 'var(--ink-soft)' }}>
                        {e.signals.priorReferrals === 0
                          ? '—'
                          : `${e.signals.priorReferrals} (${e.signals.priorEngagementsEndedWell} ended well)`}
                      </td>
                      <td className="nums" style={{ color: 'var(--ink-soft)' }}>
                        {e.signals.avgEngagementWeeks ?? '—'}
                      </td>
                      <td className="nums" style={{ color: 'var(--ink-faint)' }}>
                        {e.signals.areaRank + 1}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[0.6875rem] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              There is no composite score. The weights that would produce one are not yet
              earned — they need placement outcomes to fit to. See DEFERRED.md.
            </p>
          </ActionForm>
        )}
      </Section>

      <Section
        title={`Excluded — ${shortlist.excluded.length}`}
        blurb="Every provider the filters removed, and why. Nothing here can be overridden."
      >
        <div className="px-4 py-4">
          <Disclose summary="Show the excluded providers and the reason for each" tone="quiet">
            <div className="scroller">
              <table>
                <thead><tr><th>Provider</th><th>Type</th><th>Reason</th></tr></thead>
                <tbody>
                  {shortlist.excluded.map((e) => (
                    <tr key={e.providerId}>
                      <td>
                        <RowLink href={`/roster/${e.providerId}`}>{e.fullName}</RowLink>
                      </td>
                      <td style={{ color: 'var(--ink-soft)' }}>{e.type}</td>
                      <td style={{
                        color: e.exclusion.code === 'not_eligible'
                          ? 'var(--color-expired)' : 'var(--ink-soft)',
                      }}>
                        {e.exclusion.detail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclose>
        </div>
      </Section>

      <Section
        title="Record a referral"
        blurb="A referral is recorded only together with the spoken disclosure it was made under. There is no skip path and no option to record it later."
      >
        {shortlist.eligible.length === 0 ? (
          <Empty>Nothing eligible to refer.</Empty>
        ) : (
          <div className="px-4 py-4">
            <ActionForm
              action={makeReferralAction}
              submitLabel="Record referral and disclosure"
              primary
              confirm="This writes the disclosure and the referral together, permanently. Continue?"
            >
              <input type="hidden" name="caseId" value={kase.id} />
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="providerId">Provider referred</label>
                  <select id="providerId" name="providerId" className="select" required>
                    {shortlist.eligible.map((e) => (
                      <option key={e.providerId} value={e.providerId}>
                        {e.fullName} — {e.type}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="disclosedTo">Disclosure given to</label>
                  <input id="disclosedTo" name="disclosedTo" className="input" required
                    defaultValue={kase.household.dmName} />
                </div>
                <div>
                  <label className="label" htmlFor="method">How</label>
                  <select id="method" name="method" className="select" required>
                    <option value="phone">By phone</option>
                    <option value="in_person">In person</option>
                  </select>
                </div>
                <div className="sm:col-span-2 lg:col-span-4">
                  <label className="label" htmlFor="referral-note">Note for the timeline</label>
                  <input id="referral-note" name="note" className="input" placeholder="Optional" />
                </div>
              </div>

              <label
                className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-xs leading-relaxed hair"
                style={{ background: 'var(--accent-soft)' }}
              >
                <input type="checkbox" name="confirm" value="yes" required className="mt-0.5" />
                <span>
                  I gave the spoken disclosure to the person named above, live, by phone or
                  in person, before recording this referral. I explained that the provider
                  is a referred provider and not the registry&rsquo;s own, the fee charged
                  to the household, and that the rate is set by the provider and
                  negotiable. The written statement follows within three California
                  business days, as § 1812.5095(f) requires.
                </span>
              </label>
            </ActionForm>
          </div>
        )}
      </Section>
    </>
  );
}
