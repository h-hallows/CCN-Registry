# Statutory texts

These are the operative legal artifacts of the business. Everything else in this repo
is a tool; these are the documents the law requires to exist and to say particular
things.

| File | Statute | Status | Who may change it |
|---|---|---|---|
| `oral-disclosure.ts` | § 1812.5095(f), first paragraph | **Verbatim statutory text** | Nobody. It is the statute. |
| `written-statement.ts` | § 1812.5095(f), second paragraph | **Verbatim statutory text** | Nobody. It is the statute. |
| `nurses-registry-disclosure.ts` | § 1812.533(b)(4) | **Draft — counsel must approve** | Counsel |
| `provider-notice.ts` | § 1812.5095(d) | **Draft — counsel must approve** | Counsel |
| `referral-agency-line.ts` | § 1812.5095(h) + § 1812.533(b)(2) | Statutory line; the contact detail is a business fact | Counsel for the wording, the operator for the number |
| `complaint-contacts.ts` | § 1812.533(b)(4) | **Unfilled — needs real addresses** | Counsel |

## Two statutory regimes, not one

The earlier specs treated § 1812.5095 as governing. That is right for CNAs, HCAs and
companions. **It is the wrong chapter for nurses.** Private duty nursing referrals fall
under Civil Code Chapter 7, §§ 1812.524–1812.533, which has obligations with no
§ 1812.5095 equivalent — an assignment log, a posted fee schedule, a residence
disclosure delivered *before care begins* rather than within three days afterwards.

The operating posture is the superset: give both disclosures on every referral. The
branch decides what is *required*; the system delivers more than the minimum because one
extra document is cheaper than the question of which chapter applied.

## Why the lint lets these files say what it bans everywhere else

§ 1812.5095(f)'s written statement contains "independent contractor". The
§ 1812.533(b)(4) disclosure contains "self-employed" and "home health agency". The
statute puts them there. Meanwhile § 1812.5095(g) bars CCN from using those labels in
its own copy.

Statutory text is reproduced exactly; CCN's own copy never uses those labels. Scoping
the lint exception to this one directory is what keeps those two facts from collapsing
into each other. The advertising bans — bond, licensure — hold even here, because no
statutory text contains them.

## Versioning

Every file exports `VERSION` and `LAST_REVIEWED`. Every `disclosures` row stores the
version it used. When counsel revises wording the old version stays, and old records keep
pointing at it. A compliance record that cannot prove *which* text was delivered is a
weaker record than one that can.
