import { requireOperator } from '@/lib/operator';
import { listCases } from '@/lib/queries/cases';
import { URGENCY_LABEL } from '@/lib/domain/buckets';
import { CARE_LABEL, Empty, RowLink, Section, STATUS_LABEL } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function MatchPage() {
  const { ctx } = await requireOperator();
  const all = await listCases(ctx);
  const open = all.filter((c) => c.status !== 'ended');

  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Match</h1>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Pick a case. The shortlist applies the hard filters; the ranking is yours.
        </p>
      </div>

      <Section title="Select a case">
        {open.length === 0 ? (
          <Empty>No live case.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Household</th><th>Status</th><th>Care</th><th>Urgency</th>
                  <th>Area</th><th>Primary</th>
                </tr>
              </thead>
              <tbody>
                {open.map((c) => (
                  <tr key={c.id}>
                    <td><RowLink href={`/match/${c.id}`}>{c.householdName}</RowLink></td>
                    <td style={{ color: 'var(--ink-soft)' }}>{STATUS_LABEL[c.status]}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>{CARE_LABEL[c.care] ?? c.care}</td>
                    <td style={{
                      color: c.urgency === 'discharge' || c.urgency === 'same_day'
                        ? 'var(--color-critical)' : 'var(--ink-faint)',
                    }}>
                      {URGENCY_LABEL[c.urgency]}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>{c.crArea}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>{c.primaryProviderName ?? '—'}</td>
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
