import { requireOperator } from '@/lib/operator';
import {
  BANDED_SERVICES, CARE_LABEL, CREDENTIAL_LEVELS, CREDENTIAL_LEVEL_LABEL,
  rateBands, type Band,
} from '@/lib/queries/rates';
import { postRateBandAction } from '@/app/(app)/actions';
import { ActionForm } from '@/components/ActionForm';
import { Banner, Empty, Section, shortDate, shortDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

function money(n: number): string {
  return `$${n.toFixed(2).replace(/\.00$/, '')}`;
}

function Stat({ label, value, note, tone }: {
  label: string; value: string; note?: string; tone?: string;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="nums text-lg font-semibold leading-tight" style={{ color: tone }}>
        {value}
      </div>
      {note ? (
        <div className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--ink-faint)' }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

function BandRow({ band }: { band: Band }) {
  const tone = band.inForce
    ? 'var(--color-ok)'
    : band.upcoming ? 'var(--color-upcoming)' : 'var(--ink-faint)';
  const state = band.inForce ? 'On the page now' : band.upcoming ? 'Takes effect' : 'Superseded';
  return (
    <tr className="border-t hair" style={band.superseded ? { opacity: 0.6 } : undefined}>
      <td className="px-4 py-2 text-sm whitespace-nowrap">{band.serviceLabel}</td>
      <td className="px-4 py-2 text-sm whitespace-nowrap">{band.levelLabel}</td>
      <td className="px-4 py-2 nums text-sm whitespace-nowrap">
        <span style={band.superseded ? { textDecoration: 'line-through' } : undefined}>
          {money(band.low)}–{money(band.high)}
        </span>
        <span className="ml-1 text-xs" style={{ color: 'var(--ink-faint)' }}>/hr</span>
      </td>
      <td className="px-4 py-2 nums text-xs whitespace-nowrap">
        <span style={{ color: tone }}>{state}</span>
        <span className="ml-2" style={{ color: 'var(--ink-faint)' }}>
          {shortDate(band.effectiveFrom)}
        </span>
      </td>
      <td className="px-4 py-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
        {band.postedBy === 'seed' ? (
          <span style={{ color: 'var(--color-expired)' }}>seeded, never posted</span>
        ) : (
          <>{band.postedBy}, {shortDateTime(band.postedAt)}</>
        )}
      </td>
    </tr>
  );
}

export default async function RatesPage() {
  const { ctx } = await requireOperator();
  const state = await rateBands(ctx);

  const live = state.bands.filter((b) => b.inForce);
  const upcoming = state.bands.filter((b) => b.upcoming);

  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">Published rate bands</h1>
      <p className="mb-4 max-w-3xl text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        What the public pages tell a household that care costs here. Read live from this
        table rather than written into page content, so the number on the page is this
        number — which also means a band that has drifted is a published claim that has
        drifted. Civil Code § 1812.533(b)(1) is about what a page tells the public.
      </p>

      {state.seeded > 0 ? (
        <Banner
          tone="alert"
          title={`${state.seeded} of the ${live.length} bands on the public pages were `
            + 'written by the seed, not posted by anyone'}
        >
          <p>
            They have been serving as the registry’s published prices. Nothing in this
            console had ever written this table, so there was no way to correct them
            except by hand in the database — which is why they are still here.
          </p>
          <p className="mt-2">
            Post a band below to supersede one. The old row stays, because what the page
            said and when is the only thing that can answer a § 1812.533(b)(1) question
            after somebody asks it.
          </p>
        </Banner>
      ) : null}

      {state.unpriced.length > 0 ? (
        <Banner tone="note" title="Services with no band in force">
          <p>
            {state.unpriced.map((s) => s.serviceLabel).join(', ')}. Their pages render the
            empty state — “call us for current ranges” — which is honest and converts
            badly. It is the right state while a service has no roster behind it.
          </p>
        </Banner>
      ) : null}

      <Section
        title="What the roster charges"
        blurb="Active providers with a rate on file, by credential level. This is the
          denominator for every band below it — and it is by LEVEL, not by service,
          because that is what the roster records. A nurse may well ask more for overnight
          work than for daytime companionship."
      >
        <div className="grid gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-5">
          {state.observed.map((o) => (
            <Stat
              key={o.level}
              label={CREDENTIAL_LEVEL_LABEL[o.level]}
              value={o.low === null || o.high === null
                ? '—'
                : `${money(o.low)}–${money(o.high)}`}
              note={o.count === 0
                ? 'none on the roster'
                : o.median === null
                  ? `${o.count} active, no rates on file`
                  : `${o.count} active · middle ${money(o.median)}`}
              tone={o.count === 0 ? 'var(--ink-faint)' : undefined}
            />
          ))}
        </div>
        <p className="border-t hair px-4 py-2.5 text-xs leading-relaxed"
          style={{ color: 'var(--ink-faint)' }}>
          Nothing here fills a band in for you, and there is no button that would. A
          provider sets their own rate and it stays negotiable with the household (I5);
          a console that proposed a price would be the registry setting one with extra
          steps. These are the facts to type a band against, not a suggestion.
        </p>
      </Section>

      <Section
        title="Post a band"
        blurb="Append-only. A band is posted and superseded, never amended — date it ahead
          to plan a change, or date it today to correct one."
      >
        <div className="px-4 py-4">
          <ActionForm action={postRateBandAction} submitLabel="Post it" primary resetOnSuccess>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className="label">Service</span>
                <select name="serviceKey" required defaultValue="personal_care"
                  className="input mt-1">
                  {BANDED_SERVICES.map((s) => (
                    <option key={s} value={s}>{CARE_LABEL[s]}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Credential level</span>
                <select name="level" required defaultValue="cna" className="input mt-1">
                  {CREDENTIAL_LEVELS.map((l) => (
                    <option key={l} value={l}>{CREDENTIAL_LEVEL_LABEL[l]}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Takes effect</span>
                <input type="date" name="effectiveFrom" required
                  defaultValue={state.today} className="input mt-1" />
              </label>
              <label className="block">
                <span className="label">Bottom of the band</span>
                <input type="number" name="low" required min="1" step="0.5"
                  className="input mt-1" placeholder="40" />
              </label>
              <label className="block">
                <span className="label">Top of the band</span>
                <input type="number" name="high" required min="1" step="0.5"
                  className="input mt-1" placeholder="55" />
              </label>
              <label className="block lg:col-span-1">
                <span className="label">Note shown with it</span>
                <input type="text" name="note" className="input mt-1"
                  defaultValue="Provider-set and negotiated directly with the household." />
              </label>
            </div>
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              A band is published as a range and always carries the negotiable marker. A
              single number would read as a price list, which this is not. If the band
              sits outside what the roster charges you will be told so and the band will
              still post — the observation is by credential level and the band is by
              service, and that gap is a judgement rather than a rule.
            </p>
          </ActionForm>
        </div>
      </Section>

      <Section
        title="On the pages now"
        blurb="The newest band for each service and level whose date has arrived. This is
          what a household reading the pricing page sees today."
        right={(
          <span className="nums text-xs" style={{ color: 'var(--ink-faint)' }}>
            {live.length} live · {upcoming.length} dated ahead
          </span>
        )}
      >
        {state.bands.length === 0 ? (
          <Empty>No band has been posted. Every pricing page renders its empty state.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="px-4 py-2">Service</th>
                  <th className="px-4 py-2">Level</th>
                  <th className="px-4 py-2">Band</th>
                  <th className="px-4 py-2">State</th>
                  <th className="px-4 py-2">Posted by</th>
                </tr>
              </thead>
              <tbody>
                {state.bands.map((b) => <BandRow key={b.id} band={b} />)}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
