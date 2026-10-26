/**
 * The Today screen's seven buckets. Spec § 5.
 *
 * Eligibility drives three of them, so the provider standing is fetched once and reused
 * rather than recomputed per bucket.
 *
 * The § 5 "coverage gaps in the next 7 days" bucket is absent: the scheduling and
 * coverage surface is blocked by the § 0.5 nine-factor audit. See /DEFERRED.md.
 */
import { getDb } from '@ccn/core/db';
import { auditRead, type AuditContext } from '@/lib/audit';
import { buildToday, THIN_BENCH_TARGET, type Today, type TodayInput } from '@/lib/domain/buckets';
import { LABEL, SEVERITY, requiredFor, type CredStatus } from '@ccn/core/domain';
import { SKILLED_CARE_TYPES } from '@/lib/domain/referral';
import { listProvidersWithStanding } from './providers';
import { asDate, asTimestamp } from './providers';
import type { CareType, UrgencyValue } from '@ccn/core/schema';

const ALERT_STATUSES: CredStatus[] = ['expired', 'critical', 'soon', 'upcoming'];

export async function getToday(ctx: AuditContext, today = new Date()): Promise<Today> {
  const { query } = await getDb();
  const standing = await listProvidersWithStanding(ctx, today);
  const eligibleById = new Map(standing.map((s) => [s.provider.id, s] as const));

  // --- 1. blocking: an active case whose referred provider is no longer eligible -----
  const liveCases = await query(
    `SELECT c.id, c.status, c.care, c.urgency, c.created_at, c.ends_on,
            c.primary_provider_id, c.alternate_provider_ids,
            h.display_name, h.physician_name
       FROM cases c JOIN households h ON h.id = c.household_id
      WHERE c.deleted_at IS NULL AND c.status <> 'ended'`,
  );

  const blocking: TodayInput['blocking'] = [];
  const thinBench: TodayInput['thinBench'] = [];
  const noPhysician: TodayInput['noPhysician'] = [];
  const endingSoon: TodayInput['endingSoon'] = [];

  for (const c of liveCases) {
    const caseId = String(c.id);
    const householdName = String(c.display_name);
    const status = String(c.status);
    const primaryId = (c.primary_provider_id as string) ?? null;

    if (primaryId && (status === 'active' || status === 'referred')) {
      const s = eligibleById.get(primaryId);
      if (s && !s.eligibility.eligible) {
        blocking.push({
          caseId, householdName,
          providerId: primaryId,
          providerName: s.provider.fullName,
          reason: s.eligibility.reason ?? 'Not eligible',
        });
      }
    }

    // --- 5. thin bench: fewer than two eligible alternates ---------------------------
    if (status === 'active' || status === 'referred') {
      const alternates = ((c.alternate_provider_ids as string[]) ?? []).map(String);
      const eligibleAlternates = alternates.filter(
        (id) => eligibleById.get(id)?.eligibility.eligible,
      ).length;
      if (eligibleAlternates < THIN_BENCH_TARGET) {
        thinBench.push({ caseId, householdName, eligibleAlternates });
      }
    }

    // --- 3. skilled case with no physician of record ---------------------------------
    if ((SKILLED_CARE_TYPES as readonly string[]).includes(String(c.care))
        && !String(c.physician_name ?? '').trim()) {
      noPhysician.push({ caseId, householdName, care: c.care as CareType, status });
    }

    // --- 7. engagements ending within 14 days ----------------------------------------
    const endsOn = asDate(c.ends_on);
    if (endsOn && (status === 'active' || status === 'referred')) {
      endingSoon.push({ caseId, householdName, endsOn });
    }
  }

  // --- 2. needs response: an open enquiry with no logged call ------------------------
  const needsResponseRows = await query(
    `SELECT c.id, c.urgency, c.care, c.created_at, h.display_name
       FROM cases c JOIN households h ON h.id = c.household_id
      WHERE c.deleted_at IS NULL
        AND c.status IN ('inquiry','matching')
        AND NOT EXISTS (
          SELECT 1 FROM timeline_entries t WHERE t.case_id = c.id AND t.type = 'call'
        )`,
  );
  const needsResponse: TodayInput['needsResponse'] = needsResponseRows.map((r) => ({
    caseId: String(r.id),
    householdName: String(r.display_name),
    urgency: r.urgency as UrgencyValue,
    care: r.care as CareType,
    createdAt: asTimestamp(r.created_at),
  }));

  // --- 4. credential alerts ----------------------------------------------------------
  const credentialAlerts: TodayInput['credentialAlerts'] = [];
  for (const s of standing) {
    if (s.provider.status !== 'active') continue;      // not referable anyway
    const required = requiredFor(s.provider);
    for (const type of s.missing) {
      credentialAlerts.push({
        providerId: s.provider.id,
        providerName: s.provider.fullName,
        credentialLabel: `${LABEL[type]} — never recorded`,
        expiresOn: null,
        status: 'expired',
      });
    }
    for (const c of s.credentials) {
      if (!required.includes(c.type)) continue;
      if (!ALERT_STATUSES.includes(c.status)) continue;
      credentialAlerts.push({
        providerId: s.provider.id,
        providerName: s.provider.fullName,
        credentialLabel: c.label,
        expiresOn: c.expiresOn,
        status: c.status,
      });
    }
  }
  credentialAlerts.sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);

  // --- 6. written disclosures due ----------------------------------------------------
  const writtenRows = await query(
    `SELECT d.id, d.case_id, d.disclosed_to, d.written_due_on, h.display_name
       FROM disclosures d
       JOIN cases c ON c.id = d.case_id
       JOIN households h ON h.id = c.household_id
      WHERE d.written_sent_on IS NULL
      ORDER BY d.written_due_on`,
  );
  const writtenDue: TodayInput['writtenDue'] = writtenRows.map((r) => ({
    disclosureId: String(r.id),
    caseId: String(r.case_id),
    householdName: String(r.display_name),
    disclosedTo: String(r.disclosed_to),
    writtenDueOn: asDate(r.written_due_on) ?? '',
  }));

  await auditRead(ctx, 'today');

  return buildToday(
    { blocking, needsResponse, noPhysician, credentialAlerts, thinBench, writtenDue, endingSoon },
    today,
  );
}
