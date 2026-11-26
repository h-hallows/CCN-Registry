# Deferred and blocked

## Blocked by the nine-factor audit — spec § 0.5 item 2

**The scheduling and coverage surface is not built.**

The spec is explicit: *"Credentials, timeline, disclosure capture and the compliance
screen are safe to build regardless. The scheduling and coverage surface waits for the
audit."* Coordinating schedules is the exact activity § 1812.5095(b)(5) and § 687.2(e)
constrain, and a database makes a timestamped, per-case written record of it. A notebook
is ambiguous; a database is evidence.

What this means concretely in this repo:

- `coverage_gaps` **exists in migration 0001** so the schema accepts the feature later
  (§ 9: *design the schema to accept them, build none of them*). **Nothing anywhere
  writes to it**, in either application, which is the half of the gate that matters.
- The **Today screen ships seven buckets, not eight.** The "coverage gaps in the next
  7 days" bucket from § 5 is omitted. `lib/domain/buckets.ts` documents the gap at the
  point where it would slot in. Nothing in this console reads the table at all.
- No gap-filling, substitute-suggestion, or roster workflow exists anywhere.

### What this said until 16 November 2026, and why it was wrong

> Nothing reads or writes it. No query, server action, or component touches the table.

That stopped being true when the public platform was built, and nobody noticed for the
same reason nobody notices any of these: **nothing writes the table, so the screen it
feeds renders nothing, and an empty screen looks exactly like an absent one.**
`CCN-external/lib/schedule.ts` reads `coverage_gaps`, and `/portal/schedule` renders what
it finds under "The next thirty days" — tested, in `CCN-external/tests/clientPortal.test.ts`, against
rows the test inserts itself. The same shape as the two statutory registers found empty
this month.

The claim is now split in two, because the halves are not equally serious:

- **The writing half is the gate**, and it holds. Coordinating cover is the activity
  § 1812.5095(b)(5) and § 687.2(e) constrain, and the record of it is what makes it
  evidence. Nothing creates, resolves or assigns a gap, in either repository, and
  `tests/deferral.test.ts` in each now fails if that changes — prose was what failed
  here, so the gate is an assertion now.
- **The reading half is the "record-only coverage view" this section already
  anticipates as the permitted end state.** It arrived early and undocumented, which is
  a governance failure rather than a compliance one, and today it displays nothing to
  anybody.

**One thing for counsel rather than for code.** The portal copy around those rows reads
*"we're arranging cover"* and *"we flag these as soon as we know, rather than when we
have solved them."* That is the registry telling a household it arranges cover, which
sits closer to the line than a bare record of dates does — and it is live copy today,
on a screen that is empty only because nothing populates it. Whether it may say that is
question 9's neighbour and belongs in `COUNSEL.md`, not in a commit message.

To unblock: complete the audit in § 0.5 item 2 with counsel, then implement the bucket
and the writing half of a *record-only* coverage view that follows the design rule at
the bottom of `INVARIANTS.md`.

## Deferred by the spec itself

**Soft match score (§ 4.4).** Not implemented, deliberately. The spec's own direction:
*"Defer the soft score. These weights are invented... Ship M4 as hard filters plus a
sortable eligible list."* `apps/registry/lib/queries/match.ts` implements § 4.3 hard filters and returns
a per-provider exclusion reason. The score is added once § 8 has a few dozen placement
outcomes to fit it to.

What ships instead: an eligible list the operator can sort by the signals that are
*observed* rather than weighted — specialty overlap count, availability coverage
fraction, prior engagement with this household, continuity average. Each column is the
raw number. No composite total is computed or displayed.

## Out of scope when § 9 was written, and built since

§ 9 put the public website, the client portal, the provider portal and the referral
partner portal out of scope for V1. All four exist, in
[CCN-external](https://github.com/h-hallows/CCN-external), along with the operator half
of each loop in this repository. The list below is what is still genuinely absent.

**Payments, invoicing and the trust ledger.** Blocked by counsel question 3: § 687.2(h)
requires that provider payments not come from the agency's business accounts, which is
an account-structure decision and not a code one. The LTC claim packet and invoices are
downstream of it, and the household's documents screen names both rather than quietly
omitting them.

**Reviews or ratings.** Not deferred — refused. I7 and § 687.2(e) allow feedback to
inform future referral decisions and nothing else, and a rating attached to a provider
is the thing that turns a referral service into something that supervises.

**Messaging.** No inbox, no threads. A registry that relays messages between a household
and a provider starts to look like it coordinates the work.

**A mobile app.** Both surfaces are responsive; nothing needs a store listing.

**Automated primary-source verification.** A credential is verified by a person checking
the issuing body, and `verification_source` records which one. Automating it would mean
trusting a scraper with the thing households are relying on.

**Analytics beyond § 8.** The funnel and the capacity measure, nothing else.

## Not a code task — spec § 0.5 items 1, 3, 4

These block the *value* of the build, not the build itself. None of them is something
this repo can do.

1. **Settle who the operator is.** Every screen is designed around one person's working day.
2. **Audit the operation against the nine factors** before the coverage surface is built.
3. **Name who does the initial data entry, and when.** Roughly 15–40 provider records with
   credential documents, plus every active case and household — ten to twenty hours before
   the tool returns anything.
4. **Capture the baseline by hand, one week, before relying on this.** Inquiries received,
   same-day responses, conversions, turn-aways, active cases held, hours placed. Without it
   there is nothing to compare against in month six — and it is what decides whether the
   binding constraint is operator capacity or demand. If it is demand, the referral-partner
   and search front door is the right first build instead, and this tool is the wrong project.
