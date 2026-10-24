/**
 * Provider and credential reads/writes. Eligibility is computed here, in the query
 * layer, never in a component (I12).
 */
import { getDb } from '@/lib/db/client';
import { audit, auditRead, diffOf, type AuditContext } from '@/lib/audit';
import {
  credStatus, eligibility, LABEL, needsReverification, requiredFor,
  type CredentialLike, type CredStatus, type Eligibility,
} from '@/lib/domain/credentials';
import { asISODate } from '@/lib/domain/dates';
import { emit } from '@/lib/metrics';
import type { CredentialType, ProviderType } from '@/lib/db/schema';

export interface ProviderRow {
  id: string;
  status: 'active' | 'inactive' | 'do_not_refer';
  fullName: string;
  preferredName: string | null;
  phone: string | null;
  email: string | null;
  type: ProviderType;
  licenseNumber: string | null;
  rateHourly: string | null;
  rateNotes: string | null;
  transports: boolean;
  areas: string[];
  availability: string[];
  restrictions: string | null;
  specialties: string[];
  languages: string[];
  notes: string | null;
  maxTravelMin: number | null;
  agreementSignedOn: string | null;
  writtenNoticeAckOn: string | null;
  workAuthVerifiedOn: string | null;
  orientationOn: string | null;
  createdAt: string;
}

export interface CredentialRow {
  id: string;
  providerId: string;
  type: CredentialType;
  label: string;
  identifier: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  verifiedOn: string;
  verifiedBy: string;
  verificationSource: string;
  documentUrl: string | null;
  notes: string | null;
  status: CredStatus;
  required: boolean;
  needsReverify: boolean;
}

export interface ProviderWithStanding {
  provider: ProviderRow;
  credentials: CredentialRow[];
  /** Required credential types with no live row at all. */
  missing: CredentialType[];
  eligibility: Eligibility;
  placements: number;
  avgEngagementWeeks: number | null;
}

const PROVIDER_COLUMNS = `
  p.id, p.status, p.full_name, p.preferred_name, p.phone, p.email, p.type,
  p.license_number, p.rate_hourly, p.rate_notes, p.transports, p.areas, p.availability,
  p.restrictions, p.specialties, p.languages, p.notes, p.max_travel_min,
  p.agreement_signed_on, p.written_notice_ack_on, p.work_auth_verified_on,
  p.orientation_on, p.created_at`;

function toProvider(r: Record<string, unknown>): ProviderRow {
  return {
    id: String(r.id),
    status: r.status as ProviderRow['status'],
    fullName: String(r.full_name),
    preferredName: (r.preferred_name as string) ?? null,
    phone: (r.phone as string) ?? null,
    email: (r.email as string) ?? null,
    type: r.type as ProviderType,
    licenseNumber: (r.license_number as string) ?? null,
    rateHourly: r.rate_hourly === null ? null : String(r.rate_hourly),
    rateNotes: (r.rate_notes as string) ?? null,
    transports: Boolean(r.transports),
    areas: (r.areas as string[]) ?? [],
    availability: (r.availability as string[]) ?? [],
    restrictions: (r.restrictions as string) ?? null,
    specialties: (r.specialties as string[]) ?? [],
    languages: (r.languages as string[]) ?? [],
    notes: (r.notes as string) ?? null,
    maxTravelMin: (r.max_travel_min as number) ?? null,
    agreementSignedOn: asDate(r.agreement_signed_on),
    writtenNoticeAckOn: asDate(r.written_notice_ack_on),
    workAuthVerifiedOn: asDate(r.work_auth_verified_on),
    orientationOn: asDate(r.orientation_on),
    createdAt: asTimestamp(r.created_at),
  };
}

/** Re-exported so the query layer and the domain layer normalise dates identically. */
export const asDate = asISODate;

export function asTimestamp(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Every provider with their credential standing. Roster screen and match both use it. */
export async function listProvidersWithStanding(
  ctx: AuditContext,
  today = new Date(),
): Promise<ProviderWithStanding[]> {
  const { query } = await getDb();
  const providers = await query(
    `SELECT ${PROVIDER_COLUMNS} FROM providers p
      WHERE p.deleted_at IS NULL
      ORDER BY p.full_name`,
  );
  const creds = await query(
    `SELECT id, provider_id, type, identifier, issued_on, expires_on, verified_on,
            verified_by, verification_source, document_url, notes
       FROM credentials WHERE deleted_at IS NULL`,
  );
  const history = await query(
    `SELECT r.provider_id,
            count(*) FILTER (WHERE r.outcome = 'engaged')                  AS placements,
            avg(EXTRACT(epoch FROM (c.ended_on::timestamptz - c.created_at)) / 604800)
              FILTER (WHERE c.ended_on IS NOT NULL)                        AS avg_weeks
       FROM referrals r JOIN cases c ON c.id = r.case_id
      GROUP BY r.provider_id`,
  );

  const credsByProvider = new Map<string, Record<string, unknown>[]>();
  for (const c of creds) {
    const key = String(c.provider_id);
    const list = credsByProvider.get(key) ?? [];
    list.push(c);
    credsByProvider.set(key, list);
  }
  const historyById = new Map(history.map((h) => [String(h.provider_id), h] as const));

  await auditRead(ctx, 'providers');

  return providers.map((raw) => {
    const provider = toProvider(raw);
    const rows = credsByProvider.get(provider.id) ?? [];
    const required = requiredFor(provider);
    const credentials = rows
      .map((c): CredentialRow => {
        const type = c.type as CredentialType;
        const expiresOn = asDate(c.expires_on);
        const verifiedOn = asDate(c.verified_on) ?? '1970-01-01';
        return {
          id: String(c.id),
          providerId: provider.id,
          type,
          label: LABEL[type],
          identifier: (c.identifier as string) ?? null,
          issuedOn: asDate(c.issued_on),
          expiresOn,
          verifiedOn,
          verifiedBy: String(c.verified_by),
          verificationSource: String(c.verification_source),
          documentUrl: (c.document_url as string) ?? null,
          notes: (c.notes as string) ?? null,
          status: credStatus(expiresOn, today),
          required: required.includes(type),
          needsReverify: needsReverification(verifiedOn, today),
        };
      })
      .sort((a, b) => Number(b.required) - Number(a.required) || a.label.localeCompare(b.label));

    const credLikes: CredentialLike[] = credentials.map((c) => ({ type: c.type, expiresOn: c.expiresOn }));
    const present = new Set(credentials.map((c) => c.type));
    const h = historyById.get(provider.id);

    return {
      provider,
      credentials,
      missing: required.filter((t) => !present.has(t)),
      eligibility: eligibility(provider, credLikes, today),
      placements: h ? Number(h.placements ?? 0) : 0,
      avgEngagementWeeks: h?.avg_weeks == null ? null : Math.round(Number(h.avg_weeks) * 10) / 10,
    };
  });
}

export async function getProviderWithStanding(
  ctx: AuditContext,
  providerId: string,
  today = new Date(),
): Promise<ProviderWithStanding | null> {
  const all = await listProvidersWithStanding(ctx, today);
  const found = all.find((p) => p.provider.id === providerId) ?? null;
  if (found) await auditRead(ctx, 'provider', providerId);
  return found;
}

/**
 * Add or renew a credential. The round trip must stay under twenty seconds (M2) — this
 * is the credential vault's whole job, so it is one call with no intermediate steps.
 *
 * A renewal updates the live row and appends a `credential_events` row, which is the
 * history. `credential_events` is append-only at the database level.
 */
export async function upsertCredential(
  ctx: AuditContext,
  input: {
    providerId: string;
    type: CredentialType;
    identifier?: string | null;
    issuedOn?: string | null;
    expiresOn?: string | null;
    verifiedOn: string;
    verificationSource: string;
    documentUrl?: string | null;
    notes?: string | null;
  },
): Promise<{ credentialId: string; renewed: boolean }> {
  const handle = await getDb();
  return handle.transaction(async (tx) => {
    const [existing] = await tx.query<{
      id: string; expires_on: string | null; verified_on: string;
    }>(
      `SELECT id, expires_on, verified_on FROM credentials
        WHERE provider_id = $1 AND type = $2 AND deleted_at IS NULL`,
      [input.providerId, input.type],
    );

    if (existing) {
      await tx.query(
        `UPDATE credentials
            SET identifier = $2, issued_on = $3, expires_on = $4, verified_on = $5,
                verified_by = $6, verification_source = $7, document_url = $8, notes = $9
          WHERE id = $1`,
        [existing.id, input.identifier ?? null, input.issuedOn ?? null, input.expiresOn ?? null,
          input.verifiedOn, ctx.actor, input.verificationSource, input.documentUrl ?? null,
          input.notes ?? null],
      );
      await tx.query(
        `INSERT INTO credential_events
           (credential_id, actor, prev_expires_on, new_expires_on, prev_verified_on, new_verified_on, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [existing.id, ctx.actor, asDate(existing.expires_on), input.expiresOn ?? null,
          asDate(existing.verified_on), input.verifiedOn, input.notes ?? null],
      );
      await emit('credential_renewed', { providerId: input.providerId }, { type: input.type }, tx);
      return { credentialId: existing.id, renewed: true };
    }

    const [created] = await tx.query<{ id: string }>(
      `INSERT INTO credentials
         (provider_id, type, identifier, issued_on, expires_on, verified_on,
          verified_by, verification_source, document_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [input.providerId, input.type, input.identifier ?? null, input.issuedOn ?? null,
        input.expiresOn ?? null, input.verifiedOn, ctx.actor, input.verificationSource,
        input.documentUrl ?? null, input.notes ?? null],
    );
    if (!created) throw new Error('Could not record the credential.');
    await tx.query(
      `INSERT INTO credential_events
         (credential_id, actor, new_expires_on, new_verified_on, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [created.id, ctx.actor, input.expiresOn ?? null, input.verifiedOn, input.notes ?? null],
    );
    return { credentialId: created.id, renewed: false };
  }).then(async (result) => {
    await audit({
      ...ctx,
      action: result.renewed ? 'update' : 'create',
      entity: 'credential',
      entityId: result.credentialId,
      diff: { type: input.type, expiresOn: input.expiresOn, verifiedOn: input.verifiedOn },
    });
    return result;
  });
}

/**
 * I5: rate is written only by a provider-origin mutation. The caller must say the
 * provider stated it. Nothing in this codebase computes, suggests, caps or defaults it.
 */
export async function setProviderStatedRate(
  ctx: AuditContext,
  providerId: string,
  statedBy: 'provider',
  rateHourly: string | null,
  rateNotes: string | null,
): Promise<void> {
  if (statedBy !== 'provider') {
    throw new Error('I5: a provider rate may only be recorded as stated by the provider.');
  }
  const { query } = await getDb();
  const [before] = await query<{ rate_hourly: string | null; rate_notes: string | null }>(
    `SELECT rate_hourly, rate_notes FROM providers WHERE id = $1`, [providerId],
  );
  await query(
    `UPDATE providers SET rate_hourly = $2, rate_notes = $3, updated_at = now() WHERE id = $1`,
    [providerId, rateHourly, rateNotes],
  );
  await audit({
    ...ctx, action: 'update', entity: 'provider', entityId: providerId,
    diff: diffOf(before ?? {}, { rate_hourly: rateHourly, rate_notes: rateNotes }),
  });
}

/**
 * I4: the registry's only lever is to stop referring, forward-only. This never touches
 * an existing engagement, and there is no terminateProvider anywhere in this codebase.
 */
export async function setProviderReferralStatus(
  ctx: AuditContext,
  providerId: string,
  status: 'active' | 'inactive' | 'do_not_refer',
  note: string,
): Promise<void> {
  const { query } = await getDb();
  const [before] = await query<{ status: string }>(
    `SELECT status FROM providers WHERE id = $1`, [providerId],
  );
  await query(
    `UPDATE providers SET status = $2, notes = COALESCE(notes || E'\\n', '') || $3, updated_at = now()
      WHERE id = $1`,
    [providerId, status, `[${new Date().toISOString().slice(0, 10)}] status -> ${status}: ${note}`],
  );
  await audit({
    ...ctx, action: 'update', entity: 'provider', entityId: providerId,
    diff: diffOf({ status: before?.status }, { status }),
  });
}
