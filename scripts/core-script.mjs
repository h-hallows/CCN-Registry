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
