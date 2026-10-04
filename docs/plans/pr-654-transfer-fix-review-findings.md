QUESTIONS
q: Should the hold cover a transfer to ANY person, or only the holder's own legal name as today? | a: Any bare person name. The parser already computes `looksLikePersonName` and the existing branch relies on it; the review proved the current narrow gate books a non-holder person unconditionally, so the hold must key on the parser's flag rather than on a memory recall.
q: Where should the flag be consumed — orchestrator or parser? | a: Orchestrator, at the existing hold site (orchestrator.js:761-787). Parsing must stay free of account facts, and that site already builds the held row correctly.
q: Does the held row need `person_transfer` plumbed through `_resolveMovementToOutput`? | a: Yes. `_resolveMovementToOutput` receives the movement, so it can read `movement.person_transfer` directly and extend the existing `unverifiablePersonMovement` condition without a new field.
q: Should the ambiguity case hold or drop? | a: Hold. The branch's own comment promises a hold; silently returning null produces "Couldn't understand this transaction alert." with no notify, which is the regression this change exists to remove.
q: Is `_card_repayment` sanitizing a behaviour change? | a: No. It is a deterministic-parser-only field like its six siblings; a forged value can currently only add a hold, so deleting it is pure hardening with no booking change.

# Fix the three review findings on PR #654

## Problem

Independent review of `be4b124` proved three defects, each reproduced at base `f0b9a5b`.

**F1 (Critical) — a person-to-person transfer is booked as spend.**
`bank-movement.js:347` sets `person_transfer`, and nothing reads it
(`grep -rn person_transfer src/` returns only the two writers). The sole
person-hold is `orchestrator.js:761-765`, which requires the counterparty to be
the holder's OWN legal name, recalled from memory. Consequences:

- transfer to the holder, legal-name fact recalled → held;
- transfer to the holder, fact not recalled → `inserted` as `Misc` spend;
- transfer to ANY other person → `inserted` as `Misc` spend, always.

This is not new: the already-supported `you've sent ... to <person>` form
books the same way at base. The branch added a second way in.

**F2 (High) — the ambiguous sender-bank case is dropped, not held.**
`bank-movement.js:337` claims resolution "holds rather than guessing when that
is ambiguous". It does not. `own_account` carries only a bank, and
`resolveAccountByBank` (`bank-movement.js:701`) returns null unless exactly one
live account matches, so `_resolveMovementToOutput` returns null at
`orchestrator.js:740` and `_runPhase1` yields null. With the LLM unable to read
this sentence either, the user gets "Couldn't understand this transaction
alert." — no hold, no booking, no notification. Any holder with two accounts at
Ryt hits this.

**F3 (High, hardening) — `_card_repayment` is LLM-forgeable.**
`orchestrator.js:1297-1303` deletes six internal flags from untrusted Phase-1
output. The branch's new `_card_repayment` is absent from that list, so an LLM
can supply it. It currently only adds a hold, but it is LLM-reachable control
flow at `:2132` and `:2230`.

## Approach

### F1 — consume `person_transfer`

Extend the existing hold condition instead of adding a new gate, so one site
owns "person movement with no verified leg":

- `orchestrator.js:761-764` — add `movement.person_transfer === true` as an
  OR-term of `unverifiablePersonMovement`. The `!resolved.internal` term
  already stands, so a transfer that DID resolve to a tracked account still
  books as a transfer rather than being held.
- `orchestrator.js:766-786` — the held row is already `Misc`, no category, no
  amount booked. Only `raw_description`/`reasoning` need to stay accurate.

No new field is plumbed: `_resolveMovementToOutput` has the movement in hand.

`looksLikePersonName` is deliberately conservative and the merchant family
already relies on it — `production-incidents.test.js:185` pins that
`CFF UNITED PLT` is not a person. Keeping the parser's own verdict is what
avoids reintroducing the #585/#592 regression the comment at `:743-747`
describes.

### F2 — hold the ambiguous case

`_resolveMovementToOutput` must produce a held row rather than null when the
source cannot be resolved:

- In the `!source || !date` block (`orchestrator.js:705-741`), add a branch
  beside the existing `A/C ending` one: an outgoing movement whose source is
  unresolvable BUT which has a sender bank (so it is a bank alert whose origin
  account is genuinely ambiguous) is held with `_hold_unresolved_transfer`.

Scope is deliberately narrow — it requires `movement.own_account.bank` set and
`resolved.source_account` null. It must not fire for an outgoing movement with
no bank evidence at all, which is the `null` return the LLM fallback exists to
handle.

### F3 — sanitize

Add `delete output._card_repayment;` to the list at
`orchestrator.js:1297-1303`, and extend the existing sanitizer test rather than
adding a file, so the invariant stays pinned next to its siblings.

## Tests

RED first, each failing on `be4b124`:

1. `tests/transfer-person-hold-red.test.js` — transfer to the holder with no
   legal-name fact is held, not inserted; transfer to a NON-holder person is
   held. (currently 2 failed / 1 passed)
2. `tests/transfer-ambiguity-hold-red.test.js` — two Ryt accounts must produce
   a held row, never a null phase1; `_card_repayment` cannot survive Phase 1.
   (currently 2 failed)
3. `tests/llm-output-sanitizer.test.js` — add the flag to the existing
   "strips the other LLM-injectable internal flags too" case.

These are new whole test files under `tests/`, which the dev-loop policy treats
as a `tests_only` mutation, plus one line added to an existing test file.

## Evidence

- RED: both new files fail on `be4b124`; the recorded control fails at base
  `f0b9a5b` (`loop.py repro`, exit 1, test id named).
- GREEN: the same command must exit 0 at HEAD.
- Full suite on Node 22 (`better-sqlite3` is ABI-broken on this container's
  Node 26, a pre-existing condition): the branch currently reports 42 files /
  1203 passed / 5 skipped / 0 failed.

## Not in scope

- The `#574` generic-PayNow hold asymmetry found during review
  (`byId` arm vs `:2155-2159`) — a separate defect with its own reproduction;
  it does not share a root cause with F1-F3 and mixing them would widen the
  diff past what the findings prove.
- `CARD_PRODUCT_RE`'s redundant alternation (`\bcredit\s+cards?\b` already
  covers `\bcredit\s+card\b`) — cosmetic, no behaviour change.