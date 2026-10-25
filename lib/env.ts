/**
 * Environment guards.
 *
 * The embedded PGlite database is right for local development and wrong everywhere else.
 * On a serverless host the filesystem is read-only outside /tmp, and even where it is
 * writable every invocation gets its own container — so each request would get its own
 * empty database, sessions would never survive, and the symptom would be an unexplained
 * 500 several clicks away from the cause.
 *
 * Falling back silently is the failure mode worth preventing, so a production build with
 * no DATABASE_URL refuses to connect at all and says exactly what to set.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface EnvLike {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
  DIRECT_URL?: string | undefined;
}

export type DatabaseConfig =
  | { driver: 'postgres'; url: string }
  | { driver: 'pglite' };

const SETUP_HINT =
  'Set DATABASE_URL to a real Postgres 16 (include ?sslmode=require), then apply the '
  + 'schema from a machine that can reach it:\n'
  + '  npm run db:deploy';

/**
 * The connection the running application uses. Architecture spec § 7 calls this the
 * pooled URL.
 *
 * Pure, so the rule is testable without a database and without mutating the real process
 * environment.
 */
export function resolveDatabaseConfig(env: EnvLike): DatabaseConfig {
  const url = env.DATABASE_URL?.trim();
  if (url) return { driver: 'postgres', url };

  if (isProduction(env)) {
    throw new ConfigError(
      'DATABASE_URL is not set, and this is a production build.\n\n'
      + 'The embedded PGlite database is for local development only. On a serverless host '
      + 'it cannot persist: the filesystem is read-only, and every invocation gets its own '
      + 'container, so sessions and records would vanish between requests.\n\n'
      + SETUP_HINT,
    );
  }

  return { driver: 'pglite' };
}

/**
 * The connection migrations run over. Architecture spec § 7 keeps this separate as
 * DIRECT_URL, and the distinction is load-bearing rather than cosmetic: a pooled
 * connection in transaction mode (pgbouncer, Supabase's 6543 port, Neon's pooler) cannot
 * run the CREATE TYPE, CREATE FUNCTION and CREATE TRIGGER statements in migration 0001.
 * Point DIRECT_URL at the unpooled host.
 */
export function resolveMigrationConfig(env: EnvLike): DatabaseConfig {
  const direct = env.DIRECT_URL?.trim();
  if (direct) return { driver: 'postgres', url: direct };
  return resolveDatabaseConfig(env);
}

function isProduction(env: EnvLike): boolean {
  return env.NODE_ENV === 'production';
}

/** Host and database only. Never the password, and never logged in full. */
export function describeConnection(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return 'an unparseable connection string';
  }
}
