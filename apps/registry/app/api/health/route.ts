/**
 * Readiness check.
 *
 * The failure this exists for: with no database configured, every screen 500s and the
 * cause is three clicks from the symptom. This answers "is the database there, and does
 * it have the schema" in one request, without a sign-in — because a broken database
 * breaks sign-in, so an authenticated health check could never report the problem it
 * exists to report.
 *
 * It is therefore deliberately thin. Driver, reachability, and which migrations are
 * applied. No connection string, no credentials, no record counts, nothing about any
 * household or provider.
 *
 * Nothing in here may throw. A health route that 500s tells you only that something is
 * wrong, which is what you already knew.
 */
import { getDb } from '@ccn/core/db';
import { ConfigError, describeEnvPresence } from '@ccn/core/env';

export const dynamic = 'force-dynamic';

interface Health {
  ok: boolean;
  database: 'ok' | 'unreachable' | 'not_configured';
  driver?: 'postgres' | 'pglite';
  schema?: 'applied' | 'pending' | 'absent' | 'unknown';
  appliedMigrations?: string[];
  pendingMigrations?: string[];
  detail?: string;
  /** Variable names only, never values. See describeEnvPresence. */
  connectionVariables?: Record<string, boolean>;
}

/**
 * The migration filenames this build expects, or null when they cannot be read.
 * They are loaded through a readdir rather than an import, so a bundler that traces
 * imports will omit them unless next.config.ts says otherwise.
 */
async function expectedMigrations(): Promise<string[] | null> {
  try {
    const { migrationFiles } = await import('@ccn/core/db');
    return migrationFiles().map((m) => m.name);
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  let body: Health;

  try {
    const handle = await getDb();
    const applied = await handle
      .query<{ name: string }>(`SELECT name FROM _migrations ORDER BY name`)
      .then((rows) => rows.map((r) => r.name))
      .catch(() => null);

    if (applied === null) {
      body = {
        ok: false,
        database: 'ok',
        driver: handle.driver,
        schema: 'absent',
        detail: 'Connected, but no schema has been applied. Run: npm run db:deploy',
      };
    } else {
      const expected = await expectedMigrations();
      const pending = expected?.filter((name) => !applied.includes(name)) ?? [];
      const unknown = expected === null;

      body = {
        ok: !unknown && pending.length === 0,
        database: 'ok',
        driver: handle.driver,
        schema: unknown ? 'unknown' : pending.length === 0 ? 'applied' : 'pending',
        appliedMigrations: applied,
        ...(pending.length > 0 ? { pendingMigrations: pending } : {}),
        ...(unknown
          ? { detail: 'Connected, but this build cannot read its own migration list.' }
          : pending.length > 0
            ? { detail: 'Run: npm run db:deploy' }
            : {}),
      };
    }
  } catch (err) {
    const configProblem = err instanceof ConfigError;
    body = {
      ok: false,
      database: configProblem ? 'not_configured' : 'unreachable',
      connectionVariables: describeEnvPresence(process.env),
      // A ConfigError is written for a human and names no secret. Any other error could
      // carry a host or a credential, so it is logged rather than returned.
      detail: configProblem
        ? `${(err as ConfigError).message}\n\nIf you have just added the variable in `
          + 'Vercel, redeploy — environment changes do not reach a deployment that was '
          + 'already built.'
        : 'Could not reach the database. See the server logs.',
    };
    if (!configProblem) console.error('[health] database unreachable', err);
  }

  return Response.json(body, {
    status: body.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
