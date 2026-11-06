# Where this stands

The `@h-hallows/core` extraction is done. Three repositories, one copy of everything:

| Repository | What it is |
|---|---|
| [CCN-core](https://github.com/h-hallows/CCN-core) | the schema, the domain, the invariant suite. Consumed from git at a tag. |
| CCN-Registry (this one) | the internal operator console |
| [CCN-external](https://github.com/h-hallows/CCN-external) | the public platform |

No package registry and no tokens: all three are public, so a tagged git dependency
installs with no credentials anywhere, including on Vercel.

## Where the build is

W0–W11 of the web spec are built, reviewed and pushed. The operator half of the portal
loop — the part the console owns — is built too:

| | |
|---|---|
| Publish a bench | `/match/[caseId]`. Re-runs the identical screen inside the transaction, so a provider who lapsed since the list was drawn is refused by name. One case shows one bench. |
| Answer a request | `/requests`. Oldest first. Either a referral with its spoken disclosure, which links the request in the same transaction, or a recorded decision that is not one. |
| Read the feedback | On the case. § 1812.533(b)(5)(B), with no action offered on it — I7. |
| Give portal access | On the case, the provider and `/partners`. One address, one role, one subject; a grant never un-revokes; one live link at a time. |
| Referral partners | `/partners`. Who sends work here and what came of it. No money on that screen, and none belongs there — § 1812.531. |

Verified end to end against the Docker Postgres with both applications running: publish →
the family's portal shows the bench and the note verbatim → they ask → the request reaches
the console queue → referral and disclosure recorded → their screen reads "Introduced" →
their feedback lands on the case.

## Still blocked, and by whom

| Blocker | Blocks | Owner |
|---|---|---|
| Trading name — HSC § 1726(b), 22 CCR § 74600(b), Civ. Code § 1812.533(b)(4) | `NEXT_PUBLIC_LEGAL_NAME`, domain, logo, wordmark | Counsel |
| Nurses' registry residence disclosure and provider notice texts | Any nursing referral | Counsel |
| § 1812.531 fee splitting | Partner compensation. The portal itself is fine with none. | Counsel |
| Trust account structure | All payment code | Counsel |
| Nine-factor audit | The console's scheduling and coverage surface only | Counsel + operator |
| A business telephone number or street address | Every public page — § 1812.533(b)(2) | Operator |
| A Postgres | Both deployments. The console still reports `not_configured`. | Operator |
| A mail provider — `RESEND_API_KEY` and `MAIL_FROM` | **Signing in to either application.** `MAIL_FROM` needs a verified domain, so this waits on the trading name too. | Operator, after counsel |
| One week of tallies | Nothing technical — it decides what gets funded next | Operator |

No domain purchased. No wordmark drawn.

`restructure/workspaces` was merged to `main` on 2026-11-06; `main` is the workspace
layout and the branch is gone. `vercel.json` at the repository root sets the build
command and output directory, so the deployment does not need a Root Directory set in
the dashboard — if Vercel ever disagrees, setting it to `apps/registry` is the fallback
and nothing else has to change.
