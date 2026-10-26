# Architecture

Built to `docs/ccn-architecture-build-spec.md` v1.0.

## Where things are

```
packages/core        @ccn/core — owns the database and the rules that must not differ
                     between surfaces: Drizzle schema, migrations, the credential
                     engine, business-day arithmetic, the care vocabulary, and the
                     copy-lint ruleset. No app, no routes.

apps/registry        @ccn/registry — the operator console. A consumer of @ccn/core.
                     → Vercel project 1, non-obvious host, noindex

apps/web             not built yet. The marketing site, client portal, provider portal
                     and partner portal. Awaits ccn-front-door-spec.md.
                     → Vercel project 2, apex domain + app subdomain
```

One Postgres. `@ccn/core` owns migrations; **no app ever runs its own**, and CI fails if
one acquires a `migrations/` directory or a `drizzle-kit` dependency.

## Why a package rather than a shared folder

Eligibility, the credential matrix, the care vocabulary and the forbidden copy list have
to be computed the same way on every surface. A second implementation is a second answer,
and one of them will be the wrong one in front of a household — a provider shown as
available whose TB clearance lapsed on Tuesday, or a marketing page calling a referred
provider an employee.

Everything in `packages/core/src/domain` is pure: no database handle, no `process.env`,
no `Date.now()` captured at module scope. Every function that needs the current date
takes it as an argument. That is what makes the test suite deterministic and what lets
both apps compute eligibility identically.

## Where the invariants are tested

Split along one line — the database versus the code that writes through it:

| Suite | Covers |
|---|---|
| `packages/core/tests` | append-only triggers, check constraints, enum membership, the physician trigger, row-level security, the front-door schema, the credential engine, business days, the lint itself |
| `apps/registry/tests` | the referral transaction, the shortlist query layer, the credential vault, the Today buckets |

The schema half lives in `@ccn/core` so it cannot be weakened in one app without the
other noticing.

## Splitting this into three repositories

The spec's target is three repositories with `@ccn/core` published to GitHub Packages.
This workspace is the same layout, so the split is a move rather than a refactor:

1. `git subtree split --prefix=packages/core` into `ccn-core`, publish `0.1.0`.
2. `git subtree split --prefix=apps/registry` into `ccn-registry`.
3. In each app, replace the workspace link with the pinned dependency — the version in
   `package.json` is already an exact pin, not a range, for exactly this reason.
4. Add `.npmrc` and `GITHUB_PACKAGES_TOKEN` to both Vercel projects.

**One thing to add when you split.** Spec § 10's acceptance test — *"eligibility()
imported in both apps returns identical results for the same fixture"* — cannot run
across repositories, and exact pinning is precisely the mechanism that lets the two apps
drift apart. Add a CI check that both apps pin the **same** `@ccn/core` version, or that
test can only ever prove the fixture matches itself.

## Deployment

Two Vercel projects, one repository each after the split. While they share this
workspace, the console's project needs:

| Setting | Value |
|---|---|
| Root Directory | `apps/registry` |
| Install Command | `npm install` run from the repository root (Vercel does this when "Include files outside the root directory" is on) |

**That Root Directory setting is not optional.** The console used to be at the repository
root; it is now at `apps/registry`, and a deployment pointed at the old location will
build nothing.
