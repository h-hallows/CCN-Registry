/**
 * The assignment register — Civil Code § 1812.529. Spec § 9.1.
 *
 * WHAT THIS SCREEN IS FOR. The section asks a nurses' registry to keep permanent log
 * sheets of every order for nursing service and every assignment made from it, naming
 * the patient and their address, the attending physician, the nurse referred, the hour
 * the order arrived, the dates of service and the fee charged — and it forbids false
 * entries in them. The sheets are the thing an inspector asks for by name.
 *
 * `assignment_log` held nothing for the whole of this project's history. Core migration
 * 0023 made the sheet part of the referral transaction and checks for it at COMMIT, so
 * the register fills itself from here on. What this module adds is the other half: being
 * able to READ it, and being able to see the two ways it can still be wrong.
 *
 * THE FIRST IS A GAP. The commit check binds referrals made from now on. Rows written
 * before it existed are untouched — deliberately, because the table is append-only and a
 * migration that back-filled them would be inventing entries for assignments nobody
 * recorded the facts of. So `integrity()` counts the nursing referrals with no sheet and
 * the screen names them, with the one honest remedy: file the entry now, from the
 * household record, and let `created_at` show that it was filed late. A late entry is
 * not a false entry. An invented one is.
 *
 * THE SECOND IS A BLOCKER. Four of the statutory fields are facts about the household
 * the registry must hold before it can send a nurse: who the patient is, where they
 * live, when care begins, and what is charged. Three of them were nullable and unchecked
 * for a year. A case missing any of them cannot be referred at all now, so the screen
 * lists those cases before the operator discovers it halfway through a disclosure call.
 *
 * Every read here is a read of patients' names, home addresses and physicians, so it
 * writes its own audit rows (§ 3.8). Opening the register leaves the same mark as
 * opening the households in it.
 */
import { getDb } from '@h-hallows/core/db';
import type { Tx } from '@h-hallows/core/db';
import {
  ASSIGNMENT_FIELDS, ASSIGNMENT_LOG_CORRECTION, ASSIGNMENT_LOG_INSERT,
  SKILLED_SQL_ARRAY, asISODate, assignmentMissing, feeBasisOf, isSkilled,
  type AssignmentField, type AssignmentFacts,
} from '@h-hallows/core/domain';
import { audit, auditRead, type AuditContext } from '@/lib/audit';

export class RegisterError extends Error {}

/** One log sheet, with the record it describes named in words. */
export interface LogSheet {
  id: string;
  caseId: string;
  referralId: string;
  providerId: string;
  nurse: string;
  householdId: string;
  household: string;
  orderReceivedAt: string;
  patientName: string;
  patientAddress: string;
  attendingPhysician: string;
  serviceFrom: string;
  serviceTo: string | null;
  feeBasis: string;
  recordedBy: string;
  createdAt: string;
  correctsId: string | null;
  correctionNote: string | null;
  /** True where a later sheet corrects this one. The original stays legible either way. */
  superseded: boolean;
  /**
   * Whole days between the assignment being made and the entry being written. Zero for
   * every sheet the referral transaction wrote; anything else is an entry filed late,
   * which the register shows rather than smooths over.
   */
  enteredAfterDays: number;
}

export interface Unlogged {
  referralId: string;
  caseId: string;
  householdId: string;
  household: string;
  nurse: string;
  care: string;
  referredAt: string;
  /** Statutory fields the household record cannot supply, so the entry cannot be filed. */
  missing: AssignmentField[];
}

export interface RegisterIntegrity {
  entries: number;
  corrections: number;
  nursingReferrals: number;
  unlogged: Unlogged[];
  earliest: string | null;
  latest: string | null;
  /** Entries written more than a day after the assignment they record. */
  late: number;
}

export interface Blocker {
  caseId: string;
  householdId: string;
  household: string;
  care: string;
  status: string;
  missing: AssignmentField[];
}

const SHEET_SELECT = `
  SELECT a.id, a.case_id, a.referral_id, a.provider_id, p.full_name AS nurse,
         c.household_id, h.display_name AS household,
         a.order_received_at, a.patient_name, a.patient_address, a.attending_physician,
         a.service_from, a.service_to, a.fee_basis, a.recorded_by, a.created_at,
         a.corrects_id, a.correction_note,
         EXISTS (SELECT 1 FROM assignment_log later WHERE later.corrects_id = a.id)
           AS superseded,
         GREATEST(0, date_part('day', a.created_at - r.referred_at))::int AS entered_after
    FROM assignment_log a
    JOIN referrals r  ON r.id = a.referral_id
    JOIN providers p  ON p.id = a.provider_id
    JOIN cases c      ON c.id = a.case_id
    JOIN households h ON h.id = c.household_id`;

interface SheetRow {
  id: string; case_id: string; referral_id: string; provider_id: string; nurse: string;
  household_id: string; household: string; order_received_at: string | Date;
  patient_name: string; patient_address: string; attending_physician: string;
  service_from: string | Date; service_to: string | Date | null; fee_basis: string;
  recorded_by: string; created_at: string | Date; corrects_id: string | null;
  correction_note: string | null; superseded: boolean; entered_after: number;
}

function toSheet(r: SheetRow): LogSheet {
  return {
    id: r.id,
    caseId: r.case_id,
    referralId: r.referral_id,
    providerId: r.provider_id,
    nurse: r.nurse,
    householdId: r.household_id,
    household: r.household,
    /*
     * Normalised here, not at the call sites. `timestamptz` and `date` come back from
     * the driver as Date objects, LogSheet promises strings, and the first version
     * handed the Date straight through — so a correction form rendered
     * `String(serviceFrom).slice(0, 10)` as "Thu Jul 16" and the date input refused it.
     */
    orderReceivedAt: new Date(r.order_received_at).toISOString(),
    patientName: r.patient_name,
    patientAddress: r.patient_address,
    attendingPhysician: r.attending_physician,
    serviceFrom: asISODate(r.service_from) ?? '',
    serviceTo: asISODate(r.service_to),
    feeBasis: r.fee_basis,
    recordedBy: r.recorded_by,
    createdAt: new Date(r.created_at).toISOString(),
    correctsId: r.corrects_id,
    correctionNote: r.correction_note,
    superseded: r.superseded,
    enteredAfterDays: Number(r.entered_after ?? 0),
  };
}

/**
 * How many ASSIGNMENTS the register renders at once.
 *
 * Counted in assignments rather than rows because a sheet never travels alone: its
 * corrections belong under it, and a limit applied to rows would eventually cut a chain
 * in half and render a correction with nothing above it to correct.
 *
 * § 1812.529 asks for a permanent log, so this register only grows and has no natural
 * end the way a queue does — every sheet written since the business started is in it,
 * for good. Unbounded, this screen loaded the whole statutory history on every view and
 * got slower every week it was used. An older assignment is reached by filter: an
 * inspector asks about a particular household, nurse or case, and all three are already
 * query parameters on this screen.
 */
export const REGISTER_LIMIT = 150;

export interface RegisterPage {
  sheets: LogSheet[];
  /** Assignments shown. Never more than REGISTER_LIMIT. */
  shown: number;
  /** Assignments the filter matches in all. */
  total: number;
  /** True where older assignments exist that this page does not show. */
  truncated: boolean;
}

/**
 * The register, newest assignment first, corrections following the sheet they correct.
 *
 * Ordered by the referral the sheets belong to rather than by `created_at`, so a
 * correction filed months later reads under its original instead of at the top of the
 * register as if it were a new assignment.
 *
 * Two statements rather than one. The first picks the assignments, the second fetches
 * every sheet belonging to them; a single query with a LIMIT would be a row limit, and
 * the register's unit is the assignment.
 */
export async function register(
  ctx: AuditContext,
  filter?: { caseId?: string; providerId?: string; householdId?: string },
  /*
   * A smaller page than REGISTER_LIMIT, never a larger one.
   *
   * It exists so truncation is testable. Without it, `truncated` cannot be made true
   * against a seeded database — seven assignments against a limit of a hundred and
   * fifty — so the flag would be asserted only in the state where it is false, which is
   * how the capacity measure came to ship with two definitions of one word. A guard
   * nobody can make fire is a guard nobody has checked.
   *
   * The console never passes it, and `tests/register.test.ts` fails if a call site under
   * `app/` or `lib/` ever does: a screen quietly showing fewer assignments than the
   * register holds, with the count beside it still reading from `total`, would be the
   * register misreporting itself.
   */
  limit?: number,
): Promise<RegisterPage> {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.caseId) { params.push(filter.caseId); where.push(`a.case_id = $${params.length}`); }
  if (filter?.providerId) {
    params.push(filter.providerId); where.push(`a.provider_id = $${params.length}`);
  }
  if (filter?.householdId) {
    params.push(filter.householdId); where.push(`c.household_id = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [totals] = await db.query<{ n: string }>(
    `SELECT count(DISTINCT a.referral_id)::text AS n
       FROM assignment_log a
       JOIN cases c ON c.id = a.case_id
       ${clause}`,
    params,
  );
  const total = Number(totals!.n);

  const wanted = await db.query<{ referral_id: string }>(
    `SELECT a.referral_id
       FROM assignment_log a
       JOIN referrals r ON r.id = a.referral_id
       JOIN cases c     ON c.id = a.case_id
       ${clause}
      GROUP BY a.referral_id, r.referred_at
      ORDER BY r.referred_at DESC
      LIMIT ${Math.max(1, Math.min(limit ?? REGISTER_LIMIT, REGISTER_LIMIT))}`,
    params,
  );

  const ids = wanted.map((r) => r.referral_id);
  const rows = ids.length === 0 ? [] : await db.query<SheetRow>(
    `${SHEET_SELECT}
      WHERE a.referral_id = ANY($1::uuid[])
      ORDER BY r.referred_at DESC, a.referral_id,
               a.corrects_id NULLS FIRST, a.created_at`,
    [ids],
  );

  await auditRead(ctx, 'assignment', null, {
    read: 'the assignment register',
    section: 'Civil Code § 1812.529',
    entries: rows.length,
    assignments: ids.length,
    ofTotal: total,
    ...(filter?.caseId ? { caseId: filter.caseId } : {}),
    ...(filter?.providerId ? { providerId: filter.providerId } : {}),
    ...(filter?.householdId ? { householdId: filter.householdId } : {}),
  });

  return {
    sheets: rows.map(toSheet),
    shown: ids.length,
    total,
    truncated: total > ids.length,
  };
}

/**
 * What the register cannot account for.
 *
 * `unlogged` is the one that matters. It can only hold referrals made before core
 * migration 0023, because the commit check refuses the rest — which is exactly why it is
 * counted on screen instead of assumed to be empty. A register that is complete and a
 * register nobody has checked look identical until someone asks.
 */
export async function integrity(ctx: AuditContext): Promise<RegisterIntegrity> {
  const db = await getDb();
  const skilled = `c.care = ANY(${SKILLED_SQL_ARRAY})`;

  const [totals] = await db.query<{
    entries: string; corrections: string; late: string;
    earliest: string | Date | null; latest: string | Date | null;
  }>(
    `SELECT count(*) AS entries,
            count(*) FILTER (WHERE a.corrects_id IS NOT NULL) AS corrections,
            count(*) FILTER (WHERE a.created_at > r.referred_at + interval '1 day') AS late,
            min(a.order_received_at) AS earliest,
            max(a.order_received_at) AS latest
       FROM assignment_log a JOIN referrals r ON r.id = a.referral_id`);

  const [referrals] = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM referrals r JOIN cases c ON c.id = r.case_id
      WHERE ${skilled}`);

  const gaps = await db.query<{
    referral_id: string; case_id: string; household_id: string; household: string;
    nurse: string; care: string; referred_at: string;
    cr_name: string | null; cr_address: string | null; physician_name: string | null;
    starts_on: string | Date | null; fee_pct: string | null;
  }>(
    `SELECT r.id AS referral_id, c.id AS case_id, h.id AS household_id,
            h.display_name AS household, p.full_name AS nurse, c.care::text AS care,
            r.referred_at, h.cr_name, h.cr_address, h.physician_name,
            c.starts_on, c.fee_pct
       FROM referrals r
       JOIN cases c      ON c.id = r.case_id
       JOIN households h ON h.id = c.household_id
       JOIN providers p  ON p.id = r.provider_id
      WHERE ${skilled}
        AND NOT EXISTS (SELECT 1 FROM assignment_log a WHERE a.referral_id = r.id)
      ORDER BY r.referred_at DESC`);

  await auditRead(ctx, 'assignment', null, {
    read: 'the register’s integrity',
    unlogged: gaps.length,
  });

  return {
    entries: Number(totals?.entries ?? 0),
    corrections: Number(totals?.corrections ?? 0),
    nursingReferrals: Number(referrals?.n ?? 0),
    late: Number(totals?.late ?? 0),
    // ISO strings, like every other timestamp this module returns. Handed over as the
    // Date the driver produces, they reached shortDate() and rendered as em dashes —
    // the register's own date range, blank, on the screen that exists to show it.
    earliest: iso(totals?.earliest),
    latest: iso(totals?.latest),
    unlogged: gaps.map((g) => ({
      referralId: g.referral_id,
      caseId: g.case_id,
      householdId: g.household_id,
      household: g.household,
      nurse: g.nurse,
      care: g.care,
      referredAt: g.referred_at,
      missing: assignmentMissing(factsOf(g)),
    })),
  };
}

/**
 * `starts_on` carries `Date` in its type because that is what the driver hands back for
 * a `date` column. The first version said `string`, and `assignmentMissing` then read
 * every start date in the database as absent — core v0.1.25.
 */
function iso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function factsOf(row: {
  care: string; cr_name: string | null; cr_address: string | null;
  physician_name: string | null; starts_on: string | Date | null; fee_pct: string | null;
}): AssignmentFacts {
  return {
    care: row.care,
    patientName: row.cr_name,
    patientAddress: row.cr_address,
    attendingPhysician: row.physician_name,
    startsOn: row.starts_on,
    feePct: row.fee_pct,
  };
}

/**
 * Open nursing cases that cannot be referred, and what is missing from each.
 *
 * This is the half of the screen that is about work rather than evidence. The operator
 * finds out here, not in the middle of a disclosure call.
 */
export async function blockers(): Promise<Blocker[]> {
  const db = await getDb();
  const rows = await db.query<{
    case_id: string; household_id: string; household: string; care: string; status: string;
    cr_name: string | null; cr_address: string | null; physician_name: string | null;
    starts_on: string | Date | null; fee_pct: string | null;
  }>(
    `SELECT c.id AS case_id, h.id AS household_id, h.display_name AS household,
            c.care::text AS care, c.status::text AS status,
            h.cr_name, h.cr_address, h.physician_name, c.starts_on, c.fee_pct
       FROM cases c JOIN households h ON h.id = c.household_id
      WHERE c.deleted_at IS NULL
        AND c.status IN ('inquiry','matching','referred','active','paused')
        AND c.care = ANY(${SKILLED_SQL_ARRAY})
      ORDER BY h.display_name`);

  return rows
    .map((r): Blocker => ({
      caseId: r.case_id,
      householdId: r.household_id,
      household: r.household,
      care: r.care,
      status: r.status,
      missing: assignmentMissing(factsOf(r)),
    }))
    .filter((b) => b.missing.length > 0);
}

/**
 * What would stop this one case being referred. The match screen calls it before the
 * disclosure modal opens, from the same list the transaction refuses on, so the two
 * cannot disagree about what § 1812.529 needs.
 */
export async function assignmentBlockersFor(caseId: string): Promise<AssignmentField[]> {
  const db = await getDb();
  const [row] = await db.query<{
    care: string; cr_name: string | null; cr_address: string | null;
    physician_name: string | null; starts_on: string | Date | null; fee_pct: string | null;
  }>(
    `SELECT c.care::text AS care, h.cr_name, h.cr_address, h.physician_name,
            c.starts_on, c.fee_pct
       FROM cases c JOIN households h ON h.id = c.household_id
      WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [caseId]);
  if (!row) return [];
  return assignmentMissing(factsOf(row));
}

/**
 * File a correction. § 1812.529 forbids false entries and the table is append-only, so
 * the only way to fix one is a new sheet saying what the old one should have said, with
 * a note saying why. Both stay in the register.
 *
 * The note is required by a CHECK constraint, not only by this function. The derived
 * fields — the hour the order arrived, the case, the referral, the nurse — are copied
 * from the entry being corrected: a correction to an address is not an occasion to
 * restate when the order came in.
 */
export async function fileCorrection(
  ctx: AuditContext,
  input: {
    entryId: string;
    patientName: string;
    patientAddress: string;
    attendingPhysician: string;
    serviceFrom: string;
    serviceTo: string | null;
    feeBasis: string;
    note: string;
  },
): Promise<string> {
  const note = input.note.trim();
  if (note.length < 10) {
    throw new RegisterError(
      'Say what was wrong with the original entry. The entry it replaces stays in the '
      + 'register, so the note is what explains the pair.',
    );
  }
  for (const [field, value] of [
    ['patient_name', input.patientName], ['patient_address', input.patientAddress],
    ['attending_physician', input.attendingPhysician], ['service_from', input.serviceFrom],
    ['fee_basis', input.feeBasis],
  ] as const) {
    if (!value.trim()) {
      throw new RegisterError(
        `A log sheet must state ${ASSIGNMENT_FIELDS[field].label.replace(/^The /, 'the ')}.`,
      );
    }
  }
  if (input.serviceTo && input.serviceTo < input.serviceFrom) {
    throw new RegisterError('Service cannot end before it begins.');
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    const [prior] = await tx.query<{ id: string; case_id: string; superseded: boolean }>(
      `SELECT a.id, a.case_id,
              EXISTS (SELECT 1 FROM assignment_log l WHERE l.corrects_id = a.id) AS superseded
         FROM assignment_log a WHERE a.id = $1`,
      [input.entryId]);
    if (!prior) throw new RegisterError('That entry is not in the register.');
    if (prior.superseded) {
      throw new RegisterError(
        'That entry has already been corrected. Correct the entry that replaced it, so '
        + 'the register reads as one chain rather than two.',
      );
    }

    const [row] = await tx.query<{ id: string }>(ASSIGNMENT_LOG_CORRECTION, [
      input.entryId, input.patientName.trim(), input.patientAddress.trim(),
      input.attendingPhysician.trim(), input.serviceFrom, input.serviceTo || null,
      input.feeBasis.trim(), ctx.actor, note,
    ]);
    if (!row) throw new RegisterError('Could not file the correction.');

    await audit({
      ...ctx,
      action: 'create',
      entity: 'assignment',
      entityId: row.id,
      diff: { corrects: input.entryId, caseId: prior.case_id, note },
    }, tx);
    return row.id;
  });
}

/**
 * File the entry a referral should always have had.
 *
 * Only reachable for a referral with no sheet, which after core migration 0023 means one
 * made before it existed. The facts come from the household record, the same statement
 * the referral transaction uses, and `created_at` records that the entry was written
 * today — so the register shows a late entry as a late entry. There is no way here to
 * backdate one, and that is the whole design: § 1812.529 forbids false entries, and a
 * log sheet claiming to have been written at the time would be the clearest possible one.
 */
export async function fileMissingEntry(
  ctx: AuditContext,
  referralId: string,
): Promise<string> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx.query<{
      care: string; fee_pct: string | null; cr_name: string | null;
      cr_address: string | null; physician_name: string | null; starts_on: string | Date | null;
      case_id: string; sheets: string;
    }>(
      `SELECT c.care::text AS care, c.fee_pct, h.cr_name, h.cr_address, h.physician_name,
              c.starts_on, c.id AS case_id,
              (SELECT count(*) FROM assignment_log a WHERE a.referral_id = r.id) AS sheets
         FROM referrals r
         JOIN cases c      ON c.id = r.case_id
         JOIN households h ON h.id = c.household_id
        WHERE r.id = $1
        FOR UPDATE OF r`,
      [referralId]);
    if (!row) throw new RegisterError('That referral is not in the register.');
    if (Number(row.sheets) > 0) {
      throw new RegisterError('That referral already has an entry.');
    }
    if (!isSkilled(row.care)) {
      throw new RegisterError(
        '§ 1812.529 is the nurses’ registry section. It does not reach this care type, '
        + 'and an entry for it would be a record of an obligation that does not exist.',
      );
    }
    const missing = assignmentMissing(factsOf(row));
    if (missing.length > 0) {
      throw new RegisterError(
        'The household record cannot supply '
        + missing.map((f) => ASSIGNMENT_FIELDS[f].label.replace(/^The /, 'the ')).join(', ')
        + '. Fill those in on the household and the case first: an entry made up to '
        + 'close a gap is the false entry § 1812.529 prohibits.',
      );
    }

    const basis = feeBasisOf(row.fee_pct);
    if (!basis) throw new RegisterError('The case has no fee recorded.');

    const id = await writeSheet(tx, referralId, basis, ctx.actor);
    await audit({
      ...ctx,
      action: 'create',
      entity: 'assignment',
      entityId: id,
      diff: {
        referralId,
        caseId: row.case_id,
        feeBasis: basis,
        filedLate: true,
        section: 'Civil Code § 1812.529',
      },
    }, tx);
    return id;
  });
}

async function writeSheet(
  tx: Tx, referralId: string, feeBasis: string, actor: string,
): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    // null: the entry is made now. Nothing in the console ever predates a log sheet.
    ASSIGNMENT_LOG_INSERT, [referralId, feeBasis, actor, null]);
  if (!row) throw new RegisterError('Could not write the entry.');
  return row.id;
}

/** What each statutory field is called, for the screen. */
export { ASSIGNMENT_FIELDS };
