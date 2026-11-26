-- ---------------------------------------------------------------------------
-- The application role: what the migrations already did, what is left, and the one
-- decision that is not made yet.
--
-- READ THIS BEFORE RUNNING ANYTHING. Most of what a README would tell you to do here is
-- already done by migration 0003, and doing it again fails. This file holds the two
-- grants the migrations omit, and the queries that tell you whether the deployment is
-- in the state the application expects.
--
-- WHAT MIGRATION 0003 ALREADY DOES, so `npm run db:deploy` has done it:
--   CREATE ROLE ccn_app NOLOGIN       (idempotent; it raises a NOTICE and carries on if
--                                      the migrating role may not create roles)
--   GRANT USAGE ON SCHEMA public TO ccn_app
--   GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ccn_app
--   ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE ON TABLES TO ccn_app
-- and 0005 adds `GRANT USAGE, SELECT ON SEQUENCE rate_limit_hits_id_seq TO ccn_app`.
--
-- NO DELETE, ANYWHERE, AND THAT IS DELIBERATE. 0003 says why: the compliance record is
-- append-only, and withholding the privilege means a mistake cannot even reach the
-- triggers that would refuse it.
--
-- WHY `ccn_app` IS NOLOGIN, WHICH IS THE PART THAT SURPRISES PEOPLE. It is not a role
-- the application connects as. It is a role the application DROPS INTO, per transaction:
-- `CCN-external/lib/portalDb.ts` issues `SET LOCAL ROLE ccn_app` before every portal
-- query, because a superuser bypasses row-level security outright and a table's owner
-- bypasses it unless the table is FORCEd. Dropping the role is what makes the policies
-- in 0003 real for the household, provider and partner surfaces. The console does not
-- drop it, which is correct: the console is the operator, and `is_operator()` is what
-- its policies ask for.
--
-- So the connection string points at the role that OWNS the schema, and privilege
-- reduction happens inside the application rather than at the connection. 0003's own
-- comment calls ccn_app "what the application should connect as in deployment", and that
-- sentence is older than the code: see the note at the bottom.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The two grants the migrations omit. Safe to run more than once.
-- ---------------------------------------------------------------------------
-- 0005 grants the one sequence that exists today by name. A later migration adding a
-- `bigserial` would be reachable for SELECT, INSERT and UPDATE and would then fail on
-- the sequence — on an INSERT path nobody changed. The default privileges close that for
-- every sequence created after this runs.
--
-- RUN THIS AS THE ROLE THAT RUNS MIGRATIONS (on Supabase, `postgres`). ALTER DEFAULT
-- PRIVILEGES applies to objects created by the role that executes it, so running it as
-- anyone else silently covers nothing.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ccn_app;

-- And the sequences that already exist, in case a later migration added one before this
-- file was run.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ccn_app;

-- ---------------------------------------------------------------------------
-- 2. Is this deployment in the state the application expects?
-- ---------------------------------------------------------------------------
-- (a) The role the portal queries drop into must exist. Without it every portal page
--     fails on `SET LOCAL ROLE ccn_app` with "role does not exist" — the first thing a
--     household would see.
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ccn_app') AS ccn_app_exists;

-- (b) It must be able to see the schema. A migration that hit `insufficient_privilege`
--     when creating the role, or a hand-run `DROP OWNED BY ccn_app`, leaves the role in
--     place with nothing granted — which looks identical until a portal page is loaded.
SELECT has_schema_privilege('ccn_app', 'public', 'USAGE') AS can_see_schema,
       (SELECT count(*) FROM information_schema.role_table_grants
         WHERE grantee = 'ccn_app') AS table_grants;

-- (c) Every table must have row level security on. One without it is a table the
--     dropped role reads with no policy deciding.
SELECT count(*) AS tables_without_rls
  FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity;

-- (d) And the privilege that must stay absent.
SELECT has_table_privilege('ccn_app', 'audit_log', 'DELETE') AS can_delete_audit_log,
       has_table_privilege('ccn_app', 'assignment_log', 'DELETE') AS can_delete_assignment_log;

-- Expected: true, true and a three-figure grant count, 0, and false, false.

-- ---------------------------------------------------------------------------
-- 3. The decision that is not made yet
-- ---------------------------------------------------------------------------
-- Pointing DATABASE_URL at ccn_app itself — connecting as the reduced role rather than
-- dropping into it — would make row level security cover the console too. It cannot be
-- done today, and the reason is worth recording rather than rediscovering:
--
--   * ccn_app is NOLOGIN, so it would need `ALTER ROLE ccn_app LOGIN PASSWORD …`.
--   * ccn_app has no DELETE, and the console deletes from `sessions` in exactly two
--     places: signing out (`apps/registry/lib/auth.ts`) and revoking somebody's portal
--     access (`apps/registry/lib/domain/portalAccess.ts`), where the delete sits inside
--     the transaction that disables the user and revokes their invite. Connected as
--     ccn_app, that transaction fails whole — so **revoking a family's access to their
--     own records would stop working**, which is the one operation where failing closed
--     is not the safe direction. Signing out would fail too.
--
-- Granting DELETE on `sessions` and nothing else would resolve it, and `sessions` is not
-- a compliance table — it holds live sign-ins. That grant belongs in a CCN-core
-- migration beside the others, not in this file, because a privilege the schema depends
-- on should arrive with the schema.
--
-- Until then: connect as the owner, and the portal surfaces drop privileges themselves.
