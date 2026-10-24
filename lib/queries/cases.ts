/** Household and case reads. Every function that returns identifiable data audits the read. */
import { getDb } from '@/lib/db/client';
import { audit, auditRead, type AuditContext } from '@/lib/audit';
import { asDate, asTimestamp } from './providers';
import { emit } from '@/lib/metrics';
import { insertTimeline } from '@/lib/domain/referral';
import type {
  CareType, CaseStatusValue, EndReasonValue, UrgencyValue,
} from '@/lib/db/schema';

export interface CaseListRow {
  id: string;
  status: CaseStatusValue;
  care: CareType;
  urgency: UrgencyValue;
  householdId: string;
  householdName: string;
  crArea: string;
  hoursPerWeek: number | null;
  startsOn: string | null;
  endsOn: string | null;
  primaryProviderName: string | null;
  createdAt: string;
  writtenDueOn: string | null;
  writtenSentOn: string | null;
}

export interface HouseholdDetail {
  id: string;
  displayName: string;
  dmName: string;
  dmRelationship: string | null;
  dmPhone: string | null;
  dmEmail: string | null;
  dmLocation: string | null;
  dmTimezone: string | null;
  crName: string | null;
  crAge: number | null;
  crArea: string;
  crAddress: string | null;
  crAccessNotes: string | null;
  paymentMethod: 'private' | 'ltc_policy' | 'va' | 'other';
  ltcCarrier: string | null;
  ltcPolicyNumber: string | null;
  physicianName: string | null;
  physicianPractice: string | null;
  physicianPhone: string | null;
  physicianFax: string | null;
  ndaOnFile: boolean;
  source: string | null;
  blockedProviderIds: string[];
  notes: string | null;
}

export interface CaseDetail {
  id: string;
  status: CaseStatusValue;
  care: CareType;
  urgency: UrgencyValue;
  needsProfile: string | null;
  needsAuthoredBy: string;
  adlNeeds: string[];
  schedule: string[];
  hoursPerWeek: number | null;
  startsOn: string | null;
  endsOn: string | null;
  expectedWeeks: number | null;
  rateAgreed: string | null;
  feePct: string | null;
  feeChargedTo: string;
  rateBandLow: string | null;
  rateBandHigh: string | null;
  languagePref: string | null;
  primaryProviderId: string | null;
  alternateProviderIds: string[];
  householdProfile: string | null;
  referredOn: string | null;
  writtenDueOn: string | null;
  writtenSentOn: string | null;
  endedOn: string | null;
  endedBy: 'household' | 'provider' | 'mutual' | null;
  endReason: EndReasonValue | null;
  endReasonNote: string | null;
  createdAt: string;
  household: HouseholdDetail;
}

export interface TimelineRow {
  id: string;
  at: string;
  type: string;
  author: string;
  body: string;
  providerId: string | null;
  providerName: string | null;
}

export interface CaseReferralRow {
  id: string;
  providerId: string;
  providerName: string;
  referredAt: string;
  referredBy: string;
  outcome: string | null;
  outcomeNote: string | null;
  disclosureId: string;
  disclosedTo: string;
  disclosedAt: string;
  method: string;
  writtenDueOn: string;
  writtenSentOn: string | null;
  writtenMethod: string | null;
}

export async function listCases(
  ctx: AuditContext,
  filter?: { status?: CaseStatusValue },
): Promise<CaseListRow[]> {
  const { query } = await getDb();
  const rows = await query(
    `SELECT c.id, c.status, c.care, c.urgency, c.hours_per_week, c.starts_on, c.ends_on,
            c.created_at, c.written_due_on, c.written_sent_on,
            h.id AS household_id, h.display_name, h.cr_area,
            p.full_name AS primary_provider_name
       FROM cases c
       JOIN households h ON h.id = c.household_id
       LEFT JOIN providers p ON p.id = c.primary_provider_id
      WHERE c.deleted_at IS NULL
        AND ($1::case_status IS NULL OR c.status = $1::case_status)
      ORDER BY c.created_at DESC`,
    [filter?.status ?? null],
  );
  await auditRead(ctx, 'cases');
  return rows.map((r) => ({
    id: String(r.id),
    status: r.status as CaseStatusValue,
    care: r.care as CareType,
    urgency: r.urgency as UrgencyValue,
    householdId: String(r.household_id),
    householdName: String(r.display_name),
    crArea: String(r.cr_area),
    hoursPerWeek: (r.hours_per_week as number) ?? null,
    startsOn: asDate(r.starts_on),
    endsOn: asDate(r.ends_on),
    primaryProviderName: (r.primary_provider_name as string) ?? null,
    createdAt: asTimestamp(r.created_at),
    writtenDueOn: asDate(r.written_due_on),
    writtenSentOn: asDate(r.written_sent_on),
  }));
}

export async function getCase(
  ctx: AuditContext,
  caseId: string,
): Promise<{ kase: CaseDetail; timeline: TimelineRow[]; referrals: CaseReferralRow[] } | null> {
  const { query } = await getDb();
  const [row] = await query(
    `SELECT c.*, h.id AS h_id, h.display_name, h.dm_name, h.dm_relationship, h.dm_phone,
            h.dm_email, h.dm_location, h.dm_timezone, h.cr_name, h.cr_age, h.cr_area,
            h.cr_address, h.cr_access_notes, h.payment_method, h.ltc_carrier,
            h.ltc_policy_number, h.physician_name, h.physician_practice, h.physician_phone,
            h.physician_fax, h.nda_on_file, h.source, h.blocked_provider_ids,
            h.notes AS h_notes
       FROM cases c JOIN households h ON h.id = c.household_id
      WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [caseId],
  );
  if (!row) return null;

  const timeline = await query(
    `SELECT t.id, t.at, t.type, t.author, t.body, t.provider_id, p.full_name
       FROM timeline_entries t
       LEFT JOIN providers p ON p.id = t.provider_id
      WHERE t.case_id = $1
      ORDER BY t.at DESC, t.id DESC`,
    [caseId],
  );

  const referrals = await query(
    `SELECT r.id, r.provider_id, r.referred_at, r.referred_by, r.outcome, r.outcome_note,
            p.full_name, d.id AS disclosure_id, d.disclosed_to, d.disclosed_at, d.method,
            d.written_due_on, d.written_sent_on, d.written_method
       FROM referrals r
       JOIN providers p ON p.id = r.provider_id
       JOIN disclosures d ON d.id = r.disclosure_id
      WHERE r.case_id = $1
      ORDER BY r.referred_at DESC`,
    [caseId],
  );

  // A read of one household's record is the thing the operator may need to account for.
  await auditRead(ctx, 'case', caseId);
  await auditRead(ctx, 'household', String(row.h_id));

  return {
    kase: {
      id: String(row.id),
      status: row.status as CaseStatusValue,
      care: row.care as CareType,
      urgency: row.urgency as UrgencyValue,
      needsProfile: (row.needs_profile as string) ?? null,
      needsAuthoredBy: String(row.needs_authored_by),
      adlNeeds: (row.adl_needs as string[]) ?? [],
      schedule: (row.schedule as string[]) ?? [],
      hoursPerWeek: (row.hours_per_week as number) ?? null,
      startsOn: asDate(row.starts_on),
      endsOn: asDate(row.ends_on),
      expectedWeeks: (row.expected_weeks as number) ?? null,
      rateAgreed: nullableNumeric(row.rate_agreed),
      feePct: nullableNumeric(row.fee_pct),
      feeChargedTo: String(row.fee_charged_to),
      rateBandLow: nullableNumeric(row.rate_band_low),
      rateBandHigh: nullableNumeric(row.rate_band_high),
      languagePref: (row.language_pref as string) ?? null,
      primaryProviderId: (row.primary_provider_id as string) ?? null,
      alternateProviderIds: (row.alternate_provider_ids as string[]) ?? [],
      householdProfile: (row.household_profile as string) ?? null,
      referredOn: asDate(row.referred_on),
      writtenDueOn: asDate(row.written_due_on),
      writtenSentOn: asDate(row.written_sent_on),
      endedOn: asDate(row.ended_on),
      endedBy: (row.ended_by as CaseDetail['endedBy']) ?? null,
      endReason: (row.end_reason as EndReasonValue) ?? null,
      endReasonNote: (row.end_reason_note as string) ?? null,
      createdAt: asTimestamp(row.created_at),
      household: {
        id: String(row.h_id),
        displayName: String(row.display_name),
        dmName: String(row.dm_name),
        dmRelationship: (row.dm_relationship as string) ?? null,
        dmPhone: (row.dm_phone as string) ?? null,
        dmEmail: (row.dm_email as string) ?? null,
        dmLocation: (row.dm_location as string) ?? null,
        dmTimezone: (row.dm_timezone as string) ?? null,
        crName: (row.cr_name as string) ?? null,
        crAge: (row.cr_age as number) ?? null,
        crArea: String(row.cr_area),
        crAddress: (row.cr_address as string) ?? null,
        crAccessNotes: (row.cr_access_notes as string) ?? null,
        paymentMethod: row.payment_method as HouseholdDetail['paymentMethod'],
        ltcCarrier: (row.ltc_carrier as string) ?? null,
        ltcPolicyNumber: (row.ltc_policy_number as string) ?? null,
        physicianName: (row.physician_name as string) ?? null,
        physicianPractice: (row.physician_practice as string) ?? null,
        physicianPhone: (row.physician_phone as string) ?? null,
        physicianFax: (row.physician_fax as string) ?? null,
        ndaOnFile: Boolean(row.nda_on_file),
        source: (row.source as string) ?? null,
        blockedProviderIds: (row.blocked_provider_ids as string[]) ?? [],
        notes: (row.h_notes as string) ?? null,
      },
    },
    timeline: timeline.map((t) => ({
      id: String(t.id),
      at: asTimestamp(t.at),
      type: String(t.type),
      author: String(t.author),
      body: String(t.body),
      providerId: (t.provider_id as string) ?? null,
      providerName: (t.full_name as string) ?? null,
    })),
    referrals: referrals.map((r) => ({
      id: String(r.id),
      providerId: String(r.provider_id),
      providerName: String(r.full_name),
      referredAt: asTimestamp(r.referred_at),
      referredBy: String(r.referred_by),
      outcome: (r.outcome as string) ?? null,
      outcomeNote: (r.outcome_note as string) ?? null,
      disclosureId: String(r.disclosure_id),
      disclosedTo: String(r.disclosed_to),
      disclosedAt: asTimestamp(r.disclosed_at),
      method: String(r.method),
      writtenDueOn: asDate(r.written_due_on) ?? '',
      writtenSentOn: asDate(r.written_sent_on),
      writtenMethod: (r.written_method as string) ?? null,
    })),
  };
}

function nullableNumeric(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Log a call against an open enquiry. This is what clears the "needs response" bucket. */
export async function logCall(
  ctx: AuditContext,
  caseId: string,
  body: string,
): Promise<void> {
  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [prior] = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM timeline_entries WHERE case_id = $1 AND type = 'call'`,
      [caseId],
    );
    await insertTimeline(tx, { caseId, type: 'call', author: ctx.actor, body });
    // § 8: first_contact derives response latency, so it is emitted only once per case.
    if (Number(prior?.n ?? 0) === 0) {
      await emit('first_contact', { caseId }, {}, tx);
    }
  });
  await audit({ ...ctx, action: 'create', entity: 'timeline_entry', diff: { caseId, type: 'call' } });
}

/** A free-text note. I10: nothing here generates, suggests or templates content. */
export async function addNote(ctx: AuditContext, caseId: string, body: string): Promise<void> {
  const handle = await getDb();
  await handle.transaction((tx) =>
    insertTimeline(tx, { caseId, type: 'note', author: ctx.actor, body }),
  );
  await audit({ ...ctx, action: 'create', entity: 'timeline_entry', diff: { caseId, type: 'note' } });
}
