# CCN Architecture — Repo, Package and App Build Spec

**Version:** 1.0
**Date:** 25 October 2026
**Audience:** implementation session
**Prerequisite:** the operator console is live at `ccn-registry.vercel.app` (auth-gated, magic link)

Companion documents:
- `ccn-registry-os-build-spec.md` — backend, operator console, invariants, base schema
- `ccn-front-door-spec.md` — client, provider and partner surfaces

This document is the physical architecture: what lives in which repo, what the shared package exports, the schema additions the front door needs, auth across three audiences, and the order of operations to get there from what is already deployed.

---

## 1. Target

```
ccn-core        library. Owns the database: Drizzle schema, migrations,
                generated types, the credential engine, business-day
                arithmetic, and the copy-lint ruleset. No app, no routes.

ccn-registry    operator console. Already live. Becomes a consumer of ccn-core.
                → Vercel project 1, non-obvious host, noindex

ccn-web         marketing site + client portal + provider portal + partner portal.
                New. Consumer of ccn-core.
                → Vercel project 2, apex domain + app subdomain
```

One Postgres. One auth. `ccn-core` owns migrations; neither app ever runs its own.

**What two repos costs you.** Every change to the schema or the credential engine becomes a three-step sequence: publish `ccn-core`, bump it in both apps, deploy. That is real friction and it is the price of smaller Claude Code sessions. It is also a safety rail — a schema change can no longer land in one app and not the other by accident. If the friction becomes the dominant annoyance, collapsing to a monorepo later is a half-day of work; going the other direction is not.

---

## 2. ccn-core

### 2.1 Layout

```
ccn-core/
  package.json
  tsconfig.json
  drizzle.config.ts
  src/
    index.ts                 re-exports the public surface
    schema/
      index.ts
      enums.ts
      providers.ts           providers, credentials, credential_events
      households.ts          households, cases, coverage_gaps
      compliance.ts          timeline_entries, disclosures, referrals, referral_feedback
      portal.ts              NEW — see § 3
      intake.ts              NEW — see § 3
      auth.ts                users, household_users, provider_users, portal_invites
      audit.ts               audit_log
    domain/
      credentials.ts         credStatus, requiredFor, eligibility, REQUIRED
      match.ts               PERMITTED, hardFilters, (score deferred per spec § 4.4)
      businessDays.ts        addBusinessDays, CA_HOLIDAYS
      care.ts                CARE_LABEL, SKILLED, URGENCY
    lint/
      forbidden.ts           the I9 ruleset as data
      run.ts                 CLI: scans a directory, exits non-zero on a hit
    rls/
      policies.sql           role-based row-level security, applied by migration
  migrations/                drizzle-kit output, committed, append-only
  INVARIANTS.md              single copy — both apps link to this file
```

### 2.2 package.json

```json
{
  "name": "@ccn/core",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "exports": {
    ".":            "./src/index.ts",
    "./schema":     "./src/schema/index.ts",
    "./domain":     "./src/domain/index.ts",
    "./lint":       "./src/lint/forbidden.ts",
    "./migrations": "./migrations/index.ts"
  },
  "bin": { "ccn-lint": "./src/lint/run.ts" },
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate":  "tsx scripts/migrate.ts",
    "db:seed":     "tsx scripts/seed.ts",
    "typecheck":   "tsc --noEmit",
    "test":        "vitest run"
  },
  "peerDependencies": { "drizzle-orm": "^0.36.0" },
  "devDependencies": {
    "drizzle-kit": "0.28.1",
    "tsx": "4.19.2",
    "typescript": "5.7.2",
    "vitest": "2.1.8"
  },
  "publishConfig": { "registry": "https://npm.pkg.github.com" }
}
```

**Ships TypeScript source, no build step.** Both apps add `transpilePackages: ['@ccn/core']` to `next.config.ts`. Fewer moving parts than a compiled dist, and `drizzle-kit` can read the schema directly.

### 2.3 Distribution

Publish to GitHub Packages. In each consuming app:

```
# .npmrc  (committed)
@ccn:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

`GITHUB_PACKAGES_TOKEN` is a read-only PAT, set as an environment variable on both Vercel projects for all three environments. Pin the version exactly in each app's `package.json` — `"@ccn/core": "0.3.1"`, never a caret. The pin is the point: it stops a core change reaching one app before the other.

A `github:org/ccn-core#<sha>` git dependency also works and skips publishing, but private git dependencies need credentials in the Vercel build and that is more fragile than the registry token. Use the registry.

### 2.4 Public surface

`src/index.ts` re-exports exactly this, and nothing else:

```ts
// domain
export { credStatus, requiredFor, eligibility, REQUIRED, CRED_LABEL } from './domain/credentials';
export type { CredStatus, EligibilityResult } from './domain/credentials';
export { PERMITTED, hardFilters } from './domain/match';
export { addBusinessDays, CA_HOLIDAYS, isoLA, daysToLA } from './domain/businessDays';
export { CARE_LABEL, SKILLED, URGENCY, URGENCY_LABEL } from './domain/care';
// schema + types
export * as schema from './schema';
export type { Provider, Credential, Household, Case, Referral, Disclosure } from './schema';
// lint
export { FORBIDDEN, FORBIDDEN_EXCEPTIONS } from './lint/forbidden';
```

Everything in `domain/` is pure: no database handle, no `process.env`, no `Date.now()` captured at module scope. Every function that needs the current date takes it as an argument. That is what makes the test suite in the backend spec's § 7 deterministic, and it is what lets both apps compute eligibility identically.

### 2.5 The lint, in one place

```ts
// src/lint/forbidden.ts
export const FORBIDDEN = [
  'independent contractor', 'self-employed', 'self employed',
  'our nurses', 'our caregivers', 'our staff', 'our employees',
  'home health', 'surety bond', 'bonded and insured', 'licensed and bonded',
] as const;

// 'employee' is forbidden EXCEPT inside the statutory disclosure text,
// which is the only place the word may legitimately appear.
export const EMPLOYEE_ALLOWED_IN = ['src/content/statutory/'] as const;
```

`ccn-lint` walks a directory, skips `node_modules`, `.next` and the allow-listed paths, and exits 1 on a hit with file and line. Both apps run it in `pretest` and in CI. One ruleset, two consumers, no drift.

---

## 3. Schema additions

Everything in the backend spec's § 3 stays as-is. The front door needs the following, which does not exist yet.

### 3.1 Published shortlists

The client portal shows a curated bench, not a directory. That bench needs to be a real record, not a timeline note.

```sql
CREATE TYPE shortlist_request_status AS ENUM
  ('pending','referred','declined_by_household','withdrawn');

CREATE TABLE published_shortlists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES cases(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by text NOT NULL,
  note         text,                      -- what the operator told the household
  withdrawn_at timestamptz
);

CREATE TABLE published_shortlist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_id uuid NOT NULL REFERENCES published_shortlists(id),
  provider_id  uuid NOT NULL REFERENCES providers(id),
  position     int NOT NULL,
  UNIQUE (shortlist_id, provider_id)
);

CREATE TABLE shortlist_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_id  uuid NOT NULL REFERENCES published_shortlists(id),
  provider_id   uuid NOT NULL REFERENCES providers(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  requested_by  uuid NOT NULL REFERENCES users(id),
  status        shortlist_request_status NOT NULL DEFAULT 'pending',
  note          text,
  resolved_at   timestamptz,
  referral_id   uuid REFERENCES referrals(id)   -- set only by the console
);
```

**The load-bearing rule:** a `shortlist_requests` row is a request and nothing more. No trigger, job, or route may create a `referrals` row from it. Only the console's disclosure transaction (backend spec § 4.6) does that, and it then writes the `referral_id` back. Enforce with an RLS policy denying `INSERT` on `referrals` to the `household` and `provider` roles, plus a code review note on the table.

### 3.2 Staleness — eligibility is checked at render

A shortlist published Monday can contain a provider whose TB clearance lapses Tuesday. The client portal must not show them as available.

Two mechanisms, both required:

1. **Render-time check.** Every query that returns a published shortlist item joins credentials and runs `eligibility()` from `@ccn/core`. An ineligible provider renders as *"Temporarily unavailable — we're confirming a credential"* and cannot be requested. Never the specific reason: a household has no business seeing a provider's credential problem.
2. **A view that makes it hard to get wrong.**

```sql
CREATE VIEW v_shortlist_items_client AS
SELECT i.*, p.full_name, p.type, p.rate_hourly, p.specialties, p.languages,
       p.photo_url, p.photo_consent_on, p.restrictions,
       (p.status = 'active' AND NOT EXISTS (
          SELECT 1 FROM credentials c
          WHERE c.provider_id = p.id
            AND c.deleted_at IS NULL
            AND c.expires_on IS NOT NULL
            AND c.expires_on < (now() AT TIME ZONE 'America/Los_Angeles')::date
       )) AS appears_available
FROM published_shortlist_items i
JOIN providers p ON p.id = i.provider_id
WHERE p.deleted_at IS NULL;
```

The view is a safety net for the *expired* case. It does not cover a *missing* required credential, because that needs the per-type matrix. So the application still calls `eligibility()` — the view exists so that a query written in a hurry still fails safe rather than fails open.

### 3.3 Public intake — two write paths, neither creates a live record

```sql
CREATE TABLE inquiries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at   timestamptz NOT NULL DEFAULT now(),
  name          text NOT NULL,
  phone         text, email text,
  relationship  text,
  care_type     care_type,
  area          text,
  pattern_note  text,
  start_note    text,
  urgency       urgency,
  payment_method payment_method,
  message       text,
  source_path   text,                    -- which page it came from
  utm           jsonb,
  partner_id    uuid REFERENCES referral_partners(id),
  household_id  uuid REFERENCES households(id),   -- set when the operator converts
  handled_at    timestamptz, handled_by text
);

CREATE TABLE provider_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at   timestamptz NOT NULL DEFAULT now(),
  full_name     text NOT NULL,
  phone text, email text,
  type          provider_type,
  license_number text,
  areas         text[], languages text[], specialties text[],
  experience_note text,
  message       text,
  provider_id   uuid REFERENCES providers(id),     -- set when onboarded
  handled_at    timestamptz, handled_by text
);
```

Public forms write here and nowhere else. No public path creates a `households`, `cases` or `providers` row. The operator converts from the console. This keeps the entire live record set behind one human, which is both the compliance posture and the product.

### 3.4 Portal access — invite only

There is no public client signup, because the bench is curated and the referral requires a call. There is no public provider signup either; applications are reviewed first.

```sql
CREATE TYPE user_role AS ENUM ('operator','household','provider','partner');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  display_name text NOT NULL,
  role user_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  disabled_at timestamptz
);

CREATE TABLE household_users (
  user_id uuid NOT NULL REFERENCES users(id),
  household_id uuid NOT NULL REFERENCES households(id),
  relationship text,
  PRIMARY KEY (user_id, household_id)
);

CREATE TABLE provider_users (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  provider_id uuid NOT NULL UNIQUE REFERENCES providers(id)
);

CREATE TABLE portal_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role user_role NOT NULL,
  household_id uuid REFERENCES households(id),
  provider_id uuid REFERENCES providers(id),
  token_hash text NOT NULL,
  issued_by text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK (
    (role = 'household' AND household_id IS NOT NULL AND provider_id IS NULL) OR
    (role = 'provider'  AND provider_id  IS NOT NULL AND household_id IS NULL) OR
    (role IN ('operator','partner'))
  )
);
```

A household may have several users — the son in New York and the daughter in London both need access, and that is a common case rather than an edge one.

### 3.5 Consent and testimonials

```sql
CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('household','provider')),
  subject_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('photo','testimonial','case_study')),
  granted_at timestamptz NOT NULL,
  granted_by text NOT NULL,
  scope_note text,
  evidence_url text,
  revoked_at timestamptz
);

CREATE TABLE testimonials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  consent_id uuid NOT NULL REFERENCES consents(id),
  body text NOT NULL,
  attribution text NOT NULL,      -- "James T., Beverly Hills"
  service_line text,
  published boolean NOT NULL DEFAULT false
);
```

A testimonial without a live `consent_id` cannot be published. Household-level only — never attributed to a named provider, per the front door spec § 4.3.

### 3.6 Provider photo consent

`providers.photo_url` is already nullable with `photo_consent_on`. Add the guard so it cannot be served without consent:

```sql
ALTER TABLE providers ADD CONSTRAINT photo_requires_consent
  CHECK (photo_url IS NULL OR photo_consent_on IS NOT NULL);
```

---

## 4. Auth and RLS

One Supabase project, one `auth.users`, four roles. Session carries `role` plus the linked `household_id` or `provider_id` as JWT claims, set by a Postgres function on sign-in.

```sql
-- claims helpers
CREATE FUNCTION current_role_name() RETURNS user_role AS $$
  SELECT (auth.jwt() ->> 'ccn_role')::user_role $$ LANGUAGE sql STABLE;
CREATE FUNCTION current_household() RETURNS uuid AS $$
  SELECT NULLIF(auth.jwt() ->> 'ccn_household_id','')::uuid $$ LANGUAGE sql STABLE;
CREATE FUNCTION current_provider() RETURNS uuid AS $$
  SELECT NULLIF(auth.jwt() ->> 'ccn_provider_id','')::uuid $$ LANGUAGE sql STABLE;
```

Policy shape, applied in `src/rls/policies.sql`:

| Table | operator | household | provider | partner |
|---|---|---|---|---|
| `providers` | all | **select only**, and only rows on a shortlist published to their own case | select own row; update own rate, availability, restrictions, bio, photo fields only | none |
| `credentials` | all | none | select own; insert own | none |
| `households`, `cases` | all | select own; update `household_profile` only | select own assigned cases, limited columns | none |
| `published_shortlists`, items | all | select own case's, not withdrawn | none | none |
| `shortlist_requests` | all | select own; **insert own** | none | none |
| `referrals` | **insert/select** | select own case's | select own | none |
| `disclosures` | insert/select; update written fields only | select own case's | none | none |
| `timeline_entries` | insert/select | none | none | none |
| `referral_feedback` | select | insert own | none | none |
| `inquiries` | all | — | — | insert (partner form) |
| `provider_applications` | all | — | — | — |
| `audit_log` | select | none | none | none |

Two policies that carry the legal weight, written explicitly rather than left implicit:

```sql
-- Only the operator may create a referral. A household request is not a referral.
CREATE POLICY referrals_insert_operator_only ON referrals
  FOR INSERT TO authenticated
  WITH CHECK (current_role_name() = 'operator');

-- A provider may never edit their own credential expiry or verification.
-- Those are set by the operator against a primary source.
CREATE POLICY credentials_provider_insert ON credentials
  FOR INSERT TO authenticated
  WITH CHECK (current_role_name() = 'provider' AND provider_id = current_provider());
CREATE POLICY credentials_no_provider_update ON credentials
  FOR UPDATE TO authenticated
  USING (current_role_name() = 'operator');
```

The second one matters: a provider uploading a document is fine; a provider setting their own expiry date and verification source is the whole diligence story collapsing. They upload, the operator verifies.

**Service-role keys.** Two separate keys, one per Vercel project, both scoped. `ccn-web` must never hold a key that can insert into `referrals`, `timeline_entries` or `disclosures`. If it does, RLS is the only thing standing between a front-end bug and a fabricated compliance record.

---

## 5. ccn-registry — extracting core from a live app

The console is deployed and presumably has real or seed data. Do this as a pure refactor with no behaviour change, in one PR, verified before anything else is built.

1. Create `ccn-core`. Move `src/db/schema*`, `src/domain/*` and the lint ruleset across verbatim. Do not improve anything while moving — a refactor that also changes logic is unreviewable.
2. Move `migrations/` across. `ccn-core` now owns migration history. Delete `drizzle-kit` from the console's dependencies so it cannot generate one by accident.
3. Publish `@ccn/core@0.1.0`.
4. In the console: add the dependency pinned exactly, add `transpilePackages: ['@ccn/core']`, replace every local import with `@ccn/core` or `@ccn/core/schema`, delete the moved files.
5. Add the new tables in § 3 as `ccn-core` migration `0002_front_door`. Apply to the existing database. All additive — no table is altered except the two new constraints.
6. Add `ccn-lint` to the console's CI.
7. Verify: typecheck clean, the backend spec's § 7 tests pass from `ccn-core`, console deploys, sign-in works, every screen renders unchanged.

Only after step 7 does `ccn-web` start.

---

## 6. ccn-web

### 6.1 Structure

```
ccn-web/
  next.config.ts            transpilePackages: ['@ccn/core']
  .npmrc
  app/
    (marketing)/
      layout.tsx            light theme, footer with the referral-agency statement
      page.tsx
      services/[slug]/page.tsx
      areas/[slug]/page.tsx
      [service]-[area]/page.tsx
      how-it-works/page.tsx
      pricing/page.tsx
      vetting/page.tsx
      for-providers/page.tsx
      for-partners/page.tsx
      resources/[slug]/page.tsx
      about|privacy|terms/page.tsx
      sitemap.ts  robots.ts
    (client)/
      layout.tsx            auth: role household
      portal/page.tsx                      bench
      portal/provider/[id]/page.tsx
      portal/schedule/page.tsx
      portal/profile/page.tsx              household-authored, editable
      portal/documents/page.tsx
      portal/requests/page.tsx
      portal/feedback/[referralId]/page.tsx
    (provider)/
      layout.tsx            auth: role provider
      pro/page.tsx                         opportunities
      pro/profile/page.tsx
      pro/rate/page.tsx
      pro/availability/page.tsx
      pro/credentials/page.tsx
      pro/engagements/page.tsx
      pro/documents/page.tsx
      pro/resume/page.tsx
    (partner)/
      refer/page.tsx                       no account required
      partner/page.tsx                     auth: role partner
    api/
      inquiry/route.ts                     → inquiries
      apply/route.ts                       → provider_applications
      refer/route.ts                       → inquiries (partner_id set)
    invite/[token]/page.tsx
    login/page.tsx
  components/
    StatutoryFooter.tsx     NOT removable; rendered by (marketing) layout
    content/statutory/      the (f) and (d) texts, versioned, one copy each
```

### 6.2 Rendering

- `(marketing)` — static or ISR, no database in the request path except rate ranges, which are revalidated hourly. Full metadata, OpenGraph, JSON-LD `LocalBusiness` without any licensure or bond claim.
- `(client)`, `(provider)`, `(partner)` — dynamic, server components, `noindex`.

### 6.3 The request action

The one route where getting it wrong matters most.

```ts
// app/(client)/portal/provider/[id]/request.action.ts
'use server';

export async function requestProvider(input: { shortlistId: string; providerId: string; note?: string }) {
  const { role, householdId, userId } = await requireRole('household');

  const item = await db.query.publishedShortlistItems.findFirst({
    where: and(
      eq(publishedShortlistItems.shortlistId, input.shortlistId),
      eq(publishedShortlistItems.providerId, input.providerId)
    ),
    with: { shortlist: { with: { case: true } }, provider: { with: { credentials: true } } },
  });
  if (!item) throw new Error('Not found');
  if (item.shortlist.case.householdId !== householdId) throw new Error('Not found');
  if (item.shortlist.withdrawnAt) throw new Error('This shortlist is no longer current');

  // Staleness: re-check at request time, not just at render.
  const el = eligibility(item.provider, item.provider.credentials, new Date());
  if (!el.eligible) {
    return { ok: false, message: "We're confirming a credential for this provider. Please choose another or ask us to call." };
  }

  await db.insert(shortlistRequests).values({
    shortlistId: input.shortlistId,
    providerId: input.providerId,
    requestedBy: userId,
    note: input.note,
    status: 'pending',
  });

  await notifyOperator({ kind: 'shortlist_request', caseId: item.shortlist.caseId });

  return {
    ok: true,
    message: 'Request received. We will call you to go through a few things before we make the referral.',
  };
}
```

Three things this must never do: insert into `referrals`, insert into `timeline_entries`, or return anything the UI could render as a confirmed booking. The copy says *request received* and *we will call you*. No countdown, no "confirmed", no calendar hold.

### 6.4 Provider portal writes

Allowed from `(provider)`: `rate_hourly`, `rate_notes`, `availability`, `restrictions`, bio, photo plus its consent record, and inserting a credential document.

Forbidden, enforced by RLS not by the form: `credentials.expires_on`, `credentials.verified_on`, `credentials.verification_source`, `status`, `areas` (operator-confirmed against service area), and anything on `cases`.

Accept and decline on an opportunity are the same component with the same visual weight. Decline takes no reason and sets no flag anywhere that could later read as a performance record. Log it as a timeline entry on the case, author = provider.

### 6.5 Copy guard

`StatutoryFooter` is rendered by the `(marketing)` layout, not by individual pages, so no page can omit it. The statutory texts live as single files under `components/content/statutory/` and are imported, never retyped. `ccn-lint` runs over `app/`, `components/` and `content/` in `pretest` and CI.

---

## 7. Environment

| Variable | core | registry | web |
|---|---|---|---|
| `DATABASE_URL` (pooled) | — | ✓ | ✓ |
| `DIRECT_URL` (migrations) | ✓ | — | — |
| `SUPABASE_URL` | — | ✓ | ✓ |
| `SUPABASE_ANON_KEY` | — | ✓ | ✓ |
| `SUPABASE_SERVICE_ROLE_KEY` | — | ✓ operator-scoped | ✓ **separate, restricted** |
| `GITHUB_PACKAGES_TOKEN` | — | ✓ | ✓ |
| `RESEND_API_KEY` or equivalent | — | ✓ | ✓ |
| `NEXT_PUBLIC_SITE_URL` | — | — | ✓ |
| `OPERATOR_NOTIFY_EMAIL` | — | ✓ | ✓ |

Vercel project settings:

| | ccn-registry | ccn-web |
|---|---|---|
| Framework | Next.js | Next.js |
| Root Directory | `/` | `/` |
| Domain | non-obvious host | apex + `app.` subdomain |
| `robots.txt` | disallow all | allow marketing, disallow portals |
| `X-Robots-Tag` | `noindex, nofollow` on all routes | `noindex` on `/portal`, `/pro`, `/partner` |
| Deployment protection | Vercel Authentication on previews | standard |

Add `X-Robots-Tag: noindex, nofollow` to the console today. The `vercel.app` host is guessable and crawlable, and it is currently the front door to the entire roster.

---

## 8. CI

Both apps, on every PR:

```
pnpm install --frozen-lockfile
pnpm ccn-lint ./app ./components ./content     # I9 — fails the build
pnpm typecheck
pnpm test                                      # includes the invariant suite
```

`ccn-core` additionally runs the backend spec's § 7.1–7.3 suite. The invariant tests live in `ccn-core` so they cannot be weakened in one app without the other noticing.

Add one CI check specific to this architecture: a test asserting that `ccn-web`'s dependency tree contains no `drizzle-kit` and that no file under `ccn-web/` matches `/migrations?\//`. Migrations have one owner.

---

## 9. Order of operations

| # | Step | Gate |
|---|---|---|
| 1 | `X-Robots-Tag: noindex` + `robots.txt` on the live console | Deployed today, one line |
| 2 | Create `ccn-core`, move schema + domain + lint verbatim, publish `0.1.0` | § 7.1–7.3 tests pass from core |
| 3 | Console consumes `@ccn/core`, local copies deleted | Console deploys, every screen unchanged |
| 4 | Migration `0002_front_door` — § 3 tables, views, constraints | Applied to the live DB, console still green |
| 5 | RLS policies for the four roles, § 4 | Test: `household` role cannot insert into `referrals` |
| 6 | `ccn-web` scaffold, `(marketing)` layout, StatutoryFooter, lint in CI | Footer statement cannot be removed from any page |
| 7 | Marketing pages: home, how-it-works, pricing, vetting, for-providers, for-partners | `ccn-lint` clean; no contractor language anywhere |
| 8 | Intake routes + operator notification | Public form writes only to `inquiries` / `provider_applications` |
| 9 | Invite flow, login, `(client)` bench + provider profile | Household sees only their own case's shortlist |
| 10 | Request action, § 6.3 | **No code path from `(client)` reaches `referrals`** |
| 11 | `(client)` schedule, household profile, documents, feedback | Feedback carries `use_restriction` |
| 12 | `(provider)` profile, rate, availability, limits, credentials | Provider cannot write expiry or verification fields |
| 13 | `(provider)` opportunities, engagements, resume | Decline is one tap, logged, no penalty field exists |
| 14 | Service × area pages, ten to start | Live rate ranges, distinct content per page |
| 15 | `(partner)` refer form + acknowledgement | First referral needs no account |

Steps 1 through 5 are infrastructure and should land before any page is designed. Step 10 is the one to review twice.

---

## 10. Acceptance tests for this architecture

```
@ccn/core is the only package in either app that exports a Drizzle schema
ccn-web has no drizzle-kit dependency and no migrations directory
Both apps pin @ccn/core to an exact version, not a range
ccn-lint fails on a planted forbidden string in each app
eligibility() imported in both apps returns identical results for the same fixture
household role: INSERT INTO referrals            → RLS denies
household role: SELECT from another case's shortlist → returns zero rows
provider role: UPDATE credentials SET expires_on  → RLS denies
provider role: INSERT INTO credentials (own)      → succeeds
requestProvider() on an ineligible provider       → returns ok:false, writes nothing
requestProvider() success                          → one shortlist_requests row, zero referrals rows
StatutoryFooter present in the DOM of every (marketing) route
console responds with X-Robots-Tag: noindex on every route
```

The fifth line is the one that justifies the whole shared-package design. Run it as a real test with a shared fixture, not as a comment.

---

*Not legal advice. The RLS matrix in § 4 and the statutory texts in § 6.5 should be reviewed alongside the counsel questions in the other two specs before anything in `(marketing)` ships publicly.*
