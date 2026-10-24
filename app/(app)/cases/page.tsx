import { requireOperator } from '@/lib/operator';
import { listCases } from '@/lib/queries/cases';
import { URGENCY_LABEL } from '@/lib/domain/buckets';
import {
  CARE_LABEL, Empty, RowLink, Section, shortDate, STATUS_LABEL,
} from '@/components/ui';
import type { CaseStatusValue } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

const STATUSES: CaseStatusValue[] = ['inquiry', 'matching', 'referred', 'active', 'paused', 'ended'];

export default async function CasesPage({
  searchParams,
}: { searchParams: Promise<{ status?: string }> }) {
  const { ctx } = await requireOperator();
  const { status } = await searchParams;
  const valid = STATUSES.includes(status as CaseStatusValue) ? (status as CaseStatusValue) : undefined;
  const rows = await listCases(ctx, valid ? { status: valid } : undefined);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Cases</h1>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {rows.length} case{rows.length === 1 ? '' : 's'}
            {valid ? ` with status ${STATUS_LABEL[valid]}` : ''}
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <a href="/cases" className="hover:underline"
            style={{ color: valid ? 'var(--ink-faint)' : 'var(--ink)' }}>All</a>
          {STATUSES.map((s) => (
            <a key={s} href={`/cases?status=${s}`} className="hover:underline"
              style={{ color: valid === s ? 'var(--ink)' : 'var(--ink-faint)' }}>
              {STATUS_LABEL[s]}
            </a>
          ))}
        </nav>
      </div>

      <Section title="Household cases">
        {rows.length === 0 ? (
          <Empty>No case with that status.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Household</th><th>Status</th><th>Care</th><th>Urgency</th><th>Area</th>
                  <th>Hours/wk</th><th>Primary</th><th>Written statement</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td><RowLink href={`/cases/${c.id}`}>{c.householdName}</RowLink></td>
                    <td style={{ color: 'var(--ink-soft)' }}>{STATUS_LABEL[c.status]}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>{CARE_LABEL[c.care] ?? c.care}</td>
                    <td style={{
                      color: c.urgency === 'discharge' || c.urgency === 'same_day'
                        ? 'var(--color-critical)' : 'var(--ink-faint)',
                    }}>
                      {URGENCY_LABEL[c.urgency]}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>{c.crArea}</td>
                    <td className="nums" style={{ color: 'var(--ink-soft)' }}>{c.hoursPerWeek ?? '—'}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>{c.primaryProviderName ?? '—'}</td>
                    <td className="nums" style={{ color: 'var(--ink-faint)' }}>
                      {c.writtenSentOn
                        ? `sent ${shortDate(c.writtenSentOn)}`
                        : c.writtenDueOn
                          ? <span style={{ color: 'var(--color-critical)' }}>due {shortDate(c.writtenDueOn)}</span>
                          : '—'}
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
