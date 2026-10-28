/**
 * The console's suite runs against the same database the library's does — in-memory
 * PGlite by default, or a real Postgres via TEST_DATABASE_URL. See @ccn/core's own
 * tests/setup.ts for the reasoning; this is the same rule, applied in the app.
 */
const externalDatabase = process.env.TEST_DATABASE_URL?.trim();

if (externalDatabase) {
  process.env.DATABASE_URL = externalDatabase;
  delete process.env.PGLITE_DIR;
} else {
  process.env.DATABASE_URL = '';
  process.env.PGLITE_DIR = 'memory://';
}

process.env.OPERATOR_EMAILS = 'operator@example.com';
