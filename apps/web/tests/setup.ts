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

/**
 * A stand-in legal name, so the statutory texts compose into something assertable.
 * The real one is blocked on counsel; what the tests check is that the texts match the
 * statute once a name exists, and separately that no file hardcodes one.
 */
process.env.NEXT_PUBLIC_LEGAL_NAME = 'Test Registry LLC';
process.env.NEXT_PUBLIC_PHONE = '(310) 555-0000';
