import Link from 'next/link';
import { requireOperator } from '@/lib/operator';
import {
  bySource, capacity, failures, funnel, leakage,
  type FunnelRow, type LeakageRow, type Trend,
} from '@/lib/queries/measure';
import { SERVICE_FAILURE_LABEL } from '@/lib/metrics';
import {
  Banner, Empty, monthLabel, RowLink, Section, shortDate, shortDateTime,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

const TREND_WORD: Record<Trend, string> = {
  falling: 'Falling',
  steady: 'Steady',
  rising: 'Rising',
  too_short: 'Too short to say',
};

const TREND_COLOR: Record<Trend, string> = {
  falling: 'var(--color-expired)',
  steady: 'var(--ink-soft)',
  rising: 'var(--color-ok)',
  too_short: 'var(--ink-faint)',
};

function pct(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}

/** A bar, for reading a series down a column. Width only — no axis it does not have. */
function Bar({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const width = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  return (
    <span className="inline-flex h-2 w-24 overflow-hidden rounded-sm align-middle"
      style={{ background: 'var(--line-soft)' }}>
      <span style={{ width: `${width}%`, background: tone ?? 'var(--accent)' }} />
    </span>
  );
}

function FunnelLine({ row, worst }: { row: FunnelRow; worst: boolean }) {
  return (
    <tr className="border-t hair">
      <td className="px-4 py-2 text-sm">
        {row.label}
        {worst ? (
          <span className="ml-2 text-[0.6875rem]" style={{ color: 'var(--color-soon)' }}
            title="The largest share lost between two steps whose cases nest. Where to look first, not a conclusion.">
            biggest drop
          </span>
        ) : null}
      </td>
      <td className="px-4 py-2 nums text-sm">{row.cases}</td>
      <td className="px-4 py-2">
        <span className="nums text-sm">{pct(row.ofEnquiries)}</span>
      </td>
      <td className="px-4 py-2 nums text-sm">
        {row.skippedPrevious > 0 ? (
          <span style={{ color: 'var(--color-soon)' }} title="These cases have no record of the step above, so the column above them is not a subset of this one.">
            {row.skippedPrevious}
          </span>
        ) : '—'}
      </td>
      <td className="px-4 py-2 nums text-sm">
        {row.medianDays === null ? (
          <span style={{ color: 'var(--ink-faint)' }}>
            {row.medianOf === 0 ? '—' : `too few (${row.medianOf})`}
          </span>
        ) : (
          <>
            {row.medianDays}d
            <span className="ml-1.5 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
              of {row.medianOf}
            </span>
          </>
        )}
      </td>
    </tr>
  );
}

/**
 * Each row is drawn to ITS OWN maximum, not a scale shared down the column.
 *
 * Shared, the tapering engagement — the one row this section exists for — rendered as
 * six nearly flat bars, because its 43 hours a month sat against another household's
 * 173 and everything it did happened in the bottom quarter of the box. The shape is the
 * point; the magnitude is in the Latest column and in the tooltip. Heights are not
 * comparable between rows, which is why the header says so: two families buying
 * different amounts of different care is not a comparison worth drawing.
 */
function LeakageLine({ row }: { row: LeakageRow }) {
  const max = Math.max(1, ...row.series.map((p) => p.hours));
  return (
    <tr className="border-t hair align-top">
      <td className="px-4 py-2 text-sm">
        <RowLink href={`/cases/${row.caseId}`}>{row.householdName}</RowLink>
        <span className="ml-1.5 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
          {row.status}
        </span>
      </td>
      <td className="px-4 py-2 text-sm whitespace-nowrap"
        style={{ color: TREND_COLOR[row.trend] }}>
        {TREND_WORD[row.trend]}
        {row.decline !== null ? (
          <span className="nums ml-1.5">{Math.round(row.decline * 100)}% down</span>
        ) : null}
      </td>
      <td className="px-4 py-2">
        <span className="flex flex-wrap items-end gap-1">
          {row.series.map((p) => (
            <span key={p.month} className="inline-flex flex-col items-center gap-0.5"
              title={`${monthLabel(p.month)}: ${p.hours} hours`}>
              <span className="inline-block w-5 rounded-sm"
                style={{
                  height: `${Math.max(2, (p.hours / max) * 28)}px`,
                  background: row.trend === 'falling'
                    ? 'var(--color-expired)' : 'var(--accent)',
                }} />
              <span className="nums text-[0.5625rem]" style={{ color: 'var(--ink-faint)' }}>
                {monthLabel(p.month).slice(0, 1)}
              </span>
            </span>
          ))}
        </span>
      </td>
      <td className="px-4 py-2 nums text-sm">
        {row.series[row.series.length - 1]?.hours ?? '—'}
      </td>
    </tr>
  );
}

export default async function MeasurePage() {
  const { ctx } = await requireOperator();

  const [steps, sources, cap, hours, failed] = await Promise.all([
    funnel(ctx),
    bySource(ctx),
    capacity(ctx),
    leakage(ctx),
    failures(ctx),
  ]);

  /*
   * The biggest drop between consecutive steps. The only derived judgment on this
   * screen, and a pointer rather than a conclusion: the step that loses most is where to
   * look first.
   *
   * Two steps are skipped when deciding it. One whose cases do not nest in the step
   * above (`skippedPrevious`) is not losing anybody — the sets are simply not subsets.
   * And one with no cases at all while a LATER step has some is proof the step is
   * skippable, not that everyone stopped there: the first version of this marked "a
   * bench was screened" as the biggest drop at a 100% loss, when what it really meant
   * was that the match screen is not on the path to a referral in this data. A genuine
   * dead end — nothing recorded here and nothing after it either — still gets marked.
   */
  let worstStep: string | null = null;
  let worstLoss = 0;
  for (let i = 1; i < steps.length; i++) {
    const before = steps[i - 1]!;
    const here = steps[i]!;
    if (before.cases === 0 || here.skippedPrevious > 0) continue;
    const laterHasCases = steps.slice(i + 1).some((s) => s.cases > 0);
    if (here.cases === 0 && laterHasCases) continue;
    const lost = (before.cases - here.cases) / before.cases;
    if (lost > worstLoss) { worstLoss = lost; worstStep = here.step; }
  }

  const notNested = steps.filter((s) => s.skippedPrevious > 0);
  const maxActive = Math.max(1, ...cap.months.map((m) => m.activeCases));
  const fallingCount = hours.filter((r) => r.trend === 'falling').length;

  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Measure</h1>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          § 8. Where the work comes from, how much can be held at once, and which
          household is quietly going elsewhere.
        </p>
      </div>

      {notNested.length > 0 ? (
        <Banner tone="note" title="These steps are not nested, so read the column carefully">
          <p>
            {notNested.map((s) => `${s.skippedPrevious} at “${s.label.toLowerCase()}”`)
              .join(', ')}{' '}
            {notNested.length === 1 ? 'has' : 'have'} no record of the step above.
            A bench is screened when the match screen is opened, which an operator may
            skip — so a case can be referred with nothing recorded before it. The share
            column is therefore measured against enquiries arriving, never against the
            row above, and a conversion rate between two of these steps would be a tidy
            chart of a fiction.
          </p>
        </Banner>
      ) : null}

      <Section
        title="The funnel"
        blurb="First time each case reached each step. A case screened twice or referred twice counts once."
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left">
                <th className="px-4 py-2">Step</th>
                <th className="px-4 py-2">Cases</th>
                <th className="px-4 py-2">Of enquiries</th>
                <th className="px-4 py-2">Skipped the step above</th>
                <th className="px-4 py-2">Median since previous</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <FunnelLine key={s.step} row={s} worst={s.step === worstStep} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t hair px-4 py-3 text-xs leading-relaxed"
          style={{ color: 'var(--ink-faint)' }}>
          A median is shown only once three cases have made both steps. One case&rsquo;s
          median is that case, and beside a percentage it reads as a rate.
        </p>
      </Section>

      <Section
        title="Where the work comes from"
        blurb="§ 8 asks whether the binding constraint is demand or capacity. A channel that sends many and converts none is not the same problem as one that sends three and converts three."
      >
        {sources.length === 0 ? (
          <Empty>No enquiry has recorded a source yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2">Enquiries</th>
                  <th className="px-4 py-2">Reached a referral</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.source} className="border-t hair">
                    <td className="px-4 py-2 text-sm">{s.source}</td>
                    <td className="px-4 py-2 nums text-sm">{s.enquiries}</td>
                    <td className="px-4 py-2 nums text-sm">{s.reachedReferral}</td>
                    <td className="px-4 py-2">
                      <Bar value={s.reachedReferral} max={Math.max(1, s.enquiries)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Capacity"
        blurb="Concurrent cases held without a service failure. Not minutes per case: a time metric is the first thing abandoned in any tool, and admin time rises for the first months while habits change — so it would read as failure exactly when the tool is working."
      >
        <div className="grid gap-x-6 gap-y-3 border-b hair px-4 py-4 sm:grid-cols-3">
          <div>
            <span className="label">Held now</span>
            <p className="nums text-sm">{cap.heldNow}</p>
          </div>
          <div>
            <span className="label">Of those, never a failure</span>
            <p className="nums text-sm">
              {cap.cleanNow}
              {cap.heldNow > 0 ? (
                <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  ({pct(cap.cleanNow / cap.heldNow)})
                </span>
              ) : null}
            </p>
          </div>
          <div>
            <span className="label">Most ever held at once</span>
            <p className="nums text-sm">
              {cap.peak ? `${cap.peak.cases}` : '—'}
              {cap.peak ? (
                <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  in {monthLabel(cap.peak.month)}
                </span>
              ) : null}
            </p>
          </div>
        </div>
        <p className="border-b hair px-4 py-2.5 text-xs leading-relaxed"
          style={{ color: 'var(--ink-faint)' }}>
          Held means referred and not ended — including a household still waiting on a
          first shift and one whose care is paused. Both are being carried. An enquiry in
          the queue is not: that is capacity not yet used, and counting it would make a
          backlog look like throughput.
        </p>

        {cap.months.length === 0 ? (
          <Empty>No case has been referred yet, so nothing has been held.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="px-4 py-2">Month</th>
                  <th className="px-4 py-2">Cases held</th>
                  <th className="px-4 py-2" />
                  <th className="px-4 py-2">Service failures</th>
                </tr>
              </thead>
              <tbody>
                {[...cap.months].reverse().map((m) => (
                  <tr key={m.month} className="border-t hair">
                    <td className="px-4 py-2 nums text-sm whitespace-nowrap">
                      {monthLabel(m.month)}
                    </td>
                    <td className="px-4 py-2 nums text-sm">{m.activeCases}</td>
                    <td className="px-4 py-2"><Bar value={m.activeCases} max={maxActive} /></td>
                    <td className="px-4 py-2 nums text-sm">
                      {m.failures > 0 ? (
                        <span style={{ color: 'var(--color-expired)' }}>{m.failures}</span>
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

        {cap.failuresByKind.length > 0 ? (
          <div className="border-t hair px-4 py-3">
            <span className="label">What went wrong</span>
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-soft)' }}>
              {cap.failuresByKind
                .map((k) => `${SERVICE_FAILURE_LABEL[k.kind]} (${k.failures})`)
                .join(' · ')}
            </p>
          </div>
        ) : null}
      </Section>

      <Section
        title="Leakage"
        blurb="Billed hours per case per month. At 30–50 week median durations a small book yields three to six ended cases in six months, which is not a sample — so the end reason arrives far too late to steer anything. This is the series that moves first."
        right={fallingCount > 0 ? (
          <span className="text-xs" style={{ color: 'var(--color-expired)' }}>
            {fallingCount} falling
          </span>
        ) : null}
      >
        {hours.length === 0 ? (
          <Empty>
            No hours recorded yet. They go in on the case, one month at a time — the
            figure the invoices produce, not an estimate.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="px-4 py-2">Household</th>
                  <th className="px-4 py-2">Direction</th>
                  <th className="px-4 py-2">
                    Hours by month
                    <span className="ml-1.5 normal-case" style={{ opacity: 0.7 }}>
                      (each row to its own scale)
                    </span>
                  </th>
                  <th className="px-4 py-2">Latest</th>
                </tr>
              </thead>
              <tbody>
                {hours.map((r) => <LeakageLine key={r.caseId} row={r} />)}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t hair px-4 py-3 text-xs leading-relaxed"
          style={{ color: 'var(--ink-faint)' }}>
          A direction is only called after four months, and only on a change of a fifth or
          more. Three months lets one fortnight of holiday cover read as a household
          leaving, and the response to that false positive is a conversation that implies
          you think they are going.
        </p>
      </Section>

      <Section
        title="Service failures"
        blurb="Named, because a missed shift is a thing that happened to a family. Recording one routes nothing and reaches no provider's record."
      >
        {failed.length === 0 ? (
          <Empty>None recorded. They go in on the case.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Household</th>
                  <th className="px-4 py-2">What happened</th>
                  <th className="px-4 py-2">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {failed.map((f) => (
                  <tr key={f.id} className="border-t hair align-top">
                    <td className="px-4 py-2 nums text-sm whitespace-nowrap">
                      {shortDate(f.onDate)}
                    </td>
                    <td className="px-4 py-2 text-sm">
                      <RowLink href={`/cases/${f.caseId}`}>{f.householdName}</RowLink>
                      {' · '}
                      <Link href={`/audit?household=${f.householdId}`}
                        className="text-xs underline underline-offset-4"
                        style={{ color: 'var(--ink-faint)' }}>
                        trail
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-sm">
                      {SERVICE_FAILURE_LABEL[f.kind]}
                      {f.note ? (
                        <span className="block text-xs" style={{ color: 'var(--ink-soft)' }}>
                          {f.note}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 nums text-xs" style={{ color: 'var(--ink-faint)' }}>
                      {shortDateTime(f.recordedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <p className="pb-6 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        The funnel, the sources and the capacity series are counts and name nobody.
        Leakage and the failure list are per household, so opening this screen is
        recorded against each household it names — the same as opening their case would
        be. An instrumentation screen is not a side door.
      </p>
    </>
  );
}
