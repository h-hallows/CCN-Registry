import { requireOperator } from '@/lib/operator';
import {
  AD_MEDIA, ADVERTISING_WINDOW_DAYS, record, type AdEntry,
} from '@/lib/queries/advertising';
import {
  correctAdvertisementAction, recordAdvertisementAction, withdrawAdvertisementAction,
} from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import { Banner, Empty, Field, Section, shortDate, shortDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

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

function ran(entry: AdEntry): string {
  const from = shortDate(entry.appearedFrom);
  if (entry.appearedTo === null) return `${from} — still appearing`;
  if (entry.appearedTo === entry.appearedFrom) return from;
  return `${from} — ${shortDate(entry.appearedTo)}`;
}

/** The § 1812.533(b)(2) line this advertisement carried, which is why it is recorded. */
function ContactLine({ entry }: { entry: AdEntry }) {
  return (
    <span className="text-xs" style={{ color: 'var(--ink-soft)' }}>
      {entry.carriedName} · {entry.carriedContact}
    </span>
  );
}

function Entry({ entry, fields }: { entry: AdEntry; fields: React.ReactNode }) {
  const correction = entry.correctsId !== null;
  return (
    <div
      className={`border-t hair px-4 py-3 ${correction ? 'pl-8' : ''}`}
      style={correction ? { background: 'var(--accent-soft)' } : undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <span
            className="text-sm font-medium"
            style={entry.superseded ? { textDecoration: 'line-through' } : undefined}
          >
            {entry.publication}
          </span>
          <span className="ml-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {entry.mediumLabel}
          </span>
        </div>
        <span className="nums text-xs whitespace-nowrap" style={{ color: 'var(--ink-soft)' }}>
          {ran(entry)}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <ContactLine entry={entry} />
        <span className="nums text-xs" style={{ color: 'var(--ink-faint)' }}>
          {entry.days} {entry.days === 1 ? 'day' : 'days'}
          {entry.reference ? ` · ${entry.reference}` : ''}
        </span>
      </div>

      {correction ? (
        <p className="mt-1 text-xs leading-snug" style={{ color: 'var(--ink-soft)' }}>
          Correction: {entry.correctionNote}
        </p>
      ) : null}
      {entry.superseded ? (
        <p className="mt-1 text-xs leading-snug" style={{ color: 'var(--ink-faint)' }}>
          Superseded by the correction below. It stays in the record.
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-4">
        <span className="text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
          Recorded by {entry.recordedBy}, {shortDateTime(entry.recordedAt)}
        </span>
        {fields}
      </div>
    </div>
  );
}

export default async function AdvertisingPage() {
  const { ctx } = await requireOperator();
  const state = await record(ctx);
  const { coverage } = state;

  const originals = state.entries.filter((e) => e.correctsId === null);
  const correctionsOf = new Map<string, AdEntry[]>();
  for (const e of state.entries) {
    if (e.correctsId === null) continue;
    correctionsOf.set(e.correctsId, [...(correctionsOf.get(e.correctsId) ?? []), e]);
  }

  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">Advertising record</h1>
      <p className="mb-4 max-w-3xl text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        Civil Code § 1812.533(c): a record of all advertisements, correlated to show the
        date and the publication in which each appeared, reaching back one year. A
        website is an advertisement on every day it is up, so an entry here runs over a
        period rather than naming a date.
      </p>

      {coverage.uncoveredDays > 0 ? (
        <Banner
          tone="alert"
          title={`${coverage.uncoveredDays} ${coverage.uncoveredDays === 1 ? 'day' : 'days'} `
            + 'in the trailing year have nothing recorded against them'}
        >
          <p>
            Which means one of two things, and only you know which. Either nothing was
            advertised on those days, and the record is complete — or something was, and
            this is the gap § 1812.533(c) is about.
          </p>
          <p className="mt-2">
            There is no button for it. An assignment log entry can be filed late and the
            register will say it was late; you cannot retrospectively advertise, and an
            entry written from memory months afterwards is the false record
            § 1812.533(b)(1) prohibits. If you can establish from a deploy log, an
            invoice or a screenshot what ran and when, record it with that evidence as
            the reference. If you cannot, the honest state of the record is this one.
          </p>
        </Banner>
      ) : null}

      <Section
        title="What the record holds"
        blurb={`The trailing year is ${ADVERTISING_WINDOW_DAYS} days to today. It starts `
          + 'at the earliest entry where that is later — a registry has not failed to '
          + 'advertise in the months before it existed.'}
      >
        <div className="grid gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Entries"
            value={String(state.entries.length)}
            note={`${state.publications} ${state.publications === 1 ? 'publication' : 'publications'}`}
          />
          <Stat
            label="Appearing now"
            value={String(state.open.length)}
            note={state.open.length === 0 ? 'nothing is running' : 'open entries'}
          />
          <Stat
            label="Days accounted for"
            value={coverage.empty ? '—' : String(coverage.coveredDays)}
            note={coverage.empty
              ? 'nothing recorded'
              : `of ${coverage.coveredDays + coverage.uncoveredDays}, from ${shortDate(coverage.windowFrom)}`}
          />
          <Stat
            label="Days unaccounted for"
            value={coverage.empty ? '—' : String(coverage.uncoveredDays)}
            /*
             * An empty record is neither green nor red. Reading "the year is covered"
             * under a dash was the first thing this screen said, and it was the one
             * claim it is least entitled to make: nothing is recorded, so nothing is
             * known, and a reassuring note there would be the screen asserting
             * compliance on the strength of an empty table — which is the failure the
             * whole register exists to stop.
             */
            tone={coverage.empty
              ? undefined
              : coverage.uncoveredDays > 0 ? 'var(--color-expired)' : 'var(--color-ok)'}
            note={coverage.empty
              ? 'nothing recorded to check'
              : coverage.uncoveredDays > 0 ? 'listed below' : 'the year is covered'}
          />
        </div>

        {coverage.empty ? (
          <p className="border-t hair px-4 py-3 text-xs leading-relaxed"
            style={{ color: 'var(--ink-soft)' }}>
            The record holds nothing. That is the correct state for a registry that has
            not advertised, and the wrong one for a registry that has — and this screen
            cannot tell the difference, because nothing in a database knows about an
            advertisement nobody entered. The public site is an advertisement from the
            day it is published under a filed name.
          </p>
        ) : null}

        {coverage.stretches.length > 0 ? (
          <div className="border-t hair px-4 py-3">
            <span className="label">Days with nothing recorded</span>
            <ul className="mt-2 space-y-1">
              {coverage.stretches.map((s) => (
                <li key={s.from} className="nums text-xs" style={{ color: 'var(--ink-soft)' }}>
                  {s.from === s.to ? shortDate(s.from) : `${shortDate(s.from)} — ${shortDate(s.to)}`}
                  <span className="ml-2" style={{ color: 'var(--color-expired)' }}>
                    {s.days} {s.days === 1 ? 'day' : 'days'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section
        title="Appearing now"
        blurb="An advertisement that is still running has no end date. Recording the day it
          came down is the only change this record permits, and it is permitted once."
      >
        {state.open.length === 0 ? (
          <Empty>
            Nothing is recorded as currently appearing.
          </Empty>
        ) : (
          state.open.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              fields={(
                <Disclose summary="It came down">
                  <ActionForm
                    action={withdrawAdvertisementAction}
                    submitLabel="Record the withdrawal"
                    confirm={`Record that ${entry.publication} stopped appearing? The day is `
                      + 'recorded once and cannot be changed afterwards.'}
                  >
                    <input type="hidden" name="entryId" value={entry.id} />
                    <label className="block">
                      <span className="label">The last day it appeared</span>
                      <input
                        type="date" name="on" required
                        defaultValue={state.today}
                        min={entry.appearedFrom}
                        max={state.today}
                        className="input mt-1"
                      />
                    </label>
                  </ActionForm>
                </Disclose>
              )}
            />
          ))
        )}
      </Section>

      <Section
        title="Record an advertisement"
        blurb="§ 1812.533(b)(2) requires the registry’s correct name and either its street
          address or its correct telephone number in every advertisement. The record is the
          only thing that can show they were there, so it asks for both and refuses a
          placeholder."
      >
        <div className="px-4 py-4">
          <ActionForm
            action={recordAdvertisementAction}
            submitLabel="Record it"
            primary
            resetOnSuccess
          >
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <label className="block">
                <span className="label">Where it appeared</span>
                <select name="medium" required defaultValue="website" className="input mt-1">
                  {Object.entries(AD_MEDIA).map(([key, def]) => (
                    <option key={key} value={key}>{def.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">The publication</span>
                <input
                  type="text" name="publication" required className="input mt-1"
                  placeholder="the host, the title, the platform"
                />
              </label>
              <label className="block">
                <span className="label">First day it appeared</span>
                <input type="date" name="appearedFrom" required className="input mt-1" />
              </label>
              <label className="block">
                <span className="label">Last day, if it has ended</span>
                <input type="date" name="appearedTo" className="input mt-1" />
              </label>
              <label className="block">
                <span className="label">The name it carried</span>
                <input type="text" name="carriedName" required className="input mt-1" />
              </label>
              <label className="block">
                <span className="label">The address or number it carried</span>
                <input type="text" name="carriedContact" required className="input mt-1" />
              </label>
              <label className="block sm:col-span-2">
                <span className="label">Reference</span>
                <input
                  type="text" name="reference" className="input mt-1"
                  placeholder="a URL, a campaign id, a commit, a page number"
                />
              </label>
            </div>
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              Print, broadcast and mail appeared on a day and are over, so their entries
              close on the day they opened whatever the second date says. Everything else
              runs until it is withdrawn; leave the last day empty while it is still up.
            </p>
          </ActionForm>
        </div>
      </Section>

      <Section
        title="The record"
        blurb="Newest first. A correction sits under the entry it replaces, which stays
          legible — the register is append-only, so nothing is ever edited or removed."
      >
        {originals.length === 0 ? (
          <Empty>No advertisement has been recorded.</Empty>
        ) : (
          originals.map((entry) => (
            <div key={entry.id}>
              <Entry
                entry={entry}
                fields={(
                  <Disclose summary="Correct this entry" tone="quiet">
                    <ActionForm
                      action={correctAdvertisementAction}
                      submitLabel="File the correction"
                    >
                      <input type="hidden" name="entryId" value={entry.id} />
                      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                        <label className="block">
                          <span className="label">First day it appeared</span>
                          <input
                            type="date" name="appearedFrom" required
                            defaultValue={entry.appearedFrom} className="input mt-1"
                          />
                        </label>
                        <label className="block">
                          <span className="label">Last day, if it has ended</span>
                          <input
                            type="date" name="appearedTo"
                            defaultValue={entry.appearedTo ?? ''} className="input mt-1"
                          />
                        </label>
                        <label className="block">
                          <span className="label">The name it carried</span>
                          <input
                            type="text" name="carriedName" required
                            defaultValue={entry.carriedName} className="input mt-1"
                          />
                        </label>
                        <label className="block">
                          <span className="label">The address or number it carried</span>
                          <input
                            type="text" name="carriedContact" required
                            defaultValue={entry.carriedContact} className="input mt-1"
                          />
                        </label>
                        <label className="block sm:col-span-2">
                          <span className="label">Reference</span>
                          <input
                            type="text" name="reference"
                            defaultValue={entry.reference ?? ''} className="input mt-1"
                          />
                        </label>
                        <label className="block sm:col-span-2">
                          <span className="label">What was wrong with the original</span>
                          <input
                            type="text" name="note" required className="input mt-1"
                            placeholder="said in enough words to be read a year from now"
                          />
                        </label>
                      </div>
                      <p className="mt-3 text-xs leading-relaxed"
                        style={{ color: 'var(--ink-faint)' }}>
                        The medium and the publication are copied from the entry being
                        corrected. An advertisement in a different publication is a
                        different advertisement, and belongs in the record as one.
                      </p>
                    </ActionForm>
                  </Disclose>
                )}
              />
              {(correctionsOf.get(entry.id) ?? []).map((fix) => (
                <Entry key={fix.id} entry={fix} fields={null} />
              ))}
            </div>
          ))
        )}
      </Section>

      <Section title="What this record cannot tell you">
        <div className="px-4 py-3">
          <Field label="Why an uncovered day is not a violation" wide>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
              The record knows about advertisements somebody entered. A day with nothing
              against it means the record says nothing ran, which is either true or a
              gap, and nothing in a database can tell the difference. Every other
              compliance screen here puts the remedy beside the problem. This one does
              not, because the only moment it could have been fixed was at the time.
            </p>
          </Field>
          <div className="mt-3">
            <Field label="Why nothing is ever deleted from it" wide>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
                One year is how far back the record must reach, not how long a row is
                kept. The two read alike until somebody writes a job that prunes at 366
                days, which satisfies the misreading and breaches the section the first
                time an inspector asks about thirteen months ago. The database refuses a
                delete and says so.
              </p>
            </Field>
          </div>
        </div>
      </Section>
    </>
  );
}
