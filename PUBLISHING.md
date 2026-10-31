# Publishing `@ccn/core`

This is the one step that unblocks everything else: splitting `apps/registry` out,
deleting the duplicated `apps/web`, and the § 4.5 gate in work order 01.

## The constraint that shapes all of this

**GitHub Packages requires the npm scope to match the repository owner.** Your repos
are under `h-hallows`, there is no `ccn` organisation, and `ccn` is already taken as a
GitHub user account — so one cannot be created either. `@ccn/core` cannot be published
to GitHub Packages as named.

The package is therefore **published** as `@h-hallows/core` and **imported** as
`@ccn/core`, through an npm alias in each app:

```jsonc
"dependencies": { "@ccn/core": "npm:@h-hallows/core@0.1.0" }
```

Every `import … from '@ccn/core/domain'` is untouched, the exact pin the specs ask for
is preserved, and the workspace link still resolves. Verified: 263 tests pass through
the alias.

## 1. Make the token

github.com → Settings → Developer settings → Personal access tokens → **Tokens
(classic)**. Fine-grained tokens cannot publish to GitHub Packages; it has to be
classic.

Scopes: **`write:packages`** and **`read:packages`**. `write:packages` implies `repo`,
which GitHub will tick for you. Give it a short expiry — you need it once.

## 2. Publish

```bash
cd /Users/h/Desktop/CCN-Registry
echo "//npm.pkg.github.com/:_authToken=YOUR_TOKEN" >> ~/.npmrc
npm publish --workspace=@h-hallows/core
```

`publishConfig.registry` already points at GitHub Packages, so no `--registry` flag is
needed. The tarball is 32 files: `src/`, `migrations/` and `INVARIANTS.md`. No build
step — it ships TypeScript source, which is why both apps set
`transpilePackages: ['@ccn/core']`.

**Then remove the token line from `~/.npmrc`.** It is a write credential sitting in a
plaintext file read by every npm command you run, including ones in other projects.

## 3. A read-only token for the builds

Make a second classic token with **`read:packages` only**. Set it as
`GITHUB_PACKAGES_TOKEN` on both Vercel projects, across all three environments. The
committed `.npmrc` in each app already reads it:

```
@ccn:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Two tokens rather than one, because the thing that installs on every deploy should not
be able to publish.

## 4. Finish the split

```bash
# CCN-external can now install
cd /tmp && git clone git@github.com:h-hallows/CCN-external.git && cd CCN-external
npm install && npm run ci
```

Once that passes, delete `apps/web` from this workspace so there is one copy again.
`apps/registry` can split the same way — `git subtree split --prefix=apps/registry` —
or stay here; it is the only consumer left and a workspace of one is not a problem.

## 5. The check to add when both apps are split

Architecture spec § 10's fifth acceptance test — *"eligibility() imported in both apps
returns identical results for the same fixture"* — cannot run across repositories. And
the exact pin, which exists to stop a core change reaching one app before the other, is
the same mechanism that lets them drift.

Add a CI check asserting both apps pin the **same** `@ccn/core` version. Without it that
acceptance test can only prove the fixture matches itself.

## Version discipline

`0.1.0` now. Bump the minor for an additive schema change, the major for anything that
alters an existing table or changes what a domain function returns — the apps pin
exactly, so a major is a deliberate two-step rollout rather than a surprise.
