/**
 * The facts a referral cannot be made without — Civil Code §§ 1812.524 and 1812.529.
 *
 * WHAT WAS MISSING, AND WHY IT WAS INVISIBLE.
 *
 * `assertCaseReferable` refuses a private duty nursing referral that cannot produce a
 * § 1812.529 log sheet, and the log sheet needs five facts: the patient's name, the
 * address care is given at, the ordering physician, the date service begins and the fee
 * charged. Three of them live on `households` and two on `cases`.
 *
 * The only production INSERT into `households` was `convertInquiry`, which names eleven
 * columns — and `cr_address` and `physician_name` are not among them. There was no
 * UPDATE of `households` anywhere in the application at all. So those three facts had no
 * writer: not a screen the operator had not found, but no code path in the system.
 *
 * Which made every surface built around them unreachable in the same way. `/match` prints
 * `ASSIGNMENT_FIELDS[f].fix` — "Add the address care is given at to the household." — above
 * the sentence "Open the case to fill them in", and the case screen had nothing to fill
 * them in with. `/register`'s blocked list said "Fill those in on the household and the
 * case first". `assert_physician_for_skilled` refused every skilled case the status change
 * to `referred`, correctly, permanently. The gate worked. Nothing could ever pass it.
 *
 * This is the writer. It is deliberately not a general household editor: it writes the
 * statutory facts and the fields that travel with them, by name, and nothing else.
 *
 * WHAT IT REFUSES, AND WHAT IT ONLY SAYS.
 *
 * It refuses to take a fact away that a record already stands on — an ordering physician
 * under a live skilled case, a patient name or address the register has already sworn to.
 * It does not refuse a correction, because a record that cannot be corrected is a record
 * that has to be wrong forever, and `ASSIGNMENT_LOG_CORRECTION` exists precisely so that
 * the register can follow one.
 *
 * What it does instead, where a change makes a filed log sheet disagree with the record
 * it was taken from, is say so — naming the entries, because § 1812.529 forbids false
 * entries and a sheet that no longer matches the household record is the beginning of
 * one. The write still happens. A correction is the operator's to file, from `/register`,
 * which is the one screen that can do it.
 *
 * NOTHING HERE INVENTS A VALUE. No field defaults, no date is "today" because the
 * household never said, and the posted fee schedule is shown beside the fee rather than
 * filled into it. `src/domain/assignment.ts` is explicit about why: a fee basis derived
 * from a schedule maximum nobody agreed to is exactly the false entry the section names.
 */
import { getDb, type Tx } from '@h-hallows/core/db';
import {
  ASSIGNMENT_FIELDS, assignmentMissing, isSkilled,
  type AssignmentField,
} from '@h-hallows/core/domain';
import { audit, type AuditContext } from '@/lib/audit';

export class StatutoryFactsError extends Error {}

/**
 * Something worth saying about a write that still happened.
 *
 * Returned to the screen rather than recorded and swallowed. The audit diff keeps these
 * too, but an operator who has just made a filed register entry disagree with the record
 * is entitled to read that at the moment it happens — not to have it discoverable later
 * in a log that says they were told.
 */
export interface FactNote {
  /** Short machine-ish tag, for the audit diff. */
  concern: string;
  /** What to say to the operator. */
  message: string;
}

/** The three § 1812.529 facts that live on the household, and what travels with them. */
export interface HouseholdFactsInput {
  crName: string | null;
  crAge: number | null;
  crAddress: string | null;
  crAccessNotes: string | null;
  physicianName: string | null;
  physicianPractice: string | null;
  physicianPhone: string | null;
  physicianFax: string | null;
}

/** The two that live on the case, and the terms they are read beside. */
export interface CaseTermsInput {
  startsOn: string | null;
  endsOn: string | null;
  hoursPerWeek: number | null;
  feePct: number | null;
  rateAgreed: number | null;
}

export interface Written {
  /** Column names that actually changed. Empty where the form was submitted unchanged. */
  changed: string[];
  notes: FactNote[];
}

function trimmed(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function same(a: string | null, b: string | null): boolean {
  return (a ?? '') === (b ?? '');
}

/**
 * How many live § 1812.529 entries a household or case has.
 *
 * Live meaning not already superseded: a correction is itself a sheet that points at the
 * one it replaces, so an entry with a correction filed against it is history, and saying
 * it disagrees with the record would be saying so about a row the register already shows
 * struck through.
 */
async function liveSheetCount(
  tx: Tx, scope: { householdId: string } | { caseId: string },
): Promise<number> {
  const byCase = 'caseId' in scope;
  const [row] = await tx.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM assignment_log a
       JOIN cases c ON c.id = a.case_id
      WHERE ${byCase ? 'a.case_id = $1' : 'c.household_id = $1'}
        AND NOT EXISTS (SELECT 1 FROM assignment_log s WHERE s.corrects_id = a.id)`,
    [byCase ? scope.caseId : scope.householdId],
  );
  return Number(row?.n ?? 0);
}

/**
 * The live entries that no longer state what the record states.
 *
 * Compared in SQL, not in TypeScript, because `assignment_log.service_from` is a
 * `timestamptz` holding a `date` — `ASSIGNMENT_LOG_INSERT` selects `c.starts_on` straight
 * into it — and reading it back as text gives `2026-11-25 00:00:00+00`, which is not
 * equal to `2026-11-25` however true it is. Casting it back to a date on the way out is
 * worse than useless: the conversion depends on the session TimeZone, and on a managed
 * Postgres running UTC `(service_from AT TIME ZONE 'America/Los_Angeles')::date` moves
 * every start date a day earlier. Putting the new value through `$n::date::timestamptz`
 * sends both sides through the same conversion the INSERT used, so they agree whatever
 * the session is set to. This is the clock class `src/testing/sqlClock.ts` exists for,
 * met for the first time in the other direction.
 */
async function staleSheets(
  tx: Tx,
  scope: { householdId: string } | { caseId: string },
  next: {
    patientName?: string | null; patientAddress?: string | null;
    attendingPhysician?: string | null;
    serviceFrom?: string | null; serviceTo?: string | null;
  },
): Promise<string[]> {
  const byCase = 'caseId' in scope;
  const predicates: string[] = [];
  const params: unknown[] = [byCase ? scope.caseId : scope.householdId];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    predicates.push(sql.replace('$n', `$${params.length}`));
  };
  if ('patientName' in next) add('a.patient_name IS DISTINCT FROM $n', next.patientName);
  if ('patientAddress' in next) {
    add('a.patient_address IS DISTINCT FROM $n', next.patientAddress);
  }
  if ('attendingPhysician' in next) {
    add('a.attending_physician IS DISTINCT FROM $n', next.attendingPhysician);
  }
  if ('serviceFrom' in next) {
    add('a.service_from IS DISTINCT FROM $n::date::timestamptz', next.serviceFrom);
  }
  if ('serviceTo' in next) {
    add('a.service_to IS DISTINCT FROM $n::date::timestamptz', next.serviceTo);
  }
  if (predicates.length === 0) return [];

  const rows = await tx.query<{ id: string }>(
    `SELECT a.id
       FROM assignment_log a
       JOIN cases c ON c.id = a.case_id
      WHERE ${byCase ? 'a.case_id = $1' : 'c.household_id = $1'}
        AND NOT EXISTS (SELECT 1 FROM assignment_log s WHERE s.corrects_id = a.id)
        AND (${predicates.join(' OR ')})`,
    params,
  );
  return rows.map((r) => r.id);
}

/** One note naming the entries that no longer state what the record states. */
function divergenceNote(ids: string[], what: string): FactNote | null {
  if (ids.length === 0) return null;
  const subject = ids.length === 1
    ? 'One entry in the assignment register no longer matches'
    : `${ids.length} entries in the assignment register no longer match`;
  return {
    concern: 'register_disagrees',
    message: `Saved. ${subject} the ${what} on this record. Civil Code § 1812.529 `
      + 'forbids a false entry, and the register corrects one by filing a new entry '
      + 'against it — do that from the register.',
  };
}

/** What a set of facts still cannot supply, phrased as the statute names it. */
function stillMissing(missing: readonly AssignmentField[]): FactNote | null {
  if (missing.length === 0) return null;
  return {
    concern: 'still_unreferable',
    message: 'Saved, and this case still cannot be referred: it is missing '
      + missing.map((f) => ASSIGNMENT_FIELDS[f].label.replace(/^The /, 'the ')).join(', ')
      + '.',
  };
}

/**
 * Write the household's statutory facts.
 *
 * The UPDATE names its eight columns. A household row holds the decision-maker's details,
 * the payment method, the partner it came from and a free-text note, and none of them is
 * this screen's business — an `UPDATE households SET ...` built from whatever the form
 * posted is how the referral partner on a record changes because a field was left blank.
 */
export async function recordHouseholdFacts(
  ctx: AuditContext, householdId: string, input: HouseholdFactsInput,
): Promise<Written> {
  const db = await getDb();
  const next: HouseholdFactsInput = {
    crName: trimmed(input.crName),
    crAge: input.crAge,
    crAddress: trimmed(input.crAddress),
    crAccessNotes: trimmed(input.crAccessNotes),
    physicianName: trimmed(input.physicianName),
    physicianPractice: trimmed(input.physicianPractice),
    physicianPhone: trimmed(input.physicianPhone),
    physicianFax: trimmed(input.physicianFax),
  };

  return db.transaction(async (tx) => {
    const [before] = await tx.query<{
      cr_name: string | null; cr_age: number | null; cr_address: string | null;
      cr_access_notes: string | null; physician_name: string | null;
      physician_practice: string | null; physician_phone: string | null;
      physician_fax: string | null;
    }>(
      `SELECT cr_name, cr_age, cr_address, cr_access_notes, physician_name,
              physician_practice, physician_phone, physician_fax
         FROM households
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [householdId],
    );
    if (!before) throw new StatutoryFactsError('That household is not on the register.');

    /*
     * Taking the physician away from a live skilled case.
     *
     * `assert_physician_for_skilled` fires on a TRANSITION of `cases` — insert, status
     * change, or care type change — which is the right shape for the case side: firing
     * on every update would permanently lock a legacy skilled case that lacks a
     * physician, so that it could never be edited even to add one. The consequence is
     * that the trigger says nothing about an UPDATE of `households`, and clearing
     * `physician_name` under an already-referred skilled case is a write the database
     * accepts. It has never happened, because until now nothing could write that column
     * at all. It is refused here.
     *
     * The database is still the better place for it and this is not a substitute: a
     * BEFORE UPDATE guard on `households` would hold against the seed and against a
     * hand-run statement too. That is a core migration, recorded in NEXT.md.
     */
    if (before.physician_name?.trim() && next.physicianName === null) {
      const live = await tx.query<{ id: string; status: string; care: string }>(
        `SELECT id, status::text AS status, care::text AS care
           FROM cases
          WHERE household_id = $1 AND deleted_at IS NULL
            AND status IN ('referred', 'active')`,
        [householdId],
      );
      const skilled = live.filter((c) => isSkilled(c.care));
      if (skilled.length > 0) {
        throw new StatutoryFactsError(
          'This household has a live private duty nursing case, and Civil Code '
          + '§ 1812.524 is why it could reach that status at all: an ordering physician '
          + 'was on the record. Removing the name now would leave a case running that '
          + 'could not have been referred. Correct the name instead of clearing it.',
        );
      }
    }

    // A fact the register has already sworn to cannot be emptied — only corrected.
    const sheets = await liveSheetCount(tx, { householdId });
    if (before.cr_name?.trim() && next.crName === null && sheets > 0) {
      throw new StatutoryFactsError(
        'The assignment register already names this patient. Clearing the name would '
        + 'leave entries naming a patient the record does not. Correct it instead.',
      );
    }
    if (before.cr_address?.trim() && next.crAddress === null && sheets > 0) {
      throw new StatutoryFactsError(
        'The assignment register already states the address care is given at. Clearing '
        + 'it would leave entries stating an address the record does not. Correct it '
        + 'instead.',
      );
    }

    const changed: string[] = [];
    if (!same(before.cr_name, next.crName)) changed.push('cr_name');
    if ((before.cr_age ?? null) !== (next.crAge ?? null)) changed.push('cr_age');
    if (!same(before.cr_address, next.crAddress)) changed.push('cr_address');
    if (!same(before.cr_access_notes, next.crAccessNotes)) changed.push('cr_access_notes');
    if (!same(before.physician_name, next.physicianName)) changed.push('physician_name');
    if (!same(before.physician_practice, next.physicianPractice)) {
      changed.push('physician_practice');
    }
    if (!same(before.physician_phone, next.physicianPhone)) changed.push('physician_phone');
    if (!same(before.physician_fax, next.physicianFax)) changed.push('physician_fax');

    if (changed.length === 0) return { changed, notes: [] };

    await tx.query(
      `UPDATE households
          SET cr_name = $2, cr_age = $3, cr_address = $4, cr_access_notes = $5,
              physician_name = $6, physician_practice = $7, physician_phone = $8,
              physician_fax = $9
        WHERE id = $1 AND deleted_at IS NULL`,
      [
        householdId, next.crName, next.crAge, next.crAddress, next.crAccessNotes,
        next.physicianName, next.physicianPractice, next.physicianPhone, next.physicianFax,
      ],
    );

    const notes: FactNote[] = [];
    const stale = await staleSheets(tx, { householdId }, {
      patientName: next.crName,
      patientAddress: next.crAddress,
      attendingPhysician: next.physicianName,
    });
    const note = divergenceNote(stale, 'patient, address or physician');
    if (note) notes.push(note);

    await audit({
      ...ctx, action: 'update', entity: 'household', entityId: householdId,
      diff: {
        wrote: changed,
        section: 'Civil Code §§ 1812.524, 1812.529',
        /*
         * Which fields moved, not what they moved to. The audit log is read to answer
         * who looked at a household and who changed it; copying the patient's address
         * into a diff would put it in a second, permanently append-only place, and the
         * record itself already holds the current value.
         */
        registerEntriesNowStale: stale,
      },
    }, tx);

    return { changed, notes };
  });
}

/**
 * Write the case's engagement terms.
 *
 * `fee_pct` is here and nothing proposes it. The posted § 1812.527 schedule states the
 * maximum the registry may charge and is shown beside the field, as a fact to type
 * against; a fee above it is said and not refused, because whether a schedule posted to
 * nurses binds the percentage charged to a household is a question for counsel rather
 * than for a constraint written on a guess.
 */
export async function recordCaseTerms(
  ctx: AuditContext, caseId: string, input: CaseTermsInput,
): Promise<Written> {
  const db = await getDb();

  return db.transaction(async (tx) => {
    const [before] = await tx.query<{
      status: string; care: string; household_id: string;
      starts_on: string | null; ends_on: string | null; hours_per_week: number | null;
      fee_pct: string | null; rate_agreed: string | null;
      cr_name: string | null; cr_address: string | null; physician_name: string | null;
    }>(
      `SELECT c.status::text AS status, c.care::text AS care, c.household_id,
              c.starts_on::text, c.ends_on::text, c.hours_per_week,
              c.fee_pct::text, c.rate_agreed::text,
              h.cr_name, h.cr_address, h.physician_name
         FROM cases c JOIN households h ON h.id = c.household_id
        WHERE c.id = $1 AND c.deleted_at IS NULL
          FOR UPDATE OF c`,
      [caseId],
    );
    if (!before) throw new StatutoryFactsError('That case is not on the register.');
    if (before.status === 'ended') {
      throw new StatutoryFactsError(
        'This engagement has ended. Its terms are what they were, and the register and '
        + 'the measures are both read from them.',
      );
    }

    const next = {
      startsOn: trimmed(input.startsOn),
      endsOn: trimmed(input.endsOn),
      hoursPerWeek: input.hoursPerWeek,
      feePct: input.feePct,
      rateAgreed: input.rateAgreed,
    };

    if (next.startsOn && next.endsOn && next.endsOn < next.startsOn) {
      throw new StatutoryFactsError('Care cannot end before it begins.');
    }
    if (next.endsOn && !next.startsOn) {
      throw new StatutoryFactsError(
        'An end date with no start date would put a service period in the register '
        + 'that has no beginning. Record when care begins first.',
      );
    }

    const sheets = await liveSheetCount(tx, { caseId });
    if (before.starts_on && next.startsOn === null && sheets > 0) {
      throw new StatutoryFactsError(
        'The assignment register already states the date service begins for this case. '
        + 'Clearing it would leave an entry stating a date the case does not. Correct it '
        + 'instead.',
      );
    }

    const feeText = next.feePct === null ? null : String(next.feePct);
    const rateText = next.rateAgreed === null ? null : String(next.rateAgreed);
    const asNum = (v: string | null): number | null => (v === null ? null : Number(v));

    const changed: string[] = [];
    if (!same(before.starts_on, next.startsOn)) changed.push('starts_on');
    if (!same(before.ends_on, next.endsOn)) changed.push('ends_on');
    if ((before.hours_per_week ?? null) !== (next.hoursPerWeek ?? null)) {
      changed.push('hours_per_week');
    }
    if (asNum(before.fee_pct) !== asNum(feeText)) changed.push('fee_pct');
    if (asNum(before.rate_agreed) !== asNum(rateText)) changed.push('rate_agreed');

    /*
     * What this case still cannot supply, computed before the early return rather than
     * after it. Whether a referral can be made is a question about the record, not about
     * whether the operator happened to change anything just now — and a form that comes
     * back saying only "nothing had changed" on a case that still cannot be referred is
     * the screen agreeing with itself instead of answering.
     */
    const gap = stillMissing(assignmentMissing({
      care: before.care,
      patientName: before.cr_name,
      patientAddress: before.cr_address,
      attendingPhysician: before.physician_name,
      startsOn: next.startsOn,
      feePct: feeText,
    }));

    if (changed.length === 0) return { changed, notes: gap ? [gap] : [] };

    await tx.query(
      `UPDATE cases
          SET starts_on = $2::date, ends_on = $3::date, hours_per_week = $4,
              fee_pct = $5::numeric, rate_agreed = $6::numeric
        WHERE id = $1 AND deleted_at IS NULL`,
      [caseId, next.startsOn, next.endsOn, next.hoursPerWeek, feeText, rateText],
    );

    const notes: FactNote[] = [];

    const stale = await staleSheets(tx, { caseId }, {
      serviceFrom: next.startsOn, serviceTo: next.endsOn,
    });
    const note = divergenceNote(stale, 'dates of service');
    if (note) notes.push(note);

    if (changed.includes('fee_pct') && next.feePct !== null) {
      const [schedule] = await tx.query<{ version: number; max_fee_pct: string }>(
        `SELECT version, max_fee_pct::text
           FROM fee_schedules
          WHERE effective_from <= (now() AT TIME ZONE 'America/Los_Angeles')::date
          ORDER BY effective_from DESC, version DESC
          LIMIT 1`,
      );
      if (schedule && next.feePct > Number(schedule.max_fee_pct)) {
        notes.push({
          concern: 'above_posted_schedule',
          message: `Saved. That is above the ${Number(schedule.max_fee_pct)}% maximum in `
            + `the posted fee schedule, version ${schedule.version}, which every RN and `
            + 'LVN on the roster can read.',
        });
      }
    }

    if (gap) notes.push(gap);

    await audit({
      ...ctx, action: 'update', entity: 'case', entityId: caseId,
      diff: {
        wrote: changed,
        section: 'Civil Code §§ 1812.527, 1812.529',
        registerEntriesNowStale: stale,
        notes: notes.map((n) => n.concern),
      },
    }, tx);

    return { changed, notes };
  });
}

/** The in-force posted maximum, for the screen to show beside the fee. Null where none. */
export async function postedFeeMaximum(): Promise<{ version: number; maxFeePct: number } | null> {
  const { query } = await getDb();
  const [row] = await query<{ version: number; max_fee_pct: string }>(
    `SELECT version, max_fee_pct::text
       FROM fee_schedules
      WHERE effective_from <= (now() AT TIME ZONE 'America/Los_Angeles')::date
      ORDER BY effective_from DESC, version DESC
      LIMIT 1`,
  );
  return row ? { version: Number(row.version), maxFeePct: Number(row.max_fee_pct) } : null;
}
