/**
 * Live rate ranges. Spec § 5.
 *
 * Never written into page content. A published rate that has drifted from reality is
 * both a conversion problem and, under § 1812.533(b)(1), a misleading advertisement —
 * so the number on the page comes from the table the operator maintains, revalidated
 * hourly, and a test asserts no MDX or page file contains a rate figure.
 *
 * The range is what is shown, and it is shown as a range on purpose: the provider sets
 * their rate and it stays negotiable with the household (I5). A single number would
 * read as a price list, which this is not.
 */
import { getDb } from '@ccn/core/db';

export const RATE_REVALIDATE_SECONDS = 3600;

export type CredentialLevel = 'companion' | 'hca' | 'cna' | 'lvn' | 'rn';

export interface RateRange {
  serviceKey: string;
  credentialLevel: CredentialLevel;
  low: number;
  high: number;
  note: string | null;
}

export const CREDENTIAL_LABEL: Record<CredentialLevel, string> = {
  companion: 'Companion',
  hca: 'Home care aide',
  cna: 'Certified nursing assistant',
  lvn: 'Licensed vocational nurse',
  rn: 'Registered nurse',
};

/** Ordered as a household would read them: least clinical first. */
export const CREDENTIAL_ORDER: CredentialLevel[] = ['companion', 'hca', 'cna', 'lvn', 'rn'];

/**
 * The ranges in force today. Only the newest row per service and level whose
 * effective_from has arrived — a future-dated change is posted but not yet live.
 */
export async function currentRateRanges(serviceKey?: string): Promise<RateRange[]> {
  const { query } = await getDb();
  const rows = await query<{
    service_key: string; credential_level: string; low: string; high: string; note: string | null;
  }>(
    `SELECT DISTINCT ON (service_key, credential_level)
            service_key, credential_level, low::text, high::text, note
       FROM rate_ranges
      WHERE effective_from <= (now() AT TIME ZONE 'America/Los_Angeles')::date
        AND ($1::text IS NULL OR service_key = $1)
      ORDER BY service_key, credential_level, effective_from DESC`,
    [serviceKey ?? null],
  );

  return rows.map((r) => ({
    serviceKey: r.service_key,
    credentialLevel: r.credential_level as CredentialLevel,
    low: Number(r.low),
    high: Number(r.high),
    note: r.note,
  }));
}

export function formatRange(r: RateRange): string {
  return `$${r.low.toFixed(0)}–$${r.high.toFixed(0)} an hour`;
}
