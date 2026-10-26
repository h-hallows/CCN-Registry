'use client';

import { useState } from 'react';

/**
 * The household profile travels to a substitute, so it has to leave this screen in one
 * action. Routine, access and preferences — never clinical instruction (I2, I10).
 */
export function CopyBox({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="label mb-0">{label}</span>
        <button type="button" onClick={copy} className="btn">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p
        className="whitespace-pre-wrap rounded-md border p-3 text-sm leading-relaxed hair"
        style={{ background: 'var(--accent-soft)' }}
      >
        {text}
      </p>
    </div>
  );
}
