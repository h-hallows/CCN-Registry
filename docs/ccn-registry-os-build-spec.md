# CCN Registry OS — Build Specification

**Version:** 2.0 — supersedes the V1 spec where they differ
**Date:** 24 October 2026
**Audience:** implementation session
**Target:** internal operations tool, single operator, no public surface

---

## 0. Corrections to the earlier documents — read first

Two claims in the earlier assessment were wrong or weakly sourced. Both were checked against primary statute text on 24 October 2026.

### 0.1 The AB 5 referral agency exemption does not apply to this business

The assessment said the Labor Code § 2777 referral agency exemption was one of two things keeping CCN out of the ABC-test analysis. **That is incorrect.** § 2777(b)(2)(C) expressly excludes referrals to businesses providing **"in-home care"** from the referral agency exemption, alongside janitorial, delivery, courier, transportation, trucking, agricultural labor, retail, logging and construction. The enumerated covered services in § 2777(b)(2)(B) — graphic design, tutoring, dog walking, minor home repair, event planning and so on — do not include caregiving of any kind.

So there is no AB 5 exemption here. What determines whether CCN is the employer of a referred worker is a different and narrower mechanism:

| Purpose | Governing provision |
|---|---|
| Employer status under the Labor Code and wage orders | **Civil Code § 1812.5095(b)** — the nine factors |
| Employer status for unemployment insurance | **Unemployment Insurance Code § 687.2** — nine near-identical conditions |
| Private duty nursing referrals specifically | **Civil Code §§ 1812.520–1812.549** |
| HCO licensure exemption | **HSC § 1796.17(b)(7)** |
| Home health agency licensure exemption | **HSC § 1726(c)**, 22 CCR § 74600(b) |

**What this changes for the build:** nothing about the architecture, and everything about the margin for error. The nine factors are not one of two shields — they are the only shield. Every invariant in § 1 below is therefore load-bearing rather than belt-and-braces. Code review should treat a violation as a release blocker, not a cleanup item.

### 0.2 UI Code § 687.2 adds two conditions the Civil Code does not

§ 687.2 mirrors § 1812.5095(b) closely but is sharper in two places, and both are product constraints:

1. **§ 687.2(e):** checking client satisfaction may not be used to identify performance problems and then discipline or train the worker. The Civil Code permits the satisfaction check; § 687.2 forbids what you do with the result. This constrains the post-engagement feedback design directly — see invariant I7.
2. **§ 687.2(h):** payments to workers are **not made from the agency's business accounts**. Stricter than "hold in trust." Payments are out of scope for V1, but the schema in § 3 anticipates a segregated trust ledger rather than a single balance.

### 0.3 Claims that held up

Verified against primary or strong sources: the nine § 1812.5095(b) factors and subdivisions (c) through (k) including the $2,500 per-violation penalty; the § 1812.524 definitions requiring a self-employed private duty nurse under physician direction; HSC § 1726(c) and 22 CCR § 74600(b); the § 1812.525 and § 1812.503 $3,000 bond filings with the Secretary of State; Care.com's $500M IAC acquisition (SEC filings show ~$627M total purchase price) and the FTC's August 2024 action with $8.5M ordered and $8.1M distributed in June 2025; CareLinx's $65M sale to Sharecare ($54.6M cash, $10.4M stock); Honor's $325M equity plus $300M debt at ~$1.25B.

One nuance worth carrying: the FTC's Care.com action was framed around deceiving **caregivers** about earnings and job availability, not only families. The largest care marketplace in the country was penalized for misrepresenting the supply side's prospects. That is the failure mode of an open directory with thin real demand per profile.

### 0.4 Claims to treat as soft

Use these for direction, not for a model or a pitch deck. Each comes from a vendor blog or a single secondary source: industry caregiver turnover near 75–80%; 70% of new hires leaving within 100 days; $2,600–5,000 replacement cost; 59% of agencies understaffed; one in four clients turned away; private pay at ~22% of the market; private duty gross margins of 40–60%. IBISWorld's own pages gave two different 2026 figures for the same NAICS code (~$173.6B and ~$191.6B), so treat US home care as a $170–190B market rather than a precise number. The 31% gray-market figure is one published survey. The Clipboard Health California discovery order came from a single low-authority outlet and should be re-checked before anyone relies on it.

None of this moves the recommendation. All of it should be replaced by CCN's own instrumented data within six months, which is the point of § 8.

---

### 0.5 Four things that must happen before the first commit

The build is not the risky part. These are.

**1. Settle who the operator is.** Every screen in § 5 is designed around one person's working day. If that person is not the one commissioning the build, the whole design brief changes: adoption becomes the primary risk, the UI bar rises sharply, and someone other than the author has to want this. Nothing downstream is reliable until this is named.

**2. Audit the current operation against the nine factors — before building the scheduling surface.** This is listed as counsel question 1 in § 10 and it is the one question that genuinely blocks code. "Coordinate schedules" and "oversee administrative arrangements," as the business currently describes its own work, are the exact activities § 1812.5095(b)(5) and § 687.2(e) constrain. If the operation already directs work, then systematising it produces a clean, timestamped, per-case written record of the thing that creates liability. A notebook is ambiguous; a database is evidence. **Credentials, timeline, disclosure capture and the compliance screen are safe to build regardless** — they only strengthen the position. The scheduling and coverage surface waits for the audit.

The design rule that keeps this safe once built: the system records **the pattern the household asked for** and **the availability the provider stated**, and notes where they fail to meet. It never generates an assignment, allocates a shift, or produces a roster.

**3. Name who does the initial data entry, and when.** Day one means roughly 15–40 provider records with credential documents, plus every active case and household profile. That is ten to twenty hours of work before the tool returns anything at all. Unassigned, this is where internal tools die — and if it does not happen, § 8 collects nothing and the build has bought nothing.

**4. Capture the baseline now, by hand, before any code exists.** One week of tally marks answers it: inquiries received, how many got a same-day response, how many converted, how many were turned away or lost, active cases held, hours placed. Without that week there is nothing to compare the tool against, and no way to tell in month six whether it worked.

That fourth item also settles a prior question. The V1 thesis is that **operator capacity** is the binding constraint. If a week of tallies shows few inquiries lost and volume comfortably handled, the constraint is **demand**, and the right first build is the referral-partner and search front door instead. That is a different project. One week of counting decides which of the two to fund.

---

## 1. Invariants — enforce these in code

These are not guidelines. Each maps to a statutory condition in § 1812.5095(b) or § 687.2. Put this list in `/INVARIANTS.md` at the repo root and reference it from the PR template.

| # | Invariant | Source | Enforcement |
|---|---|---|---|
| **I1** | No training content of any kind. No modules, courses, completion tracking, required reading, competency checks, or skills assessment. A voluntary orientation record covering *only* administrative procedures and the referral agreement is permitted. | (b)(4), § 687.2(d) | No `training`, `course`, `module`, `curriculum`, `competency` tables or routes. CI grep. |
| **I2** | No work direction. No task checklists, no duty verification, no care-plan authoring, no clock-in with task attestation, no GPS verification of duties performed. | (b)(5), § 687.2(e) | No `task`, `care_plan`, `duty`, `checklist` tables. Shift records may hold confirmation only, never task completion. |
| **I3** | No auto-assignment. No code path creates a `referral` row without an explicit operator action that also writes a `disclosure` row in the same transaction. | (b)(5) | DB constraint: `referral` requires a `disclosure_id` FK. See § 3.6. |
| **I4** | The registry cannot end a household–provider relationship. Permitted actions: household ends engagement; provider declines; registry stops referring (forward-only). | (b)(9), § 687.2(i) | No `terminate_provider` mutation. `engagement.ended_by` enum excludes `registry`. |
| **I5** | Rates are provider-set and always rendered as negotiable. The system never computes, suggests, caps, or defaults a provider's rate. | (b)(3), § 687.2(c) | `provider.rate` writable only by provider-origin mutations. No rate suggestion code. |
| **I6** | The referral fee is charged to the household as a fixed percentage of job cost. It is never deducted from provider earnings, and the registry is never obligated to pay a provider when the household has not paid. | (b)(7), (c), § 687.2(g) | `fee_charged_to` is a constant `'household'`. No `provider_deduction` column. |
| **I7** | Satisfaction feedback about a referral may be recorded. It may **not** be routed into provider discipline, coaching, training, performance improvement, or any corrective workflow. | § 687.2(e) | Feedback rows feed match ranking and referral decisions only. No `performance_review`, `coaching`, `corrective_action` tables. |
| **I8** | No tools, supplies, equipment, uniforms, badges, or devices issued to providers. | (b)(6), § 687.2(f) | No inventory or asset-assignment tables. |
| **I9** | Forbidden strings in any operator-, provider- or client-facing copy: `independent contractor`, `self-employed`, `our nurses`, `our caregivers`, `our staff`, `our employees`, `employee`. Providers are *referred providers*. | (g) | CI lint over `/app`, `/components`, `/content`, i18n files. Fails the build. |
| **I10** | Needs profiles are recorded as stated by the household. The system never generates, suggests, or templates clinical content. | (b)(5) + HHA licensure | `case.needs_profile` is free text with `authored_by = 'household'`. No generation endpoint. |
| **I11** | A skilled case cannot reach `referred` status without an ordering physician on the household record. | § 1812.524(a), (c) | DB check constraint. See § 3.4. |
| **I12** | A provider with any required credential missing or expired is excluded from every shortlist. No override exists for any role. | Diligence | Computed in the query layer, not the UI. See § 4.2. |

A thirteenth rule that is operational rather than statutory: **never advertise the surety bond or any licensure** in public-facing copy, per § 1812.5095(i)–(j). V1 has no public surface, so this is a note for Phase 2.

---

## 2. Stack and repo

```
Next.js 15 (App Router) · TypeScript strict · Postgres 16 · Drizzle ORM · Tailwind · Zod
Auth: single operator, email magic link. Build the users table now.
Host: Vercel + Supabase (or RDS). Encryption at rest and in transit regardless of HIPAA outcome.
```

```
/app
  /(app)/today/page.tsx
  /(app)/roster/page.tsx            /(app)/roster/[providerId]/page.tsx
  /(app)/cases/page.tsx             /(app)/cases/[caseId]/page.tsx
  /(app)/match/page.tsx             /(app)/match/[caseId]/page.tsx
  /(app)/compliance/page.tsx
/lib
  /db/schema.ts  /db/migrations/  /db/seed.ts
  /domain/credentials.ts           # expiry + eligibility engine
  /domain/match.ts                 # hard filters + soft score
  /domain/businessDays.ts          # CA business-day arithmetic
  /domain/buckets.ts               # Today-screen derivations
  /audit.ts                        # write-through audit log
/components
INVARIANTS.md
```

Decisions already made, do not re-litigate: no GraphQL, no state library beyond React Server Components plus `useState`, no component library, no multi-tenancy, no feature flags, no i18n in V1.

---

## 3. Schema

Postgres DDL. All timestamps `timestamptz`. All dates that are dates are `date`, not timestamps. Every expiry comparison runs in `America/Los_Angeles`.

### 3.1 Enums

```sql
CREATE TYPE provider_type   AS ENUM ('RN','LVN','CNA','HCA','companion');
CREATE TYPE provider_status AS ENUM ('active','inactive','do_not_refer');
CREATE TYPE credential_type AS ENUM (
  'rn_license','lvn_license','cna_cert','hca_registry','live_scan',
  'tb_clearance','cpr_bls','auto_insurance','drivers_license','immunization','other');
CREATE TYPE care_type       AS ENUM (
  'companion','personal_care','skilled_nursing','post_surgical',
  'overnight_newborn','respite','hospice_support');
CREATE TYPE case_status     AS ENUM ('inquiry','matching','referred','active','paused','ended');
CREATE TYPE urgency         AS ENUM ('discharge','same_day','next_day','routine');
CREATE TYPE payment_method  AS ENUM ('private','ltc_policy','va','other');
CREATE TYPE timeline_type   AS ENUM (
  'inquiry','call','note','shortlist','referral','disclosure',
  'written_disclosure','schedule_change','document','status_change');
CREATE TYPE ended_by        AS ENUM ('household','provider','mutual');  -- deliberately no 'registry' (I4)
CREATE TYPE shift_block     AS ENUM ('AM','PM','NOC');                  -- 07–15, 15–23, 23–07
```

### 3.2 Providers and credentials

```sql
CREATE TABLE providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status          provider_status NOT NULL DEFAULT 'active',
  full_name       text NOT NULL,
  preferred_name  text,
  phone           text,
  email           text,
  photo_url       text,                       -- consent-gated, null until consent recorded
  photo_consent_on date,
  type            provider_type NOT NULL,
  license_number  text,
  license_state   text DEFAULT 'CA',
  rate_hourly     numeric(6,2),               -- provider-set (I5)
  rate_notes      text,
  transports      boolean NOT NULL DEFAULT false,
  areas           text[] NOT NULL DEFAULT '{}',
  max_travel_min  int,
  availability    text[] NOT NULL DEFAULT '{}', -- 'Mon:AM' … 'Sun:NOC'
  restrictions    text,                       -- provider-stated (b)(2)
  specialties     text[] NOT NULL DEFAULT '{}',
  languages       text[] NOT NULL DEFAULT '{}',
  notes           text,
  agreement_signed_on    date,                -- (b)(1)
  written_notice_ack_on  date,                -- (d)
  work_auth_verified_on  date,                -- (e)
  orientation_on         date,                -- voluntary, admin procedures only (I1)
  deleted_at      timestamptz,                -- soft delete only
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id    uuid NOT NULL REFERENCES providers(id),
  type           credential_type NOT NULL,
  identifier     text,
  issued_on      date,
  expires_on     date,                        -- NULL = non-expiring
  verified_on    date NOT NULL,
  verified_by    text NOT NULL,
  verification_source text NOT NULL,
  document_url   text,
  notes          text,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, type)                  -- one live row per type; history via credential_events
);

CREATE TABLE credential_events (              -- append-only renewal history
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES credentials(id),
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,
  prev_expires_on date,
  new_expires_on  date,
  prev_verified_on date,
  new_verified_on  date,
  note          text
);
```

### 3.3 Required credential matrix

Keep this in code, not data — it is a legal/diligence rule, not a configuration.

```ts
export const REQUIRED: Record<ProviderType, CredentialType[]> = {
  RN:        ['rn_license','tb_clearance','cpr_bls','live_scan'],
  LVN:       ['lvn_license','tb_clearance','cpr_bls','live_scan'],
  CNA:       ['cna_cert','tb_clearance','cpr_bls','live_scan'],
  HCA:       ['hca_registry','tb_clearance','live_scan'],
  companion: ['live_scan','tb_clearance'],
};
export function requiredFor(p: Pick<Provider,'type'|'transports'>): CredentialType[] {
  return p.transports
    ? [...REQUIRED[p.type], 'auto_insurance', 'drivers_license']
    : REQUIRED[p.type];
}
```

### 3.4 Households and cases

```sql
CREATE TABLE households (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'inquiry',
  dm_name       text NOT NULL,                -- person engaging care
  dm_relationship text,
  dm_phone      text, dm_email text,
  dm_location   text,                         -- often not local; keep their timezone legible
  dm_timezone   text,
  cr_name       text, cr_age int,
  cr_area       text NOT NULL,                -- matched against providers.areas
  cr_address    text,
  cr_access_notes text,
  payment_method payment_method NOT NULL DEFAULT 'private',
  ltc_carrier   text, ltc_policy_number text,
  physician_name text, physician_practice text,
  physician_phone text, physician_fax text,
  nda_on_file   boolean NOT NULL DEFAULT false,
  source        text,
  partner_id    uuid REFERENCES referral_partners(id),
  blocked_provider_ids uuid[] NOT NULL DEFAULT '{}',  -- household asked not to be referred these
  notes         text,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  status        case_status NOT NULL DEFAULT 'inquiry',
  care          care_type NOT NULL,
  urgency       urgency NOT NULL DEFAULT 'routine',
  needs_profile text,                          -- household's own words (I10)
  needs_authored_by text NOT NULL DEFAULT 'household'
                CHECK (needs_authored_by = 'household'),
  adl_needs     text[] NOT NULL DEFAULT '{}',
  schedule      text[] NOT NULL DEFAULT '{}',  -- same 'Day:BLOCK' vocabulary
  hours_per_week int,
  starts_on     date, ends_on date,
  expected_weeks int,
  rate_agreed   numeric(6,2),
  fee_pct       numeric(5,2),                  -- % of job cost, charged to household (I6)
  fee_charged_to text NOT NULL DEFAULT 'household'
                CHECK (fee_charged_to = 'household'),
  rate_band_low numeric(6,2), rate_band_high numeric(6,2),
  language_pref text,
  primary_provider_id uuid REFERENCES providers(id),
  alternate_provider_ids uuid[] NOT NULL DEFAULT '{}',  -- target 2
  household_profile text,                      -- routine/access/preferences; travels to substitutes
  referred_on   date,
  written_due_on date,                         -- 3 CA business days from referred_on
  written_sent_on date,
  ended_on      date,
  ended_by      ended_by,                      -- no 'registry' (I4)
  end_reason    text,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- I11: a skilled case cannot be referred without a physician of record.
CREATE OR REPLACE FUNCTION assert_physician_for_skilled() RETURNS trigger AS $$
DECLARE phys text;
BEGIN
  -- Fire only on a TRANSITION into referred/active. Firing on every update would
  -- permanently lock any imported or legacy skilled case that lacks a physician:
  -- the record could never be edited again, including to add the physician.
  IF NEW.care IN ('skilled_nursing','post_surgical','hospice_support')
     AND NEW.status IN ('referred','active')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT physician_name INTO phys FROM households WHERE id = NEW.household_id;
    IF phys IS NULL OR btrim(phys) = '' THEN
      RAISE EXCEPTION
        'Skilled case % cannot be referred: no ordering physician on household record', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_physician_skilled
  BEFORE INSERT OR UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION assert_physician_for_skilled();
```

### 3.5 Coverage gaps and shifts

V1 records confirmation only. No task attestation (I2).

```sql
CREATE TABLE coverage_gaps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES cases(id),
  on_date    date NOT NULL,
  block      shift_block NOT NULL,
  note       text,
  resolved_provider_id uuid REFERENCES providers(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 3.6 Timeline, disclosures, referrals

The compliance record. Append-only at the database level, not just the UI.

```sql
CREATE TABLE timeline_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid REFERENCES cases(id),
  household_id uuid REFERENCES households(id),
  at          timestamptz NOT NULL DEFAULT now(),   -- server-set, never client-supplied
  type        timeline_type NOT NULL,
  author      text NOT NULL,
  body        text NOT NULL,
  provider_id uuid REFERENCES providers(id),
  CHECK (case_id IS NOT NULL OR household_id IS NOT NULL)
);

CREATE TABLE disclosures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases(id),
  timeline_id   uuid NOT NULL REFERENCES timeline_entries(id),
  disclosed_to  text NOT NULL,
  disclosed_by  text NOT NULL,
  method        text NOT NULL CHECK (method IN ('phone','in_person')),
  disclosed_at  timestamptz NOT NULL DEFAULT now(),
  written_due_on  date NOT NULL,
  written_sent_on date,
  written_method  text
);

CREATE TABLE referrals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases(id),
  provider_id   uuid NOT NULL REFERENCES providers(id),
  disclosure_id uuid NOT NULL REFERENCES disclosures(id),   -- I3: no referral without a disclosure
  referred_at   timestamptz NOT NULL DEFAULT now(),
  referred_by   text NOT NULL,
  outcome       text,            -- 'engaged' | 'declined_by_household' | 'declined_by_provider' | 'no_response'
  outcome_note  text,
  outcome_at    timestamptz
);

-- Append-only enforcement
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tl_append_only
  BEFORE UPDATE OR DELETE ON timeline_entries
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER trg_ref_append_only
  BEFORE DELETE ON referrals
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Disclosures: only the written follow-up fields may ever change.
CREATE OR REPLACE FUNCTION disclosure_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disclosures are permanent records and cannot be deleted';
  END IF;
  IF (NEW.case_id, NEW.disclosed_to, NEW.disclosed_by, NEW.method,
      NEW.disclosed_at, NEW.written_due_on, NEW.timeline_id)
     IS DISTINCT FROM
     (OLD.case_id, OLD.disclosed_to, OLD.disclosed_by, OLD.method,
      OLD.disclosed_at, OLD.written_due_on, OLD.timeline_id) THEN
    RAISE EXCEPTION 'disclosure record is immutable; only written_sent_on and written_method may be set';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_disclosure_guard
  BEFORE UPDATE OR DELETE ON disclosures
  FOR EACH ROW EXECUTE FUNCTION disclosure_guard();
```

### 3.7 Feedback — constrained by I7

```sql
CREATE TABLE referral_feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id  uuid NOT NULL REFERENCES referrals(id),
  at           timestamptz NOT NULL DEFAULT now(),
  -- Satisfaction with the REFERRAL SERVICE, per (b)(5)(B).
  referral_service_rating int CHECK (referral_service_rating BETWEEN 1 AND 5),
  would_refer_again boolean,
  notes        text,
  -- I7 / § 687.2(e): this record informs future referral decisions only.
  -- It must never drive provider discipline, coaching, training or corrective action.
  use_restriction text NOT NULL DEFAULT 'referral_decisions_only'
                  CHECK (use_restriction = 'referral_decisions_only')
);
```

### 3.8 Partners, users, audit

```sql
CREATE TABLE referral_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, org text, role text, phone text, email text, notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL, display_name text NOT NULL,
  role text NOT NULL DEFAULT 'operator',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,          -- 'read' | 'create' | 'update' | 'soft_delete'
  entity text NOT NULL, entity_id uuid,
  diff jsonb, ip text, user_agent text
);
```

Audit every read as well as every write. The data is health-adjacent information about private individuals in a discretion-first market; read logging is the thing that lets her answer "who looked at this household" later.

Enable RLS on every table from the first migration, even with one operator.

---

## 4. Domain logic

### 4.1 Credential status

```ts
export type CredStatus = 'expired'|'critical'|'soon'|'upcoming'|'valid'|'none';

export function credStatus(expiresOn: string | null, today: Date): CredStatus {
  if (!expiresOn) return 'none';
  const d = daysBetween(today, parseLA(expiresOn));   // LA timezone, calendar days
  if (d < 0)  return 'expired';
  if (d <= 7) return 'critical';
  if (d <= 30) return 'soon';
  if (d <= 90) return 'upcoming';
  return 'valid';
}
export const SEVERITY: Record<CredStatus, number> =
  { expired:0, critical:1, soon:2, upcoming:3, valid:4, none:5 };
```

### 4.2 Eligibility — I12

```ts
export function eligibility(p: Provider, creds: Credential[], today: Date) {
  const required = requiredFor(p);
  const present  = new Set(creds.map(c => c.type));
  const missing  = required.filter(t => !present.has(t));
  const expired  = creds
    .filter(c => required.includes(c.type) && credStatus(c.expiresOn, today) === 'expired')
    .map(c => c.type);
  const blocking = [...new Set([...missing, ...expired])];

  return {
    eligible: p.status === 'active' && blocking.length === 0,
    missing, expired, blocking,
    reason:
      p.status === 'inactive'      ? 'Marked inactive' :
      p.status === 'do_not_refer'  ? 'Marked do not refer' :
      blocking.length              ? blocking.map(t =>
          `${LABEL[t]} ${expired.includes(t) ? 'expired' : 'missing'}`).join(', ')
                                   : null,
  };
}
```

Compute this **in the query layer**. A shortlist endpoint must never return an ineligible provider for the UI to filter out — if it reaches the client, the invariant is already broken.

### 4.3 Match — hard filters

```ts
export const PERMITTED: Record<CareType, ProviderType[]> = {
  companion:         ['companion','HCA','CNA','LVN','RN'],
  personal_care:     ['HCA','CNA','LVN','RN'],
  respite:           ['HCA','CNA','LVN','RN'],
  overnight_newborn: ['CNA','LVN','RN'],
  hospice_support:   ['CNA','LVN','RN'],
  skilled_nursing:   ['RN','LVN'],
  post_surgical:     ['RN','LVN'],
};
```

Exclude, and record the reason for display:

1. not eligible per 4.2
2. `type` not in `PERMITTED[case.care]`
3. `household.cr_area` not in `provider.areas`
4. zero intersection between `provider.availability` and `case.schedule`
5. provider id in `household.blocked_provider_ids`

### 4.4 Match — soft score, 100 points

| Signal | Max | Rule |
|---|---|---|
| Specialty match | 30 | 12 per matching specialty tag, capped |
| Availability fit | 20 | `round(20 × covered / required)` |
| Prior success with this household | 15 | 15 if a prior engagement ended well; 8 if prior engagement with no good outcome recorded; else 0 |
| Language | 10 | 10 if no preference stated or preference met; 0 if stated and unmet |
| Rate against band | 10 | 10 at or under band top; 5 up to 115% of top; 2 above. Never 0 — rates are negotiable (I5) |
| Continuity history | 10 | `round(10 × percentile(avg_engagement_weeks))` across the active roster |
| Proximity | 5 | 5 if the case area is the provider's first listed area, 3 if second, else 2 |

Return the per-signal breakdown with every row. The operator must be able to see why a provider ranked where it did, and override freely. Never show a bare total.

**Defer the soft score.** These weights are invented. There is no placement-outcome data to calibrate them against, and on a roster of 15–40 providers the operator already knows who fits. The valuable half of this module is § 4.3 — the hard filters, which enforce eligibility and stop a lapsed credential reaching a household. Ship M4 as hard filters plus a sortable eligible list, and add the score once § 8 has a few dozen placement outcomes to fit it to. A confident-looking ranking that disagrees with her judgment on day one is worse than no ranking: it is the fastest way to lose her trust in the tool.

### 4.5 California business days

Load-bearing: this computes the § 1812.5095(f) written-statement deadline.

```ts
const CA_HOLIDAYS = new Set([ /* keep 3 years forward; observed dates, not nominal */ ]);

export function addBusinessDays(from: Date, n: number): Date {
  let d = new Date(from), added = 0;
  while (added < n) {
    d = new Date(d.getTime() + 86_400_000);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6 && !CA_HOLIDAYS.has(isoLA(d))) added++;
  }
  return d;
}
```

Holidays to seed: New Year's Day, MLK Day, Presidents' Day, Cesar Chavez Day (31 March), Memorial Day, Independence Day (observed), Labor Day, Veterans Day, Thanksgiving, the day after Thanksgiving, Christmas (observed). Use observed dates — 4 July 2026 falls on a Saturday and is observed Friday 3 July.

### 4.6 The referral transaction

One transaction, in this order, or nothing:

```
BEGIN
  assert case.status != 'ended'
  assert physician present if care is skilled            -- I11, also enforced by trigger
  assert provider eligible                                -- I12
  INSERT timeline_entries (type='disclosure', at=now())
  INSERT disclosures (timeline_id, disclosed_to, disclosed_by, method,
                      written_due_on = addBusinessDays(today, 3))
  INSERT referrals (case_id, provider_id, disclosure_id)  -- I3
  INSERT timeline_entries (type='referral', provider_id)
  UPDATE cases SET status='referred', referred_on=today, written_due_on=<as above>
COMMIT
```

The disclosure modal must require an explicit, un-prechecked confirmation that the spoken disclosure was given, plus the name of the person it was given to. There is no skip path and no "record later" option.

---

## 5. Screens

Five, no more. Each row on every screen links to the record it names.

**Today** — ranked work queue, in this order: blocking (active case with an ineligible provider) · needs response (open enquiry with no logged call, sorted discharge → same day → next day → routine, then age) · skilled case with no physician of record · credential alerts (expired → critical → soon → upcoming) · coverage gaps in the next 7 days · thin bench (fewer than 2 eligible alternates) · written disclosures due · engagements ending within 14 days. If a row does not require action, it does not belong on this screen.

**Roster** — filter by type, area, language, eligibility, availability block; search name and specialty. Columns: name, type, rate with negotiable marker, areas, specialties, credential state, placements, average engagement weeks. Ineligible providers sort last and show the specific blocking credential. Detail view: profile, availability grid, **credential vault** (the main event — adding or renewing a credential must take under twenty seconds), registry paperwork dates, placement history, internal notes.

**Cases** — filter by status. Detail view: household and person engaging care with their timezone, engagement terms, fee as a percentage charged to the household, payment method with LTC carrier and policy when applicable, physician of record as a blocking banner when skilled and absent, stated needs in the household's own words, **household profile** (prominent, copyable — this is what travels to a substitute), cover with primary and alternates and a thin-bench warning, append-only timeline. Actions: build a shortlist · record end of engagement (household-initiated) · mark written statement sent. No action that removes a provider from a household.

**Match** — select case → ranked eligible list with per-signal breakdown on demand → select shortlist → save to timeline → separate referral action behind the disclosure gate. Excluded providers viewable behind a disclosure showing the specific reason for each; this is how she comes to trust the ranking.

**Compliance** — credential queue with inline renewal · re-verification queue (`verified_on` older than 180 days) · disclosure log with written follow-up status, exportable to CSV · provider paperwork gaps · roster standing.

---

## 6. Build order and acceptance criteria

Ship in this sequence. Each milestone has a check that must pass before the next begins.

| # | Milestone | Done when |
|---|---|---|
| **M0** | Repo, schema, migrations, seed, auth, audit log, `INVARIANTS.md`, CI copy lint | `pnpm db:reset && pnpm db:seed` produces a realistic roster and case set. Copy lint fails on a planted forbidden string. |
| **M1** | Credential engine + tests | Every case in § 7.1 passes. A provider with a lapsed required credential is eligible = false with the credential named. |
| **M2** | Roster + credential vault | Renewing a credential from the vault flips eligibility and writes a `credential_events` row. Round trip under 20 seconds. |
| **M3** | Households, cases, timeline | Timeline is append-only: a direct `UPDATE` on `timeline_entries` raises. Skilled case with no physician cannot be set to `referred` — trigger raises. |
| **M4** | Match assist | Shortlist returns no ineligible provider at the query layer. Every row carries its breakdown. Excluded list gives a specific reason per provider. |
| **M5** | Referral + disclosure transaction | Referral cannot be created without a disclosure (FK). Written due date is correct across a weekend and across Thanksgiving. Disclosure `UPDATE` of any field except the written fields raises. |
| **M6** | Today screen | All eight buckets populate from seed data and from live edits. Counts in the rail match the buckets. |
| **M7** | Compliance screen + CSV export | Disclosure log exports with disclosed-to, by, method, timestamp, written due and sent. |
| **M8** | Metrics instrumentation (§ 8) | Every event in § 8 is being written. |

---

## 7. Tests that must pass

### 7.1 Credential engine

```
expiry today+91  → 'valid'          expiry today+90 → 'upcoming'
expiry today+31  → 'upcoming'       expiry today+30 → 'soon'
expiry today+8   → 'soon'           expiry today+7  → 'critical'
expiry today     → 'critical'       expiry today-1  → 'expired'
expires_on NULL  → 'none'

RN with all four required, none expired, status active       → eligible
RN missing live_scan                                          → not eligible, reason names Live Scan
RN with tb_clearance expired yesterday                        → not eligible, reason names TB expired
HCA with no cpr_bls                                           → eligible (not required for HCA)
Companion who transports, no auto_insurance                   → not eligible
Companion who does not transport, no auto_insurance           → eligible
Fully credentialed provider, status inactive                  → not eligible, reason 'Marked inactive'
```

### 7.2 Business days

```
Sat 24 Oct 2026 + 3 → Wed 28 Oct 2026
Fri 23 Oct 2026 + 3 → Wed 28 Oct 2026
Mon 26 Oct 2026 + 3 → Thu 29 Oct 2026
Tue 24 Nov 2026 + 3 → Tue 01 Dec 2026   (skips Thanksgiving, the day after, and the weekend)
```

### 7.3 Invariant tests

```
shortlist(case) never contains an ineligible provider                       -- I12
createReferral without a disclosure                            → rejects   -- I3
createReferral on a skilled case with no physician              → rejects   -- I11
UPDATE on timeline_entries                                      → raises    -- append-only
DELETE on disclosures                                           → raises
UPDATE disclosures SET disclosed_to = …                         → raises
UPDATE disclosures SET written_sent_on = …                      → succeeds
case.ended_by cannot be set to 'registry'                       → enum rejects -- I4
case.fee_charged_to cannot be set to 'provider'                 → check rejects -- I6
grep for forbidden strings in /app /components /content         → no matches -- I9
no table named like 'training%','task%','care_plan%','coaching%' -- I1, I2, I7
```

Make 7.3 a CI gate. These are the tests that keep a future contributor from quietly dismantling the legal position.

---

## 8. Instrumentation — write from day one

The second purpose of V1 is to answer questions no market research can. Emit a row per event; keep it raw and derive later.

| Event | Fields |
|---|---|
| `inquiry_received` | case_id, source, partner_id, care, urgency, at |
| `first_contact` | case_id, at → derives response latency |
| `shortlist_generated` | case_id, candidate_count, excluded_count, at |
| `referral_made` | case_id, provider_id, at → derives time-to-placement by urgency tier |
| `engagement_started` | case_id, provider_id, at |
| `engagement_ended` | case_id, **end_reason**, ended_by, weeks, at |
| `operator_session` | case_id, minutes → derives operator hours per active case per month |
| `credential_renewed` | provider_id, type, at |

Two of these decide whether the rest of the platform is worth funding, and both need care:

**Capacity.** The thesis is that the operator stops being the bottleneck. Do not measure it with self-reported time per case — that is the first thing abandoned in any tool, and admin time *rises* for the first two or three months while records are entered and habits change, so a time metric will read as failure exactly when the tool is working. Measure instead **active cases held concurrently without a service failure** (a missed shift, an unanswered discharge call, a lapsed credential reaching a household). That is observable from the system itself, needs no timer, and is the real constraint. If she can hold twelve where she held six, the tool worked.

**Leakage.** `end_reason` captures it, but only when an engagement ends — and at 30–50 week median durations a small book yields perhaps three to six ended cases in six months. That is not a sample. Add a leading indicator: **billed hours per case per month, tracked as a series.** Leakage in home care rarely arrives as a cancellation; it arrives as a case quietly reducing hours while the household shifts them to a direct hire and keeps the registry for fill-in. That shows up monthly, not annually.

Make `end_reason` a required field with a fixed option list, one option being "moved to a direct arrangement with the referred provider." If it is free text it will be left blank, and the number that matters most will not exist.

---

## 9. Out of scope for V1

Public website · client portal · provider portal · payments, invoicing or trust ledger · LTC claim packet generator · reviews or ratings · messaging · mobile app · automated primary-source verification · referral partner portal · analytics beyond § 8.

Design the schema to accept them. Build none of them. In particular, do not build a payment flow before counsel answers question 4 in § 10 — § 687.2(h) requires that provider payments not come from the agency's business accounts, which is an account-structure decision, not a code decision.

---

## 10. Counsel questions that block specific code

Build everything else while these are open.

1. Does a recorded or interactive voice disclosure satisfy § 1812.5095(f)'s "orally communicate"? — decides whether the disclosure step can ever be automated, or must always be a live human call.
2. Does email satisfy the three-business-day "mailed" written statement, or is physical post required? — decides the written follow-up workflow.
3. What account structure satisfies both § 1812.5095(b)(8) (trust account) and § 687.2(h) (not paid from business accounts)? — blocks all payment code.
4. HIPAA posture: covered entity, business associate, or neither? — decides BAAs, audit retention, and breach obligations.
5. If CCN orders background checks, what FCRA disclosure, authorisation and adverse-action duties attach, and may Live Scan results be surfaced to a household at all? — decides what the credential vault may display and to whom.
6. Does the § 1812.524 private-duty-nursing definition hold on every current skilled case, including physician direction? — decides whether the physician field is sufficient or more is needed on the record.
7. Given that § 2777 excludes in-home care, confirm there is no other AB 5 pathway and that § 1812.5095 plus § 687.2 is the complete analysis.

---

## Sources for the legal positions above

- Civil Code § 1812.5095 — [codes.findlaw.com](https://codes.findlaw.com/ca/civil-code/civ-sect-1812-5095/)
- Civil Code § 1812.524 — [codes.findlaw.com](https://codes.findlaw.com/ca/civil-code/civ-sect-1812-524/)
- Civil Code § 1812.525 (nurses' registry bond) — [codes.findlaw.com](https://codes.findlaw.com/ca/civil-code/civ-sect-1812-525/)
- Labor Code § 2777, in-home care exclusion — [codes.findlaw.com](https://codes.findlaw.com/ca/labor-code/lab-sect-2777/) · [california.public.law](https://california.public.law/codes/labor_code_section_2777)
- Unemployment Insurance Code § 687.2 — [codes.findlaw.com](https://codes.findlaw.com/ca/unemployment-insurance-code/uic-sect-687-2/)
- HSC § 1726 (home health agency licensure, registry exemption) — [law.justia.com](https://law.justia.com/codes/california/code-hsc/division-2/chapter-8/section-1726/)
- 22 CCR § 74600 — [law.cornell.edu](https://www.law.cornell.edu/regulations/california/22-CCR-74600)
- HSC § 1796.17(b)(7) referral agency exemption, as read against the statute — [carerulebook.com](https://www.carerulebook.com/us/california/home-care)
- FTC v. Care.com, August 2024 action and June 2025 distribution — [ftc.gov](https://www.ftc.gov/news-events/news/press-releases/2024/08/ftc-takes-action-against-carecom-deceiving-caregivers-about-wages-availability-jobs-its-site) · [ftc.gov](https://www.ftc.gov/news-events/news/press-releases/2025/06/ftc-sends-more-81-million-consumers-harmed-carecoms-deceptive-claims-about-earnings-job-listings)

*Not legal advice. § 0 and § 10 need a California employment and healthcare attorney before capital is committed.*
