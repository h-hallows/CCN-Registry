/**
 * The credential submission queue. Migration 0008; web build spec § 4.2, W8.
 *
 * A submission is what a provider says about their own document. Nothing here feeds
 * `eligibility()`, and nothing here is a credential until an operator accepts it in
 * lib/domain/credentialSubmissions.ts.
 */
import { getDb } from '@h-hallows/core/db';
import { LABEL } from '@h-hallows/core/domain';
import type { CredentialType, ProviderType } from '@h-hallows/core/schema';
import { auditRead, type AuditContext } from '@/lib/audit';
import { asTimestamp } from '@/lib/queries/providers';

interface SubmissionBase {
  id: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  type: CredentialType;
  label: string;
  /** What the provider says the identifier is. Checked by the operator; believed by nobody until then. */
  claimedIdentifier: string | null;
  documentUrl: string | null;
  note: string | null;
  submittedAt: string;
}

export interface PendingSubmission extends SubmissionBase {
  /** True when the provider already holds a live credential of this type, i.e. a renewal. */
  renewsExisting: boolean;
}

/** Everything waiting on an operator, oldest first — the order they should be worked in. */
export async function listPendingSubmissions(
  ctx: AuditContext,
): Promise<PendingSubmission[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; provider_id: string; full_name: string; provider_type: ProviderType;
    type: CredentialType; identifier: string | null; document_url: string | null;
    note: string | null; submitted_at: string; renews_existing: boolean;
  }>(
    `SELECT s.id, s.provider_id, p.full_name, p.type AS provider_type, s.type,
            s.identifier, s.document_url, s.note, s.submitted_at,
            EXISTS (
              SELECT 1 FROM credentials c
               WHERE c.provider_id = s.provider_id AND c.type = s.type
                 AND c.deleted_at IS NULL
            ) AS renews_existing
       FROM credential_submissions s
       JOIN providers p ON p.id = s.provider_id
      WHERE s.state = 'submitted'
      ORDER BY s.submitted_at ASC`,
  );

  await auditRead(ctx, 'credential_submissions');

  return rows.map((r) => ({
    id: String(r.id),
    providerId: String(r.provider_id),
    providerName: String(r.full_name),
    providerType: r.provider_type,
    type: r.type,
    label: LABEL[r.type] ?? r.type,
    claimedIdentifier: r.identifier ?? null,
    documentUrl: r.document_url ?? null,
    note: r.note ?? null,
    submittedAt: asTimestamp(r.submitted_at),
    renewsExisting: Boolean(r.renews_existing),
  }));
}

/** For the nav badge. Deliberately counts nothing but what is still waiting. */
export async function countPendingSubmissions(): Promise<number> {
  const { query } = await getDb();
  const [row] = await query<{ n: string }>(
    `SELECT count(*) AS n FROM credential_submissions WHERE state = 'submitted'`,
  );
  return Number(row?.n ?? 0);
}

export interface ReviewedSubmission extends SubmissionBase {
  state: 'accepted' | 'rejected';
  reviewedAt: string;
  reviewedBy: string;
  reviewNote: string | null;
  credentialId: string | null;
}

/** The recent decisions, so the queue screen shows its own history. */
export async function listReviewedSubmissions(
  ctx: AuditContext,
  limit = 25,
): Promise<ReviewedSubmission[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; provider_id: string; full_name: string; provider_type: ProviderType;
    type: CredentialType; identifier: string | null; document_url: string | null;
    note: string | null; submitted_at: string; state: 'accepted' | 'rejected';
    reviewed_at: string; reviewed_by: string; review_note: string | null;
    credential_id: string | null;
  }>(
    `SELECT s.id, s.provider_id, p.full_name, p.type AS provider_type, s.type,
            s.identifier, s.document_url, s.note, s.submitted_at, s.state,
            s.reviewed_at, s.reviewed_by, s.review_note, s.credential_id
       FROM credential_submissions s
       JOIN providers p ON p.id = s.provider_id
      WHERE s.state <> 'submitted'
      ORDER BY s.reviewed_at DESC
      LIMIT $1`,
    [limit],
  );

  await auditRead(ctx, 'credential_submissions');

  return rows.map((r) => ({
    id: String(r.id),
    providerId: String(r.provider_id),
    providerName: String(r.full_name),
    providerType: r.provider_type,
    type: r.type,
    label: LABEL[r.type] ?? r.type,
    claimedIdentifier: r.identifier ?? null,
    documentUrl: r.document_url ?? null,
    note: r.note ?? null,
    submittedAt: asTimestamp(r.submitted_at),
    state: r.state,
    reviewedAt: asTimestamp(r.reviewed_at),
    reviewedBy: String(r.reviewed_by),
    reviewNote: r.review_note ?? null,
    credentialId: r.credential_id ? String(r.credential_id) : null,
  }));
}
