/**
 * Shortlist construction. Spec § 4.3 and I12.
 *
 * Eligibility is computed HERE. A shortlist must never return an ineligible provider for
 * the UI to filter out — if one reaches the client, the invariant is already broken.
 *
 * The excluded list is required by § 5 (the operator must be able to see why someone is
 * not there, which is how she comes to trust the filter), so it is returned alongside —
 * but an excluded entry carries only an id, a name and the reason. No profile, no rate,
 * no credential detail, and never a Live Scan result (COUNSEL.md question 5).
 */
import { getDb } from '@/lib/db/client';
import { auditRead, type AuditContext } from '@/lib/audit';
import {
  compareEligible, screen, type Candidate, type Exclusion, type MatchSignals,
} from '@/lib/domain/match';
import { emit } from '@/lib/metrics';
import { asDate } from './providers';
import type { CareType, ProviderType } from '@/lib/db/schema';

export interface ShortlistEntry {
  providerId: string;
  fullName: string;
  type: ProviderType;
  rateHourly: string | null;
  rateNotes: string | null;
  areas: string[];
  languages: string[];
  specialties: string[];
  restrictions: string | null;
  signals: MatchSignals;
}

export interface ExcludedEntry {
  providerId: string;
  fullName: string;
  type: ProviderType;
  exclusion: Exclusion;
}

export interface Shortlist {
  caseId: string;
  care: CareType;
  schedule: string[];
  eligible: ShortlistEntry[];
  excluded: ExcludedEntry[];
}

export async function shortlistFor(
  ctx: AuditContext,
  caseId: string,
  today = new Date(),
): Promise<Shortlist | null> {
  const { query } = await getDb();

  const [kase] = await query(
    `SELECT c.id, c.care, c.schedule, c.language_pref, c.rate_band_low, c.rate_band_high,
            c.adl_needs, h.id AS household_id, h.cr_area, h.blocked_provider_ids
       FROM cases c JOIN households h ON h.id = c.household_id
      WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [caseId],
  );
  if (!kase) return null;

  const providers = await query(
    `SELECT p.id, p.full_name, p.type, p.transports, p.status, p.areas, p.availability,
            p.specialties, p.languages, p.rate_hourly, p.rate_notes, p.restrictions
       FROM providers p
      WHERE p.deleted_at IS NULL
      ORDER BY p.full_name`,
  );

  const creds = await query(
    `SELECT provider_id, type, expires_on FROM credentials WHERE deleted_at IS NULL`,
  );
  const credsBy = new Map<string, { type: never; expiresOn: string | null }[]>();
  for (const c of creds) {
    const key = String(c.provider_id);
    const list = credsBy.get(key) ?? [];
    list.push({ type: c.type as never, expiresOn: asDate(c.expires_on) });
    credsBy.set(key, list);
  }

  // Prior history with THIS household, used as a raw signal column (never a weight).
  const history = await query(
    `SELECT r.provider_id,
            count(*)                                                        AS prior_referrals,
            count(*) FILTER (
              WHERE c.status = 'ended'
                AND c.end_reason IN ('care_no_longer_needed','moved_to_facility','hospitalized','deceased')
            )                                                               AS ended_well,
            avg(EXTRACT(epoch FROM (c.ended_on::timestamptz - c.created_at)) / 604800)
              FILTER (WHERE c.ended_on IS NOT NULL)                         AS avg_weeks
       FROM referrals r JOIN cases c ON c.id = r.case_id
      WHERE c.household_id = $1
      GROUP BY r.provider_id`,
    [String(kase.household_id)],
  );
  const historyBy = new Map(history.map((h) => [String(h.provider_id), h] as const));

  const matchCase = {
    care: kase.care as CareType,
    schedule: (kase.schedule as string[]) ?? [],
    languagePref: (kase.language_pref as string) ?? null,
    rateBandLow: kase.rate_band_low === null ? null : String(kase.rate_band_low),
    rateBandHigh: kase.rate_band_high === null ? null : String(kase.rate_band_high),
    specialtiesWanted: (kase.adl_needs as string[]) ?? [],
  };
  const household = {
    crArea: String(kase.cr_area),
    blockedProviderIds: ((kase.blocked_provider_ids as string[]) ?? []).map(String),
  };

  const eligible: ShortlistEntry[] = [];
  const excluded: ExcludedEntry[] = [];

  for (const raw of providers) {
    const candidate: Candidate = {
      id: String(raw.id),
      fullName: String(raw.full_name),
      type: raw.type as ProviderType,
      transports: Boolean(raw.transports),
      status: raw.status as Candidate['status'],
      areas: (raw.areas as string[]) ?? [],
      availability: (raw.availability as string[]) ?? [],
      specialties: (raw.specialties as string[]) ?? [],
      languages: (raw.languages as string[]) ?? [],
      rateHourly: raw.rate_hourly === null ? null : String(raw.rate_hourly),
      credentials: credsBy.get(String(raw.id)) ?? [],
    };

    const h = historyBy.get(candidate.id);
    const result = screen(candidate, matchCase, household, today, {
      priorReferrals: Number(h?.prior_referrals ?? 0),
      priorEngagementsEndedWell: Number(h?.ended_well ?? 0),
      avgEngagementWeeks: h?.avg_weeks == null ? null : Math.round(Number(h.avg_weeks) * 10) / 10,
    });

    if (result.included) {
      eligible.push({
        providerId: candidate.id,
        fullName: candidate.fullName,
        type: candidate.type,
        rateHourly: candidate.rateHourly,
        rateNotes: (raw.rate_notes as string) ?? null,
        areas: candidate.areas,
        languages: candidate.languages,
        specialties: candidate.specialties,
        restrictions: (raw.restrictions as string) ?? null,
        signals: result.signals,
      });
    } else {
      excluded.push({
        providerId: candidate.id,
        fullName: candidate.fullName,
        type: candidate.type,
        exclusion: result.exclusion,
      });
    }
  }

  eligible.sort((a, b) => compareEligible(a.signals, b.signals, a.fullName, b.fullName));

  await auditRead(ctx, 'shortlist', caseId);
  await emit('shortlist_generated', { caseId },
    { candidateCount: eligible.length, excludedCount: excluded.length });

  return {
    caseId: String(kase.id),
    care: matchCase.care,
    schedule: matchCase.schedule,
    eligible,
    excluded,
  };
}

/** Save the operator's chosen shortlist to the timeline. Not a referral — § 5 keeps these
 *  separate, and the referral action sits behind the disclosure gate. */
export async function saveShortlistToTimeline(
  ctx: AuditContext,
  caseId: string,
  providerIds: string[],
): Promise<void> {
  const handle = await getDb();
  const { insertTimeline } = await import('@/lib/domain/referral');
  await handle.transaction(async (tx) => {
    const names = await tx.query<{ full_name: string }>(
      `SELECT full_name FROM providers WHERE id = ANY($1::uuid[]) ORDER BY full_name`,
      [providerIds],
    );
    await insertTimeline(tx, {
      caseId,
      type: 'shortlist',
      author: ctx.actor,
      body: `Shortlist saved: ${names.map((n) => n.full_name).join(', ') || 'none'}.`,
    });
  });
}
