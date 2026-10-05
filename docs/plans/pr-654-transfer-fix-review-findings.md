QUESTIONS
q: Should the hold cover a transfer to ANY person, or only the holder's own legal name as today? | a: Any bare person name. Memory is consulted FIRST; if no fact resolves the counterparty, hold. Never guess. Confirmed by Darren 2026-10-05, superseding the earlier Option 1 (narrow hold).
q: Where should the memory lookup happen? | a: `_resolveMovementToOutput`, at the existing hold site (orchestrator.js:761-787), which already receives the movement. Parsing stays free of account facts.
q: Which memory read decides the person/business question? | a: `list_facts` (full deterministic read from disk), NOT `search_memory`. A recall miss on `search_memory` would silently book a real person transfer as spend, which is the exact defect this closes.
q: What closes the loop when a person-shaped name is held? | a: Hold only, and make the notification say why (Option 1, Darren 2026-10-05). No reply path, no auto-learn. See F1b — the field carrying the reason is `reasoning`, NOT `notify_message`, because the notify path at orchestrator.js:2398 builds its own text and ignores `notify_message`.
q: May the pipeline write facts automatically? | a: Only what the alert itself proves — digits and bank names printed in the body (orchestrator.js:2819 suffix->account, :2749 account type). Never a judgment fact. No new auto-learn is added by this plan.
q: Should the LLM-extractor route be covered too? | a: Yes (H4). `person_transfer` is written at bank-movement.js:301,347 and read NOWHERE. Without setting it on the LLM path, the new hold silently applies only to deterministically-parsed alerts.

# Fix the transfer-shape defects on PR #654 (F1, F1b, F2, F3, H4)

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

**F1b (High) — a hold notifies with text that misstates the cause.**
All three hold sites set `notify_message: ""` (orchestrator.js:735, 783, 905),
and the notify path at `:2398` ignores that field anyway, hardcoding
`Held: transfer destination for ... was not safe to resolve`. For a person-shaped
hold that text is wrong: the destination was never the problem, the counterparty
identity was. Darren chose Option 1 on 2026-10-05 — hold, and say why, with no
reply path and no auto-learn.

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

**H4 (Medium) — the LLM route never sets `person_transfer`.**
Only the two deterministic writers set it. Any F1 fix keyed on that flag would
cover only deterministically-parsed alerts.

## Approach

### F1 — memory-first person hold

Extend the existing hold condition rather than adding a gate, so one site owns
"person movement with no verified leg" (orchestrator.js:761-764):

- `orchestrator.js:761-764` — add `movement.person_transfer === true` as an
  OR-term of `unverifiablePersonMovement`. The `!resolved.internal` term
  already stands, so a transfer that DID resolve to a tracked account still
  books as a transfer rather than being held.
- BEFORE consulting the flag, resolve the counterparty against `list_facts`. A
  fact identifying the counterparty as a non-person (a recorded business /
  payee / vendor) means the alert books normally.
- with no such fact, hold. This is the "memory first, else hold" rule.

`orchestrator.js:766-786` — the held row is already `Misc`, no category, no
amount booked. Only `raw_description`/`reasoning` need to stay accurate.

**Do NOT use `looksLikePersonName` as the person/business discriminator.** It is
structural and list-free, and a person name is indistinguishable from an unlisted
business descriptor on every feature the parser exposes — proven, not asserted:

```
must HOLD:  {"person_transfer":true,"tokens":3,"nonPersonToken":false,"digits":false,"dots":false}   CHONG JIN HENG
must BOOK:  {"person_transfer":true,"tokens":3,"nonPersonToken":false,"digits":false,"dots":false}   BLUE BOTTLE COFFEE
No feature separates the classes: true
```

Memory is the discriminator. Shape is not, and this plan does not pretend
otherwise. (The parser's flag still gates WHICH movements are candidates; it no
longer decides person-vs-business.)

### F2 — hold the ambiguous case

`_resolveMovementToOutput` must produce a held row rather than null when the
source cannot be resolved:

- In the `!source || !date` block (`orchestrator.js:705-741`), add a branch
  beside the existing `A/C ending` one: an outgoing movement whose source is
  unresolvable BUT which has a sender bank (so it is a bank alert whose origin
  account is genuinely ambiguous) is held with `_hold_unresolved_transfer`.

Scope is deliberately narrow — it requires `movement.own_account.bank` set,
`resolved.source_account` null, AND that the alert names no source account at all
(no name, no suffix) while the sender bank has more than one live account. The
hold lands on the FIRST live account at that bank, which is sound because a held
row never inserts, so the account only ever carries the notification.

It must NOT be keyed on `direction + own_account.bank` alone: that predicate also
matches legacy bill payments and cross-bank transfers, which then booked against
the wrong account. Must not fire for an outgoing movement with no bank evidence
at all, which is the `null` return the LLM fallback exists to handle.

### F1b — say why, using the field that actually renders

All three hold sites set `notify_message: ""` (`:735`, `:783`, `:905`), and the
notify path at `:2398` ignores that field anyway, hardcoding
`Held: transfer destination for ... was not safe to resolve`. For a person-shaped
hold that text is wrong: the destination was never the problem, the counterparty
identity was.

Branch that template on the hold's cause: keep the existing destination text for
the two account-resolution holds (`:737`, `:907`), and add a person-identity
variant carrying the counterparty name and the instruction ("tell me it is a
vendor and I will stop holding it"). The held row's `reasoning` already
distinguishes the causes and is logged at `:2403`.

### H4 — set the flag on the LLM path

`person_transfer` is written only at bank-movement.js:301,347 and read nowhere.
Set it from the same shape check the deterministic parser uses, at the Phase-1
sanitize site where the other internal flags are computed, so the LLM route cannot
bypass the F1 hold.

### F3 — sanitize

Add `delete output._card_repayment;` to the list at
`orchestrator.js:1297-1303`, and extend the existing sanitizer test rather than
adding a file, so the invariant stays pinned next to its siblings.

## Tests

RED first, each failing on real code at HEAD `5320503`:

1. `tests/transfer-person-hold-red.test.js` — transfer to the holder with no
   legal-name fact is held, not inserted; transfer to a NON-holder person is
   held. (currently 2 failed / 1 passed)
2. `tests/transfer-ambiguity-hold-red.test.js` — two Ryt accounts must produce
   a held row, never a null phase1; `_card_repayment` cannot survive Phase 1.
   (currently 2 failed)
3. `tests/llm-output-sanitizer.test.js` — add the flag to the existing
   "strips the other LLM-injectable internal flags too" case.
4. NEW — F1b: a hold carries a notification naming the counterparty and the
   cause. H4: an LLM-routed person-shaped alert is held, not booked.

Items 1-2 are new whole test files under `tests/`, which the dev-loop policy
treats as a `tests_only` mutation, plus lines added to existing test files.

## Evidence

- RED: items 1-2 verified failing at HEAD `5320503` on 2026-10-05
  (`transfer-person-hold-red.test.js` -> 2 failed / 1 passed, `expected false to
  be true` x2; `transfer-ambiguity-hold-red.test.js` -> 2 failed, `expected null
  not to be null` and `expected true to be undefined`).
- GREEN: the same commands must exit 0 at HEAD after the change.
- Full suite: MUST be re-measured, not inherited. The earlier "42 files / 1203
  passed / 5 skipped / 0 failed" figure is NOT trusted — it was recorded against
  a different revision, and this container's Node 26 breaks `better-sqlite3` ABI.
  GREEN is a DELTA against a named baseline captured on this machine, not a flat
  count.

## Behaviour changes callers must know about

1. A transfer to any unremembered person-shaped counterparty is HELD, not booked.
   This closes the Critical, and it re-admits the name-shape sensitivity that
   `orchestrator.js:743-747` once removed to fix a real production incident
   (`CFF UNITED PLT` wrongly held). Vendors already recorded in memory keep
   booking; a brand-new vendor notifies once until taught. The must-book pin at
   `production-incidents.test.js:663` (`ACME CONSULTANCY`) therefore changes from
   "must book" to "must hold" and is amended by this change — stated plainly here
   and in the PR body rather than buried.
2. `_card_repayment` is stripped from LLM output (hardening, no booking change).
3. A hold now names the counterparty and the cause in its notification.

## Not in scope

- The `#574` generic-PayNow hold asymmetry found during review
  (`byId` arm vs `:2155-2159`) — a separate defect with its own reproduction;
  it does not share a root cause with F1-F3 and mixing them would widen the
  diff past what the findings prove.
- `CARD_PRODUCT_RE`'s redundant alternation (`\bcredit\s+cards?\b` already
  covers `\bcredit\s+card\b`) — cosmetic, no behaviour change.
- A reply-to-teach resolution path for holds (Darren's Option 2, not chosen).
  Tracked in issue #670.