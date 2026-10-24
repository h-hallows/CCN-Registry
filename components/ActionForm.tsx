'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionState } from '@/app/(app)/actions';

type Action = (prev: ActionState | undefined, form: FormData) => Promise<ActionState>;

function Submit({ label, primary, confirm }: { label: string; primary?: boolean; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={primary ? 'btn btn-primary' : 'btn'}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
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
