import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/operator';
import { readDocument, recordDownload } from '@/lib/queries/documents';

export const dynamic = 'force-dynamic';

/**
 * Hand a filed document back.
 *
 * ALWAYS AN ATTACHMENT, whatever it is. A PDF rendered inline runs in the origin of
 * this console, where the operator holds a live session — so a crafted "scan" handed in
 * by a provider would be a script with the operator's cookie. `Content-Disposition:
 * attachment` plus `nosniff` (set globally in next.config.ts) means the browser saves
 * it rather than running it. There is deliberately no inline preview.
 *
 * The content type is the one recorded at upload and checked against the accepted list
 * there, never one derived from the filename at serve time.
 *
 * Opening a document is audited separately from listing one, which is the whole point
 * of § 3.8's read log: "who looked at this household's information" has to be
 * answerable, and loading an index is not the same as opening a Live Scan result.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { ctx } = await requireOperator();
  const { documentId } = await params;

  const doc = await readDocument(documentId);
  if (!doc) {
    return NextResponse.json(
      { error: 'No such document, or it was redacted.' }, { status: 404 },
    );
  }

  await recordDownload(ctx, documentId);

  // A filename reaches a header here, so quotes and newlines come out of it first:
  // a response header is not a place a provider gets to write CRLF.
  const safe = doc.filename.replace(/["\\\r\n]/g, '_');

  return new NextResponse(new Uint8Array(doc.bytes), {
    headers: {
      'content-type': doc.contentType,
      'content-disposition': `attachment; filename="${safe}"`,
      'content-length': String(doc.bytes.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store, max-age=0',
      // So anyone holding a copy can confirm it is the one the record means.
      'x-document-sha256': doc.sha256Hex,
    },
  });
}
