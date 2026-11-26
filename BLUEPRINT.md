# Blueprint — 15 November 2026

A fresh audit from current standing, taken by measurement rather than memory: every test
suite run, every build run, every table checked against the code that reads and writes
it, foreign keys checked against the live database's own catalogue, both deployments
pinged. `NEXT.md` says where the build got to and who the blockers belong to; this says
what is actually true in the code today, what is missing, what will not scale, and what
is not tested.

---

## 1. The numbers

| | CCN-core | CCN-Registry | CCN-external |
|---|---|---|---|
| Head | `47c5ca8` (`v0.1.27`) | `1605aaf` | `60c3e98` |
| Commits | 39 | 50 | 38 |
| Pushed | yes | yes | yes |
| Tests | **336 passed, 1 skipped** | **239 passed, 1 FAILING** | **258 passed** |
| Build | typecheck clean | ✓ 3.0s, 24 routes | ✓ 1.6s, 39 routes |
| `ccn-lint` | — | clean (I1, I2, I7, I8, I9) | clean |
| Source | 7,750 lines | 15,601 lines | 9,994 lines |
| Tests | 4,341 lines | 5,097 lines | 3,998 lines |

833 passing tests over 33,345 lines of source, with 13,436 lines of test. 23 migrations,
38 tables, 12 invariants. First-load JS is 103–109 kB on every route in both apps.

Uncommitted: `CCN-core/src/domain/advertising.ts` and its line in `CCN-core/src/domain/index.ts` —
the § 1812.533(c) work parked mid-flight. It typechecks and nothing calls it.

**Live:** `ccn-external.vercel.app` 200, `ccn-registry.vercel.app/login` 200. Both
`/api/health` endpoints return **503** — there is still no Postgres attached to either
deployment, so neither site can do anything but render.

---

## 2. One thing is broken right now

`CCN-Registry/apps/registry/tests/measure.test.ts` → *"capacity > uses one definition of
held for now and for every past month"*: **expected 7 to be 6.**

It passed when it was written and it passes on most days. It fails today because of what
day it is. `capacity()` holds two queries:

- the month series counts a case as held in a month if `ended_on IS NULL OR ended_on >= month_start`
- `heldNow` counts `ended_on IS NULL`

For every complete month those agree. For the *current* month they differ by exactly the
cases that ended earlier this month — and the seed's relative dates have now put one
there. So the screen prints a figure above a chart whose last bar is a different number,
which is the precise defect the test was written to prevent. The earlier fix defined
"held" once in prose and then wrote it twice in SQL.

Both definitions are meaningful; that is the problem. "Concurrent during the month" is
the right measure for *can she hold twelve where she held six*, and "held right now" is
the right measure for the number above it. They should not be compared, and the current
month's bar should not sit in a row of complete months as though it were one.

**Recommended fix:** mark the trailing month as partial and compare `heldNow` against a
*now* definition rather than the month series — then the test asserts something that is
true on every date, which this one never did.

> **Fixed, same day.** `capacity()` now returns `endedThisMonth` — the whole of the
> difference, counted from the rows rather than subtracted — and flags the unfinished
> month as `partial`. The screen states the reconciliation instead of printing two
> numbers that look like they should agree; the peak tile reads *most held in a finished
> month* and excludes the one still running. The test asserts the identity, which holds
> on every date, with a fixture that moves an ending across the month boundary and back
> so the boundary itself is exercised rather than left to the seed's accident.
>
> It also turned up a **third instance of the UTC-date bug** V1-REVIEW § 2 records twice:
> the month series and the leakage window both took their boundary from `current_date`,
> which is the server's, so from late afternoon Pacific on the last day of a month the
> series grew a row for a month that had not started in California. Both now use
> California's date, and a source-level assertion fails if `current_date` reappears in
> that module. Six sabotages verified; registry suite 243 passing.

---

## 3. What is missing

### 3.1 Statutory obligations with no implementation

| Obligation | State |
|---|---|
| **§ 1812.533(c)** advertising record | **Built — core 0025, `/advertising`.** Was: `advertising_log` created in migration 0004, **never written to by anything**. Same shape of problem as the assignment log before last session: a present, empty table reads as compliance. Worse than empty, in fact — it holds a single `published_on` date, and the only publication this registry has is a website, which does not appear on a date; it runs until something replaces it. The table as built cannot answer the question the section exists to ask ("what was advertised on 3 March, and where"). Work started and parked. |
| **§ 1812.527** fee schedule | Built and screened. Nothing outstanding. |
| **§ 1812.528** licence inspection | Built, gated, and tested in two suites. |
| **§ 1812.529** assignment log | Built last session. `/register`, enforced at COMMIT. |
| **§ 1812.530** no charge to a nurse | Enforced by a migration assertion that fails if a provider-side charge column exists. |
| **§ 1812.531** fee splitting | No compensation mechanic and no column that could hold one. Correct posture; counsel question 10. |
| **§ 1812.533(b)(2)** name + contact in every advertisement | Enforced in the footer by construction. Not enforced in a record, because there is no record. |
| **§ 1812.533(b)(4)** residence disclosure | Gate built. **Text is a draft counsel has not approved, and complaint contacts are empty.** No nursing referral is lawful until this clears. |
| **Retention** | Unbounded everywhere. Counsel questions 4 and 15. One year is the Chapter 7 floor; nothing expires and nothing is scheduled to. |

### 3.2 Tables nothing reads, or nothing writes

Measured across all three repositories' `app/`, `lib/`, `components/`, `content/` and
`src/`, excluding tests:

- **`testimonials`** — touched by nothing at all. Not the seed, not either app. Blocked on
  the consent it requires, and migration 0014 already guards the withdrawn-consent case.
- ~~**`rate_ranges`**~~ — **built: core 0026 and `/rates`.** The public site's price bands
  came from a table no operator screen could write, which under § 1812.533(b)(1) is a
  legal edge rather than a content one. The table is now append-only and records who
  posted each band and when; the console shows what the roster actually charges at that
  credential level beside the field, and says what it notices about the band being
  posted without refusing it.

  The screen earned its place on the first load: **14 of 14 live bands were authored by
  the seed**, and the roster's certified nursing assistants charge $34–36 against a
  published overnight-newborn band of $48–65. That is the drift the section is about,
  and it was invisible from inside the console because the console never showed it.

  Nothing derives a band from the roster, and a test fails if the band fields ever gain
  a `defaultValue` — I5, and a console that proposed a price would be the registry
  setting one with extra steps.
- **`operator_notifications`** — written by `CCN-external/lib/notify.ts`, read by nothing.
  Superseded by `/intake`, `/requests`, `/submissions`, `/applications`, which are better
  than one undifferentiated inbox. Needs a decision, not a screen: either read it or drop
  the writes.
- **`coverage_gaps`** — see below. This one is a governance finding.

### 3.3 `DEFERRED.md` states something that is no longer true

> `coverage_gaps` **exists in migration 0001** so the schema accepts the feature later…
> Nothing reads or writes it. No query, server action, or component touches the table.

`CCN-external/lib/schedule.ts` reads it, and `/portal/schedule` renders it to households.
The read was written with care — a `LEFT JOIN` so an unclaimed gap still appears, and
California's date rather than the server's — but the deferral was a gate on the whole
scheduling and coverage surface, documented as held, and the external repository was
built afterwards and crossed it.

The practical exposure today is nil: nothing writes the table, so the screen always
renders empty. That is exactly why it went unnoticed. Two honest resolutions, and the
choice is a judgment about the nine-factor audit rather than a code preference:

1. Remove the read until the audit clears, and let `DEFERRED.md` stay true, or
2. Keep it as the "record-only coverage view" `DEFERRED.md` itself anticipates, and amend
   the document to say that the read-side exists and nothing populates it.

Either way the document and the code should agree, because the document is the thing
anyone reviewing the deferral would read first.

> **Resolved, 16 November 2026 — option 2, plus the gate moved out of prose.**
> `DEFERRED.md` now states what is true and keeps the history of what it used to say.
> The claim is split: the **writing** half is the gate, and it holds — nothing in either
> repository creates, resolves or assigns a coverage gap — while the **reading** half is
> the "record-only coverage view" the deferral already anticipated as the permitted end
> state, which arrived early and undocumented.
>
> Prose is what failed here, so the gate is now `tests/deferral.test.ts` in each
> repository: no writers anywhere, exactly one named reader in the public platform, none
> at all in the console, seven Today buckets rather than eight, and the document itself
> checked against the code it describes. Six sabotages verified.
>
> One thing went to `COUNSEL.md` as question 16 rather than being decided here: the
> portal copy reads *"we're arranging cover"*, which is the registry telling a household
> it coordinates cover. That is a wording question with a § 1812.5095(b)(5) edge, and it
> is live copy on a screen that is empty only because nothing populates it.

### 3.4 Features absent by decision, not oversight

Unchanged and still correct: payments and the trust ledger (counsel question 3), ratings
and reviews (refused under I7, not deferred), messaging, a mobile app, automated
primary-source verification, analytics beyond § 8, the soft match score, and the
scheduling/coverage surface.

---

## 4. What needs optimization

Nothing is slow. The dev database holds 358 audit rows, 80 credentials, 18 providers and
12 cases, so none of this is observable yet — which is the point of writing it down now
rather than finding it at 500 providers.

### 4.1 Twenty-three foreign keys have no supporting index

Taken from the live database's catalogue, not from the migrations. The ones on paths that
run on **every request** are the ones that matter:

| Column | Why it is hot |
|---|---|
| `sessions.user_id` | every authenticated request |
| `household_users.household_id` | **RLS predicates**, which evaluate per row |
| `partner_users.partner_id`, `portal_invites.*` | portal authorisation |
| `inquiries.household_id` | `ASSIGNMENT_LOG_INSERT` derives the order hour with `max(received_at)` over this |
| `referrals.disclosure_id` | the I3 join, on every referral read |
| `credentials.document_id`, `credential_submissions.*`, `disclosures.written_statement_document_id` | the document and vault screens |

The rest — `assignment_log.corrects_id`, `metric_events.provider_id`,
`fee_schedule_deliveries.schedule_id`, `testimonials.*`, `households.partner_id`,
`provider_applications.provider_id`, `shortlist_requests.referral_id`,
`shortlist_requests.requested_by`, `disclosures.timeline_id`, `auth_tokens.user_id` —
are cheap to add in the same migration and there is no reason to triage them separately.

One migration, no behaviour change, no risk.

> **Done — core migration 0024.** All 23, plus a structural test that asks the catalogue
> rather than the migrations and fails if a future foreign key arrives without a leading
> index. The live dev database now reports zero. Closes §5.4 as well.

### 4.2 Eight query modules have no `LIMIT` in them

`bench.ts`, `cases.ts`, `compliance.ts`, `consent.ts`, `match.ts`, `providers.ts`,
`register.ts`, `today.ts`. Each returns its whole result set. `/register` is the sharpest
case because the assignment log is append-only and permanent by statute: it will return
every log sheet ever written, forever, on every page load. `/cases` and `/roster` grow
with the business; `/compliance` grows with credentials.

The filter UI on `/register` already exists, so this is a page size and a cursor rather
than a redesign.

> **`/register` done; the rest left alone on purpose.** It is bounded at 150
> **assignments** — not rows, because a correction belongs under the sheet it corrects
> and a row limit would eventually cut a chain in half and render a correction with
> nothing above it to correct, on the one screen where the superseded original is the
> part an inspector reads. The header says "150 of N" when there is more, and older
> assignments are reached by the household, nurse and case filters already on the screen.
>
> The other seven were not given the same treatment, and that is a decision rather than
> a stopping point. `/register` grows with every referral **forever**, because
> § 1812.529 makes the log permanent; `/cases`, `/roster`, `/compliance` and the rest
> grow with the size of the business and are bounded by it. A caseload of four hundred
> is a working list an operator wants whole. Revisit when one of them is actually slow,
> with a number rather than a worry.

### 4.3 The audit integrity summary runs one query per entity

`lib/queries/audit.ts:348` issues a separate `count(*) … NOT EXISTS` for each of ~27
audit entities, deliberately — *"dozens of small counts rather than one clever query,
because a clever query here that is subtly wrong reports a clean log."* That reasoning is
right and the shape should stay. But each of those counts is an anti-join over the whole
of `audit_log`, with no index that helps, and `audit_log` grows by one row per page view
because every screen audits its own read. It is 358 rows today. At 100,000 it is 27
sequential scans on one page load.

Cheapest fix that keeps the shape: bound each count to a window, or materialise the
summary and recompute it on demand rather than on render.

> **Wrong, and corrected by measuring it.** I wrote that from reading the code. `EXPLAIN
> ANALYZE` against the dev database says otherwise: each count is a **Bitmap Index Scan
> on `audit_log_entity_idx`** for that entity, then a hash anti-join against the target
> table. There is no sequential scan of `audit_log` in it, and the index that supports it
> has existed since migration 0001.
>
> What *does* scale linearly with the log, on every `/audit` load, is the pair of
> unfiltered aggregates above the loop — `count(*)` with its filters, and the `GROUP BY
> entity`. Two full scans of an append-only table that grows by a row per page view.
> They are correct and the summary is meant to be over the whole log, so bounding them
> would make the screen lie about its own completeness. The lever is retention, which is
> already open as counsel question 15 — not a query rewrite.
>
> No change made. The lesson is the one in §2: a claim about performance made from
> reading source is a guess, and this one was wrong in both directions at once.

### 4.4 Twenty pages are `force-dynamic` and each one writes on read

Correct for a compliance console — § 3.8 wants to know who looked, and a cached page is a
read nobody recorded. Worth stating explicitly, because it means page-view volume is
write volume, and it is the mechanism behind 4.3. It also means retention policy
(counsel question 15) is a performance decision as well as a legal one.

### 4.5 Four files are large enough to be hard to review

`app/(app)/actions.ts` at **1,281 lines**, `cases/[caseId]/page.tsx` at 947,
`lib/domain/referral.ts` at 627, `lib/queries/bench.ts` at 535. `referral.ts` has earned
its length — it is the I3 transaction and it is heavily commented. `actions.ts` is a
single file holding every server action in the console, and it is the one worth splitting
by surface, because it is where a mistake is least visible.

---

## 5. What needs testing

The suites are strong where it counts: every statutory gate has a sabotage-verified
negative test, and the structural tests catch dead exports, deny-list regressions and
vocabulary drift. The gaps that remain:

1. **The failing capacity test asserts something that is not always true.** Fix it so it
   holds on every calendar date. The current version was a time bomb and it just went off.
2. ~~**No test fixes the date.**~~ Done, where it can be. `CCN-core/src/domain/dates.ts` is the
   module every expiry, every business-day count and every "is this in force yet"
   resolves through, and it had **no test file of its own** — it was checked through two
   callers, on whatever day the suite happened to run. `CCN-core/tests/dateBoundaries.test.ts`
   now drives it at the awkward instants: an evening in California that is already
   tomorrow in UTC, both DST transitions, a year boundary, a leap day, and a `date`
   column arriving as a `Date`. `buckets.test.ts` drives the Today screen's only date
   decision at 17:30 on New Year's Eve — decided in UTC, every engagement ending that
   day drops off the screen at half past five on the day it ends. Six sabotages.

   What cannot be frozen is SQL. `now() AT TIME ZONE 'America/Los_Angeles'` reads the
   database's clock, not the process's, so faking the system time moves the seed and not
   the queries. The protection there is the source-level assertion added with the
   capacity fix: `current_date` may not appear in `measure.ts`. The same guard is worth
   extending to the other modules that decide a date in SQL.
3. ~~**`CCN-external`: `CCN-external/lib/intakeResponse.ts` has six exports and no test naming it.**~~
   Done — 14 tests, 7 sabotages. The guard that earns its keep is structural: no public
   intake route may build a `Response` of its own, because each has a `catch` one line
   away from returning a database error message, and those carry the constraint name,
   the table, and sometimes the value that collided. `CCN-external/lib/proState.ts` and
   `CCN-external/lib/profileLimits.ts` are still unmentioned, and both are constants and shapes.

   One thing the tests recorded rather than changed: a tripped honeypot and a real
   acceptance share a status and `ok: true`, but only the real one carries `reference`,
   so the bodies are distinguishable by anyone comparing two responses. Closing it means
   emitting a reference that corresponds to no record, and a fabricated reference is a
   worse thing for this system to hold than a mild signal is.
4. ~~**No test asserts the index coverage from §4.1**~~ — `CCN-core/tests/indexes.test.ts`
   now does, against the catalogue, with an empty excuse map.
5. **No test asserts that `DEFERRED.md` is true.** The claim in §3.3 was prose, so nothing
   checked it. The banned-table test already proves tables stay untouched; pointing it at
   the deferral list would have caught this the day it was written.
6. ~~**Nothing exercises either app against a cold, empty database.**~~
   `CCN-Registry/apps/registry/tests/emptyDatabase.test.ts` drives every list and summary
   the console renders against a database that has been migrated and nothing else —
   which is exactly the state of the Vercel deployment the moment a Postgres is attached
   to it.

   **Nothing broke**, which was not the expected result. The hazards are real ones — an
   aggregate over no rows returns a row holding null, `LIMIT 1` returns none, a
   percentage divides by zero, `Math.max(...[])` is `-Infinity` — and every one of them
   was already handled. The test earns its place as the guard for day one rather than as
   a bug report. The page components were read for the same patterns by hand; the three
   that looked risky are each guarded.

---

## 6. Not a code problem

Unchanged from `NEXT.md`, restated because it is still what gates the build's value:

| Blocker | Blocks | Owner |
|---|---|---|
| **A Postgres on either deployment** | all live inspection; both health endpoints are 503 today | Operator |
| **Trading name** — HSC § 1726(b), 22 CCR § 74600(b), Civ. Code § 1812.533(b)(4) | every marketing page, the domain, all brand spend | Counsel |
| **Residence disclosure + provider notice texts**, and the empty complaint contacts | any nursing referral | Counsel |
| A business telephone number or street address | every public page — § 1812.533(b)(2) | Operator |
| Mail provider (`RESEND_API_KEY`, `MAIL_FROM`) | **signing in to either app**; needs a verified domain, so it waits on the name | Operator |
| § 1812.531 fee splitting | monetising the partner programme | Counsel |
| Trust account structure | all payment code | Counsel |
| Nine-factor audit | the coverage surface, and §3.3 above | Counsel + operator |
| One week of tallies by hand | nothing technical; it decides what is worth funding | Operator |

---

## 7. The order I would take it in

1. ~~**Fix the failing test**~~ — done; see the note in §2, which also closed a third
   instance of the UTC-date bug.
2. ~~**The index migration**~~ — done; core 0024.
3. ~~**Resolve `coverage_gaps`**~~ — done; the document is true and the gate is a test.
   Question 16 is with counsel.
4. ~~**Finish the advertising record**~~ — done; core 0025 and `/advertising`.
5. ~~**Pagination on `/register`**~~ — done, by assignment. `/cases` and the rest
   deliberately left; see the note in §4.2.
6. **Split `actions.ts`** — §4.5, mechanical, and it makes everything after it easier.

Items 1–5 are done. What is left on this list is item 6 and the retention policy behind
§4.3 and §4.4, which is counsel's question 15 rather than a code task.

## 8. Added after this list was written

- **The clock rule** (core v0.1.29). `current_date` on a managed Postgres is UTC, and
  nothing sets a connection TimeZone, so a date taken from the server is wrong from four
  in the afternoon Pacific until midnight. It had shipped three times and been caught a
  fourth, every time by reading. `CCN-core/src/testing/sqlClock.ts` refuses the six spellings and
  passes the two correct ones, and each repository sweeps itself — including all 26
  migrations, where a date decided wrongly in a trigger is decided wrongly for every
  caller at once. Five sabotages.
- **`rate_ranges`** — see §3.2.
- **The facts a referral needs** — the gate was built, green, and could never be passed.
  `assertCaseReferable` refuses a private duty nursing referral that cannot produce its
  § 1812.529 log sheet, and three of the five facts it asks for had no writer anywhere in
  the application: `convertInquiry` is the only INSERT into `households` and names eleven
  columns, `cr_address` and `physician_name` not among them, and there was no UPDATE of
  that table at all. So **no referral the console originated could ever be made**, and
  every surface built around that said so and pointed nowhere — `/match` printed "Open
  the case to fill them in" above a screen with nothing to fill in, `/register` said
  "Fill those in on the household and the case first", and `assert_physician_for_skilled`
  refused the status change every time, correctly, permanently.

  `lib/queries/statutoryFacts.ts` and the section on the case screen are the writer. Two
  audited actions, named columns only, no field with a default — a start date or a fee
  the household never agreed to arriving by way of a pre-filled box is the false entry
  § 1812.529 names, made by the screen rather than by anyone.

  It refuses to take away a fact a record already stands on, and only says — naming the
  entries — where a correction has put a filed log sheet out of step with the record,
  because a record that cannot be corrected is a record that has to be wrong forever and
  `ASSIGNMENT_LOG_CORRECTION` exists for exactly that. Ten sabotages; three of them found
  assertions that could not reach their case, including two allow-list checks taking
  their baseline from a row an earlier test had already moved.

  Verified end to end against the Docker Postgres: a hospice support case reading "1 of 5
  missing" → physician recorded → "All five on the record" → the match screen's refusal
  gone → referral and disclosure recorded → the sheet in `/register` with the typed
  physician, and no nursing case left in the blocked list.

Still written and never read: `operator_notifications` (a decision, not a screen) and
`testimonials` (blocked on the consent it requires).

Everything above is work this repository can do alone. Nothing in §6 is.
