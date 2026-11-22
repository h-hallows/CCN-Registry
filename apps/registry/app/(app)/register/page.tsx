import Link from 'next/link';
import { requireOperator } from '@/lib/operator';
import {
  ASSIGNMENT_FIELDS, blockers, integrity, register,
  type Blocker, type LogSheet, type Unlogged,
} from '@/lib/queries/register';
import {
  fileAssignmentCorrectionAction, fileMissingAssignmentEntryAction,
} from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import {
  Banner, Empty, Field, preciseDateTime, RowLink, Section, shortDate, shortDateTime,
} from '@/components/ui';
import { CARE_LABEL, type AssignmentField } from '@h-hallows/core/domain';

export const dynamic = 'force-dynamic';

function careLabel(care: string): string {
  return CARE_LABEL[care as keyof typeof CARE_LABEL] ?? care;
}

function fieldLabel(field: AssignmentField): string {
  return ASSIGNMENT_FIELDS[field].label.replace(/^The /, '');
}

/**
 * A statutory field the household record cannot supply, and what to do about it.
 *
 * The `fix` strings have always been here. What was not here was anywhere to do them:
 * no screen in the console could write `cr_address` or `physician_name`, so this list
 * named a remedy that did not exist and these rows could never clear. The link is to
 * the form that writes them.
 */
function Missing({
  fields, caseId,
}: { fields: readonly AssignmentField[]; caseId?: string }) {
  return (
    <>
      <ul className="space-y-1">
        {fields.map((f) => {
          const def: { label: string; fix?: string } = ASSIGNMENT_FIELDS[f];
          return (
            <li key={f} className="text-xs leading-snug">
              <span style={{ color: 'var(--color-expired)' }}>{fieldLabel(f)}</span>
              {def.fix ? (
                <span style={{ color: 'var(--ink-faint)' }}> — {def.fix}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {caseId ? (
        <Link
          href={`/cases/${caseId}#facts`}
          className="mt-1 inline-block text-xs underline underline-offset-4"
          style={{ color: 'var(--accent)' }}
        >
          Record them on the case
        </Link>
      ) : null}
    </>
  );
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

/** One log sheet. A correction renders under the entry it replaces. */
function Sheet({ sheet }: { sheet: LogSheet }) {
  const correction = sheet.correctsId !== null;
  return (
    <div
      className={`border-t hair px-4 py-3 ${correction ? 'pl-8' : ''}`}
      style={correction ? { background: 'var(--accent-soft)' } : undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-sm font-medium">
          <span className={sheet.superseded ? 'line-through' : undefined}>
            {sheet.patientName}
          </span>
          <span style={{ color: 'var(--ink-faint)' }}>
            {' · '}
            <RowLink href={`/cases/${sheet.caseId}`}>{sheet.household}</RowLink>
          </span>
        </div>
        <div className="nums text-xs" style={{ color: 'var(--ink-faint)' }}>
          {correction ? 'Correction filed ' : 'Entered '}
          {preciseDateTime(sheet.createdAt)} by {sheet.recordedBy}
          {sheet.enteredAfterDays > 0 ? (
            <span style={{ color: 'var(--color-soon)' }}>
              {` · ${sheet.enteredAfterDays} day${sheet.enteredAfterDays === 1 ? '' : 's'} after the assignment`}
            </span>
          ) : null}
        </div>
      </div>

      {sheet.correctionNote ? (
        <p className="mt-1 text-xs leading-snug" style={{ color: 'var(--ink-soft)' }}>
          <strong>Corrects the entry above:</strong> {sheet.correctionNote}
        </p>
      ) : null}
      {sheet.superseded ? (
        <p className="mt-1 text-xs" style={{ color: 'var(--color-soon)' }}>
          Superseded by the correction below. It stays in the register.
        </p>
      ) : null}

      <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Address care is given at">{sheet.patientAddress}</Field>
        <Field label="Attending physician">{sheet.attendingPhysician}</Field>
        <Field label="Nurse referred">
          <RowLink href={`/roster/${sheet.providerId}`}>{sheet.nurse}</RowLink>
        </Field>
        <Field label="Order received">{preciseDateTime(sheet.orderReceivedAt)}</Field>
        <Field label="Service from">{shortDate(sheet.serviceFrom)}</Field>
        <Field label="Service to">
          {sheet.serviceTo ? shortDate(sheet.serviceTo) : (
            <span style={{ color: 'var(--ink-faint)' }}>Open — the assignment has not ended</span>
          )}
        </Field>
        <Field label="Fee charged">{sheet.feeBasis}</Field>
      </div>

      {sheet.superseded ? null : (
        <div className="mt-3">
          <Disclose summary="File a correction" tone="quiet">
            <p className="mb-2 text-xs leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
              Nothing is edited. This files a new entry saying what this one should have
              said, pointing at it, with your note explaining the pair. Both stay in the
              register — that is what makes “no false entries” answerable.
            </p>
            <ActionForm
              action={fileAssignmentCorrectionAction}
              submitLabel="File the correction"
              confirm="File a correction? The original entry stays in the register permanently."
            >
              <input type="hidden" name="entryId" value={sheet.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="label">Patient</span>
                  <input className="input" name="patientName" defaultValue={sheet.patientName} />
                </label>
                <label className="block">
                  <span className="label">Address care is given at</span>
                  <input className="input" name="patientAddress"
                    defaultValue={sheet.patientAddress} />
                </label>
                <label className="block">
                  <span className="label">Attending physician</span>
                  <input className="input" name="attendingPhysician"
                    defaultValue={sheet.attendingPhysician} />
                </label>
                <label className="block">
                  <span className="label">Fee charged</span>
                  <input className="input" name="feeBasis" defaultValue={sheet.feeBasis} />
                </label>
                <label className="block">
                  <span className="label">Service from</span>
                  <input className="input nums" type="date" name="serviceFrom"
                    defaultValue={sheet.serviceFrom.slice(0, 10)} />
                </label>
                <label className="block">
                  <span className="label">Service to (blank if open)</span>
                  <input className="input nums" type="date" name="serviceTo"
                    defaultValue={sheet.serviceTo ? sheet.serviceTo.slice(0, 10) : ''} />
                </label>
                <label className="block sm:col-span-2">
                  <span className="label">What was wrong with the original entry</span>
                  <textarea className="textarea" name="note" rows={2}
                    placeholder="The house number was transposed." />
                </label>
              </div>
            </ActionForm>
          </Disclose>
        </div>
      )}
    </div>
  );
}

function Gap({ row }: { row: Unlogged }) {
  const fillable = row.missing.length === 0;
  return (
    <div className="border-t hair px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-sm font-medium">
          <RowLink href={`/cases/${row.caseId}`}>{row.household}</RowLink>
          <span style={{ color: 'var(--ink-faint)' }}>
            {` · ${careLabel(row.care)} · ${row.nurse}`}
          </span>
        </div>
        <span className="nums text-xs" style={{ color: 'var(--ink-faint)' }}>
          Referred {shortDate(row.referredAt)}
        </span>
      </div>
      {fillable ? (
        <div className="mt-2">
          <ActionForm
            action={fileMissingAssignmentEntryAction}
            submitLabel="Enter it now, dated today"
            primary
            confirm="File this entry? It will be dated today, and the register will show it was filed late."
          >
            <input type="hidden" name="referralId" value={row.referralId} />
          </ActionForm>
        </div>
      ) : (
        <div className="mt-2">
          <p className="mb-1 text-xs" style={{ color: 'var(--ink-soft)' }}>
            The household record cannot supply this entry yet:
          </p>
          <Missing fields={row.missing} caseId={row.caseId} />
        </div>
      )}
    </div>
  );
}

function BlockedCase({ row }: { row: Blocker }) {
  return (
    <tr className="border-t hair">
      <td className="px-4 py-2 text-sm">
        <RowLink href={`/cases/${row.caseId}`}>{row.household}</RowLink>
      </td>
      <td className="px-4 py-2 text-sm">{careLabel(row.care)}</td>
      <td className="px-4 py-2 text-sm" style={{ color: 'var(--ink-faint)' }}>{row.status}</td>
      <td className="px-4 py-2">
        <Missing fields={row.missing} caseId={row.caseId} />
      </td>
    </tr>
  );
}

export default async function RegisterPage({ searchParams }: {
  searchParams: Promise<{ case?: string; provider?: string; household?: string }>;
}) {
  const { ctx } = await requireOperator();
  const params = await searchParams;
  const filter = {
    caseId: params.case,
    providerId: params.provider,
    householdId: params.household,
  };
  const filtered = Boolean(filter.caseId || filter.providerId || filter.householdId);

  const [page, state, blocked] = await Promise.all([
    register(ctx, filter),
    integrity(ctx),
    blockers(),
  ]);
  const { sheets } = page;

  const logged = state.nursingReferrals - state.unlogged.length;

  return (
    <div className="wrap py-6">
      <header className="mb-4">
        <h1 className="text-lg font-semibold">The assignment register</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          Civil Code § 1812.529 asks a nurses’ registry to keep permanent log sheets of
          every order for nursing service and every assignment made from it, and forbids
          false entries in them. A sheet is written in the same transaction as the
          referral it records; the database refuses a private duty nursing referral that
          arrives without one. Nothing here can be edited — a mistake is corrected by a
          new entry that supersedes the old one and says why.
        </p>
      </header>

      {state.unlogged.length > 0 ? (
        <Banner tone="alert" title={`${state.unlogged.length} nursing referrals have no log sheet`}>
          These were made before the entry became part of the referral transaction. The
          table is append-only and nothing back-filled them, because an entry invented to
          close a gap is the false entry the section prohibits. Each one below can be
          filed now from the household record, dated today.
        </Banner>
      ) : null}

      {filtered ? (
        <Banner tone="note" title="Showing part of the register">
          <Link href="/register" className="underline">Show the whole register</Link>
        </Banner>
      ) : null}

      <Section
        title="What the register holds"
        blurb="The counts are the answer to “is it complete?”, which is not the same question as “does the table exist?”."
      >
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Entries" value={String(state.entries)}
            note={state.corrections > 0
              ? `${state.corrections} of them corrections`
              : 'no corrections filed'} />
          <Stat
            label="Nursing referrals logged"
            value={`${logged} / ${state.nursingReferrals}`}
            tone={state.unlogged.length > 0 ? 'var(--color-expired)' : 'var(--color-ok)'}
            note={state.unlogged.length > 0
              ? `${state.unlogged.length} with no sheet`
              : 'every one has its sheet'}
          />
          <Stat label="Filed late" value={String(state.late)}
            tone={state.late > 0 ? 'var(--color-soon)' : undefined}
            note="entered more than a day after the assignment" />
          {/* § 1812.529 asks for the date AND hour the order arrived, and these are
              timestamps, so they are rendered in California rather than sliced. */}
          <Stat label="Earliest order"
            value={state.earliest ? shortDateTime(state.earliest) : '—'} />
          <Stat label="Latest order"
            value={state.latest ? shortDateTime(state.latest) : '—'} />
        </div>
        <div className="border-t hair px-4 py-3">
          <Disclose summary="What § 1812.529 asks each sheet to state" tone="quiet">
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {(Object.keys(ASSIGNMENT_FIELDS) as AssignmentField[]).map((f) => {
                const def: { label: string; source: string; blocking: boolean } =
                  ASSIGNMENT_FIELDS[f];
                return (
                  <div key={f}>
                    <dt className="text-xs font-medium">
                      {def.label}
                      {def.blocking ? (
                        <span className="ml-1.5 text-[0.6875rem]"
                          style={{ color: 'var(--color-expired)' }}>
                          blocks a referral
                        </span>
                      ) : null}
                    </dt>
                    <dd className="text-xs leading-snug" style={{ color: 'var(--ink-faint)' }}>
                      {def.source}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </Disclose>
        </div>
      </Section>

      {state.unlogged.length > 0 ? (
        <Section
          title="Referrals with no entry"
          blurb="Made before the commit check existed. Each entry is written from the household record and dated today, and the register says how long after the assignment it was filed — there is no backdating here, because a sheet claiming to have been written at the time would be the clearest false entry there is."
        >
          {state.unlogged.map((row) => <Gap key={row.referralId} row={row} />)}
        </Section>
      ) : null}

      <Section
        title="Nursing cases that cannot be referred"
        blurb="A log sheet needs these facts, so a referral without them is refused — here rather than halfway through a disclosure call."
      >
        {blocked.length === 0 ? (
          <Empty>
            Every open nursing case has what § 1812.529 needs: a patient, an address, a
            physician, a start date and a fee.
          </Empty>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Household</th>
                  <th>Care</th>
                  <th>Status</th>
                  <th>Missing from the record</th>
                </tr>
              </thead>
              <tbody>
                {blocked.map((row) => <BlockedCase key={row.caseId} row={row} />)}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title={filtered ? 'The log sheets shown' : 'The log sheets'}
        blurb={page.truncated
          ? `The ${page.shown} most recent assignments, of ${page.total} in the register. `
            + 'A correction reads under the entry it replaces. Older assignments are '
            + 'reached by filtering to the household, the nurse or the case — the '
            + 'register is permanent, so it is only ever longer than this.'
          : 'Newest assignment first. A correction reads under the entry it replaces.'}
        right={page.truncated ? (
          <span className="nums text-xs" style={{ color: 'var(--ink-faint)' }}>
            {page.shown} of {page.total}
          </span>
        ) : null}
      >
        {sheets.length === 0 ? (
          <Empty>
            {filtered
              ? 'No log sheets match that filter.'
              : 'No assignments have been logged. Every private duty nursing referral writes one.'}
          </Empty>
        ) : (
          sheets.map((sheet) => <Sheet key={sheet.id} sheet={sheet} />)
        )}
      </Section>
    </div>
  );
}
