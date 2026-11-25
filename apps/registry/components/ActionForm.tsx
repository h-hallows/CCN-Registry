'use client';

import { useActionState, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionState } from '@/app/(app)/actions';
import { CopyBox } from '@/components/CopyBox';

type Action = (prev: ActionState | undefined, form: FormData) => Promise<ActionState>;

/**
 * THE CONFIRMATION IS IN THE PAGE, NOT IN THE BROWSER CHROME.
 *
 * This used to be `if (confirm && !window.confirm(confirm)) e.preventDefault();` on the
 * submit button, which was a real confirmation for a human being and completely opaque
 * to everything else. A native dialog is drawn by the browser rather than by the
 * document: it is not in the DOM, a headless driver dismisses it by default rather than
 * reading it, and no assertion can be written against its wording. Every write in this
 * console that carries a `confirm` prop — the forward-only referral stop, publishing and
 * withdrawing a bench, the referral itself, posting a fee schedule, filing a register
 * correction, destroying a document, ending an engagement — was therefore unreachable to
 * an automated test. Not untested by omission: untestable, which in a codebase whose
 * controls are enforced in code and in CI rather than in documentation is the worst
 * place to leave a gate.
 *
 * So the gate moved into the page and kept its weight. The button that posts the form
 * does not exist until the question has been asked: the first press renders this panel
 * and the only `type="submit"` in a confirming form is the one inside it, so a write
 * still costs two deliberate acts and neither of them can be skipped by a script any
 * more than by a person.
 *
 * WHAT MAKES IT A CONFIRMATION RATHER THAN A SECOND CLICK. `role="alertdialog"` with the
 * question as its accessible name, so a screen reader is interrupted by it the way the
 * native dialog interrupted. Focus moves to the panel's cancel control on open, because
 * the conservative answer is the one that should be under the cursor and under Return
 * when a destructive question appears. Escape cancels and puts focus back on the button
 * that opened it. Cancelling leaves the form exactly as it was, so an operator who
 * changes their mind has not lost what they typed.
 */
function Confirm({
  question, label, primary, onClose,
}: {
  question: string;
  label: string;
  primary?: boolean;
  /** `refocus` returns the caret to the control that asked, which a save should not. */
  onClose: (refocus: boolean) => void;
}) {
  const { pending } = useFormStatus();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  const posted = useRef(false);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  /*
   * A question that has been answered is closed, including when the answer was yes.
   * Left open, the panel would sit there after the save with its accept button live
   * again, which is an invitation to record the same write twice — and on this form the
   * writes are referrals and register entries.
   */
  useEffect(() => {
    if (pending) {
      posted.current = true;
      return;
    }
    if (posted.current) {
      posted.current = false;
      onClose(false);
    }
  }, [pending, onClose]);

  return (
    <div
      role="alertdialog"
      aria-labelledby={questionId}
      data-confirm="open"
      className="flex flex-wrap items-center gap-3 rounded-md border p-3 hair"
      style={{ background: 'var(--accent-soft)' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose(true);
        }
      }}
    >
      <p id={questionId} className="text-xs leading-relaxed">{question}</p>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          data-confirm-accept
          className={primary ? 'btn btn-primary' : 'btn'}
        >
          {pending ? 'Working…' : `Yes — ${label.toLowerCase()}`}
        </button>
        <button
          type="button"
          ref={cancelRef}
          disabled={pending}
          data-confirm-cancel
          className="btn"
          onClick={() => onClose(true)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The submit control, which for a confirming form is a question rather than a post.
 *
 * `type="button"` while the question has not been asked is the load-bearing half. A
 * `type="submit"` that merely refused to proceed would post the form the moment anything
 * — Return in a text field, a driver pressing the button, a future `requestSubmit` —
 * reached the form rather than the button, which is precisely how the native dialog
 * could be bypassed and how a replacement built on `preventDefault` would be too.
 */
function Submit({ label, primary, confirm }: { label: string; primary?: boolean; confirm?: string }) {
  const { pending } = useFormStatus();
  const [asking, setAsking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((refocus: boolean) => {
    setAsking(false);
    // Back to the control that opened the question, so a keyboard operator is not
    // returned to the top of the document by cancelling. Not after a save: the answer
    // the operator wants to read then is the one the server sent back.
    if (refocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  if (confirm && asking) {
    return (
      <Confirm question={confirm} label={label} primary={primary} onClose={close} />
    );
  }

  return (
    <button
      ref={triggerRef}
      type={confirm ? 'button' : 'submit'}
      disabled={pending}
      className={primary ? 'btn btn-primary' : 'btn'}
      {...(confirm
        ? { 'aria-haspopup': 'dialog' as const, 'data-confirm': 'closed', onClick: () => setAsking(true) }
        : {})}
    >
      {pending ? 'Working…' : label}
    </button>
  );
}

/**
 * A form bound to a server action, with the result shown inline. Nothing here is
 * optimistic: the operator sees what the server actually recorded, which matters when the
 * record is the compliance evidence.
 */
export function ActionForm({
  action, submitLabel, primary, confirm, className, children, resetOnSuccess,
}: {
  action: Action;
  submitLabel: string;
  primary?: boolean;
  confirm?: string;
  className?: string;
  children: React.ReactNode;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form
      action={formAction}
      className={className}
      key={resetOnSuccess && state?.ok ? state.ok : undefined}
      /*
       * Return inside a text field submits a form implicitly, and it does it without
       * going near the button — so on a confirming form it would post the write with the
       * question unasked. Blocked here rather than relied on not to happen, because the
       * same keystroke was already bypassing `window.confirm` in exactly this way.
       */
      onKeyDown={confirm ? (e) => {
        const target = e.target as HTMLElement;
        if (e.key !== 'Enter' || e.defaultPrevented) return;
        if (target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON') return;
        e.preventDefault();
      } : undefined}
    >
      {children}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Submit label={submitLabel} primary={primary} confirm={confirm} />
        {state?.error ? (
          <span className="text-xs" style={{ color: 'var(--color-expired)' }}>{state.error}</span>
        ) : null}
        {state?.ok ? (
          <span className="text-xs" style={{ color: 'var(--color-ok)' }}>{state.ok}</span>
        ) : null}
      </div>
      {/* Shown once, and only here. A sign-in link is a credential: it is not logged,
          not audited and not re-readable after this render. */}
      {state?.copy ? (
        <div className="mt-3">
          <CopyBox label={state.copy.label} text={state.copy.text} />
        </div>
      ) : null}
    </form>
  );
}

/** A collapsible wrapper so a dense screen is not also a tall one. */
export function Disclose({
  summary, children, tone,
}: { summary: string; children: React.ReactNode; tone?: 'quiet' }) {
  return (
    <details className="group">
      <summary
        className="cursor-pointer select-none text-xs font-medium underline-offset-4 hover:underline"
        style={{ color: tone === 'quiet' ? 'var(--ink-faint)' : 'var(--accent)' }}
      >
        {summary}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
