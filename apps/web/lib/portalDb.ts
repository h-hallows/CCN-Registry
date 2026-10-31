/**
 * Every portal read and write goes through here.
 *
 * Two things happen before the callback runs, and both matter:
 *
 *  1. `SET LOCAL ROLE ccn_app` — a superuser bypasses row-level security outright, and
 *     a table's owner bypasses it unless the table is FORCEd. On a managed Postgres the
 *     role you are handed usually owns everything. Dropping to the non-owning
 *     application role is what makes the § 4 matrix actually apply rather than merely
 *     exist.
 *
 *  2. `request.jwt.claims` is set from the session. The policies key off it, so a query
 *     run without it sees nothing — which is the right default for a database holding
 *     health-adjacent information about private individuals.
 *
 * Both are LOCAL, so they end with the transaction and cannot leak into the next
 * request through a pooled connection.
 */
import { getDb, type Tx } from '@ccn/core/db';
import { claimsFor, type PortalSession } from './session';

export async function asPortalUser<T>(
  session: PortalSession,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const handle = await getDb();
  return handle.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE ccn_app`);
    await tx.query(
      `SELECT set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(claimsFor(session))],
    );
    return fn(tx);
  });
}

/**
 * A narrow, server-only read that the signed-in household could not perform itself.
 *
 * WHY THIS EXISTS. Spec § 3.2 requires eligibility to be re-checked at render, and
 * eligibility needs the provider's credentials. Spec § 4 gives a household no access to
 * `credentials` at all — correctly: a household has no business reading a provider's
 * credential record. Those two requirements cannot both be met by one query run as the
 * household, so the check runs here instead and returns only what the household is
 * entitled to: a boolean, and for the profile, which credential types were confirmed
 * and on what date.
 *
 * The alternative would be a SECURITY DEFINER function computing eligibility in SQL,
 * which means a second implementation of the per-type matrix — the exact drift
 * @ccn/core exists to prevent.
 *
 * Use it for nothing else. Every query that returns data the household owns goes
 * through `asPortalUser`, where the policies decide.
 */
export async function forEligibilityCheck<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const handle = await getDb();
  return handle.transaction(async (tx) => {
    await tx.query(
      `SELECT set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ ccn_role: 'operator' })],
    );
    return fn(tx);
  });
}
