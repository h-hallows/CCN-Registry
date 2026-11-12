/**
 * Enquiries, and turning one into a household. Spec § 4.1.
 *
 * WHAT WAS MISSING. The three public intake routes write to `inquiries`, and nothing in
 * this console ever read that table — Today's "needs response" bucket reads `cases`,
 * which is a step later. So a family who filled in the front-door form arrived in a
 * table nobody displayed, and nothing anywhere created a `households` or `cases` row:
 * every household in the system came from the seed. The whole funnel downstream of this
 * point existed with nowhere to start from.
 *
 * THE CONVERSION IS THE RECORD. An enquiry is what somebody typed. A household is what
 * the registry believes after speaking to them, and the two are kept apart on purpose:
 * the enquiry row is never edited, the household is created from it, and
 * `inquiries.household_id` joins them. "What did they originally say" stays answerable
 * — which matters when the care that was asked for and the care that was arranged turn
 * out to differ.
 */
import { getDb, type Tx } from '@h-hallows/core/db';
import { audit, auditRead, type AuditContext } from '@/lib/audit';
import { emit } from '@/lib/metrics';
import { insertTimeline } from '@/lib/domain/referral';
import type { CareType, UrgencyValue } from '@h-hallows/core/schema';

export class IntakeError extends Error {}

export interface InquiryRow {
  id: string;
  receivedAt: string;
  name: string;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  careType: CareType | null;
  area: string | null;
  patternNote: string | null;
  startNote: string | null;
  urgency: UrgencyValue | null;
  paymentMethod: string | null;
  message: string | null;
  sourcePath: string | null;
  /** The partner block, when a professional sent it. Initials only, never a name. */
  referrer: Record<string, unknown> | null;
  partnerName: string | null;
  handledAt: string | null;
  handledBy: string | null;
  householdId: string | null;
}

const COLUMNS = `
  i.id, i.received_at::text, i.name, i.phone, i.email, i.relationship,
  i.care_type::text AS care_type, i.area, i.pattern_note, i.start_note,
  i.urgency::text AS urgency, i.payment_method::text AS payment_method,
  i.message, i.source_path, i.referrer, i.handled_at::text, i.handled_by,
  i.household_id, p.name AS partner_name`;

type Raw = {
  id: string; received_at: string; name: string; phone: string | null;
  email: string | null; relationship: string | null; care_type: string | null;
  area: string | null; pattern_note: string | null; start_note: string | null;
  urgency: string | null; payment_method: string | null; message: string | null;
  source_path: string | null; referrer: Record<string, unknown> | null;
  handled_at: string | null; handled_by: string | null; household_id: string | null;
  partner_name: string | null;
};

function asRow(r: Raw): InquiryRow {
  return {
    id: r.id,
    receivedAt: r.received_at,
    name: r.name,
    phone: r.phone,
    email: r.email,
    relationship: r.relationship,
    careType: (r.care_type as CareType) ?? null,
    area: r.area,
    patternNote: r.pattern_note,
    startNote: r.start_note,
    urgency: (r.urgency as UrgencyValue) ?? null,
    paymentMethod: r.payment_method,
    message: r.message,
    sourcePath: r.source_path,
    referrer: r.referrer,
    partnerName: r.partner_name,
    handledAt: r.handled_at,
    handledBy: r.handled_by,
    householdId: r.household_id,
  };
}

/**
 * Everything waiting, most urgent first and then oldest first.
 *
 * The same ordering Today uses for its own queues, and for the same reason: a discharge
 * is measured in hours. Sorted in SQL rather than in the page so that the count badge
 * and the list cannot disagree about what "waiting" means.
 */
export async function unhandledInquiries(ctx: AuditContext): Promise<InquiryRow[]> {
  const { query } = await getDb();
  const rows = await query<Raw>(
    `SELECT ${COLUMNS}
       FROM inquiries i
       LEFT JOIN referral_partners p ON p.id = i.partner_id
      WHERE i.handled_at IS NULL
      ORDER BY CASE i.urgency
                 WHEN 'discharge' THEN 0 WHEN 'same_day' THEN 1
                 WHEN 'next_day'  THEN 2 ELSE 3 END,
               i.received_at`,
  );
  if (rows.length > 0) await auditRead(ctx, 'inquiry');
  return rows.map(asRow);
}

export async function countUnhandledInquiries(): Promise<number> {
  const { query } = await getDb();
  const [row] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM inquiries WHERE handled_at IS NULL`,
  );
  return Number(row?.n ?? 0);
}

/** What was decided recently, so a mistake is findable without opening the audit log. */
export async function recentlyHandled(
  ctx: AuditContext,
  limit = 15,
): Promise<InquiryRow[]> {
  const { query } = await getDb();
  const rows = await query<Raw>(
    `SELECT ${COLUMNS}
       FROM inquiries i
       LEFT JOIN referral_partners p ON p.id = i.partner_id
      WHERE i.handled_at IS NOT NULL
      ORDER BY i.handled_at DESC
      LIMIT $1`,
    [limit],
  );
  if (rows.length > 0) await auditRead(ctx, 'inquiry');
  return rows.map(asRow);
}

export interface ConvertInput {
  inquiryId: string;
  /** How the household is referred to on every screen. Not the patient's full name. */
  displayName: string;
  /** The person engaging care. */
  dmName: string;
  dmRelationship?: string;
  dmPhone?: string;
  dmEmail?: string;
  crName?: string;
  crArea: string;
  care: CareType;
  urgency: UrgencyValue;
  paymentMethod: 'private' | 'ltc_policy' | 'va' | 'other';
  /** In the household's own words. Never generated, never templated — I10. */
  needsNote?: string;
}

export interface ConvertResult {
  householdId: string;
  caseId: string;
}

/**
 * Create the household and the first case from an enquiry.
 *
 * One transaction, because a household with no case is a record of nobody wanting
 * anything and a case with no household cannot exist — and an enquiry marked handled
 * with neither behind it is the worst of the three, since it leaves the queue.
 *
 * The enquiry itself is never edited. What the operator types here is what the registry
 * believes after a conversation; what the family typed stays exactly as they typed it,
 * joined by `household_id`.
 */
export async function convertInquiry(
  ctx: AuditContext,
  input: ConvertInput,
): Promise<ConvertResult> {
  const displayName = input.displayName.trim();
  const dmName = input.dmName.trim();
  const crArea = input.crArea.trim();
  if (displayName.length < 2) throw new IntakeError('Give the household a name to go by.');
  if (dmName.length < 2) throw new IntakeError('Name the person engaging care.');
  if (crArea.length < 2) throw new IntakeError('Say which area they are in.');

  const handle = await getDb();
  return handle.transaction(async (tx) => {
    const inquiry = await lockUnhandled(tx, input.inquiryId);

    const [household] = await tx.query<{ id: string }>(
      `INSERT INTO households
         (display_name, status, dm_name, dm_relationship, dm_phone, dm_email,
          cr_name, cr_area, payment_method, source, partner_id)
       VALUES ($1, 'inquiry', $2, $3, $4, $5, $6, $7, $8::payment_method, $9, $10)
       RETURNING id`,
      [
        displayName, dmName, blank(input.dmRelationship), blank(input.dmPhone),
        blank(input.dmEmail), blank(input.crName), crArea, input.paymentMethod,
        inquiry.source_path ?? 'enquiry', inquiry.partner_id,
      ],
    );
    if (!household) throw new IntakeError('Could not create the household.');

    const [kase] = await tx.query<{ id: string }>(
      `INSERT INTO cases
         (household_id, status, care, urgency, needs_profile, needs_authored_by)
       VALUES ($1, 'inquiry', $2::care_type, $3::urgency, $4, 'household')
       RETURNING id`,
      [household.id, input.care, input.urgency, blank(input.needsNote)],
    );
    if (!kase) throw new IntakeError('Could not create the case.');

    /*
     * The enquiry leaves the queue and gains the household it became. `handled_at` and
     * `household_id` are set in the same statement so a row can never be out of the
     * queue with nothing to show for it.
     */
    await tx.query(
      `UPDATE inquiries
          SET household_id = $2, handled_at = now(), handled_by = $3
        WHERE id = $1 AND handled_at IS NULL`,
      [input.inquiryId, household.id, ctx.actor],
    );

    await insertTimeline(tx, {
      caseId: kase.id,
      householdId: household.id,
      type: 'inquiry',
      author: ctx.actor,
      body:
        `Enquiry received ${inquiry.received_at.slice(0, 10)}`
        + (inquiry.source_path ? ` via ${inquiry.source_path}` : '')
        + `, opened as a case by ${ctx.actor}.`
        + (inquiry.message ? ` They wrote: ${inquiry.message}` : ''),
    });

    await emit('inquiry_received',
      { caseId: kase.id },
      { inquiryId: input.inquiryId, sourcePath: inquiry.source_path, converted: true },
      tx);

    await audit({
      ...ctx,
      action: 'create',
      entity: 'household',
      entityId: household.id,
      diff: { fromInquiry: input.inquiryId, caseId: kase.id, displayName, crArea },
    }, tx);

    return { householdId: household.id, caseId: kase.id };
  });
}

/**
 * Close an enquiry without a household behind it.
 *
 * Wrong area, wrong level of care, nobody available — all ordinary, and all worth
 * counting. DEFERRED.md puts turn-aways in the baseline the business is measured
 * against, which only works if they are recorded rather than deleted.
 */
export async function turnAwayInquiry(
  ctx: AuditContext,
  inquiryId: string,
  reason: string,
): Promise<void> {
  if (reason.trim().length < 3) throw new IntakeError('Record why.');

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    await lockUnhandled(tx, inquiryId);

    await tx.query(
      `UPDATE inquiries SET handled_at = now(), handled_by = $2
        WHERE id = $1 AND handled_at IS NULL`,
      [inquiryId, ctx.actor],
    );

    await audit({
      ...ctx,
      action: 'update',
      entity: 'inquiry',
      entityId: inquiryId,
      diff: { turnedAway: true, reason: reason.trim() },
    }, tx);
  });
}

/**
 * Read the enquiry and refuse if somebody already dealt with it.
 *
 * `FOR UPDATE` because two clicks half a second apart would otherwise both pass the
 * check and create two households from one enquiry — and the second would be a
 * duplicate family nobody notices until they are called twice.
 */
async function lockUnhandled(tx: Tx, inquiryId: string): Promise<{
  received_at: string; source_path: string | null; message: string | null;
  partner_id: string | null;
}> {
  const [row] = await tx.query<{
    received_at: string; source_path: string | null; message: string | null;
    partner_id: string | null; handled_at: string | null; handled_by: string | null;
  }>(
    `SELECT received_at::text, source_path, message, partner_id,
            handled_at::text, handled_by
       FROM inquiries WHERE id = $1 FOR UPDATE`,
    [inquiryId],
  );
  if (!row) throw new IntakeError('That enquiry does not exist.');
  if (row.handled_at) {
    throw new IntakeError(
      `${row.handled_by ?? 'Somebody'} already dealt with that enquiry.`,
    );
  }
  return row;
}

function blank(v: string | undefined): string | null {
  return v?.trim() ? v.trim() : null;
}
