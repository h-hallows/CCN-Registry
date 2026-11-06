/**
 * Documents in the console. Core migration 0015.
 *
 * The operator is the only person who files one against a household or a case, and the
 * only person who decides whether the subject sees it. Both of those are deliberate
 * acts with an audit row behind them.
 *
 * READS ARE AUDITED INDIVIDUALLY. Listing a file index is one thing; opening a scanned
 * Live Scan result is another, and § 3.8's reason for logging reads — being able to
 * answer "who looked at this household" later — only works if opening a document is
 * distinguishable from listing one. `recordDownload` is called by the download route
 * and nowhere else.
 */
import { createHash } from 'node:crypto';
import { getDb, type Tx } from '@h-hallows/core/db';
import { audit, auditRead, type AuditContext } from '@/lib/audit';
import { insertTimeline } from '@/lib/domain/referral';

export class DocumentError extends Error {}

export const MAX_BYTES = 10 * 1024 * 1024;

export type DocumentKind =
  | 'credential' | 'registry_agreement' | 'written_notice' | 'written_statement'
  | 'nurse_disclosure' | 'correspondence' | 'other';

export const KIND_LABEL: Record<DocumentKind, string> = {
  credential: 'Credential document',
  registry_agreement: 'Signed registry agreement',
  written_notice: 'Written notice, acknowledged',
  written_statement: 'Written statement sent to the household',
  nurse_disclosure: "Nurses' registry disclosure",
  correspondence: 'Correspondence',
  other: 'Other',
};

/**
 * What may be filed. Deliberately short.
 *
 * Anything the browser will open inline is a thing the browser will also execute, so
 * the download route serves everything as an attachment regardless — this list is about
 * what is worth keeping, not about what is safe to render.
 */
export const ACCEPTED: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/tiff': 'tiff',
};

export interface DocumentRow {
  id: string;
  kind: DocumentKind;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256Hex: string;
  uploadedBy: string;
  uploadedAt: string;
  note: string | null;
  visibleToSubject: boolean;
  redactedAt: string | null;
  redactedBy: string | null;
  redactionReason: string | null;
  credentialId: string | null;
}

/** Columns, never `*`: `bytes` must not be dragged into a list query. */
const COLUMNS = `
  id, kind::text AS kind, filename, content_type, byte_size, sha256_hex,
  uploaded_by, uploaded_at::text, note, visible_to_subject,
  redacted_at::text, redacted_by, redaction_reason, credential_id`;

type Raw = {
  id: string; kind: string; filename: string; content_type: string; byte_size: number;
  sha256_hex: string; uploaded_by: string; uploaded_at: string; note: string | null;
  visible_to_subject: boolean; redacted_at: string | null; redacted_by: string | null;
  redaction_reason: string | null; credential_id: string | null;
};

function asRow(r: Raw): DocumentRow {
  return {
    id: r.id,
    kind: r.kind as DocumentKind,
    filename: r.filename,
    contentType: r.content_type,
    byteSize: Number(r.byte_size),
    sha256Hex: r.sha256_hex,
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at,
    note: r.note,
    visibleToSubject: r.visible_to_subject,
    redactedAt: r.redacted_at,
    redactedBy: r.redacted_by,
    redactionReason: r.redaction_reason,
    credentialId: r.credential_id,
  };
}

export type Subject =
  | { kind: 'provider'; id: string }
  | { kind: 'household'; id: string }
  | { kind: 'case'; id: string };

const COLUMN: Record<Subject['kind'], string> = {
  provider: 'provider_id',
  household: 'household_id',
  case: 'case_id',
};

export async function documentsFor(
  ctx: AuditContext,
  subject: Subject,
): Promise<DocumentRow[]> {
  const { query } = await getDb();
  const rows = await query<Raw>(
    `SELECT ${COLUMNS} FROM documents
      WHERE ${COLUMN[subject.kind]} = $1
      ORDER BY uploaded_at DESC`,
    [subject.id],
  );
  if (rows.length > 0) await auditRead(ctx, 'documents', subject.id);
  return rows.map(asRow);
}

/** A case's own documents plus the household's. Two subjects, one screen. */
export async function documentsForCase(
  ctx: AuditContext,
  caseId: string,
  householdId: string,
): Promise<{ onTheCase: DocumentRow[]; onTheHousehold: DocumentRow[] }> {
  const { query } = await getDb();
  const rows = await query<Raw & { scope: string }>(
    `SELECT ${COLUMNS},
            CASE WHEN case_id = $1 THEN 'case' ELSE 'household' END AS scope
       FROM documents
      WHERE case_id = $1 OR household_id = $2
      ORDER BY uploaded_at DESC`,
    [caseId, householdId],
  );
  if (rows.length > 0) await auditRead(ctx, 'documents', caseId);
  return {
    onTheCase: rows.filter((r) => r.scope === 'case').map(asRow),
    onTheHousehold: rows.filter((r) => r.scope === 'household').map(asRow),
  };
}

export interface FileDocumentInput {
  subject: Subject;
  kind: DocumentKind;
  filename: string;
  contentType: string;
  bytes: Buffer;
  note?: string;
  /** The operator's deliberate decision to show it to the household or provider. */
  visibleToSubject?: boolean;
  credentialId?: string;
}

/**
 * File a document.
 *
 * The digest is computed here and checked by the database against the bytes, so a bug
 * in this function cannot produce a row whose digest is wrong — it produces no row.
 */
export async function fileDocument(
  ctx: AuditContext,
  input: FileDocumentInput,
): Promise<{ id: string; sha256Hex: string; duplicateOf: string | null }> {
  const filename = input.filename.trim().slice(0, 200);
  if (!filename) throw new DocumentError('That file has no name.');
  if (!ACCEPTED[input.contentType]) {
    throw new DocumentError(
      `${input.contentType || 'That file type'} is not one we file. PDF, JPEG, PNG, HEIC or TIFF.`,
    );
  }
  if (input.bytes.length === 0) throw new DocumentError('That file is empty.');
  if (input.bytes.length > MAX_BYTES) {
    throw new DocumentError(
      `That file is ${(input.bytes.length / 1048576).toFixed(1)} MB. The limit is 10 MB.`,
    );
  }
  if (input.credentialId && input.subject.kind !== 'provider') {
    throw new DocumentError('A credential document belongs to a provider.');
  }

  const sha256Hex = createHash('sha256').update(input.bytes).digest('hex');
  const handle = await getDb();

  return handle.transaction(async (tx) => {
    await assertSubjectExists(tx, input.subject);

    /*
     * The same bytes filed twice against the same subject is almost always the same
     * scan uploaded again, and a file list with the same document three times is one
     * nobody reads. Reported, not refused: there are legitimate reasons to file a
     * duplicate (a second case, a re-signed copy), and the operator decides.
     */
    const [existing] = await tx.query<{ id: string }>(
      `SELECT id FROM documents
        WHERE sha256_hex = $1 AND ${COLUMN[input.subject.kind]} = $2
          AND redacted_at IS NULL
        ORDER BY uploaded_at LIMIT 1`,
      [sha256Hex, input.subject.id],
    );

    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO documents
         (kind, ${COLUMN[input.subject.kind]}, credential_id, filename, content_type,
          byte_size, sha256_hex, bytes, uploaded_by, note, visible_to_subject)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.kind, input.subject.id, input.credentialId ?? null, filename,
        input.contentType, input.bytes.length, sha256Hex, input.bytes,
        ctx.actor, input.note?.trim() || null, input.visibleToSubject ?? false,
      ],
    );
    if (!row) throw new DocumentError('Could not file that.');

    await writeTimeline(tx, ctx, input.subject,
      `Filed: ${filename} (${KIND_LABEL[input.kind]})`
      + (input.visibleToSubject ? ', shared with them.' : '.'));

    // The digest, not the bytes. The log says what was filed and lets anyone confirm a
    // file they are holding is the one the record means.
    await audit({
      ...ctx,
      action: 'create',
      entity: 'document',
      entityId: row.id,
      diff: {
        subject: input.subject,
        kind: input.kind,
        filename,
        byteSize: input.bytes.length,
        sha256Hex,
        visibleToSubject: input.visibleToSubject ?? false,
      },
    }, tx);

    return { id: row.id, sha256Hex, duplicateOf: existing?.id ?? null };
  });
}

async function assertSubjectExists(tx: Tx, subject: Subject): Promise<void> {
  const table = subject.kind === 'provider' ? 'providers'
    : subject.kind === 'household' ? 'households' : 'cases';
  const [row] = await tx.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [subject.id]);
  if (!row) throw new DocumentError('That record does not exist.');
}

async function writeTimeline(
  tx: Tx, ctx: AuditContext, subject: Subject, body: string,
): Promise<void> {
  if (subject.kind === 'provider') return; // providers have no timeline
  await insertTimeline(tx, {
    caseId: subject.kind === 'case' ? subject.id : null,
    householdId: subject.kind === 'household' ? subject.id : null,
    type: 'document',
    author: ctx.actor,
    body,
  });
}

/** The bytes, for the download route. Nothing else calls this. */
export async function readDocument(
  id: string,
): Promise<{ filename: string; contentType: string; bytes: Buffer; sha256Hex: string } | null> {
  const { query } = await getDb();
  const [row] = await query<{
    filename: string; content_type: string; bytes: Buffer | null; sha256_hex: string;
  }>(
    `SELECT filename, content_type, bytes, sha256_hex FROM documents
      WHERE id = $1 AND redacted_at IS NULL`,
    [id],
  );
  if (!row?.bytes) return null;
  return {
    filename: row.filename,
    contentType: row.content_type,
    bytes: Buffer.from(row.bytes),
    sha256Hex: row.sha256_hex,
  };
}

/**
 * Opening a document is its own audit entry.
 *
 * § 3.8 logs reads so that "who looked at this household's information" is answerable
 * later. That only works if opening a scanned document is distinguishable from loading
 * the screen that lists it.
 */
export async function recordDownload(ctx: AuditContext, id: string): Promise<void> {
  await auditRead(ctx, 'document_bytes', id);
}

/**
 * Show it to them, or stop showing it.
 *
 * The one mutable thing about a document, and it is not part of the document: it is the
 * registry's decision about what it shares, recorded separately from the evidence.
 */
export async function setDocumentVisibility(
  ctx: AuditContext,
  id: string,
  visible: boolean,
): Promise<void> {
  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [doc] = await tx.query<{
      visible_to_subject: boolean; redacted_at: string | null; filename: string;
      provider_id: string | null; household_id: string | null; case_id: string | null;
    }>(
      `SELECT visible_to_subject, redacted_at::text, filename,
              provider_id, household_id, case_id
         FROM documents WHERE id = $1`,
      [id],
    );
    if (!doc) throw new DocumentError('That document does not exist.');
    if (doc.redacted_at) throw new DocumentError('That document was redacted.');
    if (doc.visible_to_subject === visible) {
      throw new DocumentError(visible ? 'Already shared.' : 'Already not shared.');
    }

    await tx.query(
      `UPDATE documents SET visible_to_subject = $2 WHERE id = $1`, [id, visible]);

    const subject: Subject | null = doc.case_id
      ? { kind: 'case', id: doc.case_id }
      : doc.household_id
        ? { kind: 'household', id: doc.household_id }
        : null;
    if (subject) {
      await writeTimeline(tx, ctx, subject,
        visible
          ? `Shared with them: ${doc.filename}.`
          : `No longer shared with them: ${doc.filename}.`);
    }

    await audit({
      ...ctx,
      action: 'update',
      entity: 'document',
      entityId: id,
      diff: { visibleToSubject: { from: !visible, to: visible } },
    }, tx);
  });
}

/**
 * Drop the bytes, keep the record.
 *
 * The only destructive act this console can perform, and it exists for one reason: file
 * one household's paperwork against another and append-only means you cannot un-leak
 * it. What was filed, by whom, when and what it hashed to all survive.
 */
export async function redactDocument(
  ctx: AuditContext,
  id: string,
  reason: string,
): Promise<void> {
  if (reason.trim().length < 3) throw new DocumentError('Record why.');

  const handle = await getDb();
  await handle.transaction(async (tx) => {
    const [doc] = await tx.query<{
      redacted_at: string | null; filename: string; sha256_hex: string;
      provider_id: string | null; household_id: string | null; case_id: string | null;
    }>(
      `SELECT redacted_at::text, filename, sha256_hex, provider_id, household_id, case_id
         FROM documents WHERE id = $1`,
      [id],
    );
    if (!doc) throw new DocumentError('That document does not exist.');
    if (doc.redacted_at) throw new DocumentError('That document is already redacted.');

    await tx.query(
      `UPDATE documents
          SET redacted_at = now(), redacted_by = $2, redaction_reason = $3, bytes = NULL
        WHERE id = $1`,
      [id, ctx.actor, reason.trim()],
    );

    const subject: Subject | null = doc.case_id
      ? { kind: 'case', id: doc.case_id }
      : doc.household_id
        ? { kind: 'household', id: doc.household_id }
        : null;
    if (subject) {
      await writeTimeline(tx, ctx, subject,
        `Redacted: ${doc.filename}. The record of it remains. ${reason.trim()}`);
    }

    await audit({
      ...ctx,
      action: 'update',
      entity: 'document',
      entityId: id,
      diff: { redacted: true, filename: doc.filename, sha256Hex: doc.sha256_hex, reason: reason.trim() },
    }, tx);
  });
}
