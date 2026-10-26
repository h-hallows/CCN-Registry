import { requireOperator } from '@/lib/operator';
import { listProvidersWithStanding } from '@/lib/queries/providers';
import {
  CredentialPill, Eligibility, Empty, Rate, RowLink, Section,
} from '@/components/ui';
import { worstRequiredStatus } from '@ccn/core/domain';

export const dynamic = 'force-dynamic';

const TYPES = ['RN', 'LVN', 'CNA', 'HCA', 'companion'] as const;

interface Filters {
  type?: string; area?: string; language?: string; eligibility?: string;
  block?: string; q?: string;
}

export default async function RosterPage({
  searchParams,
}: { searchParams: Promise<Filters> }) {
  const { ctx } = await requireOperator();
  const f = await searchParams;
  const today = new Date();
  const all = await listProvidersWithStanding(ctx, today);

  const areas = [...new Set(all.flatMap((s) => s.provider.areas))].sort();
  const languages = [...new Set(all.flatMap((s) => s.provider.languages))].sort();

  const needle = f.q?.trim().toLowerCase() ?? '';
  const rows = all.filter((s) => {
    const p = s.provider;
    if (f.type && p.type !== f.type) return false;
    if (f.area && !p.areas.includes(f.area)) return false;
    if (f.language && !p.languages.includes(f.language)) return false;
    if (f.eligibility === 'eligible' && !s.eligibility.eligible) return false;
    if (f.eligibility === 'ineligible' && s.eligibility.eligible) return false;
    if (f.block && !p.availability.includes(f.block)) return false;
    if (needle) {
      const haystack = [p.fullName, p.preferredName ?? '', ...p.specialties].join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  // Ineligible providers sort last and show the specific blocking credential (§ 5).
  rows.sort((a, b) =>
    Number(b.eligibility.eligible) - Number(a.eligibility.eligible)
    || a.provider.fullName.localeCompare(b.provider.fullName));

  const blocks = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .flatMap((d) => ['AM', 'PM', 'NOC'].map((b) => `${d}:${b}`));

  return (
    <>
      <div className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">Roster</h1>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          {rows.length} of {all.length} referred providers · {all.filter((s) => s.eligibility.eligible).length} eligible
        </p>
      </div>

      <form className="card mb-4 grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <label className="label" htmlFor="q">Name or specialty</label>
          <input id="q" name="q" defaultValue={f.q ?? ''} className="input" placeholder="Search" />
        </div>
        <div>
          <label className="label" htmlFor="type">Type</label>
          <select id="type" name="type" defaultValue={f.type ?? ''} className="select">
            <option value="">Any</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="area">Area</label>
          <select id="area" name="area" defaultValue={f.area ?? ''} className="select">
            <option value="">Any</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="language">Language</label>
          <select id="language" name="language" defaultValue={f.language ?? ''} className="select">
            <option value="">Any</option>
            {languages.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="eligibility">Eligibility</label>
          <select id="eligibility" name="eligibility" defaultValue={f.eligibility ?? ''} className="select">
            <option value="">Any</option>
            <option value="eligible">Eligible</option>
            <option value="ineligible">Not eligible</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="block">Availability block</label>
          <select id="block" name="block" defaultValue={f.block ?? ''} className="select">
            <option value="">Any</option>
            {blocks.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div className="col-span-2 flex items-end gap-2 sm:col-span-3 lg:col-span-6">
          <button type="submit" className="btn btn-primary">Apply</button>
          <a href="/roster" className="btn">Clear</a>
        </div>
      </form>

      <Section title="Referred providers" blurb="Providers with a blocking credential sort last and name the credential.">
        {rows.length === 0 ? (
          <Empty>No provider matches these filters.</Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Type</th><th>Rate</th><th>Areas</th><th>Specialties</th>
                  <th>Credentials</th><th>Placements</th><th>Avg weeks</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.provider.id}>
                    <td>
                      <RowLink href={`/roster/${s.provider.id}`}>{s.provider.fullName}</RowLink>
                      {s.provider.status !== 'active' ? (
                        <span className="ml-1.5 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
                          {s.provider.status === 'inactive' ? 'inactive' : 'not referring'}
                        </span>
                      ) : null}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>{s.provider.type}</td>
                    <td><Rate hourly={s.provider.rateHourly} notes={s.provider.rateNotes} /></td>
                    <td style={{ color: 'var(--ink-soft)' }}>{s.provider.areas.join(', ') || '—'}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {s.provider.specialties.map((x) => x.replace(/_/g, ' ')).join(', ') || '—'}
                    </td>
                    <td>
                      {s.eligibility.eligible
                        ? <CredentialPill status={worstRequiredStatus(
                            s.provider,
                            s.credentials.map((c) => ({ type: c.type, expiresOn: c.expiresOn })),
                            today,
                          )} />
                        : <Eligibility eligible={false} reason={s.eligibility.reason} />}
                    </td>
                    <td className="nums" style={{ color: 'var(--ink-soft)' }}>{s.placements}</td>
                    <td className="nums" style={{ color: 'var(--ink-soft)' }}>
                      {s.avgEngagementWeeks ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <p className="text-[0.6875rem] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        Availability shown on a provider&rsquo;s own record is the availability they stated.
        {' '}The registry records it; it does not set it.
      </p>
    </>
  );
}
