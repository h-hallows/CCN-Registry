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
import { getDb } from '@/lib/db/client';

export type AuditAction = 'read' | 'create' | 'update' | 'soft_delete';

export interface AuditContext {
  actor: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditRecord extends AuditContext {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  diff?: unknown;
}

export async function audit(record: AuditRecord): Promise<void> {
  const { query } = await getDb();
  await query(
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
  entity: string,
  entityId?: string | null,
): Promise<void> {
  try {
    await audit({ ...ctx, action: 'read', entity, entityId });
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
