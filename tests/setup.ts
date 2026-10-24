/**
 * Tests run against an in-memory PGlite, so the invariant triggers in migration 0001 are
 * exercised for real — an append-only trigger that is only asserted in a mock is not
 * asserted at all.
 */
process.env.DATABASE_URL = '';
process.env.PGLITE_DIR = 'memory://';
process.env.OPERATOR_EMAILS = 'operator@example.com';
