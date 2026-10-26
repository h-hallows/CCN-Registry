/**
 * Shared presentation pieces.
 *
 * Two of these carry an invariant:
 *  - `Rate` always renders the negotiable marker, because I5 requires a provider's rate
 *    to be presented as provider-set and negotiable wherever it appears.
 *  - `CredentialPill` shows a state, never a document or a Live Scan result. COUNSEL.md
 *    question 5 is open on what may be surfaced at all.
 */
import Link from 'next/link';
import type { CredStatus } from '@ccn/core/domain';

/**
 * The care vocabulary comes from @ccn/core so the console, the marketing site and the
 * client portal describe the same thing with the same words. Re-exported here only so
 * existing imports in this app keep working.
 */
export { CARE_LABEL, STATUS_LABEL, END_REASON_LABEL } from '@ccn/core/domain';

const STATUS_COLOR: Record<CredStatus, string> = {
  expired: 'var(--color-expired)',
  critical: 'var(--color-critical)',
  soon: 'var(--color-soon)',
  upcoming: 'var(--color-upcoming)',
  valid: 'var(--color-ok)',
  none: 'var(--ink-faint)',
};

const STATUS_WORD: Record<CredStatus, string> = {
  expired: 'Expired',
  critical: 'Expires within 7 days',
  soon: 'Expires within 30 days',
  upcoming: 'Expires within 90 days',
  valid: 'Current',
  none: 'Does not expire',
};

export function CredentialPill({ status, label }: { status: CredStatus; label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap"
      title={STATUS_WORD[status]}
    >
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full shrink-0"
        style={{ background: STATUS_COLOR[status] }}
      />
      <span style={{ color: status === 'valid' || status === 'none' ? 'var(--ink-soft)' : STATUS_COLOR[status] }}>
        {label ?? STATUS_WORD[status]}
      </span>
    </span>
  );
}

/** I5. There is no code path that renders a rate without the negotiable marker. */
export function Rate({ hourly, notes }: { hourly: string | null; notes?: string | null }) {
  if (!hourly) {
    return <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>Not stated</span>;
  }
  return (
    <span className="nums whitespace-nowrap">
      ${Number(hourly).toFixed(2)}/hr
      <span
        className="ml-1.5 text-[0.6875rem]"
        style={{ color: 'var(--ink-faint)' }}
        title={notes ?? 'Provider-stated and negotiable with the household.'}
      >
        provider-stated, negotiable
      </span>
    </span>
  );
}

export function Eligibility({ eligible, reason }: { eligible: boolean; reason: string | null }) {
  if (eligible) {
    return <CredentialPill status="valid" label="Eligible" />;
  }
  return (
    <span className="inline-flex flex-col gap-0.5">
      <CredentialPill status="expired" label="Not eligible" />
      {reason ? (
        <span className="text-[0.6875rem]" style={{ color: 'var(--ink-soft)' }}>{reason}</span>
      ) : null}
    </span>
  );
}

export function Section({
  title, blurb, right, children, id,
}: {
  title: string; blurb?: string; right?: React.ReactNode;
  children: React.ReactNode; id?: string;
}) {
  return (
    <section id={id} className="card mb-4 overflow-hidden">
      <header
        className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 border-b hair"
      >
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {blurb ? (
            <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--ink-faint)' }}>
              {blurb}
            </p>
          ) : null}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-6 text-xs" style={{ color: 'var(--ink-faint)' }}>{children}</p>
  );
}

export function Field({
  label, children, wide,
}: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2 lg:col-span-3' : undefined}>
      <span className="label">{label}</span>
      <div className="text-sm leading-snug">{children ?? '—'}</div>
    </div>
  );
}

export function Banner({
  tone, title, children,
}: { tone: 'alert' | 'note'; title: string; children?: React.ReactNode }) {
  const color = tone === 'alert' ? 'var(--color-expired)' : 'var(--color-upcoming)';
  return (
    <div
      className="mb-4 rounded-lg border px-4 py-3 text-sm"
      style={{ borderColor: color, background: 'color-mix(in oklab, var(--card) 88%, transparent)' }}
    >
      <strong className="block text-sm font-semibold" style={{ color }}>{title}</strong>
      {children ? (
        <div className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function Count({ n }: { n: number }) {
  return (
    <span
      className="nums inline-flex min-w-5 justify-center rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold"
      style={{
        background: n > 0 ? 'var(--accent)' : 'var(--line-soft)',
        color: n > 0 ? 'var(--page)' : 'var(--ink-faint)',
      }}
    >
      {n}
    </span>
  );
}

export function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

export function formatBlocks(blocks: string[]): string {
  if (blocks.length === 0) return '—';
  const byBlock = new Map<string, string[]>();
  for (const b of blocks) {
    const [day, block] = b.split(':');
    if (!day || !block) continue;
    const list = byBlock.get(block) ?? [];
    list.push(day);
    byBlock.set(block, list);
  }
  const order = ['AM', 'PM', 'NOC'];
  const windows: Record<string, string> = { AM: '07–15', PM: '15–23', NOC: '23–07' };
  return order
    .filter((b) => byBlock.has(b))
    .map((b) => `${byBlock.get(b)!.join(' ')} ${b} (${windows[b]})`)
    .join(' · ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a plain 'YYYY-MM-DD'. Anything else returns an em dash rather than a mangled
 * date: a wrong-looking date on a compliance screen is worse than a visible blank.
 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '—';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** A timestamp rendered in California, which is where every one of these happened. */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Month names come from MONTHS, not from Intl, so a timestamp and a date read the
  // same down a column ("Sep", never "Sept").
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Los_Angeles',
    day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${Number(get('day'))} ${MONTHS[Number(get('month')) - 1]} ${get('year')} `
    + `${get('hour')}:${get('minute')}`;
}
