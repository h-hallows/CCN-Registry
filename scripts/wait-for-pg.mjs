#!/usr/bin/env node
/** Wait for the Docker Postgres from docker-compose.yml to accept connections. */
import { execFileSync } from 'node:child_process';

const DEADLINE = Date.now() + 60_000;
process.stdout.write('waiting for postgres');

for (;;) {
  try {
    execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-U', 'ccn', '-d', 'ccn_registry'], {
      stdio: 'ignore',
    });
    console.log('\npostgres is ready on localhost:5433');
    console.log('set DATABASE_URL=postgres://ccn:ccn@localhost:5433/ccn_registry');
    process.exit(0);
  } catch {
    if (Date.now() > DEADLINE) {
      console.error('\npostgres did not become ready within 60s');
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
