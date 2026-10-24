/**
 * Migration runner. Applies lib/db/migrations/*.sql in filename order, once each.
 *
 *   npm run db:migrate          apply pending migrations
 *   npm run db:reset            drop the public schema first, then apply everything
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbHandle } from './client';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

export async function applyMigrations(
  handle: DbHandle,
  opts: { reset?: boolean; quiet?: boolean } = {},
): Promise<string[]> {
  const log = (m: string) => { if (!opts.quiet) console.log(m); };

  if (opts.reset) {
    await handle.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    log('dropped and recreated schema public');
  }

  // The migrator must satisfy the RLS policies it is about to create.
  await handle.exec(`
    SET app.operator_id = 'migrator';
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set<string>();
  for (const r of await handle.query<{ name: string }>(`SELECT name FROM _migrations`)) {
    applied.add(r.name);
  }

  const ran: string[] = [];
  for (const { name, sql } of migrationFiles()) {
    if (applied.has(name)) continue;
    await handle.exec(`BEGIN;\n${sql}\nINSERT INTO _migrations (name) VALUES ('${name}');\nCOMMIT;`);
    ran.push(name);
    log(`applied ${name}`);
  }
  if (ran.length === 0) log('no pending migrations');
  return ran;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

async function main(): Promise<void> {
  const { getDb } = await import('./client');
  const handle = await getDb();
  console.log(`driver: ${handle.driver}`);
  await applyMigrations(handle, { reset: process.argv.includes('--reset') });
  await handle.close();
}

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
