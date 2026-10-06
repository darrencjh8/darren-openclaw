QUESTIONS
q: Is the defect a missing `incoming` branch, or a wrong `direction` value? | a: a missing branch. `parseBankMovement` returns `direction: "incoming"` for all three real bodies, and `resolveMovementAccounts` returns the correct account. Measured at `3ccf684`: uid 1030 parses with `own_account.suffix "5750"` and resolves `own = destination = source = DBS Account`, then the route returns null.
q: Why does uid 1030 drop when its account resolves? | a: `src/orchestrator.js:1026` opens the booking/holding block with `if (movement.direction === "outgoing")`. The incoming movement skips it, and there is no incoming counterpart, so control reaches the final `return null` at `:1097` with no candidate left. This is the whole defect for a resolvable credit.
q: Why does uid 942 drop, and does it reach `:1097`? | a: no — a different exit. Its `own` is null (no account, no fact for 4380) and its counterparty resolves to nothing, so `source = other || own` is null and the guard at `:774` returns at `:870` via the `return null` on that path. Its hold therefore has to live INSIDE that guard, not beside `:1026`. (Corrected after review round 1 finding H1.)
q: Should an incoming credit with a resolved account BOOK, or be HELD? | a: book. It is a real credit the tracker can attribute to a real account; holding it would keep every received transfer out of the budget forever. The hold stays for a credit whose credited account cannot be resolved (uid 942's `4380`), mirroring the outgoing `destination_unresolved` hold.
q: Which account is the credited one, `source` or `destination`? | a: `destination`. `resolveMovementAccounts` (`bank-movement.js:736`) computes `destination = own` and `source = other || own` for an incoming movement, so the credited own account is `destination` and `source` may be the SENDER's account. The branch keys on `destination_account` being truthy, exactly as the internal-transfer arm at `:951` already does. This is also what keeps uid 895 out: its `own` is null, so `destination_account` is null and the branch does not fire, instead of booking the credit to OCBC 360, the sender. (Corrected after round 1 finding M2.)
q: Does booking an incoming credit risk re-opening the pinned #654 person boundary? | a: yes, and the branch is scoped to avoid it. `production-incidents.test.js:857-870` pins `expect(phase1).toBeNull()` for `RYT_RECEIVED_FROM_PERSON` once a `maps to … payee` fact releases it, and `:841-845` says closing that "means adding an incoming person arm, which is its own change with its own reproduction". So the book arm requires `movement.person_transfer !== true`. The DBS/Trust parser branches do not set `person_transfer` (only the Ryt sentence form at `bank-movement.js:309`/`:355` do), so uid 1030 books and the released Ryt person credit still drops — the pinned boundary is preserved by construction, not by luck. (Corrected after round 1 findings H2 and L1.)
q: Which counterparty side is the other party on an incoming movement? | assumption: the deterministic parser's own convention, not the LLM-extractor route's. On this route the other party is `movement.counterparty`. The extractor route at `:1229-1230` assigns the fields the other way round, and `:1201-1221` documents why that route keys its person flag per direction instead; this change does not touch that route.
q: Should the incoming row be positive, and what payee/category? | assumption: positive (`Math.abs`), `payee_name: "Misc"`, `category_id: null`. Money received is not spend, and the one-sided deposit branch at `:1004` uses `Misc`. No income category is inferred, because the alert names no payer to categorise.
q: Does the one-sided deposit branch at `:1004` already cover this? | a: no. It requires `!movement.counterparty`. uid 1030 names `ACCOUNT HOLDER`, so it falls past `:1004` and reaches `:1097`.
q: Can uid 942's `4380` ever resolve? | assumption: not until the user teaches it. There is no `DBS/ POSB account ending 4380` account in `Darren SGD` and no suffix fact naming 4380, so it is genuinely unresolvable today. It is held with `destination_unresolved`, and it books the moment a fact maps 4380, with no further change.
q: Is the uid 895 Trust/OCBC row in scope? | a: no. `own` is null and the counterparty is a bank, so `destination_account` is null and the new branch does not fire; it keeps dropping exactly as before. Its own cause is tracked on #680.
q: Will the full suite regress? | a: measured, not assumed. The suites that assert resolver outcomes for inbound movements are `production-incidents.test.js` and `ocbc-trust-transfer-hold.test.js`, not the parser-only ones. The `person_transfer !== true` scope is what keeps `:811-825` and `:857-870` green, and both are re-run rather than assumed.

## Intent

A bank alert saying money was **received** into an account the tracker can already identify is parsed correctly, matched to a real account, and then thrown away. The alert is never booked and never marked read, so `imap.js:86` re-fetches it as `{ unseen: true }` on every idle poll and the user is notified "Couldn't understand email" forever. Tracked by issue #680.

One harm, one fix: give the incoming direction the counterparts of the two blocks that already exist for outgoing.

## Current behaviour (measured at `3ccf684`, real accounts and the real 253-fact store)

| Body | parsed suffix | `own`/`destination` | outcome | exit |
|---|---|---|---|---|
| uid 942 DBS `…ending 4380` | 4380 | **null** (no account, no fact) | dropped | `return null` at `:870` |
| uid 1030 DBS `…ending 5750` | 5750 | **DBS Account** (fact `Account ending 5750 belongs to DBS Account`) | dropped | `return null` at `:1097` |
| uid 895 Trust OCBC `…ending 9001` | — | null (`source` = OCBC 360, the sender) | dropped, different cause, out of scope | `:1097` |

End to end through `processEmail`, uid 1030: `action=notified`, no `insert_transaction`, **no** `mark_email_read`, message `Couldn't understand email from "no-reply@dbs" re: "digibank Alerts - You've received a transfer".`

Two exits, two fixes:

- **Resolvable credit.** `:1026` opens the booking/holding block with `direction === "outgoing"`; there is no incoming counterpart. The one-sided deposit branch at `:1004` needs `!counterparty`, which uid 1030 has. Control reaches `return null` at `:1097`.
- **Unresolvable credit.** The guard at `:774` (`if (!source || !date)`) contains two holds, both keyed `direction === "outgoing"` (`:782`, `:842`), so an incoming `!source` movement matches neither and falls to the `return null` at `:870`.

`processEmail:633` treats either null as "could not understand": it notifies and returns without `mark_email_read`.

Why no test caught it: `tests/own-account-fast-transfer-598.test.js` and `tests/transfer-shape-resilience.test.js` carry these bodies but assert only on `parseBankMovement`. The resolver and the `processEmail` path were untested for a resolvable inbound movement, which is exactly the broken region.

## Target design

Two insertions, because the two bodies exit at two different lines.

**1. Unresolvable credited account — inside the `!source || !date` guard, before the `return null` at `:870`.**
Condition: `!source && date && movement.direction === "incoming"`. Returns the same shape as the outgoing `destination_unresolved` twin at `:1049` — `account_id: ""`, `account_name: ""`, `payee_name: "Misc"`, `category_id: null`, `amount_cents: Math.abs(...)`, `_hold_unresolved_transfer: true`, `_hold_cause: "destination_unresolved"` — so the notification path is the existing one and needs no new text.

**2. Resolvable credited account — after the `resolved.internal` arm (`:949`) and before the `:1026` outgoing gate.**
Condition: `movement.direction === "incoming"`, `resolved.destination_account` truthy, a `date`, and `movement.person_transfer !== true`.
Books to `resolved.destination_account` with `amount_cents: Math.abs(...)`, `payee_name: "Misc"`, `category_id: null`, `raw_description: "Transfer from <counterparty>"`, `reasoning: "Deterministic incoming bank credit"`, `_structured_movement: true`, and `_is_paynow` / `_paynow_merchant` mirroring `:1093-1094` so the inbound PayNow hold at `:2092` still fires for this body class.

Both are gated on `incoming` and change no existing line. Outgoing behaviour is untouched.

Placement is load-bearing in three ways, each from a different pinned test:
- **After `:949`** so an own-to-own leg is still paired as a transfer rather than booked as a plain credit.
- **On `destination_account`, not `source`** so uid 895 keeps dropping instead of booking to the sender's account.
- **On `person_transfer !== true`** so `production-incidents.test.js:857-870` keeps pinning the released person credit as dropped.

Deliberately **not** changed: the person-identity hold (`:913`), the LLM-extractor route (`:1201-1230`), `resolveMovementAccounts`, and the parser.

## Test plan (TDD; RED at base, GREEN at HEAD)

Named RED control: `modules/expense-tracker/tests/incoming-credit-booking-680.test.js` → `incoming credit into a resolvable account (issue #680) > books the credit on the resolved account instead of dropping it`. Fails at base with `expected null not to be null`.

The file carries the two real production bodies, PII-redacted the way this repository redacts elsewhere (`tests/bank-movement.test.js:373` cites the convention; suffixes kept so suffix-to-account pairing still resolves, names and amounts shortened), with the live `Darren SGD` account list and the real suffix facts:

1. uid 1030 books on `DBS Account`, `amount_cents` positive `100000`, `action: "insert"`. (RED at base: null.)
2. `processEmail` on uid 1030 does not return `notified`, and calls both `insert_transaction` and `mark_email_read`. (RED at base: `notified`, neither call.)
3. uid 942 (`4380`, unresolvable) is held with `_hold_cause: "destination_unresolved"` rather than dropped. (RED at base: null.)
4. **Boundary guard:** a person-flagged incoming credit released by a `maps to … payee` fact still returns null — the `production-incidents.test.js:857-870` shape, asserted here so the scope cannot be widened silently.

No LLM is stubbed to a plausible answer: `orch._llm.chat` is a bare `vi.fn()`, so if the deterministic route returned null the full Phase-1 extractor would be asked and the assertion would fail — the defect cannot be masked by a stubbed fallback.

Tests gate command, run in full (the pack's scaffold command is a Python `unittest` discovery that matches no file in this module, so it is a misfire and is not used):

```
cd modules/expense-tracker && npx vitest run
```

plus the two resolver suites by name, `production-incidents.test.js` and `ocbc-trust-transfer-hold.test.js`.

The recorded mutation control for the new file links `node_modules` before running, because the driver's throwaway worktree is populated with tracked files only.

## Risks and how they are handled

- **Widening the pinned #654 person boundary.** The book arm requires `person_transfer !== true`, and test 4 asserts the released person credit still drops. `production-incidents.test.js:811-825` and `:857-870` are re-run as part of the gate.
- **Booking a sender's account as the destination.** The branch keys on `destination_account`, never `source`; uid 895 has a null `destination_account` and is re-measured to confirm it still drops.
- **Dropping the inbound PayNow hold.** `_is_paynow`/`_paynow_merchant` are carried as `:1093-1094` sets them, so `:2092` still gates the hold at `:2143-2184`.
- **Double-booking a leg that is part of an own-to-own pair.** `resolved.internal` at `:949` is evaluated on the same accounts this branch uses and sits between the new arm and `:1026`.
- **The unresolvable hold double-notifying.** It reuses `_hold_unresolved_transfer`, whose notification path already exists and is pinned by `production-incidents.test.js:728`, `:744` and `:770`.
- **uid 942 staying held.** Correct and intended: `4380` has no account and no fact. It books as soon as a fact maps it, with no further change.

## Rollout

No manual production action; the change reaches production through the PR and `deploy.yml`.

## Non-goals

- Not the uid 895 Trust/OCBC row (different cause; tracked on #680).
- Not the incoming **person** arm — `production-incidents.test.js:857-870` pins it as its own change with its own reproduction.
- Not the LLM-extractor route's field convention, the person hold, `resolveMovementAccounts`, or the parser.
- No change to `mark_email_read` behaviour or to `imap.js` polling.