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

Vercel plus Supabase, Neon or RDS. Encryption at rest and in transit regardless of the
HIPAA outcome (COUNSEL.md question 4).

### Two connection strings, not one

| Variable | What it is | Used by |
|---|---|---|
| `DATABASE_URL` | the **pooled** connection | the running app |
| `DIRECT_URL` | the **unpooled** connection | migrations and seeding |

The distinction is load-bearing. Migration `0001_init.sql` contains `CREATE TYPE`,
`CREATE FUNCTION` and `CREATE TRIGGER` statements — the append-only guards, the
disclosure immutability guard, the physician check — and a pooler in transaction mode
(Supabase port 6543, Neon's pooler, any pgbouncer) cannot execute them. Point `DIRECT_URL`
at the direct host, usually port 5432.

A production build with **no** `DATABASE_URL` refuses to start. It does not fall back to
the embedded database: on a serverless host the filesystem is read-only and every
invocation gets its own container, so the fallback would appear to work and then lose
every session. There is deliberately no flag to re-enable it.

### Getting a deployment running

Provision the database **through Vercel** — Storage → Marketplace → Supabase. Doing it
there injects the connection strings into the project automatically, and `lib/env.ts`
reads the names Vercel uses (`POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`,
`DATABASE_URL_UNPOOLED`) as well as its own, so there is nothing to copy by hand.
Supabase rather than Neon because architecture spec § 4 puts all four portal roles on
Supabase Auth, and standing Postgres up elsewhere now means moving it later.

Then:

1. Set `OPERATOR_EMAILS` in the Vercel project. Nobody can sign in without it, and the
   sign-in form deliberately gives the same answer either way, so an empty value looks
   like success.
2. Apply the schema from a machine that can reach the database — **there is no migration
   step in the deployment**, by design, so nothing can migrate a live database on a push:

   ```bash
   npm run db:deploy
   ```

   `db:deploy` only applies pending migrations. `db:reset` and `db:seed` both refuse to
   run against a remote Postgres without `--i-mean-it`, because one drops the schema and
   the other truncates every table.
3. Run `scripts/sql/app-role.sql` in the Supabase SQL editor and point the application at
   that role. See below for why.
4. Check `/api/health`. It reports driver, reachability and pending migrations, needs no
   sign-in, and returns nothing about any household or provider.

If step 2 fails on `CREATE TRIGGER`, the migration is going through the transaction
pooler. `resolveMigrationConfig` refuses that case with a message naming the host — set
`DIRECT_URL` to the session pooler or direct connection on **port 5432**, not 6543.

### Connect as a non-owner role

Row level security is enabled on every table from the first migration, but a table owner
bypasses RLS, so the application role must not own the schema:

```sql
CREATE ROLE ccn_app LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA public TO ccn_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ccn_app;
-- No DELETE: the compliance record is append-only by design.
```

### Sign-in

There is no mail provider wired. The magic link is written to the server console, which
on a deployed host means the function logs. Wiring Resend or Postmark is a deployment
step; for a single-operator internal tool, host-level access protection in front of the
whole site is the simpler answer.

## Before this tool is worth anything

Four things in § 0.5 of the spec are not code, and the build does not substitute for any
of them: settle who the operator is; audit the current operation against the nine factors
before the coverage surface is built; name who does the initial data entry; and capture a
week of baseline tallies by hand. That last one also decides whether the binding
constraint is operator capacity or demand — and if it is demand, this is the wrong first
build. `DEFERRED.md` has the detail.

*Not legal advice.*
