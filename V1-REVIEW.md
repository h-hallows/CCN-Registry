# CCN — V1 review

Date: 2026-11-05. Covers all three repositories at `CCN-core cf4b1d3`,
`CCN-Registry 5fea97c`, `CCN-external 3199b38`. Four parallel hostile reviews plus a
first-party pass; every finding below was reproduced before it was acted on.

Not legal advice.

---

## 1. Can this go live?

**The code can. The business cannot yet, for two reasons that are not engineering.**

| Blocker | Who clears it |
|---|---|
| The § 1812.533(b)(4) nurses' registry disclosure and the § 1812.5095(d) provider notice are **drafts**. Spec § 12 closes: they "must be reviewed before any referral is made under them." | Counsel |
| The § 1812.533(b)(4) complaint contacts document is **`unfilled` and empty** — there is no text at all. | A business fact nobody has supplied |
| The trading name (counsel questions 7) blocks every marketing page. | Counsel |

Until the first two clear, **no referral may lawfully be made**, so the operator console
cannot be used for its primary purpose. That is a larger constraint than "the marketing
pages are gated" and it is the headline of this review.

The deployment itself is healthy. Everything is pushed, every suite is green, and the
public site correctly serves a holding page that names nothing.

### To bring the marketing pages up

Three variables in Vercel, then redeploy (`NEXT_PUBLIC_*` is inlined at build time):

- `NEXT_PUBLIC_LEGAL_NAME` — the registry's name **as filed**. This is a fact, not the
  DBA counsel is holding.
- `NEXT_PUBLIC_PHONE` (or `NEXT_PUBLIC_STREET`) — § 1812.533(b)(2) wants the name plus
  one of them.
- `DATABASE_URL` — currently unset, so the portals and live rates are down.

Optional: `NEXT_PUBLIC_OPERATOR_NAME`, which puts a real person's name on the partner
acknowledgement. Unset, it omits the name rather than printing a placeholder.

---

## 2. What the review found, and what was done

Eleven defects were found and fixed in this pass. Each was reproduced first.

### Critical

**A household could read any provider's record in the registry.**
`shortlist_requests_household_insert` checked that the *shortlist* belonged to the
household and never that the provider was **on** it. Migration 0007 then treated the
presence of such a row as proof of a relationship and granted SELECT on the whole
`providers` row — including `providers.notes`, the operator's diligence record.
Reproduced: a household with no sight of a provider gained their name, phone, licence
number and notes in one statement. I12 says an ineligible provider must not reach the
client "and the reason must not reach them either"; the reason is written in `notes`.
It also let a household put an unscreened provider — possibly `do_not_refer`, possibly
on their own blocked list — into the operator's pending queue. **Fixed in core 0013**,
in both halves: the policy requires the provider be on that shortlist, and the helper
proves it through `published_shortlist_items`, which only the operator writes.

**Session takeover via the invite link.** `/invite/[token]` was a bare GET that wrote
the session cookie unconditionally, without checking who was signed in. One top-level
navigation to someone else's invite link silently signed you in as them — and the
household profile autosaves, so the next thing typed (the door code, the 3am routine)
would have been written into the attacker's household under their own claims. RLS
cannot help: the claims are legitimately theirs. **Fixed**: the route refuses when a
different person holds a live session, and leaves the invite unconsumed.

### High

- **I11's physician gate was skipped** by changing `care` without `status` — an active
  companion case could become skilled nursing with no ordering physician. Fixed.
- **The § 1812.533(b)(4) gate read only the newest disclosure**, flag defaulting to
  false. A second referral on the same case silently removed the gate. Fixed; any
  outstanding disclosure now blocks, and it fails closed.
- **`forEligibilityCheck` never dropped the owning role**, so the one documented escape
  hatch bypassed row-level security rather than acting as operator. Fixed.
- **Self-service sign-in was broken entirely.** `/login` wrote an invite naming no
  subject, violating the CHECK — households and providers for some time, every role
  after 0012. Nobody could log in except by operator-issued link. Fixed, with a test
  that runs the statement against the real constraint.

### Medium

- **A draft disclosure was shown as settled text.** `isDeliverable` grades every
  statutory text and only the footer consulted it, so the household's documents screen
  rendered the *empty* complaint-contacts document as a "Read it" panel containing
  nothing — a required disclosure presented as existing and saying nothing. Fixed; both
  document screens check, and say plainly what the position is.
- **Metadata advertised while the page was withheld.** Every title read
  `PENDING_LEGAL_NAME`, each page served its real marketing description under a body
  saying the site is not published, and the home page emitted `LocalBusiness`
  structured data naming the sentinel. Fixed and verified live.
- **Two timezone bugs**, both observable daily: the fee schedule decided "in force"
  from a UTC date, showing a schedule live up to eight hours early on the screen that
  exists to make the § 1812.527 embargo auditable; and the schedule window used
  `current_date`, silently dropping *tonight's* coverage gaps from late afternoon
  Pacific — including the overnight block. Both use California's date now.
- **Both column guards were deny-lists with gaps.** A household could set its own rate
  band, rewrite its ADL needs or soft-delete its own case; a provider could declare any
  specialty, which is shown to households beside verified credentials. Both inverted to
  allow-lists, so a column added later is refused by default.
- **Revocation did not stick** — accepting an invite cleared `disabled_at`. **Nobody
  could sign out**; `endSession` was written at the start and called from nowhere. Both
  fixed.
- Feedback could be double-submitted; a case with two disclosures rendered every
  document twice with duplicate keys; the household's credential view was a deny-list
  of one. All fixed.

### Performance

`getPortalSession` ran two to three times per authenticated request (a five-table join)
and is now deduplicated per request, as is the health probe. `/pro` read the provider
row twice. Seven indexes added for access patterns the portals actually use. `/refer`
was dynamic with nothing request-dependent.

---

## 3. Known gaps, deliberately not closed

These are judgement calls for the business, not oversights.

1. ~~**No document storage.**~~ **Closed.** Core migrations 0015–0017. The bytes live in
   Postgres behind the same row-level security as everything else, the database checks
   the recorded SHA-256 against them, and a document is append-only apart from
   redaction — which drops the file and keeps the row, the digest and the reason,
   because append-only cannot un-leak a document filed against the wrong family.
   Retention is deliberately unbounded while COUNSEL question 4 is open. Invoices and
   the LTC claim packet remain absent and the screen still says so: both are downstream
   of payments, which counsel question 3 blocks.
2. ~~**No mail provider.** Notifications write a row and log a line; sign-in links print
   to the server log.~~ **Closed.** `@h-hallows/core/mail` refuses to print in
   production however it is asked, so an unconfigured deployment says signing in is
   unavailable rather than leaking a bearer credential into a log drain. Needs
   `RESEND_API_KEY` and `MAIL_FROM` set, and `MAIL_FROM` needs a verified domain — which
   needs the trading name.
3. ~~**No file upload.** Credential submissions take a URL, not a file.~~ **Closed.** A
   provider hands in the document itself and the registry holds it. 0017 constrains
   which document a submission may point at — the column 0015 added was unconstrained
   by the 0008 policy, which is the write-to-read pattern arriving through a column
   added later.
4. ~~**The console is thinner than the platform** — 37 tests to 221. It also has no
   screen to publish a bench to a household or to see a household's request, so the
   portal request loop has no operator half; and `referrals.outcome` is displayed but
   written by nothing, so an engagement can never be recorded as started.~~ **Closed.**
   `recordReferralOutcome` writes the outcome and starts the engagement clock; the bench,
   the request queue and the feedback view give the loop its operator half; and portal
   access is issued from the console, which nothing did before — so every portal built in
   W6–W11 was unreachable to everyone. 91 tests.
5. ~~**The console's authorization check is one predicate short.** `getOperator()`
   verifies a session row exists but checks neither `users.role` nor `disabled_at`,
   while `users` and `sessions` are shared across all four audiences and both
   applications. Not exploitable today — the console's only session issuer gates on
   `OPERATOR_EMAILS` and the portal uses a different cookie and token table — but it
   is one shared host or one future entry point away from mattering.~~ **Closed** —
   `getOperator()` and `consumeMagicLink` both check `role` and `disabled_at`.
6. **The statutory texts live only in CCN-external**, yet the console is what delivers
   them. ~~The referral transaction never consults them, and
   `disclosures.statutory_version` is a column default rather than the version actually
   used — so the compliance record cannot prove which wording was delivered.~~ **Half
   closed, and the better half.** Core 0018 lets a disclosure point at the copy of the
   statement that was actually sent, which the operator attaches when recording the
   delivery — a document with a digest the database checked against its own bytes,
   rather than a version number that is hand-bumped and drifts from the text it names.
   Attaching it is optional: some statements go out by post and nobody scans the copy,
   and requiring one would make the choice an unrecorded delivery or a fabricated
   document. The screen says plainly which of the two a record is.

   Still open: the texts themselves are in the wrong repository, and moving them into
   `@h-hallows/core` would let the referral transaction stamp the version it used as
   well. That move has to carry the I9 copy-lint's `content/statutory/` exception with
   it, which is the part worth doing carefully rather than in passing.
7. **"Private duty nursing"** is the industry search term and the I2 copy lint bans
   "duty". Rephrased rather than weakening a statutory gate; worth a counsel
   conversation before anyone changes the ruleset for SEO.
8. **The crossed pages' local claims need a local reader.** They stick to facts that
   are structurally true, and no specific regulation, statistic or timing was invented.
   Each carries `reviewedOn`. Someone who knows the Westside should read them before
   they go live — under § 1812.533(b)(1) a wrong local detail on a public page is a
   misleading-advertising problem.

---

## 4. The structural lesson

Migration 0008 closed one instance of a pattern: a role could write a row, and other
code read the presence of that row as proof. The reviews found the same pattern live in
four more places — a household-written `shortlist_requests.provider_id` proving a
relationship, a partner-written `inquiries.partner_id` proving ownership, a delivery row
proving delivery of mutable content, and a `published` flag proving live consent.

Two things let the original survive review, and both recurred:

1. **A test asserted the bug.** `rls.test.ts` had *"provider role: INSERT INTO
   credentials for themselves succeeds"* inside a describe block named *"a provider
   uploads, the operator verifies"*. A green suite said the rule held. The test guarding
   the critical finding above was a tautology for the same reason — it computed its
   expected set with the same predicate as the policy.
2. **A `NOT NULL` looked like a control.** It made the naive statement fail, which is
   not the same as refusing the action.

The practical consequence: **negative assertions must be proved to fail.** Several tests
in this pass now construct the bug and check the gate catches it.

---

## 5. Numbers

| | |
|---|---|
| CCN-core | 18 migrations, 279 tests |
| CCN-external | 240 tests, 36 routes |
| CCN-Registry | 115 tests, 19 routes |
| CI | every suite now runs twice — in-memory PGlite and a real Postgres 16 |

CI previously ran only against PGlite, a WASM build that has already differed in ways
that mattered: a nested transaction that works pooled deadlocks single-connection, and a
TRUNCATE lock-ordering bug appeared only there. The layer carrying the legal position
was never exercised on the engine it ships on. It is now.

---

## 6. Outstanding, in order

1. Counsel: approve the two draft texts and supply the complaint contacts. **Blocks all
   referrals.**
2. Counsel: the trading name. Blocks all marketing.
3. Set the three Vercel variables and redeploy.
4. ~~Add `role` and `disabled_at` to the console's `getOperator()`.~~ Done.
5. ~~Point Vercel's Root Directory at `apps/registry`, then merge
   `restructure/workspaces` to `main`.~~ Merged. `vercel.json` at the repository root
   carries the build command and output directory instead, so the dashboard setting is
   a fallback rather than a prerequisite.
6. ~~Wire a mail provider.~~ Done, in code. Set `RESEND_API_KEY` and `MAIL_FROM` — and
   note that until they are set, **nobody can sign in to either application**, which is
   deliberate: the alternative was a sign-in link in the function logs.
7. ~~Decide on document storage.~~ Decided and built — see § 3.1.
8. Have someone local read the crossed pages before they go live (§ 3.8).
