/**
 * Write-through audit log. Spec § 3.8.
 *
 * Audit every read as well as every write. This data is health-adjacent information
 * about private individuals in a discretion-first market, and read logging is the thing
 * that lets the operator answer "who looked at this household" later. The table is
 * append-only at the database level (trg_audit_append_only).
 *
 * Retention is currently unbounded — set a policy once counsel answers the HIPAA
 * question (COUNSEL.md question 4).
 */
import { getDb, type Tx } from '@h-hallows/core/db';
import { AUDIT_ENTITIES, isAuditView, type AuditEntity, type AuditView } from '@h-hallows/core/domain';

export type AuditAction = 'read' | 'create' | 'update' | 'soft_delete';

export interface AuditContext {
  actor: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditRecord extends AuditContext {
  action: AuditAction;
  /**
   * From the closed vocabulary in @h-hallows/core/domain, and nowhere else. The names
   * drifted when this was a string — `document` beside `documents`, `case` beside
   * `cases` — and a query for one silently missed the other. Migration 0021 holds the
   * same list as a CHECK, so an entity added here without a migration is caught twice.
   */
  entity: AuditEntity | AuditView;
  /**
   * The primary key of `entity`'s OWN table, or null.
   *
   * This is the part that was wrong. A read of a case's bench used to be recorded as
   * ('shortlist', caseId) — the entity naming one table and the id belonging to
   * another — so the pair was not a key into anything and "who looked at this
   * household" had no query. What was being looked at belongs in `diff`; the pair
   * names the subject.
   */
  entityId?: string | null;
  diff?: unknown;
}

/**
 * A view carries no id by design: it is a screen, not a record. Passing one would put a
 * uuid under an entity that has no table to look it up in, which is the shape of the
 * bug this vocabulary exists to stop — so it throws here rather than being written.
 */
function assertIdBelongs(record: AuditRecord): void {
  if (record.entityId == null) return;
  if (isAuditView(record.entity)) {
    throw new Error(
      `audit: '${record.entity}' is a view and cannot carry an id (${record.entityId}). `
      + 'Record it against the subject it is about instead.',
    );
  }
  if (!(record.entity in AUDIT_ENTITIES)) {
    throw new Error(`audit: '${record.entity}' is not a known entity`);
  }
}

/**
 * Record a write.
 *
 * `tx` is how a mutation writes its audit row inside its own transaction, so the log
 * cannot disagree with what happened: for the referral and the disclosure this is the
 * § 1812.5095 evidence, and a log that can be missing the entry for a write it describes
 * is the weak version of it. Reads pass no tx — see auditRead, which must never block a
 * read — but a write that matters should go in with the row it is about.
 */
export async function audit(record: AuditRecord, tx?: Tx): Promise<void> {
  assertIdBelongs(record);
  const run = tx ?? (await getDb());
  await run.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, diff, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      record.actor,
      record.action,
      record.entity,
      record.entityId ?? null,
      record.diff === undefined ? null : JSON.stringify(record.diff),
      record.ip ?? null,
      record.userAgent ?? null,
    ],
  );
}

/**
 * Audit a read. Called by every query-layer function that returns identifiable data.
 * Failures here are logged but never block the read — a broken audit sink must not take
 * the operator's tool down mid-shift. It is loud so it gets noticed.
 */
export async function auditRead(
  ctx: AuditContext,
  entity: AuditEntity | AuditView,
  entityId?: string | null,
  /** What was read, where the subject alone does not say it: `{ read: 'bench' }`. */
  diff?: unknown,
): Promise<void> {
  try {
    await audit({ ...ctx, action: 'read', entity, entityId, diff });
  } catch (err) {
    console.error('[audit] failed to record read', { entity, entityId }, err);
  }
}

/** Shallow field-level diff, so the log says what changed rather than only that it did. */
export function diffOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = { from: a, to: b };
  }
  return out;
}
