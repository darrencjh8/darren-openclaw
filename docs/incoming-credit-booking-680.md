QUESTIONS
q: Is the defect a missing `incoming` branch, or a wrong `direction` value? | a: a missing branch. `parseBankMovement` returns `direction: "incoming"` for all three real bodies, and `resolveMovementAccounts` returns the correct `source_account`. Measured at `3ccf684`: uid 1030 parses with `own_account.suffix "5750"` and resolves `source = DBS Account`, then the route returns null.
q: Why does uid 1030 drop when its account resolves? | a: `src/orchestrator.js:1026` opens the booking/holding block with `if (movement.direction === "outgoing")`. The incoming movement skips it, and there is no incoming counterpart, so control reaches the final `return null` at `:1097` with no candidate left. This is the whole defect.
q: Should an incoming credit with a resolved account BOOK, or be HELD? | a: book. It is a real credit the tracker can attribute to a real account; holding it would keep every received transfer out of the budget forever. The hold stays for a credit whose own account cannot be resolved (uid 942's `4380`, which has neither an account nor a fact), mirroring the outgoing `destination_unresolved` hold.
q: Which counterparty side is the other party on an incoming movement? | assumption: the deterministic parser's own convention, not the LLM-extractor route's. `resolveMovementAccounts` (`bank-movement.js:736`) computes `source = other || own` for an incoming movement and `destination = own`, so on this route the other party is `counterparty` and the booked account is the resolved `own`/`source`. The extractor route at `:1229-1230` assigns the fields the other way round, and `:1201-1221` documents why that route keys its person flag per direction instead; this change does not touch that route.
q: Should the incoming row be positive, and what payee/category? | assumption: positive (`Math.abs`), `payee_name: "Misc"`, `category_id: null`. Money received is not spend, and the outgoing twin at `:1071` already books with an empty payee; the one-sided deposit branch at `:1004` uses `Misc`. No income category is inferred, because the alert names no payer to categorise.
q: Does the incoming branch risk booking a person transfer as income? | assumption: yes, and it is accepted, because the alternative is dropping the alert. `person_transfer` is not set on this route's movements (it is only set by the extractor route at `:1230`), so `personNamed` at `:907` is false and the person hold does not fire. uid 1030's counterparty is `ACCOUNT HOLDER`, the holder's own legal name, which `knownOwnIdentity`/memory would release if the fact existed. A received transfer from an unverified person is still a real credit to a real account, so booking it as income with `Misc` and no category is honest; the person-identity hold exists to stop a transfer TO a person being booked as SPEND, which is the opposite direction and is untouched.
q: Does the one-sided deposit branch at `:1004` already cover this? | a: no. It requires `!movement.counterparty`, so it only fires when the alert names no counterparty at all. uid 1030 names `ACCOUNT HOLDER`, so it falls past `:1004` and reaches `:1097`.
q: Can uid 942's `4380` ever resolve? | assumption: not until the user teaches it. There is no `DBS/ POSB account ending 4380` account in `Darren SGD` and no suffix fact naming 4380, so it is genuinely unresolvable today. It is held with `destination_unresolved`, which is the same honest outcome the outgoing branch already produces for an unresolvable account, and it becomes bookable the moment a fact maps 4380.
q: Is the uid 895 Trust/OCBC row in scope? | a: no. It has a different cause: `source` resolves to `OCBC 360` while `destination` is null and the counterparty is a bank, so it needs its own treatment and is deliberately left alone and tracked on #680.
q: Will the full suite regress? | a: unknown until measured, which is why the plan runs the whole expense-tracker suite as the tests gate and not just the new file. The risk is concentrated in suites that assert on inbound movements — `own-account-fast-transfer-598.test.js`, `transfer-shape-resilience.test.js`, `production-incidents.test.js`, `ocbc-trust-transfer-hold.test.js` — all of which assert on `parseBankMovement` only, so they should be unaffected; `orchestrator.test.js` is the one that may pin resolver outcomes.

## Intent

A bank alert saying money was **received** into an account the tracker can already identify is parsed correctly, matched to a real account, and then thrown away. The alert is never booked and never marked read, so `imap.js:86` re-fetches it as `{ unseen: true }` on every idle poll and the user is notified "Couldn't understand email" forever. Tracked by issue #680.

One harm, one fix: give the incoming direction the counterpart of the block that already exists for outgoing.

## Current behaviour (measured at `3ccf684`, real accounts and the real 253-fact store)

| Body | parsed suffix | `source` resolved | outcome |
|---|---|---|---|
| uid 942 DBS `…ending 4380` | 4380 | **null** (no account, no fact) | dropped |
| uid 1030 DBS `…ending 5750` | 5750 | **DBS Account** (fact `Account ending 5750 belongs to DBS Account`) | dropped |
| uid 895 Trust OCBC `…ending 9001` | — | OCBC 360 | dropped, different cause, out of scope |

End to end through `processEmail`, uid 1030: `action=notified`, no `insert_transaction`, **no** `mark_email_read`, message `Couldn't understand email from "no-reply@dbs" re: "digibank Alerts - You've received a transfer".`

- `_resolveMovementToOutput` (`src/orchestrator.js:733`) resolves accounts at `:741-768`, then gates every booking/holding path on `direction === "outgoing"` at `:1026`. An incoming movement skips the block containing the `destination_unresolved` hold (`:1049`) and the external-payment booking (`:1071`), and the one-sided deposit branch (`:1004`) needs `!counterparty`, which uid 1030 has. Control reaches `return null` at `:1097`.
- `processEmail:633` treats `!phase1` as "could not understand": it notifies and returns without `mark_email_read`.

Why no test caught it: `tests/own-account-fast-transfer-598.test.js` and `tests/transfer-shape-resilience.test.js` carry these bodies but assert only on `parseBankMovement`. The resolver and the `processEmail` path were untested for inbound movements, which is exactly the broken region.

## Target design

In `_resolveMovementToOutput`, add an incoming counterpart immediately **before** the `:1026` outgoing gate, so it is reachable and cannot shadow any outgoing path:

- Condition: `movement.direction === "incoming"` and a resolved `source` (the credited account) and a `date`.
- Resolved-account credit (counterparty is not one of the holder's own accounts): book to `source` with `amount_cents: Math.abs(...)`, `payee_name: "Misc"`, `category_id: null`, `raw_description: "Transfer from <counterparty>"`, `reasoning: "Deterministic incoming bank credit"`, `_structured_movement: true`. Mirrors `:1071` and `:1004`.
- Unresolvable credited account (`!source`): hold as `Misc` with `_hold_cause: "destination_unresolved"`, reusing the outgoing twin's cause so the notification reads the same way.

Outgoing behaviour is untouched: the new branch is gated on `incoming`, sits before `:1026`, and changes no existing line.

Deliberately **not** changed: the person-identity hold (`:913`), the LLM-extractor route (`:1201-1230`), `resolveMovementAccounts`, and the parser. The extractor route's field convention is deliberately different from the parser's, per the comment at `:1201-1221`.

## Test plan (TDD; RED at base, GREEN at HEAD)

Named RED control: `modules/expense-tracker/tests/incoming-credit-booking-680.test.js` → `incoming credit into a resolvable account (issue #680) > books the credit on the resolved account instead of dropping it`. It fails at base with `expected null not to be null`.

The file carries the two real production bodies, PII-redacted the way this repository redacts elsewhere (`tests/bank-movement.test.js:373` cites the convention; suffixes kept so suffix-to-account pairing still resolves, names and amounts shortened), with the live `Darren SGD` account list and the real suffix facts:

1. uid 1030 books on `DBS Account`, `amount_cents` positive `100000`, `action: "insert"`. (RED at base: null.)
2. `processEmail` on uid 1030 does not return `notified`, and calls both `insert_transaction` and `mark_email_read`. (RED at base: `notified`, neither call.)
3. uid 942 (`4380`, unresolvable) is held with `_hold_cause: "destination_unresolved"` rather than dropped. (RED at base: null.)

No LLM is stubbed to a plausible answer: `orch._llm.chat` is a bare `vi.fn()`, so if the deterministic route returned null the full Phase-1 extractor would be asked and the assertion would fail — the defect cannot be masked by a stubbed fallback.

Outgoing regression is covered by the existing suites, which are run in full rather than assumed.

## Risks and how they are handled

- **Booking an unverified person credit as income.** Accepted. `person_transfer` is never set on this route, so `:907` is false; the credit is real and attributable, the alternative is dropping it, and `Misc` with no category records no spend. The hold that stops a transfer *to* a person booking as spend (`:913`) is a different direction and is untouched.
- **Double-booking a leg that is really part of an own-to-own pair.** `resolved.internal` at `:949` is evaluated on the same `source`/`destination` this branch uses, and that check sits between the new branch and `:1026` — so the new branch must be placed *after* `:949`, not before it, or an own-to-own leg would book as a plain credit and lose its transfer pairing. The plan places it immediately before `:1026`, which is after `:949`.
- **The unresolvable hold double-notifying.** It reuses the existing `_hold_unresolved_transfer` mechanism, whose notification path already exists and is pinned by `production-incidents.test.js:872`.
- **uid 942 staying held.** Correct and intended: `4380` has no account and no fact. It books as soon as a fact maps it, with no further change.

## Rollout

No manual production action; the change reaches production through the PR and `deploy.yml`.

## Non-goals

- Not the uid 895 Trust/OCBC row (different cause; tracked on #680).
- Not the LLM-extractor route's field convention, the person hold, `resolveMovementAccounts`, or the parser.
- No change to `mark_email_read` behaviour or to `imap.js` polling.