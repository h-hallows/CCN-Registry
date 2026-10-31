# Where this stops, and what comes next

**Do not start further `ccn-web` work until § 4.5 of work order 01 passes.**

## The next step is the `ccn-core` extraction — work order 01 § 4

In substance it is already done, as a workspace rather than a separate repository:

| § 4 asks for | Here |
|---|---|
| `ccn-core` owns schema, domain, lint, migrations, INVARIANTS.md | `packages/core` — all of it |
| exports map for `.`, `./schema`, `./domain`, `./lint`, a `ccn-lint` bin | present |
| `drizzle-orm` as a peer dependency, TS source with no build step | present |
| apps pin an exact version, never a caret | `"@h-hallows/core": "0.1.0"` in both |
| `transpilePackages: ['@h-hallows/core']` | both apps |
| no `drizzle-kit` or `migrations/` in any app | enforced by a CI job |
| no local copy of `eligibility()`, `credStatus()`, `addBusinessDays()` | neither app has one |

**What is NOT done, and cannot be here:** publishing `@h-hallows/core` to GitHub Packages as
its own repository. That needs a token with `write:packages`, two new repositories, and a
read-only `GITHUB_PACKAGES_TOKEN` on both Vercel projects. All four are account-level
actions.

Because the single-source-of-truth already exists, the split is a `git subtree split`
plus a publish rather than a refactor. `ARCHITECTURE.md` has the steps.

**One thing to add at the split.** Architecture spec § 10's fifth acceptance test —
"eligibility() imported in both apps returns identical results for the same fixture" —
cannot run across repositories, and exact pinning is the very mechanism that lets the
two apps drift. Add a CI check that both apps pin the *same* `@h-hallows/core` version.

## Built ahead of the stated sequence

Work order 01 § 2 says stop at the end of W2. W3, W4 and W5 were built before it
arrived. The hard stops exist to prevent duplicate implementations and multiple
migration owners, and neither happened — every migration is in `packages/core`, and
`ccn-web` imports `eligibility()` rather than carrying one. The sequencing is out, the
invariant it protects is intact.

Treat W3–W5 as needing review against § 4.5 rather than as settled.

## The public platform has moved out

`apps/web` is gone from here. It lives in **h-hallows/CCN-external**, with its history,
and that repository has its own CI asserting it owns no schema. There is one copy again.

This repository is now the internal tool and the package the other one consumes:
`packages/core` and `apps/registry`.

**The one remaining step is publishing.** `@h-hallows/core` is unpublished, so
CCN-external cannot `npm install` or deploy. `PUBLISHING.md` has it: a classic token
with `write:packages`, one `npm publish`, then a read-only token on both Vercel
projects.

## Still blocked, and by whom

| Blocker | Blocks | Owner |
|---|---|---|
| Trading name — HSC § 1726(b), 22 CCR § 74600(b), Civ. Code § 1812.533(b)(4) | `NEXT_PUBLIC_LEGAL_NAME`, domain, logo, wordmark | Counsel |
| Nurses' registry residence disclosure and provider notice texts | Any nursing referral | Counsel |
| § 1812.531 fee splitting | Partner compensation. The portal itself is fine with none. | Counsel |
| Trust account structure | All payment code | Counsel |
| Nine-factor audit | The console's scheduling and coverage surface only | Counsel + operator |
| A business telephone number or street address | Every public page — § 1812.533(b)(2) | Operator |
| A Postgres for the console | The live deployment, which still reports `not_configured` | Operator |
| Vercel Root Directory → `apps/registry` | Merging `restructure/workspaces` | Operator |
| One week of tallies | Nothing technical — it decides what gets funded next | Operator |
| A `write:packages` token, and a read-only `GITHUB_PACKAGES_TOKEN` on both Vercel projects | Publishing `@h-hallows/core`, which is what ends the duplicated `ccn-web` above | Operator |

No domain has been purchased. No wordmark has been drawn.
