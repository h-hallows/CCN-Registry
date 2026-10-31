/**
 * Layout primitives. Spec § 6.
 *
 * Four of them, deliberately. A larger set invites a component per page, which is how a
 * site stops looking like one thing.
 */
import type { ReactNode } from 'react';

/** Page gutter and maximum width. Everything sits inside one of these. */
export function Wrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `wrap ${className}` : 'wrap'}>{children}</div>;
}

/**
 * Running text. Constrains children to --measure rather than the container, because a
 * 66-character line is readable and a 120-character one is not, whatever the viewport.
 */
export function Prose({ children }: { children: ReactNode }) {
  return <div className="prose">{children}</div>;
}

/** Vertical rhythm between blocks, so pages do not each invent their own spacing. */
export function Stack({ children, gap = 'md' }: { children: ReactNode; gap?: 'sm' | 'md' | 'lg' }) {
  const rem = { sm: '1rem', md: '2rem', lg: '4rem' }[gap];
  return <div style={{ display: 'flex', flexDirection: 'column', gap: rem }}>{children}</div>;
}

/** A titled section. The heading level is explicit so pages keep a sane outline. */
export function Section({
  title, label, children, as: As = 'h2',
}: {
  title?: string;
  label?: string;
  children: ReactNode;
  as?: 'h2' | 'h3';
}) {
  return (
    <section style={{ paddingBlock: '2.5rem' }}>
      {label ? <p className="label" style={{ margin: '0 0 .35rem' }}>{label}</p> : null}
      {title ? <As>{title}</As> : null}
      {children}
    </section>
  );
}
