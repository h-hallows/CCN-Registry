/**
 * Filing a document in the console.
 *
 * The database half — that a row cannot lie about its bytes, that nothing can rewrite
 * one, that redaction keeps the record — is in @h-hallows/core's own suite, so it cannot
 * be weakened in one app without the other noticing. What is here is the behaviour of
 * the code that writes through those constraints, and the two decisions the operator
 * makes that the database cannot: what a file is, and whether the subject sees it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  DocumentError, documentsFor, documentsForCase, fileDocument, readDocument,
  redactDocument, setDocumentVisibility,
} from '@/lib/queries/documents';
import { makeReferral, markWrittenStatementSent } from '@/lib/domain/referral';
import { shortlistFor } from '@/lib/queries/match';

let db: DbHandle;
let providerId: string;
let caseId: string;
let householdId: string;

const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}`);
const hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  db = await seededDb();
  const [p] = await db.query<{ id: string }>(
    `SELECT id FROM providers WHERE deleted_at IS NULL ORDER BY id LIMIT 1`);
  providerId = p!.id;
  const [c] = await db.query<{ id: string; household_id: string }>(
    `SELECT id, household_id FROM cases WHERE deleted_at IS NULL ORDER BY id LIMIT 1`);
  caseId = c!.id;
  householdId = c!.household_id;
});

describe('filing one', () => {
  it('holds the file, records the digest, and says what it filed on the timeline', async () => {
    const body = pdf('the signed registry agreement');
    const before = await db.query(
      `SELECT 1 FROM timeline_entries WHERE case_id = $1 AND type = 'document'`, [caseId]);

    const result = await fileDocument(TEST_CTX, {
      subject: { kind: 'case', id: caseId },
      kind: 'written_statement',
      filename: 'statement.pdf',
      contentType: 'application/pdf',
      bytes: body,
      note: 'Posted first class.',
    });

    expect(result.sha256Hex).toBe(hex(body));
    expect(result.duplicateOf).toBeNull();

    const held = await readDocument(result.id);
    expect(held!.bytes.equals(body)).toBe(true);
    expect(held!.contentType).toBe('application/pdf');

    const after = await db.query<{ body: string }>(
      `SELECT body FROM timeline_entries
        WHERE case_id = $1 AND type = 'document' ORDER BY at DESC`, [caseId]);
    expect(after.length).toBe(before.length + 1);
    expect(after[0]!.body).toContain('statement.pdf');
  });

  it('audits the digest and never the bytes', async () => {
    const body = pdf('a scan that should not be in the log');
    const result = await fileDocument(TEST_CTX, {
      subject: { kind: 'provider', id: providerId },
      kind: 'registry_agreement',
      filename: 'agreement.pdf',
      contentType: 'application/pdf',
      bytes: body,
    });

    const [row] = await db.query<{ diff: unknown }>(
      `SELECT diff FROM audit_log
        WHERE entity = 'document' AND entity_id = $1 AND action = 'create'`,
      [result.id]);
    const diff = JSON.stringify(row!.diff);
    expect(diff).toContain(hex(body));
    expect(diff).not.toContain('should not be in the log');
    expect(diff).toContain('agreement.pdf');
  });

  it('is not shared with the subject unless the operator says so', async () => {
    const quiet = await fileDocument(TEST_CTX, {
      subject: { kind: 'provider', id: providerId },
      kind: 'other',
      filename: 'notes.pdf',
      contentType: 'application/pdf',
      bytes: pdf('operator notes'),
    });
    const shared = await fileDocument(TEST_CTX, {
      subject: { kind: 'provider', id: providerId },
      kind: 'registry_agreement',
      filename: 'countersigned.pdf',
      contentType: 'application/pdf',
      bytes: pdf('countersigned'),
      visibleToSubject: true,
    });

    const docs = await documentsFor(TEST_CTX, { kind: 'provider', id: providerId });
    expect(docs.find((d) => d.id === quiet.id)!.visibleToSubject).toBe(false);
    expect(docs.find((d) => d.id === shared.id)!.visibleToSubject).toBe(true);
  });

  it('refuses a file type it does not keep, and says which', async () => {
    await expect(fileDocument(TEST_CTX, {
      subject: { kind: 'provider', id: providerId },
      kind: 'other',
      filename: 'macro.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: Buffer.from('PK'),
    })).rejects.toThrow(DocumentError);
  });

  it('refuses an empty file and one over the ceiling, before the database has to', async () => {
    await expect(fileDocument(TEST_CTX, {
      subject: { kind: 'provider', id: providerId },
      kind: 'other',
      filename: 'empty.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.alloc(0),
    })).rejects.toThrow(/empty/i);

    await expect(fileDocument(TEST_CTX, {
      subject: { kind: 'provider', id: providerId },
      kind: 'other',
      filename: 'huge.pdf',
      contentType: 'application/pdf',
      bytes: randomBytes(10 * 1024 * 1024 + 1),
    })).rejects.toThrow(/10 MB/);
  });

  it('refuses a subject that does not exist', async () => {
    await expect(fileDocument(TEST_CTX, {
      subject: { kind: 'case', id: '00000000-0000-0000-0000-000000000000' },
      kind: 'other',
      filename: 'x.pdf',
      contentType: 'application/pdf',
      bytes: pdf('x'),
    })).rejects.toThrow(/does not exist/);
  });

  it('reports the same file filed twice rather than refusing it', async () => {
    const body = pdf('the same scan, twice');
    const first = await fileDocument(TEST_CTX, {
      subject: { kind: 'household', id: householdId },
      kind: 'correspondence',
      filename: 'letter.pdf',
      contentType: 'application/pdf',
      bytes: body,
    });
    const second = await fileDocument(TEST_CTX, {
      subject: { kind: 'household', id: householdId },
      kind: 'correspondence',
      filename: 'letter-again.pdf',
      contentType: 'application/pdf',
      bytes: body,
    });

    expect(second.duplicateOf).toBe(first.id);
    // Both are kept. The operator decides; the screen says so.
    const docs = await documentsFor(TEST_CTX, { kind: 'household', id: householdId });
    expect(docs.filter((d) => d.sha256Hex === hex(body))).toHaveLength(2);
  });
});

describe('reading them back', () => {
  it('keeps a case\'s documents apart from the household\'s on one screen', async () => {
    const onCase = await fileDocument(TEST_CTX, {
      subject: { kind: 'case', id: caseId },
      kind: 'written_statement',
      filename: 'case.pdf',
      contentType: 'application/pdf',
      bytes: pdf('about this case'),
    });
    const onHousehold = await fileDocument(TEST_CTX, {
      subject: { kind: 'household', id: householdId },
      kind: 'nurse_disclosure',
      filename: 'household.pdf',
      contentType: 'application/pdf',
      bytes: pdf('about the family'),
    });

    const split = await documentsForCase(TEST_CTX, caseId, householdId);
    expect(split.onTheCase.some((d) => d.id === onCase.id)).toBe(true);
    expect(split.onTheCase.some((d) => d.id === onHousehold.id)).toBe(false);
    expect(split.onTheHousehold.some((d) => d.id === onHousehold.id)).toBe(true);
  });

  it('never drags the bytes into a list', async () => {
    const docs = await documentsFor(TEST_CTX, { kind: 'provider', id: providerId });
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(Object.keys(doc)).not.toContain('bytes');
    }
  });

  it('records opening one separately from listing them', async () => {
    const filed = await fileDocument(TEST_CTX, {
      subject: { kind: 'provider', id: providerId },
      kind: 'credential',
      filename: 'livescan.pdf',
      contentType: 'application/pdf',
      bytes: pdf('live scan result'),
    });

    const before = await db.query(
      `SELECT 1 FROM audit_log WHERE entity = 'document_bytes' AND entity_id = $1`,
      [filed.id]);
    expect(before).toHaveLength(0);

    const { recordDownload } = await import('@/lib/queries/documents');
    await recordDownload(TEST_CTX, filed.id);

    const after = await db.query(
      `SELECT 1 FROM audit_log WHERE entity = 'document_bytes' AND entity_id = $1`,
      [filed.id]);
    expect(after).toHaveLength(1);
  });
});

describe('sharing and redacting', () => {
  it('turns sharing on and off, and refuses a no-op', async () => {
    const filed = await fileDocument(TEST_CTX, {
      subject: { kind: 'case', id: caseId },
      kind: 'written_statement',
      filename: 'share.pdf',
      contentType: 'application/pdf',
      bytes: pdf('the statement'),
    });

    await expect(setDocumentVisibility(TEST_CTX, filed.id, false))
      .rejects.toThrow(/Already not shared/);
    await setDocumentVisibility(TEST_CTX, filed.id, true);
    await expect(setDocumentVisibility(TEST_CTX, filed.id, true))
      .rejects.toThrow(/Already shared/);
    await setDocumentVisibility(TEST_CTX, filed.id, false);

    const [row] = await db.query<{ visible_to_subject: boolean }>(
      `SELECT visible_to_subject FROM documents WHERE id = $1`, [filed.id]);
    expect(row!.visible_to_subject).toBe(false);
  });

  it('redaction destroys the file and keeps everything else', async () => {
    const body = pdf('filed against the wrong family');
    const filed = await fileDocument(TEST_CTX, {
      subject: { kind: 'case', id: caseId },
      kind: 'correspondence',
      filename: 'misfiled.pdf',
      contentType: 'application/pdf',
      bytes: body,
    });

    await expect(redactDocument(TEST_CTX, filed.id, ' '))
      .rejects.toThrow(/why/i);

    await redactDocument(TEST_CTX, filed.id, 'Belonged to another family.');

    // Gone from the download path entirely.
    expect(await readDocument(filed.id)).toBeNull();

    const docs = (await documentsForCase(TEST_CTX, caseId, householdId)).onTheCase;
    const row = docs.find((d) => d.id === filed.id);
    expect(row).toBeTruthy();
    expect(row!.redactedAt).not.toBeNull();
    expect(row!.sha256Hex).toBe(hex(body));
    expect(row!.redactionReason).toBe('Belonged to another family.');

    await expect(redactDocument(TEST_CTX, filed.id, 'again'))
      .rejects.toThrow(/already redacted/);
    await expect(setDocumentVisibility(TEST_CTX, filed.id, true))
      .rejects.toThrow(/redacted/);
  });
});

describe('the download route', () => {
  const route = readFileSync('app/(app)/documents/[documentId]/route.ts', 'utf8');

  /*
   * A source-level assertion, because the failure it guards against is invisible at
   * runtime: an inline PDF renders perfectly and also runs in this console's origin,
   * where the operator holds a live session. A provider hands in the "scan".
   */
  it('always serves an attachment, and never offers an inline preview', () => {
    expect(route).toContain('attachment; filename=');
    expect(route).not.toMatch(/['"`]inline/);
    expect(route).toContain("'x-content-type-options': 'nosniff'");
  });

  it('strips quotes and newlines out of a filename before it reaches a header', () => {
    expect(route).toMatch(/replace\(\/\[.*\\r\\n\]\/g/);
  });

  it('requires an operator and records the read before returning bytes', () => {
    expect(route).toContain('requireOperator()');
    expect(route.indexOf('recordDownload')).toBeLessThan(route.indexOf('new NextResponse'));
  });
});

/**
 * The § 1812.5095(f) record and the copy of what it delivered. Core migration 0018.
 *
 * Both land together or neither does: a disclosure pointing at a document that failed
 * to write, and a document filed against a delivery that rolled back, are each worse
 * than no copy.
 */
describe('recording the written statement that went out', () => {
  async function aFreshReferral(): Promise<{ disclosureId: string; caseId: string }> {
    /*
     * A case with somebody referable on it, found by asking rather than by position.
     *
     * Both halves of this used to be `ORDER BY ... LIMIT 1` over a random uuid, and
     * both were wrong in the same way — they picked by position and hoped for a
     * property. `status = 'active'` is not eligibility: the seed carries Grace Okonkwo
     * with an expired TB clearance so the blocking bucket has something in it, and she
     * is active, so whenever her uuid sorted first every test here failed with "TB
     * clearance expired". And not every companion case has a bench — the one at
     * `inquiry` has nobody — so filtering to non-ended was not enough either.
     *
     * Roughly one fresh run in eight, on both engines, because the seed's uuids are
     * random per run. `shortlistFor` is the same source the match screen reads, so
     * what counts as referable here cannot drift from the product.
     */
    const candidates = await db.query<{ id: string; dm_name: string }>(
      `SELECT c.id, h.dm_name
         FROM cases c JOIN households h ON h.id = c.household_id
        WHERE c.deleted_at IS NULL AND c.status <> 'ended' AND c.care = 'companion'
        ORDER BY c.id`);

    let row: { id: string; dm_name: string } | undefined;
    let providerId: string | undefined;
    for (const candidate of candidates) {
      const shortlist = await shortlistFor(TEST_CTX, candidate.id);
      const first = shortlist?.eligible[0];
      if (first) { row = candidate; providerId = first.providerId; break; }
    }
    expect(row, 'the seed has no companion case with anybody referable').toBeTruthy();

    const result = await makeReferral(TEST_CTX, {
      caseId: row!.id,
      providerId: providerId!,
      disclosedTo: row!.dm_name,
      disclosedBy: 'Operator',
      method: 'phone',
      spokenDisclosureGiven: true,
    });
    return { disclosureId: result.disclosureId, caseId: row!.id };
  }

  it('files the copy, links it, and shares it with the family', async () => {
    const { disclosureId, caseId } = await aFreshReferral();
    const body = pdf('the statement we posted');

    await markWrittenStatementSent(
      TEST_CTX, disclosureId, '2026-11-10', 'post', 'Operator',
      { filename: 'statement.pdf', contentType: 'application/pdf', bytes: body },
    );

    const [disclosure] = await db.query<{
      written_sent_on: string; written_statement_document_id: string | null;
    }>(
      `SELECT written_sent_on::text, written_statement_document_id
         FROM disclosures WHERE id = $1`, [disclosureId]);
    expect(disclosure!.written_sent_on).toBe('2026-11-10');
    expect(disclosure!.written_statement_document_id).not.toBeNull();

    const docs = (await documentsForCase(TEST_CTX, caseId, '00000000-0000-0000-0000-000000000000')).onTheCase;
    const copy = docs.find((d) => d.id === disclosure!.written_statement_document_id);
    expect(copy).toBeTruthy();
    expect(copy!.kind).toBe('written_statement');
    // They received it; a copy of their own statement is theirs to re-read.
    expect(copy!.visibleToSubject).toBe(true);
    expect(copy!.sha256Hex).toBe(hex(body));
  });

  it('records the delivery with no copy, rather than refusing it', async () => {
    const { disclosureId } = await aFreshReferral();
    await markWrittenStatementSent(
      TEST_CTX, disclosureId, '2026-11-11', 'post', 'Operator');

    const [disclosure] = await db.query<{
      written_sent_on: string; written_statement_document_id: string | null;
    }>(
      `SELECT written_sent_on::text, written_statement_document_id
         FROM disclosures WHERE id = $1`, [disclosureId]);
    expect(disclosure!.written_sent_on).toBe('2026-11-11');
    expect(disclosure!.written_statement_document_id).toBeNull();
  });

  it('a rejected file takes the delivery record with it', async () => {
    /*
     * The point of filing inside the same transaction. A delivery recorded alongside a
     * document that did not write would be a reference to nothing; a document filed
     * against a delivery that rolled back would be a copy of a statement nobody sent.
     */
    const { disclosureId } = await aFreshReferral();

    await expect(markWrittenStatementSent(
      TEST_CTX, disclosureId, '2026-11-12', 'post', 'Operator',
      { filename: 'notes.docx', contentType: 'application/msword', bytes: pdf('x') },
    )).rejects.toThrow(DocumentError);

    const [disclosure] = await db.query<{ written_sent_on: string | null }>(
      `SELECT written_sent_on::text FROM disclosures WHERE id = $1`, [disclosureId]);
    expect(disclosure!.written_sent_on).toBeNull();
  });
});
