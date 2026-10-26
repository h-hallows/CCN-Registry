import { requireOperator } from '@/lib/operator';
import { getToday } from '@/lib/queries/today';
import { ageWording, dueWording, URGENCY_LABEL } from '@/lib/domain/buckets';
import {
  CARE_LABEL, Count, CredentialPill, Empty, RowLink, Section, shortDate,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  const { ctx } = await requireOperator();
  const now = new Date();
  const today = await getToday(ctx, now);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Today</h1>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {today.totalActions === 0
              ? 'Nothing needs action.'
              : `${today.totalActions} item${today.totalActions === 1 ? '' : 's'} needing action. If a row does not require action, it is not on this screen.`}
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {today.ordered.map((b) => (
            <a key={b.key} href={`#${b.key}`} className="inline-flex items-center gap-1.5 hover:underline">
              <span style={{ color: 'var(--ink-soft)' }}>{b.title}</span>
              <Count n={b.rows.length} />
            </a>
          ))}
        </nav>
      </div>

      <Section
        id="blocking" title={today.blocking.title} blurb={today.blocking.blurb}
        right={<Count n={today.blocking.rows.length} />}
      >
        {today.blocking.rows.length === 0 ? (
          <Empty>No active case has an ineligible referred provider.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr><th>Household</th><th>Referred provider</th><th>Why it blocks</th><th /></tr>
              </thead>
              <tbody>
                {today.blocking.rows.map((r) => (
                  <tr key={`${r.caseId}-${r.providerId}`}>
                    <td><RowLink href={`/cases/${r.caseId}`}>{r.householdName}</RowLink></td>
                    <td><RowLink href={`/roster/${r.providerId}`}>{r.providerName}</RowLink></td>
                    <td style={{ color: 'var(--color-expired)' }}>{r.reason}</td>
                    <td className="text-right">
                      <RowLink href={`/roster/${r.providerId}#vault`}>Open vault</RowLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        id="needs-response" title={today.needsResponse.title} blurb={today.needsResponse.blurb}
        right={<Count n={today.needsResponse.rows.length} />}
      >
        {today.needsResponse.rows.length === 0 ? (
          <Empty>Every open enquiry has a logged call.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr><th>Household</th><th>Urgency</th><th>Care</th><th>Received</th></tr>
              </thead>
              <tbody>
                {today.needsResponse.rows.map((r) => (
                  <tr key={r.caseId}>
                    <td><RowLink href={`/cases/${r.caseId}`}>{r.householdName}</RowLink></td>
                    <td>
                      <span style={{
                        color: r.urgency === 'discharge' || r.urgency === 'same_day'
                          ? 'var(--color-expired)' : 'var(--ink-soft)',
                      }}>
                        {URGENCY_LABEL[r.urgency]}
                      </span>
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>{CARE_LABEL[r.care] ?? r.care}</td>
                    <td className="nums" style={{ color: 'var(--ink-faint)' }}>
                      {ageWording(r.createdAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        id="no-physician" title={today.noPhysician.title} blurb={today.noPhysician.blurb}
        right={<Count n={today.noPhysician.rows.length} />}
      >
        {today.noPhysician.rows.length === 0 ? (
          <Empty>Every skilled case has an ordering physician on the household record.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead><tr><th>Household</th><th>Care</th><th>Status</th></tr></thead>
              <tbody>
                {today.noPhysician.rows.map((r) => (
                  <tr key={r.caseId}>
                    <td><RowLink href={`/cases/${r.caseId}`}>{r.householdName}</RowLink></td>
                    <td style={{ color: 'var(--ink-soft)' }}>{CARE_LABEL[r.care] ?? r.care}</td>
                    <td style={{ color: 'var(--ink-faint)' }}>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        id="credentials" title={today.credentialAlerts.title} blurb={today.credentialAlerts.blurb}
        right={<Count n={today.credentialAlerts.rows.length} />}
      >
        {today.credentialAlerts.rows.length === 0 ? (
          <Empty>No required credential expires within ninety days.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr><th>Provider</th><th>Credential</th><th>State</th><th>Expires</th><th /></tr>
              </thead>
              <tbody>
                {today.credentialAlerts.rows.map((r, i) => (
                  <tr key={`${r.providerId}-${r.credentialLabel}-${i}`}>
                    <td><RowLink href={`/roster/${r.providerId}`}>{r.providerName}</RowLink></td>
                    <td style={{ color: 'var(--ink-soft)' }}>{r.credentialLabel}</td>
                    <td><CredentialPill status={r.status} /></td>
                    <td className="nums" style={{ color: 'var(--ink-faint)' }}>
                      {r.expiresOn ? shortDate(r.expiresOn) : '—'}
                    </td>
                    <td className="text-right">
                      <RowLink href={`/roster/${r.providerId}#vault`}>Renew</RowLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        id="thin-bench" title={today.thinBench.title} blurb={today.thinBench.blurb}
        right={<Count n={today.thinBench.rows.length} />}
      >
        {today.thinBench.rows.length === 0 ? (
          <Empty>Every live case has at least two eligible alternates.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead><tr><th>Household</th><th>Eligible alternates</th><th /></tr></thead>
              <tbody>
                {today.thinBench.rows.map((r) => (
                  <tr key={r.caseId}>
                    <td><RowLink href={`/cases/${r.caseId}`}>{r.householdName}</RowLink></td>
                    <td className="nums" style={{
                      color: r.eligibleAlternates === 0 ? 'var(--color-expired)' : 'var(--color-critical)',
                    }}>
                      {r.eligibleAlternates} of 2
                    </td>
                    <td className="text-right">
                      <RowLink href={`/match/${r.caseId}`}>Build a shortlist</RowLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        id="written-due" title={today.writtenDue.title} blurb={today.writtenDue.blurb}
        right={<Count n={today.writtenDue.rows.length} />}
      >
        {today.writtenDue.rows.length === 0 ? (
          <Empty>Every spoken disclosure has its written statement recorded as sent.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr><th>Household</th><th>Disclosed to</th><th>Due</th><th /></tr>
              </thead>
              <tbody>
                {today.writtenDue.rows.map((r) => {
                  const wording = dueWording(r.writtenDueOn, now);
                  const late = wording.includes('overdue') || wording === 'due today';
                  return (
                    <tr key={r.disclosureId}>
                      <td><RowLink href={`/cases/${r.caseId}`}>{r.householdName}</RowLink></td>
                      <td style={{ color: 'var(--ink-soft)' }}>{r.disclosedTo}</td>
                      <td className="nums" style={{
                        color: late ? 'var(--color-expired)' : 'var(--ink-soft)',
                      }}>
                        {shortDate(r.writtenDueOn)} · {wording}
                      </td>
                      <td className="text-right">
                        <RowLink href={`/cases/${r.caseId}#disclosures`}>Mark sent</RowLink>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        id="ending-soon" title={today.endingSoon.title} blurb={today.endingSoon.blurb}
        right={<Count n={today.endingSoon.rows.length} />}
      >
        {today.endingSoon.rows.length === 0 ? (
          <Empty>No engagement ends in the next fourteen days.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead><tr><th>Household</th><th>Ends</th></tr></thead>
              <tbody>
                {today.endingSoon.rows.map((r) => (
                  <tr key={r.caseId}>
                    <td><RowLink href={`/cases/${r.caseId}`}>{r.householdName}</RowLink></td>
                    <td className="nums" style={{ color: 'var(--ink-soft)' }}>
                      {shortDate(r.endsOn)} · {dueWording(r.endsOn, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <p className="mt-6 text-[0.6875rem] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        Coverage gaps are not on this screen. The scheduling and coverage surface is held
        until the nine-factor audit is complete — see DEFERRED.md in the repository.
      </p>
    </>
  );
}
