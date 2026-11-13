/**
 * What a household has agreed the registry may share. Architecture spec § 3.5.
 *
 * WHAT WAS MISSING. `household_shares_outcome_with_partner()` — the gate that decides
 * whether a referral partner ever learns how their referral went — reads `consents`
 * for a live row of kind `partner_outcome`. Nothing wrote one. So the partner portal's
 * outcome column was NULL for every referral ever sent, permanently, and the sentence
 * on that screen promising "where a family has told us we may share how it went, you
 * will see that here" described something that could not happen.
 *
 * CONSENT IS RECORDED, NEVER INFERRED. Not from the family having used a partner, not
 * from them having been friendly on the phone, and not as a default on a form. The row
 * names who gave it and when, because the question a year later is "who agreed to
 * this, and when" and a boolean on the household answers neither.
 *
 * REVOKING LEAVES THE ROW. `revoked_at` is set and the grant stays, so the record
 * shows that permission existed and ended — and migration 0014's trigger unpublishes
 * anything that depended on it. A deleted consent is indistinguishable from one nobody
 * ever gave.
 */
import { getDb } from '@h-hallows/core/db';
import { audit, auditRead, type AuditContext } from '@/lib/audit';
import { insertTimeline } from '@/lib/domain/referral';

export class ConsentError extends Error {}

export const CONSENT_KINDS = ['partner_outcome', 'photo', 'testimonial', 'case_study'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export const CONSENT_LABEL: Record<ConsentKind, string> = {
  partner_outcome: 'Tell whoever referred them how it went',
  photo: 'Use a photograph',
  testimonial: 'Quote them',
  case_study: 'Write up their case',
};

/** What each one actually permits, in the words the operator should read out. */
export const CONSENT_MEANS: Record<ConsentKind, string> = {
  partner_outcome:
    'The discharge planner or adviser who sent them to us will see that care was '
    + 'arranged. Not who with, not what it costs, not anything clinical.',
  photo: 'A photograph of them may appear on the public site.',
  testimonial:
    'Something they said may be quoted publicly, under a first name and an area — '
    + 'never a full name, and never attributed to a provider.',
  case_study: 'Their situation may be written up, without identifying them.',
};

export interface ConsentRow {
  id: string;
  kind: ConsentKind;
  grantedAt: string;
  grantedBy: string;
  scopeNote: string | null;
  revokedAt: string | null;
}

export async function consentsFor(
  ctx: AuditContext,
  householdId: string,
): Promise<ConsentRow[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; kind: string; granted_at: string; granted_by: string;
    scope_note: string | null; revoked_at: string | null;
  }>(
    `SELECT id, kind, granted_at::text, granted_by, scope_note, revoked_at::text
       FROM consents
      WHERE subject_type = 'household' AND subject_id = $1
      ORDER BY granted_at DESC`,
    [householdId],
  );
  if (rows.length > 0) await auditRead(ctx, 'consent', householdId);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as ConsentKind,
    grantedAt: r.granted_at,
    grantedBy: r.granted_by,
    scopeNote: r.scope_note,
    revokedAt: r.revoked_at,
  }));
}

export async function recordConsent(
  ctx: AuditContext,
  input: {
    householdId: string;
    kind: ConsentKind;
    /** The person in the family who gave it, by name. Not the operator. */
    grantedBy: string;
    scopeNote?: string;
  },
): Promise<void> {
  const grantedBy = input.grantedBy.trim();
  if (grantedBy.length < 2) {
    throw new ConsentError('Name the person who agreed. Consent is given by somebody.');
  }

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [household] = await tx.query<{ id: string }>(
      `SELECT id FROM households WHERE id = $1 AND deleted_at IS NULL`,
      [input.householdId],
    );
    if (!household) throw new ConsentError('That household does not exist.');

    const [live] = await tx.query<{ id: string }>(
      `SELECT id FROM consents
        WHERE subject_type = 'household' AND subject_id = $1
          AND kind = $2 AND revoked_at IS NULL`,
      [input.householdId, input.kind],
    );
    if (live) throw new ConsentError('They have already agreed to that.');

    await tx.query(
      `INSERT INTO consents
         (subject_type, subject_id, kind, granted_at, granted_by, scope_note)
       VALUES ('household', $1, $2, now(), $3, $4)`,
      [input.householdId, input.kind, grantedBy, input.scopeNote?.trim() || null],
    );

    await insertTimeline(tx, {
      householdId: input.householdId,
      type: 'note',
      author: ctx.actor,
      body: `${grantedBy} agreed: ${CONSENT_LABEL[input.kind].toLowerCase()}.`
        + (input.scopeNote?.trim() ? ` ${input.scopeNote.trim()}` : ''),
    });

    await audit({
      ...ctx,
      action: 'create',
      entity: 'consent',
      entityId: input.householdId,
      diff: { kind: input.kind, grantedBy, scopeNote: input.scopeNote?.trim() || null },
    }, tx);
  });
}

/**
 * Withdraw it.
 *
 * The row stays and gains `revoked_at`, which is what lets the record say permission
 * existed and ended. Migration 0014's trigger unpublishes anything that depended on
 * it, so a withdrawn testimonial comes off the site without anybody remembering to.
 */
export async function revokeConsent(
  ctx: AuditContext,
  consentId: string,
  reason: string,
): Promise<void> {
  if (reason.trim().length < 3) throw new ConsentError('Record what they said.');

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [row] = await tx.query<{
      subject_id: string; kind: string; revoked_at: string | null; granted_by: string;
    }>(
      `SELECT subject_id, kind, revoked_at::text, granted_by FROM consents WHERE id = $1`,
      [consentId],
    );
    if (!row) throw new ConsentError('That consent does not exist.');
    if (row.revoked_at) throw new ConsentError('That was already withdrawn.');

    await tx.query(
      `UPDATE consents SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [consentId],
    );

    await insertTimeline(tx, {
      householdId: row.subject_id,
      type: 'note',
      author: ctx.actor,
      body: `Consent withdrawn — ${CONSENT_LABEL[row.kind as ConsentKind]?.toLowerCase()
        ?? row.kind}. ${reason.trim()}`,
    });

    await audit({
      ...ctx,
      action: 'update',
      entity: 'consent',
      entityId: consentId,
      diff: { revoked: true, kind: row.kind, reason: reason.trim() },
    }, tx);
  });
}
