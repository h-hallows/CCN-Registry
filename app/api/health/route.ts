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
 */
import { getDb } from '@/lib/db/client';
import { migrationFiles } from '@/lib/db/migrate';
import { ConfigError } from '@/lib/env';

export const dynamic = 'force-dynamic';

interface Health {
  ok: boolean;
  database: 'ok' | 'unreachable' | 'not_configured';
  driver?: 'postgres' | 'pglite';
  schema?: 'applied' | 'pending' | 'absent';
  pendingMigrations?: string[];
  detail?: string;
}

export async function GET(): Promise<Response> {
  const expected = migrationFiles().map((m) => m.name);
  let body: Health;

  try {
    const handle = await getDb();
    const rows = await handle.query<{ name: string }>(
      `SELECT name FROM _migrations ORDER BY name`,
    ).catch(() => null);

    if (rows === null) {
      body = {
        ok: false, database: 'ok', driver: handle.driver, schema: 'absent',
        pendingMigrations: expected,
        detail: 'Connected, but no schema has been applied. Run: npm run db:deploy',
      };
    } else {
      const applied = new Set(rows.map((r) => r.name));
      const pending = expected.filter((name) => !applied.has(name));
      body = {
        ok: pending.length === 0,
        database: 'ok',
        driver: handle.driver,
        schema: pending.length === 0 ? 'applied' : 'pending',
        ...(pending.length > 0 ? { pendingMigrations: pending } : {}),
        ...(pending.length > 0 ? { detail: 'Run: npm run db:deploy' } : {}),
      };
    }
  } catch (err) {
    const configProblem = err instanceof ConfigError;
    body = {
      ok: false,
      database: configProblem ? 'not_configured' : 'unreachable',
      // A ConfigError is written for a human and names no secret. Any other error could
      // carry a host or a credential, so it is logged rather than returned.
      detail: configProblem
        ? (err as ConfigError).message
        : 'Could not reach the database. See the server logs.',
    };
    if (!configProblem) console.error('[health] database unreachable', err);
  }

  return Response.json(body, {
    status: body.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
