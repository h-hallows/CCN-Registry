import { ActionForm, Disclose } from '@/components/ActionForm';
import {
  fileDocumentAction, redactDocumentAction, setDocumentVisibilityAction,
} from '@/app/(app)/actions';
import { Empty, shortDateTime } from '@/components/ui';
import { KIND_LABEL, type DocumentKind, type DocumentRow, type Subject } from '@/lib/queries/documents';

const KINDS: DocumentKind[] = [
  'registry_agreement', 'written_notice', 'written_statement', 'nurse_disclosure',
  'credential', 'correspondence', 'other',
];

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * The file behind a record.
 *
 * Every row is a link that downloads — never one that previews. A PDF rendered inline
 * runs in this console's origin where a live operator session lives, so a crafted
 * "scan" handed in by a provider would execute with that cookie. The route serves
 * everything as an attachment and there is deliberately no viewer here.
 *
 * A redacted document keeps its row. That is the point of redaction: the file is gone
 * and the fact that it was filed, by whom, when, and what it hashed to is not.
 */
export function Documents({
  subject, documents, defaultKind, shareLabel,
}: {
  subject: Subject;
  documents: DocumentRow[];
  defaultKind?: DocumentKind;
  /** What sharing means on this screen — "the family" reads differently from "them". */
  shareLabel: string;
}) {
  const live = documents.filter((d) => !d.redactedAt);
  const redacted = documents.filter((d) => d.redactedAt);

  return (
    <div className="divide-y hair-soft">
      {live.length === 0 ? (
        <div className="px-4 py-4">
          <Empty>
            Nothing filed. A date on a record with no document behind it cannot produce
            what it refers to.
          </Empty>
        </div>
      ) : (
        <ul className="divide-y hair-soft">
          {live.map((d) => (
            <li key={d.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div>
                  <a
                    href={`/documents/${d.id}`}
                    className="text-sm font-medium underline underline-offset-4"
                  >
                    {d.filename}
                  </a>
                  <span className="ml-2 text-xs" style={{ color: 'var(--ink-soft)' }}>
                    {KIND_LABEL[d.kind]} · <span className="nums">{size(d.byteSize)}</span>
                  </span>
                </div>
                <span className="text-xs" style={{
                  color: d.visibleToSubject ? 'var(--color-ok)' : 'var(--ink-faint)',
                }}>
                  {d.visibleToSubject ? `shared with ${shareLabel}` : 'not shared'}
                </span>
              </div>

              <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
                filed {shortDateTime(d.uploadedAt)} by {d.uploadedBy}
                {d.note ? ` · ${d.note}` : null}
              </p>
              <p className="mt-0.5 break-all font-mono text-[0.625rem]"
                style={{ color: 'var(--ink-faint)' }}>
                sha256 {d.sha256Hex}
              </p>

              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                <Disclose
                  summary={d.visibleToSubject ? 'Stop sharing it' : `Share it with ${shareLabel}`}
                  tone="quiet"
                >
                  <ActionForm
                    action={setDocumentVisibilityAction}
                    submitLabel={d.visibleToSubject ? 'Stop sharing' : 'Share it'}
                  >
                    <input type="hidden" name="subjectKind" value={subject.kind} />
                    <input type="hidden" name="subjectId" value={subject.id} />
                    <input type="hidden" name="documentId" value={d.id} />
                    <input type="hidden" name="visible" value={d.visibleToSubject ? 'no' : 'yes'} />
                    <p className="text-[0.6875rem] leading-relaxed"
                      style={{ color: 'var(--ink-faint)' }}>
                      Sharing puts this on their own screen. Filing something is not the
                      same as showing it to them, which is why it is off until you say so.
                    </p>
                  </ActionForm>
                </Disclose>

                <Disclose summary="Redact it" tone="quiet">
                  <ActionForm
                    action={redactDocumentAction}
                    submitLabel="Redact it"
                    confirm="This permanently destroys the file. The record that it was filed, by whom, and what it hashed to is kept. Continue?"
                  >
                    <input type="hidden" name="subjectKind" value={subject.kind} />
                    <input type="hidden" name="subjectId" value={subject.id} />
                    <input type="hidden" name="documentId" value={d.id} />
                    <label className="label" htmlFor={`redact-${d.id}`}>Why</label>
                    <input id={`redact-${d.id}`} name="reason" className="input" required
                      placeholder="Filed against the wrong record, say" />
                    <p className="mt-2 text-[0.6875rem] leading-relaxed"
                      style={{ color: 'var(--ink-faint)' }}>
                      For a file that should never have been here. A wrong version is
                      replaced by filing the right one — both are kept, because what was
                      on file in March is a question someone may ask later.
                    </p>
                  </ActionForm>
                </Disclose>
              </div>
            </li>
          ))}
        </ul>
      )}

      {redacted.length > 0 ? (
        <div className="px-4 py-3">
          <Disclose summary={`${redacted.length} redacted`} tone="quiet">
            <ul className="space-y-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
              {redacted.map((d) => (
                <li key={d.id}>
                  {d.filename} · filed {shortDateTime(d.uploadedAt)} by {d.uploadedBy} ·
                  {' '}redacted {shortDateTime(d.redactedAt!)} by {d.redactedBy} ·{' '}
                  {d.redactionReason}
                  <span className="block break-all font-mono text-[0.625rem]">
                    sha256 {d.sha256Hex}
                  </span>
                </li>
              ))}
            </ul>
          </Disclose>
        </div>
      ) : null}

      <div className="px-4 py-4">
        <Disclose summary="File a document">
          <ActionForm action={fileDocumentAction} submitLabel="File it" resetOnSuccess>
            <input type="hidden" name="subjectKind" value={subject.kind} />
            <input type="hidden" name="subjectId" value={subject.id} />
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor={`doc-kind-${subject.id}`}>What it is</label>
                <select id={`doc-kind-${subject.id}`} name="kind" className="select"
                  defaultValue={defaultKind ?? 'other'} required>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{KIND_LABEL[k]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor={`doc-file-${subject.id}`}>The file</label>
                <input id={`doc-file-${subject.id}`} name="file" type="file" required
                  className="input"
                  accept="application/pdf,image/jpeg,image/png,image/heic,image/tiff" />
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor={`doc-note-${subject.id}`}>Note</label>
                <input id={`doc-note-${subject.id}`} name="note" className="input"
                  placeholder="Optional. What this is, in your words." />
              </div>
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed">
              <input type="checkbox" name="visibleToSubject" value="yes" className="mt-0.5" />
              <span>
                Show it to {shareLabel} on their own screen. Off by default: the
                registry&rsquo;s file is not theirs to read.
              </span>
            </label>

            <p className="mt-3 text-[0.6875rem] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              PDF, JPEG, PNG, HEIC or TIFF, up to 10 MB. The file is held by the registry,
              not linked to, and its SHA-256 is checked by the database against the bytes
              — so the digest below it is evidence, not a claim. Once filed it cannot be
              edited or deleted, only redacted.
            </p>
          </ActionForm>
        </Disclose>
      </div>
    </div>
  );
}
