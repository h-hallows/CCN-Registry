/**
 * Who may sign in to the client, provider and partner portals, and how they get a link.
 *
 * WHY THIS EXISTS. The portals authenticate against `users` plus one of three membership
 * tables, and the public `/login` page deliberately issues a link only to an address that
 * already has one of those membership rows — there is no public sign-up for any portal
 * audience, by design. Nothing in this console created those rows, so every portal built
 * in W6–W11 was unreachable to everyone: a household could be sent a bench it had no way
 * to open. This is the other half of that.
 *
 * FOUR RULES, each of which refuses rather than repairs:
 *
 *  1. One address, one role. An address that is already an operator, or already a
 *     provider, is never quietly re-pointed at a household. `users.role` defaults to
 *     'operator', so an upsert that forgot to name the role would mint an operator.
 *  2. One address, one subject. `current_household()` validates the claim against
 *     `household_users`; a user holding two membership rows would validate for either,
 *     which is the one way a portal user could legitimately claim two households.
 *  3. Granting never un-revokes. `disabled_at` is the documented way to withdraw access
 *     and rows are never deleted, so a grant against a disabled account is refused and
 *     the operator restores it deliberately. Accepting an invite used to clear
 *     `disabled_at` in the sibling application; that is the bug this rule prevents here.
 *  4. One live link at a time. Issuing a link revokes any outstanding one, so a link
 *     that was forwarded to the wrong address stops working the moment a new one is cut.
 *
 * There is no mail provider, so the link is returned to the operator to send. It is
 * displayed once and not stored: only its SHA-256 hash is written.
 */
import { createHash, randomBytes } from 'node:crypto';
import { getDb, type Tx } from '@h-hallows/core/db';
import { audit, auditRead, type AuditContext } from '@/lib/audit';
import type { AuditEntity } from '@h-hallows/core/domain';
import { insertTimeline } from '@/lib/domain/referral';

export class AccessError extends Error {}

export type PortalSubjectKind = 'household' | 'provider' | 'partner';

/**
 * The audit entity a portal-access read is recorded against: the subject whose accounts
 * were listed, so the read appears on that subject's trail rather than under an entity
 * with no table to look the id up in.
 */
const SUBJECT_ENTITY = {
  household: 'household',
  provider: 'provider',
  partner: 'referral_partner',
} as const satisfies Record<PortalSubjectKind, AuditEntity>;

/**
 * A closed map, so the table and column names below are literals from this file and
 * never anything derived from a request. `kind` is validated against these keys before
 * it reaches a statement.
 */
const MEMBERSHIP = {
  household: {
    membership: 'household_users',
    column: 'household_id',
    subjectTable: 'households',
    softDeleted: true,
    nameColumn: 'display_name',
  },
  provider: {
    membership: 'provider_users',
    column: 'provider_id',
    subjectTable: 'providers',
    softDeleted: true,
    nameColumn: 'full_name',
  },
  partner: {
    membership: 'partner_users',
    column: 'partner_id',
    subjectTable: 'referral_partners',
    softDeleted: false,
    nameColumn: 'name',
  },
} as const satisfies Record<PortalSubjectKind, {
  membership: string; column: string; subjectTable: string;
  softDeleted: boolean; nameColumn: string;
}>;

export function isPortalSubjectKind(value: unknown): value is PortalSubjectKind {
  return typeof value === 'string' && value in MEMBERSHIP;
}

/**
 * Seven days, not the fifteen minutes the self-service form uses.
 *
 * That form mails the link to the address that just asked for it, so a short window
 * costs nothing. This link is handed to a person to forward to a family who may open it
 * after the weekend, and a link that has quietly expired reads to them as a portal that
 * does not work.
 */
const INVITE_TTL_DAYS = 7;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The origin the link points at. The portals are paths on one host, not subdomains. */
export function portalOrigin(): string {
  return (process.env.PORTAL_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3003')
    .replace(/\/+$/, '');
}

export interface PortalUser {
  userId: string;
  email: string;
  displayName: string;
  role: PortalSubjectKind;
  lastSeenAt: string | null;
  disabledAt: string | null;
  /** The outstanding link, if one is live. Never the token itself. */
  liveInviteExpiresAt: string | null;
  acceptedAt: string | null;
}

export async function portalUsersFor(
  ctx: AuditContext,
  kind: PortalSubjectKind,
  subjectId: string,
): Promise<PortalUser[]> {
  const map = MEMBERSHIP[kind];
  const { query } = await getDb();
  const rows = await query<{
    id: string; email: string; display_name: string; last_seen_at: string | null;
    disabled_at: string | null; live_expires_at: string | null; accepted_at: string | null;
  }>(
    `SELECT u.id, u.email, u.display_name, u.last_seen_at::text, u.disabled_at::text,
            (SELECT max(i.expires_at) FROM portal_invites i
              WHERE i.email = u.email AND i.accepted_at IS NULL
                AND i.revoked_at IS NULL AND i.expires_at > now())::text AS live_expires_at,
            (SELECT max(i.accepted_at) FROM portal_invites i
              WHERE i.email = u.email)::text AS accepted_at
       FROM ${map.membership} m
       JOIN users u ON u.id = m.user_id
      WHERE m.${map.column} = $1
      ORDER BY u.email`,
    [subjectId],
  );

  await auditRead(ctx, SUBJECT_ENTITY[kind], subjectId, { read: 'portal accounts' });

  return rows.map((r) => ({
    userId: r.id,
    email: r.email,
    displayName: r.display_name,
    role: kind,
    lastSeenAt: r.last_seen_at,
    disabledAt: r.disabled_at,
    liveInviteExpiresAt: r.live_expires_at,
    acceptedAt: r.accepted_at,
  }));
}

/**
 * The same read for many subjects at once.
 *
 * `/partners` rendered one `portalUsersFor` per partner — a five-table read per row,
 * serially, on a screen whose whole job is to list them. Fifteen partners was sixteen
 * round trips before the page could start.
 */
export async function portalUsersForMany(
  ctx: AuditContext,
  kind: PortalSubjectKind,
  subjectIds: string[],
): Promise<Map<string, PortalUser[]>> {
  const out = new Map<string, PortalUser[]>(subjectIds.map((id) => [id, []]));
  if (subjectIds.length === 0) return out;

  const map = MEMBERSHIP[kind];
  const { query } = await getDb();
  const rows = await query<{
    subject_id: string; id: string; email: string; display_name: string;
    last_seen_at: string | null; disabled_at: string | null;
    live_expires_at: string | null; accepted_at: string | null;
  }>(
    `SELECT m.${map.column} AS subject_id,
            u.id, u.email, u.display_name, u.last_seen_at::text, u.disabled_at::text,
            (SELECT max(i.expires_at) FROM portal_invites i
              WHERE i.email = u.email AND i.accepted_at IS NULL
                AND i.revoked_at IS NULL AND i.expires_at > now())::text AS live_expires_at,
            (SELECT max(i.accepted_at) FROM portal_invites i
              WHERE i.email = u.email)::text AS accepted_at
       FROM ${map.membership} m
       JOIN users u ON u.id = m.user_id
      WHERE m.${map.column} = ANY($1::uuid[])
      ORDER BY u.email`,
    [subjectIds],
  );

  await auditRead(ctx, 'user');

  for (const r of rows) {
    out.get(r.subject_id)?.push({
      userId: r.id,
      email: r.email,
      displayName: r.display_name,
      role: kind,
      lastSeenAt: r.last_seen_at,
      disabledAt: r.disabled_at,
      liveInviteExpiresAt: r.live_expires_at,
      acceptedAt: r.accepted_at,
    });
  }
  return out;
}

export interface GrantInput {
  kind: PortalSubjectKind;
  subjectId: string;
  email: string;
  displayName: string;
}

export interface GrantResult {
  userId: string;
  /** Shown to the operator once. Not stored, not logged, not audited. */
  url: string;
  expiresAt: string;
  /** True when the account already existed and only a new link was issued. */
  existing: boolean;
  /** So the caller can address the message without looking the account up again. */
  kind: PortalSubjectKind;
  email: string;
}

export async function grantPortalAccess(
  ctx: AuditContext,
  input: GrantInput,
): Promise<GrantResult> {
  if (!isPortalSubjectKind(input.kind)) throw new AccessError('Unknown portal.');
  const map = MEMBERSHIP[input.kind];
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!email.includes('@')) throw new AccessError('That is not an email address.');
  if (displayName.length < 2) throw new AccessError('Give the person a name.');

  const handle = await getDb();
  return handle.transaction(async (tx) => {
    const [subject] = await tx.query<{ name: string }>(
      `SELECT ${map.nameColumn} AS name FROM ${map.subjectTable}
        WHERE id = $1${map.softDeleted ? ' AND deleted_at IS NULL' : ''}`,
      [input.subjectId],
    );
    if (!subject) throw new AccessError('That record does not exist.');

    const [found] = await tx.query<{ id: string; role: string; disabled_at: string | null }>(
      `SELECT id, role::text AS role, disabled_at::text FROM users WHERE email = $1`,
      [email],
    );

    let userId: string;
    const existing = Boolean(found);

    if (found) {
      // Rule 1.
      if (found.role !== input.kind) {
        throw new AccessError(
          `That address is already ${found.role === 'operator' ? 'an operator' : `a ${found.role}`} account.`
          + ' One address holds one role. Use a different address.',
        );
      }
      // Rule 3.
      if (found.disabled_at) {
        throw new AccessError(
          'That account was revoked. Restore it deliberately before issuing a new link.',
        );
      }
      // Rule 2.
      const others = await tx.query<{ id: string }>(
        `SELECT ${map.column} AS id FROM ${map.membership}
          WHERE user_id = $1 AND ${map.column} <> $2`,
        [found.id, input.subjectId],
      );
      if (others.length > 0) {
        throw new AccessError(
          `That address already has access to another ${input.kind}. One address, one ${input.kind}.`,
        );
      }
      userId = found.id;
    } else {
      const [created] = await tx.query<{ id: string }>(
        `INSERT INTO users (email, display_name, role) VALUES ($1, $2, $3::user_role)
         RETURNING id`,
        [email, displayName, input.kind],
      );
      if (!created) throw new AccessError('Could not create the account.');
      userId = created.id;
    }

    await tx.query(
      `INSERT INTO ${map.membership} (user_id, ${map.column}) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, input.subjectId],
    );

    // Rule 4.
    await tx.query(
      `UPDATE portal_invites SET revoked_at = now()
        WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [email],
    );

    const token = randomBytes(32).toString('base64url');
    const [invite] = await tx.query<{ expires_at: string }>(
      `INSERT INTO portal_invites
         (email, role, ${map.column}, token_hash, issued_by, expires_at)
       VALUES ($1, $2::user_role, $3, $4, $5, now() + ($6 || ' days')::interval)
       RETURNING expires_at::text`,
      [email, input.kind, input.subjectId, hash(token), ctx.actor, String(INVITE_TTL_DAYS)],
    );
    if (!invite) throw new AccessError('Could not issue the link.');

    if (input.kind === 'household') {
      await insertTimeline(tx, {
        householdId: input.subjectId,
        type: 'note',
        author: ctx.actor,
        body: existing
          ? `A new sign-in link was issued to ${email} for the family's own screen.`
          : `${displayName} (${email}) was given access to the family's own screen.`,
      });
    }

    // The token is not in the diff. What is auditable is that a link was issued, to
    // whom, by whom and when — not a credential anyone reading the log could use.
    await audit({
      ...ctx,
      action: existing ? 'update' : 'create',
      entity: 'user',
      entityId: userId,
      diff: {
        kind: input.kind,
        subjectId: input.subjectId,
        subjectName: subject.name,
        email,
        linkExpiresAt: invite.expires_at,
      },
    }, tx);

    return {
      userId,
      url: `${portalOrigin()}/invite/${token}`,
      expiresAt: invite.expires_at,
      existing,
      kind: input.kind,
      email,
    };
  });
}

/** A fresh link for an account that already exists. The previous one stops working. */
export async function reissuePortalLink(
  ctx: AuditContext,
  userId: string,
): Promise<GrantResult> {
  const handle = await getDb();
  return handle.transaction(async (tx) => {
    const [user] = await tx.query<{
      email: string; role: string; disabled_at: string | null;
      household_id: string | null; provider_id: string | null; partner_id: string | null;
    }>(
      `SELECT u.email, u.role::text AS role, u.disabled_at::text,
              hu.household_id, pu.provider_id, ru.partner_id
         FROM users u
         LEFT JOIN household_users hu ON hu.user_id = u.id
         LEFT JOIN provider_users pu  ON pu.user_id  = u.id
         LEFT JOIN partner_users ru   ON ru.user_id  = u.id
        WHERE u.id = $1`,
      [userId],
    );
    if (!user) throw new AccessError('That account does not exist.');
    if (user.disabled_at) throw new AccessError('That account was revoked. Restore it first.');
    if (!isPortalSubjectKind(user.role)) {
      throw new AccessError('That is not a portal account.');
    }

    const map = MEMBERSHIP[user.role];
    const subjectId = user.role === 'household' ? user.household_id
      : user.role === 'provider' ? user.provider_id : user.partner_id;
    // The CHECK on portal_invites refuses an invite that names no subject, so a user
    // whose role and membership disagree must fail here with something readable.
    if (!subjectId) {
      throw new AccessError(
        `That account is marked ${user.role} but belongs to no ${user.role}. Fix the record first.`,
      );
    }

    await tx.query(
      `UPDATE portal_invites SET revoked_at = now()
        WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [user.email],
    );

    const token = randomBytes(32).toString('base64url');
    const [invite] = await tx.query<{ expires_at: string }>(
      `INSERT INTO portal_invites
         (email, role, ${map.column}, token_hash, issued_by, expires_at)
       VALUES ($1, $2::user_role, $3, $4, $5, now() + ($6 || ' days')::interval)
       RETURNING expires_at::text`,
      [user.email, user.role, subjectId, hash(token), ctx.actor, String(INVITE_TTL_DAYS)],
    );
    if (!invite) throw new AccessError('Could not issue the link.');

    await audit({
      ...ctx,
      action: 'update',
      entity: 'user',
      entityId: userId,
      diff: { reissued: true, email: user.email, linkExpiresAt: invite.expires_at },
    }, tx);

    return {
      userId,
      url: `${portalOrigin()}/invite/${token}`,
      expiresAt: invite.expires_at,
      existing: true,
      kind: user.role,
      email: user.email,
    };
  });
}

/**
 * Withdraw access. Three things, because any one alone leaves a way in: the account is
 * disabled, every live session is deleted, and every outstanding link is revoked.
 *
 * Nothing is deleted from `users` or from the membership table. Who had access, and when,
 * is part of the record of who could see a household's information.
 */
export async function revokePortalAccess(
  ctx: AuditContext,
  userId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim()) throw new AccessError('Record why.');

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [user] = await tx.query<{
      email: string; role: string; disabled_at: string | null; household_id: string | null;
    }>(
      `SELECT u.email, u.role::text AS role, u.disabled_at::text, hu.household_id
         FROM users u LEFT JOIN household_users hu ON hu.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );
    if (!user) throw new AccessError('That account does not exist.');
    if (!isPortalSubjectKind(user.role)) {
      throw new AccessError('Operator accounts are not revoked from this screen.');
    }
    if (user.disabled_at) throw new AccessError('That account is already revoked.');

    await tx.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [userId]);
    await tx.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await tx.query(
      `UPDATE portal_invites SET revoked_at = now()
        WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [user.email],
    );

    if (user.household_id) {
      await insertTimeline(tx, {
        householdId: user.household_id,
        type: 'note',
        author: ctx.actor,
        body: `Access to the family's own screen was withdrawn from ${user.email}. ${reason.trim()}`,
      });
    }

    await audit({
      ...ctx,
      action: 'update',
      entity: 'user',
      entityId: userId,
      diff: { disabledAt: { from: null, to: 'now' }, email: user.email, reason: reason.trim() },
    }, tx);
  });
}

/** Put a revoked account back. Deliberate, and recorded, because rule 3 depends on it. */
export async function restorePortalAccess(
  ctx: AuditContext,
  userId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim()) throw new AccessError('Record why.');

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [user] = await tx.query<{ email: string; role: string; disabled_at: string | null }>(
      `SELECT email, role::text AS role, disabled_at::text FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw new AccessError('That account does not exist.');
    if (!isPortalSubjectKind(user.role)) {
      throw new AccessError('Operator accounts are not restored from this screen.');
    }
    if (!user.disabled_at) throw new AccessError('That account is not revoked.');

    await tx.query(`UPDATE users SET disabled_at = NULL WHERE id = $1`, [userId]);

    await audit({
      ...ctx,
      action: 'update',
      entity: 'user',
      entityId: userId,
      diff: { disabledAt: { from: user.disabled_at, to: null }, email: user.email, reason: reason.trim() },
    }, tx);
  });
}
