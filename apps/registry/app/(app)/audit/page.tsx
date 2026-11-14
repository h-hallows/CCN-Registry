import Link from 'next/link';
import { requireOperator } from '@/lib/operator';
import {
  actorTrail, actors, householdChoices, householdTrail, integrity, providerChoices,
  providerTrail, recentWrites,
  collapse,
  type ActorEntry, type TrailRow,
} from '@/lib/queries/audit';
import { Banner, Empty, Section, preciseDateTime, shortDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

const ACTION_WORD: Record<string, string> = {
  read: 'looked at',
  create: 'created',
  update: 'changed',
  soft_delete: 'removed',
};

/** The diff, as a sentence rather than a blob. Reads say what was read; writes, what changed. */
function describe(diff: unknown): string | null {
  if (diff === null || typeof diff !== 'object') return null;
  const d = diff as Record<string, unknown>;
  if (typeof d.read === 'string') return d.read;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(d)) {
    if (value && typeof value === 'object' && 'from' in value && 'to' in value) {
      const v = value as { from: unknown; to: unknown };
      parts.push(`${key}: ${format(v.from)} → ${format(v.to)}`);
    } else {
      parts.push(`${key} ${format(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function Row({ row, times }: { row: TrailRow; times: number }) {
  const said = describe(row.diff);
  return (
    <tr className="border-t hair align-top">
      <td className="px-4 py-2 whitespace-nowrap nums text-xs" style={{ color: 'var(--ink-soft)' }}>
        {preciseDateTime(row.at)}
      </td>
      <td className="px-4 py-2 text-sm">{row.actor}</td>
      <td className="px-4 py-2 text-sm">
        {ACTION_WORD[row.action] ?? row.action}{' '}
        <span style={{ color: 'var(--ink-soft)' }}>{row.label.toLowerCase()}</span>
        {times > 1 ? (
          <span className="nums ml-1.5 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}
            title={`${times} identical entries in the same second, shown as one.`}>
            ×{times}
          </span>
        ) : null}
        {row.mislabelled ? (
          <span
            className="ml-1.5 text-[0.6875rem]"
            style={{ color: 'var(--color-soon)' }}
            title={`The log says ${row.storedEntity}; the id is a row of ${row.actualEntity}. Written before the vocabulary existed, and kept as written — the table is append-only.`}
          >
            recorded as {row.storedEntity}
          </span>
        ) : null}
      </td>
      <td className="px-4 py-2 text-xs" style={{ color: 'var(--ink-soft)' }}>
        {said ?? '—'}
      </td>
      <td className="px-4 py-2 nums text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
        {row.ip ?? '—'}
      </td>
    </tr>
  );
}

function Head() {
  return (
    <thead>
      <tr className="text-left">
        <th className="px-4 py-2 label">When</th>
        <th className="px-4 py-2 label">Who</th>
        <th className="px-4 py-2 label">Did what</th>
        <th className="px-4 py-2 label">Detail</th>
        <th className="px-4 py-2 label">From</th>
      </tr>
    </thead>
  );
}

function FlatRow({ entry }: { entry: ActorEntry & { actor?: string } }) {
  const said = describe(entry.diff);
  return (
    <tr className="border-t hair align-top">
      <td className="px-4 py-2 whitespace-nowrap nums text-xs" style={{ color: 'var(--ink-soft)' }}>
        {preciseDateTime(entry.at)}
      </td>
      {entry.actor ? <td className="px-4 py-2 text-sm">{entry.actor}</td> : null}
      <td className="px-4 py-2 text-sm">
        {ACTION_WORD[entry.action] ?? entry.action}{' '}
        <span style={{ color: 'var(--ink-soft)' }}>{entry.label.toLowerCase()}</span>
      </td>
      <td className="px-4 py-2 text-xs" style={{ color: 'var(--ink-soft)' }}>{said ?? '—'}</td>
      <td className="px-4 py-2 nums text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
        {entry.ip ?? '—'}
      </td>
    </tr>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ household?: string; provider?: string; actor?: string }>;
}) {
  const { ctx } = await requireOperator();
  const params = await searchParams;

  const [households, providers, log, people] = await Promise.all([
    householdChoices(),
    providerChoices(),
    integrity(ctx),
    actors(ctx),
  ]);

  const household = params.household
    ? await householdTrail(ctx, params.household)
    : null;
  const provider = params.provider ? await providerTrail(ctx, params.provider) : null;
  const person = params.actor ? await actorTrail(ctx, params.actor) : null;
  const writes = household || provider || person ? null : await recentWrites(ctx);

  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Audit</h1>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Who looked at what, and when. Every read on this screen is itself recorded —
          including this one.
        </p>
      </div>

      <Section
        title="Who looked at this household"
        blurb="The question § 3.8 exists to answer. Everything recorded about a household, its cases, the referrals on those cases and the documents on either."
      >
        <form method="GET" className="flex flex-wrap items-end gap-3 px-4 py-4">
          <div className="min-w-60">
            <label className="label" htmlFor="household">Household</label>
            <select id="household" name="household" className="select"
              defaultValue={params.household ?? ''}>
              <option value="">Choose one</option>
              {households.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary">Show the trail</button>
          {household ? (
            <Link href="/audit" className="text-xs underline underline-offset-4"
              style={{ color: 'var(--ink-faint)' }}>Clear</Link>
          ) : null}
        </form>
      </Section>

      {household ? (
        <>
          <Section
            title={`${household.householdName} — ${household.rows.length} entries`}
            blurb={
              household.readers.length === 0
                ? 'Nobody has read or written anything about them.'
                : `${household.readers.length} ${household.readers.length === 1 ? 'person has' : 'people have'} touched this record. `
                  + 'Identical reads in the same second are shown once, with a count: '
                  + 'one page view can read the same record more than once.'
            }
            right={
              <Link href={`/audit?household=${household.householdId}`}
                className="text-xs underline underline-offset-4">Refresh</Link>
            }
          >
            {household.readers.length > 0 ? (
              <div className="flex flex-wrap gap-x-5 gap-y-1 border-b hair px-4 py-3">
                {household.readers.map((r) => (
                  <span key={r.actor} className="text-xs">
                    <Link href={`/audit?actor=${encodeURIComponent(r.actor)}`}
                      className="font-medium underline-offset-2 hover:underline">
                      {r.actor}
                    </Link>
                    <span className="nums ml-1.5" style={{ color: 'var(--ink-faint)' }}>
                      {r.reads} read{r.reads === 1 ? '' : 's'}
                      {r.writes > 0 ? `, ${r.writes} write${r.writes === 1 ? '' : 's'}` : ''}
                      {' · last '}{shortDateTime(r.lastAt)}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}

            {household.rows.length === 0 ? (
              <Empty>
                Nothing recorded. For a household in the demo seed that is expected — the
                seed writes rows directly and never goes through the console, so nobody
                has looked at them yet. Open the case and come back.
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full"><Head />
                  <tbody>
                    {collapse(household.rows).map(({ row, times }) => (
                      <Row key={row.id} row={row} times={times} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {household.truncatedAt ? (
              <p className="border-t hair px-4 py-3 text-xs" style={{ color: 'var(--ink-faint)' }}>
                Showing the most recent {household.truncatedAt}. There are more.
              </p>
            ) : null}
          </Section>
        </>
      ) : null}

      <Section
        title="Who looked at this provider"
        blurb="The same question from the other side: everything recorded about a provider, their credentials, their submissions and the referrals they were named in."
      >
        <form method="GET" className="flex flex-wrap items-end gap-3 px-4 py-4">
          <div className="min-w-60">
            <label className="label" htmlFor="provider">Provider</label>
            <select id="provider" name="provider" className="select"
              defaultValue={params.provider ?? ''}>
              <option value="">Choose one</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary">Show the trail</button>
        </form>
      </Section>

      {provider ? (
        <Section
          title={`${provider.providerName} — ${provider.rows.length} entries`}
          blurb={`${provider.readers.length} ${provider.readers.length === 1 ? 'person has' : 'people have'} touched this record.`}
        >
          {provider.rows.length === 0 ? (
            <Empty>Nothing recorded about them yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full"><Head />
                <tbody>
                  {collapse(provider.rows).map(({ row, times }) => (
                    <Row key={row.id} row={row} times={times} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}

      {person ? (
        <Section
          title={`Everything recorded for ${params.actor}`}
          blurb="Reads included. This is the insider question, and it is the half of § 3.8 that only matters after something has gone wrong."
          right={<Link href="/audit" className="text-xs underline underline-offset-4">Clear</Link>}
        >
          {person.length === 0 ? (
            <Empty>Nothing recorded for them.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left">
                    <th className="px-4 py-2 label">When</th>
                    <th className="px-4 py-2 label">Did what</th>
                    <th className="px-4 py-2 label">Detail</th>
                    <th className="px-4 py-2 label">From</th>
                  </tr>
                </thead>
                <tbody>
                  {person.map((e) => <FlatRow key={e.id} entry={e} />)}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}

      {writes ? (
        <Section
          title="Recent writes"
          blurb="The log is mostly reads, so this is the part worth scanning. Every one of these changed something."
        >
          {writes.length === 0 ? (
            <Empty>Nothing has been written through the console yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left">
                    <th className="px-4 py-2 label">When</th>
                    <th className="px-4 py-2 label">Who</th>
                    <th className="px-4 py-2 label">Did what</th>
                    <th className="px-4 py-2 label">Detail</th>
                    <th className="px-4 py-2 label">From</th>
                  </tr>
                </thead>
                <tbody>{writes.map((e) => <FlatRow key={e.id} entry={e} />)}</tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}

      <Section
        title="Everyone the log has recorded"
        blurb="Operators, and the portal accounts that act through the API. Pick one to see what they have done."
      >
        {people.length === 0 ? (
          <Empty>The log is empty.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="px-4 py-2 label">Who</th>
                  <th className="px-4 py-2 label">Reads</th>
                  <th className="px-4 py-2 label">Writes</th>
                  <th className="px-4 py-2 label">First seen</th>
                  <th className="px-4 py-2 label">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.actor} className="border-t hair">
                    <td className="px-4 py-2 text-sm">
                      <Link href={`/audit?actor=${encodeURIComponent(p.actor)}`}
                        className="font-medium underline-offset-2 hover:underline">
                        {p.actor}
                      </Link>
                    </td>
                    <td className="px-4 py-2 nums text-sm">{p.reads}</td>
                    <td className="px-4 py-2 nums text-sm">{p.writes}</td>
                    <td className="px-4 py-2 nums text-xs" style={{ color: 'var(--ink-soft)' }}>
                      {shortDateTime(p.firstAt)}
                    </td>
                    <td className="px-4 py-2 nums text-xs" style={{ color: 'var(--ink-soft)' }}>
                      {shortDateTime(p.lastAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="What the log can and cannot tell you"
        blurb="Stated rather than implied, because the alternative is a screen that looks complete."
      >
        <div className="grid gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-3">
          <div>
            <span className="label">Entries</span>
            <p className="nums text-sm">{log.total.toLocaleString('en-GB')}</p>
          </div>
          <div>
            <span className="label">Reads · writes</span>
            <p className="nums text-sm">
              {log.reads.toLocaleString('en-GB')} · {log.writes.toLocaleString('en-GB')}
            </p>
          </div>
          <div>
            <span className="label">Oldest entry</span>
            <p className="text-sm">{log.oldestAt ? shortDateTime(log.oldestAt) : '—'}</p>
          </div>
        </div>

        {log.mislabelled.length > 0 || log.unrecognised.length > 0 ? (
          <div className="border-t hair px-4 py-4">
            <Banner tone="note" title="Rows written before the vocabulary existed">
              <p>
                <code>audit_log</code> is append-only at the database level, which is what
                makes it evidence rather than a note — so these stay exactly as they were
                written. They are still attributed to a subject, because the match is on
                the id and a uuid belongs to one row whatever the entity column says. The
                trail marks them.
              </p>
              {log.mislabelled.length > 0 ? (
                <p className="mt-2">
                  <strong>Entity names a different table than the id:</strong>{' '}
                  {log.mislabelled.map((m) => `${m.entity} (${m.rows})`).join(', ')}.
                </p>
              ) : null}
              {log.unrecognised.length > 0 ? (
                <p className="mt-2">
                  <strong>Names in no list:</strong>{' '}
                  {log.unrecognised.map((m) => `${m.entity} (${m.rows})`).join(', ')}. These
                  cannot be attributed to any subject.
                </p>
              ) : null}
            </Banner>
          </div>
        ) : (
          <p className="border-t hair px-4 py-3 text-xs" style={{ color: 'var(--ink-faint)' }}>
            Every entry uses a declared entity name, and every id is a row of the table
            its entity names. Migration 0021 holds the vocabulary as a database
            constraint, so that stays true.
          </p>
        )}

        <p className="border-t hair px-4 py-3 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
          Retention is unbounded. COUNSEL.md question 4 asks what it should be; until that
          is answered nothing here is deleted, and nothing can be — the table refuses
          UPDATE and DELETE outright.
        </p>
      </Section>
    </>
  );
}
