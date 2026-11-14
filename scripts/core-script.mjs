#!/usr/bin/env node
/**
 * Run a script that ships inside @h-hallows/core, wherever npm has put it.
 *
 * The db:migrate / db:reset / db:seed scripts used to spell the path out:
 *
 *   tsx node_modules/@h-hallows/core/src/db/migrate.ts
 *
 * which resolves against the workspace they run in — apps/registry — while npm hoists
 * the dependency to the repo root. So all three failed with ERR_MODULE_NOT_FOUND, which
 * meant there was no working way to migrate or seed a deployment from this repository.
 * Worse than failing loudly: an aborted `db:seed` leaves a real Postgres half-populated,
 * and the test suite then fails inside seededDb() with a foreign-key violation that
 * reads like a broken test rather than a broken database.
 *
 * Node's own resolver knows where the package is, so ask it. This keeps working if npm
 * ever nests the dependency under a workspace instead of hoisting it.
 *
 *   node scripts/core-script.mjs db/migrate.ts [--reset] [--i-mean-it]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , relativePath, ...passThrough] = process.argv;
if (!relativePath) {
  console.error('usage: core-script <path-inside-core-src> [args...]');
  console.error('  e.g. core-script db/migrate.ts --reset');
  process.exit(2);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let coreSrc;
try {
  // './db' is in the package's exports map, so this resolves under exports enforcement
  // where './package.json' would not. It returns the path without loading the module.
  coreSrc = dirname(dirname(require.resolve('@h-hallows/core/db')));
} catch {
  console.error('Cannot find @h-hallows/core. Run `npm install` from the repository root.');
  process.exit(1);
}

const target = join(coreSrc, relativePath);

/*
 * SAY WHICH DATABASE THIS IS ABOUT TO TOUCH.
 *
 * This spawns tsx directly, so none of the app's `.env` files are loaded — Next does
 * that, and this is not Next. With DATABASE_URL unset, core falls back to an embedded
 * PGlite at ./.pglite, and the migration then succeeds loudly against a directory no
 * application uses. `npm run db:migrate` printing "applied 0021" while the console
 * carries on against the Postgres named in apps/registry/.env is the worst kind of
 * success: there is nothing to notice.
 *
 * So name it. The path is printed absolute, because `./.pglite` resolves against this
 * script's cwd and not the caller's, which is the other half of the same confusion.
 */
if (!process.env.DATABASE_URL?.trim()) {
  const dir = resolve(repoRoot, process.env.PGLITE_DIR ?? './.pglite');
  console.warn(
    `DATABASE_URL is not set, so this will use the embedded PGlite at:\n  ${dir}\n`
    + 'App .env files are NOT read here. To act on the database the console actually\n'
    + 'uses, export DATABASE_URL first:\n'
    + '  DATABASE_URL=postgres://ccn:ccn@localhost:5433/ccn_registry npm run db:migrate\n',
  );
}

// --import tsx rather than `npx tsx`: no network lookup, no second package manager
// process, and it fails immediately if tsx is missing instead of offering to install it.
const child = spawn(process.execPath, ['--import', 'tsx', target, ...passThrough], {
  stdio: 'inherit',
  cwd: repoRoot,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
