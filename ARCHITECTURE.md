# Architecture

Built to `docs/ccn-architecture-build-spec.md` v1.0.

## Three repositories

```
CCN-core        @h-hallows/core — owns the database. Drizzle schema, migrations, the
                credential engine, business-day arithmetic, the care vocabulary, the
                copy-lint ruleset. No app, no routes.
                Consumed from git, pinned to a tag. No registry, no tokens.

CCN-Registry    this one. The internal operator console.
                → Vercel project 1, non-obvious host, noindex everywhere

CCN-external    the public platform. Marketing site plus the household, provider and
                partner portals.
                → Vercel project 2, apex domain, portals as paths
```

One Postgres. `@h-hallows/core` owns migrations; neither app runs its own, and CI in
both fails on a `migrations/` directory, a `drizzle-kit` dependency, or a second
`eligibility()`.

```jsonc
"dependencies": { "@h-hallows/core": "github:h-hallows/CCN-core#v0.1.3" }
```

**Why a git dependency rather than a registry.** GitHub Packages needs the npm scope to
match the repository owner and authenticates with a personal access token. All three
repositories are public, so a tagged git dependency installs with no credentials at
all — on a laptop, in CI, and on Vercel. The tag is still an exact pin, which is the
property the specs actually ask for.

**On the scope.** The architecture spec says `@ccn/core`. There is no `ccn` organisation
and `ccn` is already a GitHub user, so the scope is `@h-hallows`. Read one for the other
in the spec documents under `docs/`.

**Working on core locally.** It is a dependency now, not a workspace link, so a change
there means commit, tag, bump the consumer. For a tight loop, `npm install
../CCN-core` in the consuming app points at a local checkout; put the tag back before
committing.

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
| CCN-external's `tests/` | that public intake creates no live record, that no path reaches the compliance record, that a household sees only its own shortlist, and that the statutory footer cannot be removed or shipped unapproved |

The schema half lives in `@h-hallows/core` so it cannot be weakened in one app without the
other noticing.

## Deployment

Two Vercel projects, one repository each after the split. While they share this
workspace, the console's project needs:

| Setting | Value |
|---|---|
| Root Directory | `apps/registry` |
| Install Command | `npm install` run from the repository root (Vercel does this when "Include files outside the root directory" is on) |

Two Vercel projects, one per repository:

| Setting | CCN-Registry | CCN-external |
|---|---|---|
| Root Directory | `apps/registry` | `/` |
| Domain | non-obvious host | apex + `app.` subdomain |
| `X-Robots-Tag` | `noindex, nofollow` everywhere | `noindex` on `/portal`, `/pro`, `/partner` only |

**That Root Directory setting is not optional.** The console used to be at the repository
root; it is now at `apps/registry`, and a deployment pointed at the old location will
build nothing.

## What stops the front door shipping

CCN-external's `content/statutory/` holds the § 1812.5095(f) and (d) notices and the footer
statement. **They are empty.** They are legal notices rather than copy, and a
plausible-looking one is worse than a blank: it is the kind nobody checks. They come from
the attorney in COUNSEL.md.

Until each is marked `approved`, `StatutoryFooter` throws during a build where
`VERCEL_ENV=production`, so the public site cannot ship without them. Local builds and
preview deploys render a loud placeholder instead — the gate is meant to stop shipping,
not to stop work.
