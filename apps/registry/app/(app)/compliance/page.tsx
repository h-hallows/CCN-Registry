import Link from 'next/link';
import { requireOperator } from '@/lib/operator';
import { getCompliance } from '@/lib/queries/compliance';
import { LABEL, REVERIFY_AFTER_DAYS } from '@ccn/core/domain';
import { dueWording } from '@/lib/domain/buckets';
import {
  CredentialPill, Empty, RowLink, Section, shortDate, shortDateTime,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function CompliancePage() {
  const { ctx } = await requireOperator();
  const now = new Date();
  const c = await getCompliance(ctx, now);
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
    </>
  );
}
