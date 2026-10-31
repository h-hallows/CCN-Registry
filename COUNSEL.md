# Counsel questions that block specific code

Spec § 10. Everything else is built while these are open. Each entry names the code it gates.

| # | Question | Blocks |
|---|---|---|
| 1 | Does a recorded or interactive voice disclosure satisfy § 1812.5095(f)'s "orally communicate"? | Whether the disclosure step can ever be automated. **Current build assumes it cannot** — `lib/domain/referral.ts` requires a live human call, `method` is constrained to `phone` or `in_person`, and there is no skip path. |
| 2 | Does email satisfy the three-business-day "mailed" written statement, or is physical post required? | The written follow-up workflow. **Current build records `written_method` as free text and does not send anything**, so either answer is accommodated. |
| 3 | What account structure satisfies both § 1812.5095(b)(8) (trust account) and § 687.2(h) (provider payments not from business accounts)? | All payment code. Nothing is built. The schema anticipates a segregated trust ledger rather than a single balance. |
| 4 | HIPAA posture: covered entity, business associate, or neither? | BAAs, audit retention policy, breach obligations. **Current build encrypts in transit and at rest and audits every read regardless of the answer**, which is the conservative position. Retention is currently unbounded — set a policy once answered. |
| 5 | If CCN orders background checks, what FCRA disclosure, authorisation and adverse-action duties attach, and may Live Scan results be surfaced to a household at all? | What the credential vault may display and to whom. **Current build never surfaces Live Scan detail outside the operator's own vault view** — shortlists expose only an eligible/ineligible boolean and the credential *type* that blocks, never a result or a document. |
| 6 | Does the § 1812.524 private-duty-nursing definition hold on every current skilled case, including physician direction? | Whether `households.physician_name` is sufficient or more is needed on the record. Build captures name, practice, phone and fax. |
| 7 | Given that § 2777 excludes in-home care, confirm there is no other AB 5 pathway and that § 1812.5095 plus § 687.2 is the complete analysis. | Nothing directly — but it decides how much margin for error the invariants carry. Current build assumes **none**. |

*Not legal advice. § 0 and § 10 of the build spec need a California employment and
healthcare attorney before capital is committed.*

## Raised by the web build spec (31 October 2026)

| # | Question | Blocks |
|---|---|---|
| 8 | **Approve the § 1812.533(b)(4) residence disclosure and the § 1812.5095(d) provider notice.** The statute gives required content and two quoted phrases but not full wording. Both are drafts in `apps/web/content/statutory/`, marked `draft`, and the code refuses to deliver them. | Every nursing referral. |
| 9 | Which chapter governs a given referral — § 1812.5095 or §§ 1812.524–1812.533 — and is the superset default the right posture, or does giving a domestic-worker disclosure on a nursing referral create a different problem? | The disclosure flow. Built as the superset for now. |
| 10 | **Does § 1812.531's fee-splitting prohibition bar any compensation, cash or otherwise, to referring physicians, surgical practices, hospitals or hospital-employed discharge planners?** Does it reach care managers and estate attorneys, who are not enumerated? Where LTC or VA dollars are involved, does federal anti-kickback or Stark attach? | Monetising the partner programme. Built with **no compensation mechanic and no column that could hold one**. |
| 11 | What form and delivery method does the § 1812.533(b)(4) residence disclosure require, and does "before they are under the care of any nursing personnel" permit delivery at the first shift, or must it precede it? | The status gate's trigger point. Built to block the case going active. |
| 12 | Does the § 1812.527 fee schedule need to reach CNA, HCA and companion applicants before interview too, or only nurses? | Onboarding. |
| 13 | May verified credential facts — licence number, verification date, source — be shown to a household at all? Live Scan specifically. | What the client portal may render. |
| 14 | **Does the trading name create § 1726(b), 22 CCR § 74600(b) or § 1812.533(b)(4) exposure?** | **All marketing pages and all brand spend.** |
| 15 | Retention: one year is the Chapter 7 floor. Confirm the right period for disclosures, referrals and the assignment log given wage and classification limitation periods. | Retention policy; currently unbounded. |
| — | The complaint contacts in `complaint-contacts.ts` are **unfilled**. A guessed address sends a complaint nowhere while looking like it works. | Nursing referrals. |
