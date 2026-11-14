/**
 * Reading the audit log. Spec § 3.8.
 *
 * The log has been written from day one and could not be read. `audit_log` holds
 * `(entity, entity_id)`, the names drifted, and the id did not mean the same thing
 * twice — so the one question the table exists for, WHO LOOKED AT THIS HOUSEHOLD, had
 * no query behind it. The answer was "run SQL", which is the same as no answer when
 * somebody is standing in front of you asking.
 *
 * HOW A ROW IS ATTRIBUTED TO A SUBJECT. Each entity in @h-hallows/core/domain carries
 * the SQL selecting the rows of its table that are about a given household or provider.
 * The union of those is the subject's span, and a row belongs to the trail when its
 * `entity_id` is in the span.
 *
 * The match is on the ID ALONE, not on the pair. That is deliberate and it is the
 * stronger test: these are gen_random_uuid() keys, so a uuid that is a row of this
 * household's cases is about that case whatever the `entity` column was told to say.
 * Matching the pair would drop every row written before the vocabulary existed —
 * precisely the history worth having — and dropping them would look like a household
 * nobody had read. Where the declared entity disagrees with the table the id is really
 * in, the row is kept and the disagreement is shown.
 *
 * THIS SCREEN IS ITSELF A READ of identifiable data, so it writes its own audit rows:
 * the log as a view, and the subject whose trail was opened. Someone who reads a
 * household's history leaves the same mark as someone who reads the household.
 */
import { getDb } from '@h-hallows/core/db';
import {
  AUDIT_ENTITIES, AUDIT_ENTITY_NAMES, AUDIT_VIEWS, auditEntityLabel,
  canonicalAuditEntity, isAuditView, type AuditEntity,
} from '@h-hallows/core/domain';
import { auditRead, type AuditContext } from '@/lib/audit';

export type Direction = 'byHousehold' | 'byProvider';

export interface TrailRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  /** Exactly what the column holds, so the screen never claims the log said something else. */
  storedEntity: string;
  /** The canonical name, or null where the stored name is in neither list. */
  entity: AuditEntity | null;
  label: string;
  entityId: string | null;
  /** The table the id is really a row of, from the span. */
  actualEntity: AuditEntity;
  /** True where `storedEntity` names a different table than the id belongs to. */
  mislabelled: boolean;
  diff: unknown;
  ip: string | null;
}

/** `(entity, id)` pairs for everything about one subject. */
function spanSql(direction: Direction): { sql: string; entities: AuditEntity[] } {
  const parts: string[] = [];
  const entities: AuditEntity[] = [];
  for (const name of AUDIT_ENTITY_NAMES) {
    const fragment = AUDIT_ENTITIES[name][direction];
    if (!fragment) continue;
    // The literal is a key of AUDIT_ENTITIES, never anything a request supplied.
    parts.push(`SELECT '${name}'::text AS entity, s.id FROM (${fragment}) s`);
    entities.push(name);
  }
  return { sql: parts.join('\n      UNION ALL\n      '), entities };
}

async function trail(
  direction: Direction,
  subjectId: string,
  limit: number,
): Promise<TrailRow[]> {
  const { sql } = spanSql(direction);
  const { query } = await getDb();
  const rows = await query<{
    id: string; at: string; actor: string; action: string; entity: string;
    entity_id: string | null; actual_entity: string; diff: unknown; ip: string | null;
  }>(
    `WITH span(entity, id) AS (
      ${sql}
     )
     SELECT a.id, a.at::text, a.actor, a.action, a.entity, a.entity_id::text,
            s.entity AS actual_entity, a.diff, a.ip
       FROM audit_log a
       JOIN span s ON s.id = a.entity_id
      ORDER BY a.at DESC, a.id
      LIMIT ${limit}`,
    [subjectId],
  );

  return rows.map((r) => {
    const entity = canonicalAuditEntity(r.entity);
    return {
      id: r.id,
      at: r.at,
      actor: r.actor,
      action: r.action,
      storedEntity: r.entity,
      entity,
      label: auditEntityLabel(r.entity),
      entityId: r.entity_id,
      actualEntity: r.actual_entity as AuditEntity,
      mislabelled: entity !== null && entity !== r.actual_entity,
      diff: r.diff,
      ip: r.ip,
    };
  });
}

export interface HouseholdTrail {
  householdId: string;
  householdName: string;
  rows: TrailRow[];
  /** Distinct people who have read or written anything about them, most recent first. */
  readers: { actor: string; reads: number; writes: number; lastAt: string }[];
  truncatedAt: number | null;
}

const TRAIL_LIMIT = 400;

export async function householdTrail(
  ctx: AuditContext,
  householdId: string,
): Promise<HouseholdTrail | null> {
  const { query } = await getDb();
  const [household] = await query<{ display_name: string }>(
    `SELECT display_name FROM households WHERE id = $1`, [householdId],
  );
  if (!household) return null;

  const rows = await trail('byHousehold', householdId, TRAIL_LIMIT + 1);

  /*
   * Opening a household's history is reading that household. Recording it any other way
   * would make the audit screen the one place in the console you can look from without
   * leaving a mark, which is the opposite of what § 3.8 is for.
   */
  await auditRead(ctx, 'household', householdId, { read: 'the audit trail' });

  return {
    householdId,
    householdName: household.display_name,
    rows: rows.slice(0, TRAIL_LIMIT),
    readers: summarise(rows),
    truncatedAt: rows.length > TRAIL_LIMIT ? TRAIL_LIMIT : null,
  };
}

export interface ProviderTrail {
  providerId: string;
  providerName: string;
  rows: TrailRow[];
  readers: { actor: string; reads: number; writes: number; lastAt: string }[];
  truncatedAt: number | null;
}

export async function providerTrail(
  ctx: AuditContext,
  providerId: string,
): Promise<ProviderTrail | null> {
  const { query } = await getDb();
  const [provider] = await query<{ full_name: string }>(
    `SELECT full_name FROM providers WHERE id = $1`, [providerId],
  );
  if (!provider) return null;

  const rows = await trail('byProvider', providerId, TRAIL_LIMIT + 1);
  await auditRead(ctx, 'provider', providerId, { read: 'the audit trail' });

  return {
    providerId,
    providerName: provider.full_name,
    rows: rows.slice(0, TRAIL_LIMIT),
    readers: summarise(rows),
    truncatedAt: rows.length > TRAIL_LIMIT ? TRAIL_LIMIT : null,
  };
}

function summarise(rows: TrailRow[]): HouseholdTrail['readers'] {
  const by = new Map<string, { actor: string; reads: number; writes: number; lastAt: string }>();
  for (const row of rows) {
    const seen = by.get(row.actor) ?? { actor: row.actor, reads: 0, writes: 0, lastAt: row.at };
    if (row.action === 'read') seen.reads += 1; else seen.writes += 1;
    if (row.at > seen.lastAt) seen.lastAt = row.at;
    by.set(row.actor, seen);
  }
  return [...by.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export interface ActorRow {
  actor: string;
  reads: number;
  writes: number;
  firstAt: string;
  lastAt: string;
}

/** Everyone the log has ever recorded, busiest last seen first. */
export async function actors(ctx: AuditContext): Promise<ActorRow[]> {
  const { query } = await getDb();
  const rows = await query<{
    actor: string; reads: string; writes: string; first_at: string; last_at: string;
  }>(
    `SELECT actor,
            count(*) FILTER (WHERE action = 'read')::text  AS reads,
            count(*) FILTER (WHERE action <> 'read')::text AS writes,
            min(at)::text AS first_at,
            max(at)::text AS last_at
       FROM audit_log
      GROUP BY actor
      ORDER BY max(at) DESC`,
  );
  await auditRead(ctx, 'audit_log', null, { read: 'who the log has recorded' });
  return rows.map((r) => ({
    actor: r.actor,
    reads: Number(r.reads),
    writes: Number(r.writes),
    firstAt: r.first_at,
    lastAt: r.last_at,
  }));
}

export interface ActorEntry {
  id: string;
  at: string;
  action: string;
  storedEntity: string;
  label: string;
  entityId: string | null;
  diff: unknown;
  ip: string | null;
  /** True where the entity is a screen rather than a record, so there is nothing to open. */
  isView: boolean;
}

/** What one person has done. The insider question, which is the other half of § 3.8. */
export async function actorTrail(
  ctx: AuditContext,
  actor: string,
  limit = 300,
): Promise<ActorEntry[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; at: string; action: string; entity: string; entity_id: string | null;
    diff: unknown; ip: string | null;
  }>(
    `SELECT id, at::text, action, entity, entity_id::text, diff, ip
       FROM audit_log WHERE actor = $1 ORDER BY at DESC, id LIMIT ${limit}`,
    [actor],
  );
  await auditRead(ctx, 'audit_log', null, { read: `everything recorded for ${actor}` });
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    storedEntity: r.entity,
    label: isAuditView(r.entity)
      ? AUDIT_VIEWS[r.entity]
      : auditEntityLabel(r.entity),
    entityId: r.entity_id,
    diff: r.diff,
    ip: r.ip,
    isView: isAuditView(r.entity),
  }));
}

export interface WriteEntry extends ActorEntry {
  actor: string;
}

/** Every write, newest first. The log is mostly reads, so the writes are the needle. */
export async function recentWrites(ctx: AuditContext, limit = 200): Promise<WriteEntry[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; at: string; actor: string; action: string; entity: string;
    entity_id: string | null; diff: unknown; ip: string | null;
  }>(
    `SELECT id, at::text, actor, action, entity, entity_id::text, diff, ip
       FROM audit_log WHERE action <> 'read' ORDER BY at DESC, id LIMIT ${limit}`,
  );
  await auditRead(ctx, 'audit_log', null, { read: 'recent writes' });
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    actor: r.actor,
    storedEntity: r.entity,
    label: isAuditView(r.entity) ? AUDIT_VIEWS[r.entity] : auditEntityLabel(r.entity),
    entityId: r.entity_id,
    diff: r.diff,
    ip: r.ip,
    isView: isAuditView(r.entity),
  }));
}

export interface Integrity {
  total: number;
  reads: number;
  writes: number;
  oldestAt: string | null;
  /** Names in neither the entity list nor the view list — unreadable without a guess. */
  unrecognised: { entity: string; rows: number }[];
  /** Rows whose id is not in the table their entity names. Attributable by id, not by pair. */
  mislabelled: { entity: string; rows: number }[];
}

/**
 * What the log cannot tell you, counted.
 *
 * This is here because the alternative is a screen that looks complete. `audit_log` is
 * append-only — that is what makes it evidence rather than a note — so the rows written
 * before the vocabulary stay exactly as they were written, and the honest thing is to
 * say how many of them there are and what is wrong with them.
 */
export async function integrity(ctx: AuditContext): Promise<Integrity> {
  const { query } = await getDb();

  const [totals] = await query<{
    total: string; reads: string; writes: string; oldest: string | null;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE action = 'read')::text  AS reads,
            count(*) FILTER (WHERE action <> 'read')::text AS writes,
            min(at)::text AS oldest
       FROM audit_log`,
  );

  const byEntity = await query<{ entity: string; rows: string }>(
    `SELECT entity, count(*)::text AS rows FROM audit_log GROUP BY entity`,
  );

  const unrecognised = byEntity
    .filter((r) => canonicalAuditEntity(r.entity) === null && !isAuditView(r.entity))
    .map((r) => ({ entity: r.entity, rows: Number(r.rows) }))
    .sort((a, b) => b.rows - a.rows);

  /*
   * One statement per entity that has an id and a table, asking how many of its rows
   * name something that is not in that table. Dozens of small counts rather than one
   * clever query, because a clever query here that is subtly wrong reports a clean log.
   */
  const mislabelled: { entity: string; rows: number }[] = [];
  for (const row of byEntity) {
    const entity = canonicalAuditEntity(row.entity);
    if (!entity) continue;
    const table = AUDIT_ENTITIES[entity].table;
    const [count] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log a
        WHERE a.entity = $1 AND a.entity_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = a.entity_id)`,
      [row.entity],
    );
    const n = Number(count!.n);
    if (n > 0) mislabelled.push({ entity: row.entity, rows: n });
  }
  mislabelled.sort((a, b) => b.rows - a.rows);

  await auditRead(ctx, 'audit_log', null, { read: 'the integrity summary' });

  return {
    total: Number(totals!.total),
    reads: Number(totals!.reads),
    writes: Number(totals!.writes),
    oldestAt: totals!.oldest,
    unrecognised,
    mislabelled,
  };
}

/** Households to pick from, most recently touched first. */
export async function householdChoices(): Promise<{ id: string; name: string }[]> {
  const { query } = await getDb();
  const rows = await query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM households
      WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({ id: r.id, name: r.display_name }));
}

export async function providerChoices(): Promise<{ id: string; name: string }[]> {
  const { query } = await getDb();
  const rows = await query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM providers
      WHERE deleted_at IS NULL ORDER BY full_name LIMIT 300`,
  );
  return rows.map((r) => ({ id: r.id, name: r.full_name }));
}

/**
 * Consecutive identical reads, collapsed with a count.
 *
 * One page view of a case records the household more than once — the detail query, the
 * portal accounts and, where there are any, the consents each read it — and every one of
 * those is true. Left alone they are most of the table, and the one unusual entry gets
 * buried in them. So identical neighbours within the same second become one row that
 * says how many.
 *
 * Nothing is dropped. The count is the number of rows behind the one shown, and the
 * totals from `integrity()` count every row separately — a screen that quietly showed
 * fewer entries than the log holds would be the same failure as a log that cannot be
 * queried.
 */
export function collapse(rows: TrailRow[]): { row: TrailRow; times: number }[] {
  const out: { row: TrailRow; times: number }[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    const same = last
      && last.row.actor === row.actor
      && last.row.action === row.action
      && last.row.storedEntity === row.storedEntity
      && last.row.entityId === row.entityId
      && JSON.stringify(last.row.diff) === JSON.stringify(row.diff)
      // Same second, so a repeat an hour later is still its own line.
      && last.row.at.slice(0, 19) === row.at.slice(0, 19);
    if (same) last.times += 1;
    else out.push({ row, times: 1 });
  }
  return out;
}
