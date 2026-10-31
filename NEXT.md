# Where this stands

The `@h-hallows/core` extraction is done. Three repositories, one copy of everything:

| Repository | What it is |
|---|---|
| [CCN-core](https://github.com/h-hallows/CCN-core) | the schema, the domain, the invariant suite. Consumed from git at a tag. |
| CCN-Registry (this one) | the internal operator console |
| [CCN-external](https://github.com/h-hallows/CCN-external) | the public platform |

No package registry and no tokens: all three are public, so a tagged git dependency
installs with no credentials anywhere, including on Vercel.

## Built ahead of the stated sequence

Work order 01 § 2 said stop at the end of W2. W3, W4 and W5 were built before it
arrived. The hard stops exist to prevent two implementations of `eligibility()` and more
than one migration owner — neither happened, and the extraction those stops were waiting
for has now completed. Treat W3–W5 as needing a review pass rather than as settled.

W6, the request action, is where work resumes. The spec calls it the one to review
twice: it is the path where a household request must never become a referral.

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
| Vercel Root Directory → `apps/registry` | Merging `restructure/workspaces` | Operator |
| One week of tallies | Nothing technical — it decides what gets funded next | Operator |

No domain purchased. No wordmark drawn.
