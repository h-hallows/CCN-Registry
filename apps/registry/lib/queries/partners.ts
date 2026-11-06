/**
 * Referral partners — the discharge planners, care managers and attorneys who send
 * families here. Web build spec § 4.3, W11.
 *
 * NOTHING HERE TOUCHES MONEY, and nothing should be added that does. Civil Code
 * § 1812.531 forbids a nurses' registry from splitting a fee with anyone, and COUNSEL.md
 * question 3 is open on what, if anything, a partner may be compensated for. So this
 * holds a name, an organisation, a way to reach them, and a count of what they sent. No
 * rate, no percentage, no credit, no balance, and no field that could become one.
 *
 * The counts are a measure of where the work comes from, which § 8 needs in order to
 * answer whether the binding constraint is demand or capacity.
 */
import { getDb } from '@h-hallows/core/db';
import { audit, auditRead, type AuditContext } from '@/lib/audit';

export class PartnerError extends Error {}

export interface PartnerRow {
  id: string;
  name: string;
  org: string | null;
  role: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  createdAt: string;
  /** Inquiries attributed to them, ever. */
  sent: number;
  /** Of those, how many the operator converted into a household. */
  became: number;
  /** The most recent one, so a quiet partner is visible as quiet. */
  lastSentAt: string | null;
  /** How many people can sign in on their behalf, and whether any are revoked. */
  accounts: number;
  revokedAccounts: number;
}

export async function listPartners(ctx: AuditContext): Promise<PartnerRow[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; name: string; org: string | null; role: string | null;
    phone: string | null; email: string | null; notes: string | null;
    created_at: string; sent: string; became: string; last_sent_at: string | null;
    accounts: string; revoked_accounts: string;
  }>(
    `SELECT p.id, p.name, p.org, p.role, p.phone, p.email, p.notes, p.created_at::text,
            coalesce(i.sent, 0)::text   AS sent,
            coalesce(i.became, 0)::text AS became,
            i.last_sent_at::text,
            coalesce(a.accounts, 0)::text         AS accounts,
            coalesce(a.revoked_accounts, 0)::text AS revoked_accounts
       FROM referral_partners p
       LEFT JOIN (
         SELECT partner_id,
                count(*)                                      AS sent,
                count(*) FILTER (WHERE household_id IS NOT NULL) AS became,
                max(received_at)                              AS last_sent_at
           FROM inquiries WHERE partner_id IS NOT NULL GROUP BY partner_id
       ) i ON i.partner_id = p.id
       LEFT JOIN (
         SELECT pu.partner_id,
                count(*)                                           AS accounts,
                count(*) FILTER (WHERE u.disabled_at IS NOT NULL)  AS revoked_accounts
           FROM partner_users pu JOIN users u ON u.id = pu.user_id
          GROUP BY pu.partner_id
       ) a ON a.partner_id = p.id
      ORDER BY coalesce(i.sent, 0) DESC, p.name`,
  );

  await auditRead(ctx, 'referral_partner');

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    org: r.org,
    role: r.role,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    createdAt: r.created_at,
    sent: Number(r.sent),
    became: Number(r.became),
    lastSentAt: r.last_sent_at,
    accounts: Number(r.accounts),
    revokedAccounts: Number(r.revoked_accounts),
  }));
}

export interface AddPartnerInput {
  name: string;
  org?: string;
  role?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export async function addPartner(
  ctx: AuditContext,
  input: AddPartnerInput,
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name.length < 2) throw new PartnerError('Give them a name.');

  const { query } = await getDb();
  const [row] = await query<{ id: string }>(
    `INSERT INTO referral_partners (name, org, role, phone, email, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [name, input.org?.trim() || null, input.role?.trim() || null,
      input.phone?.trim() || null, input.email?.trim() || null, input.notes?.trim() || null],
  );
  if (!row) throw new PartnerError('Could not add them.');

  await audit({
    ...ctx,
    action: 'create',
    entity: 'referral_partner',
    entityId: row.id,
    diff: { name, org: input.org?.trim() || null, role: input.role?.trim() || null },
  });

  return { id: row.id };
}
