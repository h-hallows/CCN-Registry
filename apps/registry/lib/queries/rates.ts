/**
 * The published rate bands — Civil Code § 1812.533(b)(1). Spec § 5.
 *
 * WHAT THIS SCREEN IS FOR. The public pricing page and the crossed landing pages show a
 * band per service and credential level, read live from `rate_ranges` rather than
 * written into page content — which was the right decision, and left half-finished.
 * Nothing in this console has ever written that table. The bands the public have been
 * reading are seeded demonstration data, and an operator who noticed they were wrong had
 * no way to say so except by editing the database by hand.
 *
 * A band is an advertising claim. § 1812.533(b)(1) prohibits publishing false or
 * misleading information, so a band that has drifted from what providers actually charge
 * is the same kind of problem as a wrong name in a footer, not a conversion problem.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO. It does not propose a band. I5: a provider
 * sets their own rate and it stays negotiable with the household, and nothing in this
 * system computes, suggests, caps or defaults it. A button that filled the band in from
 * the roster would be the registry setting a price with extra steps.
 *
 * What it does instead is show, beside the empty field, what the roster actually charges
 * at that level — the spread and the middle of it — so the operator types a number
 * against the facts rather than against memory. `bandNotes` in core says what is worth
 * saying about the result, and says it rather than refusing, because the observation is
 * by credential level and the band is by service.
 */
import { getDb } from '@h-hallows/core/db';
import {
  BANDED_SERVICES, CARE_LABEL, CREDENTIAL_LEVELS, CREDENTIAL_LEVEL_LABEL,
  RATE_BAND_INSERT, bandIsPostable, bandNotes, isBandedService, isCredentialLevel,
  levelOfProviderType,
  type BandNote, type CredentialLevel, type ObservedRates,
} from '@h-hallows/core/domain';
import { audit, auditRead, type AuditContext } from '@/lib/audit';

export class RateBandError extends Error {}

/** One band, as the record holds it. */
export interface Band {
  id: string;
  serviceKey: string;
  serviceLabel: string;
  level: CredentialLevel;
  levelLabel: string;
  low: number;
  high: number;
  effectiveFrom: string;
  note: string | null;
  postedBy: string;
  postedAt: string;
  /** In force today: the newest band for this pair whose date has arrived. */
  inForce: boolean;
  /** Dated ahead. Posted, and not yet what the page says. */
  upcoming: boolean;
  /** Superseded by a later band that has already taken effect. */
  superseded: boolean;
}

export interface RateBandsState {
  bands: Band[];
  /** What the roster charges, by credential level. The denominator for every judgement. */
  observed: ObservedRates[];
  /** California's date, which is the one the public query compares against. */
  today: string;
  /** Service and level pairs with no band at all — a page with nothing to show. */
  unpriced: { serviceKey: string; serviceLabel: string }[];
  /** Bands still carrying the seed as their author. */
  seeded: number;
}

interface Row {
  id: string; service_key: string; credential_level: string;
  low: string; high: string; effective_from: string; note: string | null;
  posted_by: string; posted_at: string; in_force: boolean; upcoming: boolean;
}

async function californiaToday(): Promise<string> {
  const db = await getDb();
  const [row] = await db.query<{ d: string }>(
    `SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date::text AS d`);
  return row!.d;
}

/**
 * What the roster charges, by credential level.
 *
 * Active providers only, and only those with a rate on file: a rate nobody has stated is
 * not a rate of zero, and averaging it in would drag every band downwards. The median is
 * taken rather than the mean so that one provider at two hundred dollars an hour does
 * not move the number an operator is reading.
 *
 * Observed by LEVEL and not by service, because that is what the roster records. The
 * screen says so, and `bandNotes` is written around the gap rather than over it.
 */
async function observedRates(): Promise<ObservedRates[]> {
  const db = await getDb();
  const rows = await db.query<{
    type: string; n: string; low: string | null; high: string | null; med: string | null;
  }>(
    `SELECT p.type::text AS type,
            count(*)::text AS n,
            min(p.rate_hourly)::text AS low,
            max(p.rate_hourly)::text AS high,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY p.rate_hourly))::text AS med
       FROM providers p
      WHERE p.deleted_at IS NULL
        AND p.status = 'active'
        AND p.rate_hourly IS NOT NULL
      GROUP BY p.type`,
  );

  const byLevel = new Map<CredentialLevel, ObservedRates>();
  for (const level of CREDENTIAL_LEVELS) {
    byLevel.set(level, { level, count: 0, low: null, high: null, median: null });
  }
  for (const r of rows) {
    const level = levelOfProviderType(r.type);
    if (level === null) continue;
    byLevel.set(level, {
      level,
      count: Number(r.n),
      low: r.low === null ? null : Number(r.low),
      high: r.high === null ? null : Number(r.high),
      median: r.med === null ? null : Number(r.med),
    });
  }

  /*
   * A level with providers but no rates on file reads as count 0 above, because the
   * query filters them out — and "nobody at this level" and "nobody has stated a rate"
   * are different sentences on the screen. So the headcount is taken separately.
   */
  const heads = await db.query<{ type: string; n: string }>(
    `SELECT p.type::text AS type, count(*)::text AS n
       FROM providers p
      WHERE p.deleted_at IS NULL AND p.status = 'active'
      GROUP BY p.type`,
  );
  for (const h of heads) {
    const level = levelOfProviderType(h.type);
    if (level === null) continue;
    const existing = byLevel.get(level)!;
    if (existing.count === 0) byLevel.set(level, { ...existing, count: Number(h.n) });
  }

  return CREDENTIAL_LEVELS.map((l) => byLevel.get(l)!);
}

/** Every band ever posted, newest first, with what is live marked. */
export async function rateBands(ctx: AuditContext): Promise<RateBandsState> {
  const db = await getDb();
  const today = await californiaToday();

  const rows = await db.query<Row>(
    `WITH today AS (SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date AS d),
     live AS (
       SELECT DISTINCT ON (service_key, credential_level) id
         FROM rate_ranges, today
        WHERE effective_from <= today.d
        ORDER BY service_key, credential_level, effective_from DESC
     )
     SELECT r.id, r.service_key, r.credential_level,
            r.low::text, r.high::text, r.effective_from::text,
            r.note, r.posted_by, r.posted_at::text,
            (r.id IN (SELECT id FROM live))      AS in_force,
            (r.effective_from > today.d)         AS upcoming
       FROM rate_ranges r, today
      ORDER BY r.effective_from DESC, r.service_key, r.credential_level`,
  );

  const bands: Band[] = rows.map((r) => {
    const level = isCredentialLevel(r.credential_level) ? r.credential_level : 'companion';
    return {
      id: r.id,
      serviceKey: r.service_key,
      serviceLabel: isBandedService(r.service_key)
        ? CARE_LABEL[r.service_key] : r.service_key,
      level,
      levelLabel: CREDENTIAL_LEVEL_LABEL[level],
      low: Number(r.low),
      high: Number(r.high),
      effectiveFrom: r.effective_from,
      note: r.note,
      postedBy: r.posted_by,
      postedAt: r.posted_at,
      inForce: r.in_force,
      upcoming: r.upcoming,
      superseded: !r.in_force && !r.upcoming,
    };
  });

  const priced = new Set(bands.filter((b) => b.inForce).map((b) => b.serviceKey));
  const unpriced = BANDED_SERVICES
    .filter((s) => !priced.has(s))
    .map((s) => ({ serviceKey: s, serviceLabel: CARE_LABEL[s] }));

  await auditRead(ctx, 'rate_band', null, {
    read: 'the published rate bands',
    section: 'Civil Code § 1812.533(b)(1)',
    bands: bands.length,
    inForce: bands.filter((b) => b.inForce).length,
  });

  return {
    bands,
    observed: await observedRates(),
    today,
    unpriced,
    seeded: bands.filter((b) => b.inForce && b.postedBy === 'seed').length,
  };
}

export interface NewBand {
  serviceKey: string;
  level: string;
  low: number;
  high: number;
  effectiveFrom: string;
  note: string | null;
}

/**
 * Post a band.
 *
 * The refusals here are the structural ones, phrased so the operator learns what is
 * wrong rather than which constraint fired. The judgements are returned to the screen as
 * notes and do not stop anything, for the reason in `src/domain/rates.ts`.
 */
export interface PostedBand {
  id: string;
  /**
   * What was worth saying about the band that was just published.
   *
   * Returned rather than swallowed. The whole design is that a band outside what the
   * roster charges posts WITH a warning rather than being refused — and the first
   * version computed those warnings, recorded them in the audit diff, and told the
   * operator nothing. A warning nobody reads is the same as no warning, and worse,
   * because the record says they were told.
   */
  notes: BandNote[];
}

export async function postBand(ctx: AuditContext, input: NewBand): Promise<PostedBand> {
  const db = await getDb();

  if (!isBandedService(input.serviceKey)) {
    throw new RateBandError(
      `“${input.serviceKey}” is not a service any page quotes a band for, so a band for `
      + 'it would be published, invisible, and still in the record as a claim.');
  }
  if (!isCredentialLevel(input.level)) {
    throw new RateBandError(`“${input.level}” is not a credential level.`);
  }

  const observed = (await observedRates()).find((o) => o.level === input.level) ?? null;
  const notes = bandNotes(
    { serviceKey: input.serviceKey, level: input.level, low: input.low, high: input.high },
    observed,
  );
  if (!bandIsPostable(notes)) {
    throw new RateBandError(notes.find((n) => n.blocking)!.message);
  }

  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM rate_ranges
        WHERE service_key = $1 AND credential_level = $2 AND effective_from = $3::date`,
      [input.serviceKey, input.level, input.effectiveFrom],
    );
    if (existing.length > 0) {
      throw new RateBandError(
        'A band for that service and level already takes effect on that date. The record '
        + 'is append-only, so choose another date rather than replacing it — which is '
        + 'also what keeps it possible to say what the page showed, and when.');
    }

    const [row] = await tx.query<{ id: string }>(RATE_BAND_INSERT, [
      input.serviceKey, input.level, input.low, input.high,
      input.effectiveFrom, input.note?.trim() || null, ctx.actor,
    ]);

    await audit({
      ...ctx, action: 'create', entity: 'rate_band', entityId: row!.id,
      diff: {
        service: input.serviceKey, level: input.level,
        band: `$${input.low}–${input.high}`, effectiveFrom: input.effectiveFrom,
        notes: notes.map((n) => n.concern),
        section: 'Civil Code § 1812.533(b)(1)',
      },
    }, tx);
    return { id: row!.id, notes };
  });
}

export { BANDED_SERVICES, CARE_LABEL, CREDENTIAL_LEVELS, CREDENTIAL_LEVEL_LABEL };
