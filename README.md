# CCN Registry OS

Internal operations tool for a California nurses' registry. One operator, no public
surface. Built to [`docs/ccn-registry-os-build-spec.md`](docs/ccn-registry-os-build-spec.md) v2.0.

**Read [`INVARIANTS.md`](INVARIANTS.md) before changing anything.** Each rule there maps
to a condition in Civil Code § 1812.5095(b) or Unemployment Insurance Code § 687.2, and
those nine factors are the only mechanism keeping a referred provider from being treated
as the registry's employee. Labor Code § 2777's referral agency exemption does not apply
to in-home care. A violation is a release blocker.

See also [`DEFERRED.md`](DEFERRED.md) for what is deliberately not built, and
[`COUNSEL.md`](COUNSEL.md) for the questions that gate specific code.

## Running it

```bash
npm install
cp .env.example .env            # set OPERATOR_EMAILS to your address
npm run db:reset && npm run db:seed
npm run dev
```

With no `DATABASE_URL`, the app runs on an embedded PGlite database (WASM Postgres 16)
at `.pglite/` — no server to install, and the invariant triggers in migration 0001 are
real triggers. PGlite keeps its database in a single directory and one process owns it at a time, so
stop the dev server before running `db:reset` or `db:seed`, then start it again.

For a real Postgres 16:

```bash
npm run db:up                   # Docker, port 5433
# then set DATABASE_URL in .env and re-run db:reset && db:seed
```

Sign-in is an email magic link restricted to the addresses in `OPERATOR_EMAILS`. In
development the link is printed to the server console rather than emailed; wiring a mail
provider is a deployment step.

## Checks

```bash
npm run ci                      # copy lint, typecheck, tests
```

| Command | What it guards |
|---|---|
| `npm run lint:copy` | I9 forbidden copy, and the I1/I2/I7/I8 forbidden identifiers |
| `npm run typecheck` | TypeScript strict, `noUncheckedIndexedAccess` |
| `npm test` | 96 tests, including the § 7.3 invariant gate against a real Postgres |

The § 7.3 tests run against an in-memory Postgres with the real migration applied, so the
append-only triggers, the physician trigger and the check constraints are exercised rather
than mocked.

## Layout

```
app/(app)/today        ranked work queue — seven buckets (§ 5)
app/(app)/roster       roster and the credential vault
app/(app)/cases        households, cases, append-only timeline
app/(app)/match        hard filters, then the referral behind the disclosure gate
app/(app)/compliance   credential queue, re-verification, disclosure log, CSV export
lib/domain             credentials, match, businessDays, buckets, referral, dates
lib/queries            the query layer — eligibility is computed here, never in the UI
lib/db                 schema.ts, migrations/, seed.ts, client.ts
scripts/copy-lint.mjs  the I9 build gate
```

## Deploying

Vercel plus Supabase or RDS. Encryption at rest and in transit regardless of the HIPAA
outcome (COUNSEL.md question 4).

**Connect as a non-owner role.** Row level security is enabled on every table from the
first migration, but a table owner bypasses RLS, so the application role must not own the
schema:

```sql
CREATE ROLE ccn_app LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA public TO ccn_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ccn_app;
-- No DELETE: the compliance record is append-only by design.
```

Set `DATABASE_URL` to that role with `sslmode=require`.

## Before this tool is worth anything

Four things in § 0.5 of the spec are not code, and the build does not substitute for any
of them: settle who the operator is; audit the current operation against the nine factors
before the coverage surface is built; name who does the initial data entry; and capture a
week of baseline tallies by hand. That last one also decides whether the binding
constraint is operator capacity or demand — and if it is demand, this is the wrong first
build. `DEFERRED.md` has the detail.

*Not legal advice.*
