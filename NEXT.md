# Where this stands

The `@h-hallows/core` extraction is done. Three repositories, one copy of everything:

| Repository | What it is |
|---|---|
| [CCN-core](https://github.com/h-hallows/CCN-core) | the schema, the domain, the invariant suite. Consumed from git at a tag. |
| CCN-Registry (this one) | the internal operator console |
| [CCN-external](https://github.com/h-hallows/CCN-external) | the public platform |

No package registry and no tokens: all three are public, so a tagged git dependency
installs with no credentials anywhere, including on Vercel.

## Where the build is

W0–W11 of the web spec are built, reviewed and pushed. The operator half of the portal
loop — the part the console owns — is built too:

| | |
|---|---|
| Publish a bench | `/match/[caseId]`. Re-runs the identical screen inside the transaction, so a provider who lapsed since the list was drawn is refused by name. One case shows one bench. |
| Answer a request | `/requests`. Oldest first. Either a referral with its spoken disclosure, which links the request in the same transaction, or a recorded decision that is not one. |
| Read the feedback | On the case. § 1812.533(b)(5)(B), with no action offered on it — I7. |
| Give portal access | On the case, the provider and `/partners`. One address, one role, one subject; a grant never un-revokes; one live link at a time. |
| Referral partners | `/partners`. Who sends work here and what came of it. No money on that screen, and none belongs there — § 1812.531. |

Verified end to end against the Docker Postgres with both applications running: publish →
the family's portal shows the bench and the note verbatim → they ask → the request reaches
the console queue → referral and disclosure recorded → their screen reads "Introduced" →
their feedback lands on the case.

## Still blocked, and by whom

| Blocker | Blocks | Owner |
|---|---|---|
| Trading name — HSC § 1726(b), 22 CCR § 74600(b), Civ. Code § 1812.533(b)(4) | `NEXT_PUBLIC_LEGAL_NAME`, domain, logo, wordmark | Counsel |
| Nurses' registry residence disclosure and provider notice texts | Any nursing referral | Counsel |
| § 1812.531 fee splitting | Partner compensation. The portal itself is fine with none. | Counsel |
| Trust account structure | All payment code | Counsel |
| Nine-factor audit | The console's scheduling and coverage surface only | Counsel + operator |
| A business telephone number or street address | Every public page — § 1812.533(b)(2) | Operator |
| A Postgres | Both deployments. The console still reports `not_configured`. | Operator |
| A mail provider — `RESEND_API_KEY` and `MAIL_FROM` | **Signing in to either application.** `MAIL_FROM` needs a verified domain, so this waits on the trading name too. | Operator, after counsel |
| One week of tallies | Nothing technical — it decides what gets funded next | Operator |

No domain purchased. No wordmark drawn.

## Owed to this repository

**Every write button in this console is gated by something no test can drive.** The
native `window.confirm` that used to gate them was replaced with an in-page confirmation
in `components/ActionForm.tsx`, specifically so the write surface would be reachable to
verification — `type="button"` until asked, `data-confirm` / `data-confirm-accept` /
`data-confirm-cancel` hooks, implicit submit blocked on Enter, `role="alertdialog"`. The
gate is well built for testability and **still untested**: `apps/registry/vitest.config.ts`
sets `environment: 'node'` and there is no `jsdom`, `happy-dom` or `@testing-library` in
`node_modules`, so nothing in the suite can click it. The claim made when that shipped —
that the write surface is now reachable to verification — is true of a browser and remains
untrue of the suite, which is the same shape of gap the change set out to close.

Deliberately not done on launch day: it means a new devDependency and a `vitest.config.ts`
change in the repository whose CI had never once run until this morning, for a test-only
gain, while the thing actually blocking V1 is a Postgres. The low-risk shape when it is
done: per-file environment (`// @vitest-environment happy-dom` in the one new test, or
`environmentMatchGlobs`) rather than switching the whole suite off `node`, so the other
456 tests keep the environment they pass under.

## Owed to core

Two migrations, both deliberately not taken here because they belong in the database
rather than in one caller.

**Every append-only table can be emptied by TRUNCATE, and no guard sees it.** Seven
tables carry a `deny_mutation()` trigger: `assignment_log`, `audit_log`,
`credential_events`, `metric_events`, `rate_ranges`, `referrals`, `timeline_entries`.
Every one of them is declared `BEFORE DELETE OR UPDATE ... FOR EACH ROW`. TRUNCATE is
neither a DELETE nor an UPDATE and does not fire a row-level trigger at all, so it
removes every row in the table and nothing raises. Verified against the dev database:
`BEGIN; TRUNCATE audit_log;` reported 928 rows gone, inside a transaction that was then
rolled back.

What makes this worth a migration rather than a note is which tables they are.
`assignment_log` is the § 1812.529 permanent record — the one the statute requires be
kept, and the one `/register` exists to evidence. `audit_log` is the answer to "who
looked at this household" under § 3.8, and `/audit` tells the operator in its own words
that "nothing here is deleted, and nothing can be — the table refuses UPDATE and DELETE
outright". That sentence is exactly true and reads as a stronger guarantee than it is: a
reader takes it to mean the record is permanent, and permanence is the property the
statute is actually asking for.

`deny_mutation()` needs no change — it reads only `TG_OP` and `TG_TABLE_NAME`, both of
which a statement-level trigger has. TRUNCATE triggers cannot be `FOR EACH ROW`, so each
one is a second trigger beside the existing one:

```sql
CREATE TRIGGER trg_audit_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();
-- and the same for assignment_log, credential_events, metric_events,
-- rate_ranges, referrals, timeline_entries.
```

The test that belongs with it is the one that would have caught this: enumerate every
table holding a `deny_mutation()` trigger and assert each has BOTH a row-level guard and
a statement-level TRUNCATE guard, so an eighth append-only table added later cannot ship
with half of one. Asserting the seven by name would pass while leaving the next table
open, which is the same shape of mistake as the trigger itself.

Nothing in either application issues a TRUNCATE, so this is not a live breach — it is a
guarantee the console states in writing and the database does not hold. `db:reset` is the
one legitimate caller, and it drops the schema rather than truncating.

**A household may not lose its ordering physician under a live private duty nursing
case.** `assert_physician_for_skilled` fires on a TRANSITION of `cases` — insert, status
change, care-type change — which is right for the case side: firing on every update would
permanently lock a legacy skilled case that has no physician, so it could never be edited
even to add one. The cost is that an UPDATE of `households` is outside its reach, and
clearing `physician_name` under an already-referred skilled case is a write the database
accepts. It had never happened because until `statutoryFacts.ts` nothing could write that
column at all.

`recordHouseholdFacts` refuses it, with a test that proves the database would still allow
it. That is one caller, and the seed and any hand-run statement are not it. The migration
is a BEFORE UPDATE guard on `households` raising when `physician_name` goes empty while a
case on that household is `referred` or `active` and its care type is in `SKILLED`.

**`ccn_app` cannot delete a session, and revoking portal access needs to.** The role is
created `NOLOGIN` by migration 0003 with no DELETE anywhere, which is right for the
compliance tables and is stated as a deliberate choice. But the console deletes from
`sessions` in exactly two places — signing out (`apps/registry/lib/auth.ts`) and revoking
somebody's portal access (`apps/registry/lib/domain/portalAccess.ts`), where the delete
sits inside the transaction that disables the user and revokes their invite. Verified
against the Docker Postgres: under `SET LOCAL ROLE ccn_app`, `DELETE FROM sessions` is
`permission denied for table sessions`. It does not bite today because the console
connects as the owner and never drops the role — but it is what stops
`DATABASE_URL` from being pointed at a reduced role, which is the only way row level
security would cover the console too. `GRANT DELETE ON TABLE sessions TO ccn_app` and
nothing else: `sessions` holds live sign-ins, not compliance. A privilege the schema
depends on should arrive with the schema, so it belongs beside the grants in 0003 rather
than in a hand-run script. Same file, same reasoning: `ALTER DEFAULT PRIVILEGES IN
SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ccn_app` — 0005 grants
`rate_limit_hits_id_seq` by name, so the next `bigserial` a migration adds is reachable
for INSERT and fails on its sequence, on a path nobody changed.

**Two columns for one fact, with nothing stopping them disagreeing.** `inquiries.partner_id`
and `households.partner_id` both answer "which partner sent this family", and
`partner_referrals()` scopes a partner's sight of a referral on the enquiry's key alone
while the household's is the durable record. The console now writes both in one
transaction, refuses a conflicting attach, and reconciles the two on `/partners` — so
anything it finds came from outside it. What it cannot do is make them unable to
disagree. The shape, with the full SQL written into the doc comment above
`attributionDisagreements` in `apps/registry/lib/queries/partners.ts`: a `DEFERRABLE
INITIALLY DEFERRED` constraint trigger on each table calling one
`assert_one_sender_per_family(uuid)`. Deferred is load-bearing — `convertInquiry` inserts
the household before updating the enquiry, so an immediate trigger would reject the
correct sequence. It cannot go in cold: the backfill that fills a null household key from
its enquiry is safe and grants nobody anything, and the reverse is an access grant that
belongs to an operator, which is what the new screen gives them the list for. Reasoned
from the DDL rather than executed.

**No CHECK on `providers.rate_hourly`.** `recordStatedRate` validates the attestation and
the provider's existence; "above nothing, at most 1000" lives in the zod schema in
`app/(app)/actions.ts`, so a caller reaching the module directly can write a negative
rate. Either a `> 0` floor in the module or a column CHECK in core — the latter is the
one that holds for every caller. Worth weighing against the I5 and § 1812.530-531
reasoning that nothing here sets, suggests or caps a rate: a floor at zero is not a cap.

`restructure/workspaces` was merged to `main` on 2026-11-06; `main` is the workspace
layout and the branch is gone. `vercel.json` at the repository root sets the build
command and output directory, so the deployment does not need a Root Directory set in
the dashboard — if Vercel ever disagrees, setting it to `apps/registry` is the fallback
and nothing else has to change.
