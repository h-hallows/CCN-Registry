/**
 * The client portal's reads. Spec § 4.1.
 *
 * Everything here runs through `asPortalUser`, so row-level security decides what is
 * visible rather than a WHERE clause we remembered to write. The queries still scope
 * explicitly — belt and braces — but if one of them forgot to, the policies would
 * return nothing rather than someone else's case.
 */
import { eligibility } from '@h-hallows/core/domain';
import type { CredentialType } from '@h-hallows/core/schema';
import type { Tx } from '@h-hallows/core/db';
import { asPortalUser, forEligibilityCheck } from './portalDb';
import type { PortalSession } from './session';

export interface BenchProvider {
  providerId: string;
  fullName: string;
  type: string;
  /** Only ever set when photo consent is recorded. */
  photoUrl: string | null;
  rateHourly: string | null;
  specialties: string[];
  languages: string[];
  restrictions: string | null;
  position: number;
  /**
   * False when a required credential is missing or lapsed. The reason is deliberately
   * NOT carried out of this module: a household has no business seeing a provider's
   * credential problem.
   */
  available: boolean;
}

export interface Bench {
  caseId: string;
  shortlistId: string;
  publishedAt: string;
  note: string | null;
  care: string;
  providers: BenchProvider[];
}

interface ItemRow {
  shortlist_id: string;
  case_id: string;
  published_at: string;
  note: string | null;
  care: string;
  provider_id: string;
  full_name: string;
  type: string;
  rate_hourly: string | null;
  specialties: string[];
  languages: string[];
  restrictions: string | null;
  photo_url: string | null;
  photo_consent_on: string | null;
  position: number;
  appears_available: boolean;
}

interface CredRow { provider_id: string; type: string; expires_on: string | null }

/**
 * Eligibility is re-checked here even though the view already reports
 * `appears_available`.
 *
 * The view is a safety net for the EXPIRED case only. It cannot cover a MISSING
 * required credential, because that needs the per-type matrix from @h-hallows/core. The view
 * exists so a query written in a hurry fails safe; this is the check that is actually
 * correct, and it runs on every render because a shortlist published Monday can hold a
 * provider whose clearance lapses Tuesday.
 */
function availability(
  item: ItemRow,
  creds: CredRow[],
  now: Date,
): boolean {
  if (!item.appears_available) return false;
  const mine = creds
    .filter((c) => c.provider_id === item.provider_id)
    .map((c) => ({ type: c.type as CredentialType, expiresOn: c.expires_on }));
  return eligibility(
    { type: item.type as never, transports: false, status: 'active' },
    mine,
    now,
  ).eligible;
}

export async function currentBenches(
  session: PortalSession,
  now = new Date(),
): Promise<Bench[]> {
  if (!session.householdId) return [];

  // Two reads, deliberately sequential rather than nested.
  //
  // The elevated credential read cannot happen inside the household's transaction: a
  // pooled driver would hand it a second connection and work, while the embedded
  // single-connection one deadlocks against the transaction already open. Running them
  // one after the other behaves identically on both.
  const items = await asPortalUser(session, (tx: Tx) => tx.query<ItemRow>(
    `SELECT s.id AS shortlist_id, s.case_id, s.published_at, s.note, c.care::text AS care,
            v.provider_id, v.full_name, v.type::text AS type, v.rate_hourly::text,
            v.specialties, v.languages, v.restrictions,
            v.photo_url, v.photo_consent_on, v.position, v.appears_available
       FROM published_shortlists s
       JOIN cases c ON c.id = s.case_id
       JOIN v_shortlist_items_client v ON v.shortlist_id = s.id
      WHERE s.withdrawn_at IS NULL
        AND c.status <> 'ended'
      ORDER BY s.published_at DESC, v.position`,
  ));
  if (items.length === 0) return [];

  // Outside the household's claim: they cannot see `credentials`, and should not. Only
  // the resulting boolean reaches them. See forEligibilityCheck.
  const creds = await forEligibilityCheck((op) => op.query<CredRow>(
    `SELECT provider_id, type::text AS type, expires_on::text
       FROM credentials
      WHERE deleted_at IS NULL
        AND provider_id = ANY($1::uuid[])`,
    [items.map((i) => i.provider_id)],
  ));

  const byShortlist = new Map<string, Bench>();
  for (const item of items) {
    const bench = byShortlist.get(item.shortlist_id) ?? {
      caseId: item.case_id,
      shortlistId: item.shortlist_id,
      publishedAt: item.published_at,
      note: item.note,
      care: item.care,
      providers: [],
    };
    bench.providers.push({
      providerId: item.provider_id,
      fullName: item.full_name,
      type: item.type,
      // The view returns photo_url regardless; consent is what decides whether it is
      // ever rendered. A photo without a recorded consent is not ours to show.
      photoUrl: item.photo_consent_on ? item.photo_url : null,
      rateHourly: item.rate_hourly,
      specialties: item.specialties ?? [],
      languages: item.languages ?? [],
      restrictions: item.restrictions,
      position: item.position,
      available: availability(item, creds, now),
    });
    byShortlist.set(item.shortlist_id, bench);
  }
  return [...byShortlist.values()];
}

export interface BenchProviderDetail extends BenchProvider {
  shortlistId: string;
  caseId: string;
  /**
   * What was verified and when. Never a licence number, never a Live Scan result —
   * counsel question 13 is open on whether a household may see those at all, and the
   * conservative reading costs a household nothing.
   */
  verified: { label: string; verifiedOn: string }[];
  /** Mean engagement length across this provider's ended engagements, in weeks. */
  continuityWeeks: number | null;
  availabilityBlocks: string[];
}

const CREDENTIAL_LABEL: Record<string, string> = {
  rn_license: 'Registered nurse licence',
  lvn_license: 'Licensed vocational nurse licence',
  cna_cert: 'Certified nursing assistant certification',
  hca_registry: 'Home care aide registration',
  live_scan: 'Background screening',
  tb_clearance: 'Tuberculosis clearance',
  cpr_bls: 'CPR and basic life support',
  auto_insurance: 'Auto insurance',
  drivers_license: "Driver's licence",
  immunization: 'Immunisation record',
  other: 'Other',
};

/** Not shown to a household at all, pending counsel question 13. */
const WITHHELD_FROM_HOUSEHOLD = new Set(['live_scan']);

export async function benchProvider(
  session: PortalSession,
  providerId: string,
  now = new Date(),
): Promise<BenchProviderDetail | null> {
  const benches = await currentBenches(session, now);
  for (const bench of benches) {
    const found = bench.providers.find((p) => p.providerId === providerId);
    if (!found) continue;

    // Same reasoning: the household cannot read `credentials`, so the facts it is
    // entitled to see are selected here and filtered before they cross.
    const creds = await forEligibilityCheck((op) => op.query<{ type: string; verified_on: string }>(
      `SELECT type::text AS type, verified_on::text
         FROM credentials
        WHERE provider_id = $1 AND deleted_at IS NULL
        ORDER BY type`,
      [providerId],
    ));

    return asPortalUser(session, async (tx) => {
      const [extra] = await tx.query<{ availability: string[] }>(
        `SELECT availability FROM providers WHERE id = $1`, [providerId],
      );

      return {
        ...found,
        shortlistId: bench.shortlistId,
        caseId: bench.caseId,
        verified: creds
          .filter((c) => !WITHHELD_FROM_HOUSEHOLD.has(c.type))
          .map((c) => ({
            label: CREDENTIAL_LABEL[c.type] ?? c.type,
            verifiedOn: c.verified_on,
          })),
        continuityWeeks: null,
        availabilityBlocks: extra?.availability ?? [],
      };
    });
  }
  return null;
}
