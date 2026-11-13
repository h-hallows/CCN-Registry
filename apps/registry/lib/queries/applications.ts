/**
 * Provider applications, and putting somebody on the roster. Spec § 4.2.
 *
 * WHAT WAS MISSING, and it is the same gap the family side had. `/for-providers`
 * writes to `provider_applications` and nothing in this console read it, so a nurse
 * filled in the form and arrived nowhere. Nothing created a `providers` row either:
 * every provider in the system came from the seed, which means the roster could not
 * grow and the supply side of a two-sided business had no intake at all.
 *
 * ONBOARDING CREATES NO CREDENTIALS, and that is the point. What an applicant typed
 * about their own licence is a claim; `eligibility()` counts the PRESENCE of a
 * credential row as that requirement being met, which is exactly the hole migration
 * 0008 closed when a provider could insert their own Live Scan. So a new provider
 * starts with nothing verified, is ineligible for everything, and reaches no shortlist
 * until somebody checks each document against the body that issued it.
 *
 * `status` starts 'inactive' for the same reason. Active is a statement that this is
 * somebody we would put in front of a family, and nobody has met them yet.
 */
import { getDb, type Tx } from '@h-hallows/core/db';
import { audit, auditRead, type AuditContext } from '@/lib/audit';
import { areaLabel } from '@h-hallows/core/domain';
import type { ProviderType } from '@h-hallows/core/schema';

export class ApplicationError extends Error {}

export interface ApplicationRow {
  id: string;
  receivedAt: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  type: ProviderType | null;
  licenseNumber: string | null;
  areas: string[];
  languages: string[];
  specialties: string[];
  experienceNote: string | null;
  message: string | null;
  handledAt: string | null;
  handledBy: string | null;
  providerId: string | null;
  /** Someone already on the roster with the same name or licence number. */
  possibleDuplicateId: string | null;
  possibleDuplicateName: string | null;
}

const COLUMNS = `
  a.id, a.received_at::text, a.full_name, a.phone, a.email, a.type::text AS type,
  a.license_number, a.areas, a.languages, a.specialties, a.experience_note, a.message,
  a.handled_at::text, a.handled_by, a.provider_id,
  d.id AS dup_id, d.full_name AS dup_name`;

/**
 * The join that spots somebody already on the roster.
 *
 * Licence number first, because it identifies a person where a name does not — two
 * caregivers called Maria Garcia is ordinary, and onboarding one twice produces a
 * second record whose credentials are checked against neither.
 */
const DUPLICATE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT p.id, p.full_name
      FROM providers p
     WHERE p.deleted_at IS NULL
       AND ((a.license_number IS NOT NULL
             AND p.license_number IS NOT NULL
             AND lower(p.license_number) = lower(a.license_number))
         OR lower(p.full_name) = lower(a.full_name))
     ORDER BY (p.license_number IS NOT NULL) DESC
     LIMIT 1
  ) d ON true`;

type Raw = {
  id: string; received_at: string; full_name: string; phone: string | null;
  email: string | null; type: string | null; license_number: string | null;
  areas: string[] | null; languages: string[] | null; specialties: string[] | null;
  experience_note: string | null; message: string | null; handled_at: string | null;
  handled_by: string | null; provider_id: string | null;
  dup_id: string | null; dup_name: string | null;
};

function asRow(r: Raw): ApplicationRow {
  return {
    id: r.id,
    receivedAt: r.received_at,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    type: (r.type as ProviderType) ?? null,
    licenseNumber: r.license_number,
    // The form submits slugs; the roster holds what a person wrote. Same translation
    // the enquiry screen does, and for the same reason — `providers.areas` is compared
    // to `households.cr_area` by string equality.
    areas: (r.areas ?? []).map((a) => areaLabel(a)),
    languages: r.languages ?? [],
    specialties: r.specialties ?? [],
    experienceNote: r.experience_note,
    message: r.message,
    handledAt: r.handled_at,
    handledBy: r.handled_by,
    providerId: r.provider_id,
    possibleDuplicateId: r.dup_id,
    possibleDuplicateName: r.dup_name,
  };
}

export async function unhandledApplications(ctx: AuditContext): Promise<ApplicationRow[]> {
  const { query } = await getDb();
  const rows = await query<Raw>(
    `SELECT ${COLUMNS}
       FROM provider_applications a ${DUPLICATE_JOIN}
      WHERE a.handled_at IS NULL
      ORDER BY a.received_at`,
  );
  if (rows.length > 0) await auditRead(ctx, 'provider_application');
  return rows.map(asRow);
}

export async function countUnhandledApplications(): Promise<number> {
  const { query } = await getDb();
  const [row] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM provider_applications WHERE handled_at IS NULL`,
  );
  return Number(row?.n ?? 0);
}

export async function recentlyDecidedApplications(
  ctx: AuditContext,
  limit = 15,
): Promise<ApplicationRow[]> {
  const { query } = await getDb();
  const rows = await query<Raw>(
    `SELECT ${COLUMNS}
       FROM provider_applications a ${DUPLICATE_JOIN}
      WHERE a.handled_at IS NOT NULL
      ORDER BY a.handled_at DESC
      LIMIT $1`,
    [limit],
  );
  if (rows.length > 0) await auditRead(ctx, 'provider_application');
  return rows.map(asRow);
}

export interface OnboardInput {
  applicationId: string;
  fullName: string;
  type: ProviderType;
  phone?: string;
  email?: string;
  licenseNumber?: string;
  /** Labels, as the roster holds them. */
  areas: string[];
  languages: string[];
  specialties: string[];
  transports: boolean;
  /** The operator's own note. Never shown to a household — I12. */
  notes?: string;
}

/**
 * Put an applicant on the roster.
 *
 * Nothing about this makes them referable. They arrive `inactive` with no credentials,
 * which means `eligibility()` excludes them from every shortlist until each required
 * document has been checked against its issuing body and recorded on the credentials
 * screen. The application's claims are copied into `notes` rather than into fields the
 * matcher reads, because an applicant describing their own licence is a claim and the
 * verification is the part a household is relying on.
 */
export async function onboardApplicant(
  ctx: AuditContext,
  input: OnboardInput,
): Promise<{ providerId: string }> {
  const fullName = input.fullName.trim();
  if (fullName.length < 2) throw new ApplicationError('Give them a name.');

  const handle = await getDb();
  return handle.transaction(async (tx) => {
    const application = await lockUnhandled(tx, input.applicationId);

    const [provider] = await tx.query<{ id: string }>(
      `INSERT INTO providers
         (status, full_name, type, phone, email, license_number, transports,
          areas, languages, specialties, notes)
       VALUES ('inactive', $1, $2::provider_type, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        fullName, input.type, blank(input.phone), blank(input.email),
        blank(input.licenseNumber), input.transports,
        input.areas, input.languages, input.specialties,
        onboardingNote(ctx.actor, application, input.notes),
      ],
    );
    if (!provider) throw new ApplicationError('Could not create the provider.');

    await tx.query(
      `UPDATE provider_applications
          SET provider_id = $2, handled_at = now(), handled_by = $3
        WHERE id = $1 AND handled_at IS NULL`,
      [input.applicationId, provider.id, ctx.actor],
    );

    await audit({
      ...ctx,
      action: 'create',
      entity: 'provider',
      entityId: provider.id,
      diff: {
        fromApplication: input.applicationId,
        fullName,
        type: input.type,
        // Said in the log, because it is the thing somebody will want to confirm later.
        status: 'inactive',
        credentials: 'none — nothing is verified by onboarding',
      },
    }, tx);

    return { providerId: provider.id };
  });
}

/** Close an application without a roster entry. Recorded, like a turn-away. */
export async function declineApplicant(
  ctx: AuditContext,
  applicationId: string,
  reason: string,
): Promise<void> {
  if (reason.trim().length < 3) throw new ApplicationError('Record why.');

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    await lockUnhandled(tx, applicationId);
    await tx.query(
      `UPDATE provider_applications SET handled_at = now(), handled_by = $2
        WHERE id = $1 AND handled_at IS NULL`,
      [applicationId, ctx.actor],
    );
    await audit({
      ...ctx,
      action: 'update',
      entity: 'provider_application',
      entityId: applicationId,
      diff: { declined: true, reason: reason.trim() },
    }, tx);
  });
}

/**
 * What the applicant said about themselves, kept where the matcher cannot read it.
 *
 * `notes` is the operator's working record. A claimed licence number goes into the
 * field the roster screen shows for checking, but a claimed twenty years of dementia
 * experience is not a specialty until somebody has talked to them — and `specialties`
 * is shown to households beside verified credentials.
 */
function onboardingNote(
  actor: string,
  application: { full_name: string; experience_note: string | null; message: string | null },
  operatorNote: string | undefined,
): string {
  const parts = [`Onboarded from an application by ${actor}. Nothing verified yet.`];
  if (application.experience_note) {
    parts.push(`They said of their experience: ${application.experience_note}`);
  }
  if (application.message) parts.push(`They wrote: ${application.message}`);
  if (operatorNote?.trim()) parts.push(operatorNote.trim());
  return parts.join('\n\n');
}

async function lockUnhandled(tx: Tx, applicationId: string): Promise<{
  full_name: string; experience_note: string | null; message: string | null;
}> {
  const [row] = await tx.query<{
    full_name: string; experience_note: string | null; message: string | null;
    handled_at: string | null; handled_by: string | null;
  }>(
    `SELECT full_name, experience_note, message, handled_at::text, handled_by
       FROM provider_applications WHERE id = $1 FOR UPDATE`,
    [applicationId],
  );
  if (!row) throw new ApplicationError('That application does not exist.');
  if (row.handled_at) {
    throw new ApplicationError(
      `${row.handled_by ?? 'Somebody'} already dealt with that application.`,
    );
  }
  return row;
}

function blank(v: string | undefined): string | null {
  return v?.trim() ? v.trim() : null;
}
