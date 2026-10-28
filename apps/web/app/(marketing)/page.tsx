/**
 * Placeholder. The marketing pages — home, services, areas, how it works, pricing,
 * vetting, for providers, for partners — are specified in ccn-front-door-spec.md, which
 * this build does not have. Their content is not guessed at here: a page that claims
 * something about how the registry works, written without the spec, is a compliance
 * problem rather than a draft.
 */
export default function Home() {
  return (
    <main className="py-16">
      <h1 className="text-2xl font-semibold tracking-tight">CCN</h1>
      <p className="mt-3 text-sm" style={{ color: 'var(--ink-soft)' }}>
        A California nurses&rsquo; registry.
      </p>
    </main>
  );
}
