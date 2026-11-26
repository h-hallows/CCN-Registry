# Standing V1 up

Two Vercel projects and one Postgres. Both applications are deployed and healthy right
now; what is missing is the database and six business facts. Nothing below is a code
change.

Current state, readable at any time without signing in:

```
https://ccn-external.vercel.app/api/health
https://ccn-registry.vercel.app/api/health
```

Both answer `"database": "not_configured"` today. That is the single thing standing
between here and a working V1: the public marketing pages serve without a database, and
everything else in either application — signing in, every form, both portals, the whole
console — needs one.

## 1. The database, once, for both

Provision it **through the console project in Vercel** — Storage → Marketplace →
Supabase. Doing it there injects the connection strings into that project automatically,
and the console reads the names Vercel uses as well as its own, so there is nothing to
copy by hand.

Supabase rather than Neon because the architecture spec puts all four portal roles on
Supabase Auth; standing Postgres up elsewhere now means moving it later.

Then apply the schema from your own machine — there is deliberately no migration step in
either deployment, so nothing can migrate a live database on a push:

```bash
npm run db:deploy
```

If that fails on `CREATE TRIGGER`, the migration is going through the transaction pooler.
Set `DIRECT_URL` to the session pooler or direct connection on **port 5432**, not 6543.
`README.md` has the long version of why.

Then run `scripts/sql/app-role.sql` in the Supabase SQL editor and point the application
at that role. A table owner bypasses row level security, so the application must not own
the schema.

## 2. The public site project

Copy the **pooled** connection string from the console project into this one as
`DATABASE_URL`, with `?sslmode=require`. One database, two projects: the public site
owns no schema and never migrates.

`CCN-external/.env.example` is the full list of variables with what each one does unset.
These are the ones that decide whether the site is V1:

| | |
|---|---|
| `DATABASE_URL` | the pooled string from step 1. Without it both portals and every form return an explicit "unavailable" page. |
| `RESEND_API_KEY` + `MAIL_FROM` | **without both, nobody can sign in at all.** No link is printed anywhere in production, by design. `MAIL_FROM` must be on a domain Resend has verified, so this waits on the trading name. |
| `NEXT_PUBLIC_SITE_URL` | `https://ccn-external.vercel.app`, or the real domain once there is one. |
| `NEXT_PUBLIC_LEGAL_NAME` | the registry's name **as filed**. |
| `NEXT_PUBLIC_PHONE` or `NEXT_PUBLIC_STREET` | § 1812.533(b)(2) wants the correct name plus one of them in every advertisement. |
| `NEXT_PUBLIC_NAME_IS_FILED` | `1`, and only once the name above is the filed one. This is what makes the marketing pages indexable; nothing infers it. |

Every `NEXT_PUBLIC_*` value is compiled into the build. **Redeploy after saving them** or
the site goes on serving what it was built with.

## 3. The console project

| | |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | injected by step 1 if you provisioned it here. |
| `OPERATOR_EMAILS` | who may request a sign-in link. Nobody can sign in without it, and the form gives the same answer either way, so an empty value looks like success. |
| `RESEND_API_KEY` + `MAIL_FROM` | same two, same reason. |
| `PORTAL_URL` | `https://ccn-external.vercel.app` — where a family, a nurse or a partner is sent when this console grants them access. On a production build it has **no default**: with neither this nor `NEXT_PUBLIC_SITE_URL` set, a grant refuses rather than minting a link to localhost, and refuses before writing anything. |

## 4. Getting in before a mail domain is verified

`MAIL_FROM` needs a verified domain, which waits on the trading name, which waits on
counsel. Until then mint a sign-in link yourself from a machine that can reach the
database:

```bash
npm run operator:link
```

Set `CONSOLE_URL` to stop typing the origin each time. `README.md`, "Getting in before
mail is wired", has the detail.

## 5. Check it

```
https://ccn-external.vercel.app/api/health
https://ccn-registry.vercel.app/api/health
```

The console's reports driver, reachability and pending migrations. The public site's
reports the database and which brand facts are still missing, and neither returns
anything about any household or provider.

## What is still owed, and by whom

These are not engineering, and three of them are what keeps the site from being V1 rather
than merely live.

| | Owner |
|---|---|
| The trading name, as filed — HSC § 1726(b), 22 CCR § 74600(b), Civ. Code § 1812.533(b)(4). Blocks the name, the domain, `MAIL_FROM`, and therefore signing in. | Counsel |
| The § 1812.533(b)(4) nurses' registry residence disclosure and the § 1812.5095(d) provider notice. These are **drafts**. Until counsel clears them **no referral may lawfully be made**, so the console cannot be used for its primary purpose. | Counsel |
| A business telephone number or street address — § 1812.533(b)(2). Every public page wants one. | Operator |
| The two figures on `/pricing`: `NEXT_PUBLIC_FEE_PCT` and `NEXT_PUBLIC_FEE_TERMS`, from the schedule actually posted in the console. § 1812.527 expects a registry to post it. | Operator |
| The five commitments on `/privacy`: retention, requests, contact, sale, processors. Unset, each prints as a marked placeholder naming who owes it. | Operator, on advice |
| The § 1812.533(b)(4) complaint contacts document, which is empty. | Operator |

Until the name and the two texts clear, the honest launch is: the site live and not
indexed, the console in use for intake and screening, and no referral made. Everything
above is set up for the day they clear.

*Not legal advice.*
