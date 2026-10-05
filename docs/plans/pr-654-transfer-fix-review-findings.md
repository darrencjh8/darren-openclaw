QUESTIONS
q: Should the hold cover a transfer to ANY person, or only the holder's own legal name as today? | a: Any bare person name, in BOTH directions. Memory is consulted FIRST; if no fact resolves the counterparty, hold. Never guess. Confirmed by Darren 2026-10-05, superseding the earlier Option 1 (narrow hold).
q: Where should the memory lookup happen? | a: `_resolveMovementToOutput`, at the existing hold site (orchestrator.js:761-765), which already receives the movement. Parsing stays free of account facts.
q: Which memory read decides the person/business question? | a: `list_facts` (full deterministic read from disk), NOT `search_memory`. A recall miss on `search_memory` would silently book a real person transfer as spend, which is the exact defect this closes. The read is made only when `movement.person_transfer === true`, so plain merchant alerts pay nothing.
q: EXACTLY which facts release the hold? | a: Only the payee/category mapping grammar — a fact whose key normalises equal to the alert's counterparty name under `normalizeIdentityName` (orchestrator.js:290, already used at :759) using the shape `KEY (merchant )?maps to VALUE (payee|category)`. A legal-name / account-holder fact or an `is a ... account` fact can NEVER release the hold. It is fail-closed: an unrecognised grammar holds.
q: What closes the loop when a person-shaped name is held? | a: Hold only, and name the counterparty and the cause in the notification (Option 1, Darren 2026-10-05). No reply path, no auto-learn, and the notification does NOT tell the user to teach it — nothing would act on that. The cause rides a NEW `_hold_person_identity` flag, not `notify_message` (ignored by the notify path at orchestrator.js:2395-2406) and not `reasoning` (LLM-authored for the three Phase-2 holds).
q: Does the hold also fire on INCOMING person credits? | a: Yes, deliberately. The flag is direction-independent (bank-movement.js:292-293 sets it for `received` as well as `sent`) and an unverified incoming person credit is as unverifiable as an outgoing one; this already matches the #585 precedent that an own-name credit is held rather than booked as income. Stated in Behaviour changes.
q: May the pipeline write facts automatically? | a: Only what the alert itself proves — digits and bank names printed in the body (orchestrator.js:2819 suffix->account, :2749 account type). Never a judgment fact. No new auto-learn is added by this plan.
q: Should the LLM-extractor route be covered too? | a: Yes (H4), and at `_llmExtractMovement` (orchestrator.js:1040-1052) where the movement is built — NOT at the Phase-1 sanitize block at :1297-1303, which runs after every `_resolveMovementToOutput` caller has already returned.
q: Is the generic full Phase-1 LLM path covered? | a: No. The loop at orchestrator.js:1128 never enters `_resolveMovementToOutput`, so no movement hold can reach it. Stated as a boundary and tracked as its own issue.

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
and the notify path at `:2395-2406` ignores that field anyway, hardcoding
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
"person movement with no verified leg" (orchestrator.js:761-765):

- `orchestrator.js:761-765` — add `movement.person_transfer === true` as an
  OR-term of `unverifiablePersonMovement`, and add a `_hold_person_identity: true`
  to the row it returns. The `!resolved.internal` term already stands, so a
  transfer that DID resolve to a tracked account still books as a transfer.
- The held row stays `Misc`, no category, no amount booked. `raw_description`,
  `reasoning` and `payee_source` must say which cause it was.
- No direction term: the hold covers incoming person credits too (see QUESTIONS).
- The existing `knownOwnIdentity` term is unchanged, so nothing that holds today
  stops holding.

**Do NOT use `looksLikePersonName` as the person/business discriminator.** It is
structural and list-free, and a person name is indistinguishable from an unlisted
business descriptor on every feature the parser exposes — proven, not asserted:

```
must HOLD:  {"person_transfer":true,"tokens":3,"nonPersonToken":false,"digits":false,"dots":false}   CHONG JIN HENG
must BOOK:  {"person_transfer":true,"tokens":3,"nonPersonToken":false,"digits":false,"dots":false}   BLUE BOTTLE COFFEE
No feature separates the classes: true
```

Memory is the discriminator. Shape is not, and this plan does not pretend
otherwise. (The parser's flag only gates WHICH movements are candidates.)

#### F1 — the release predicate (exact)

"Memory-first, else hold" is only implementable once the releasing fact is pinned,
because no fact in this module asserts an entity type. Enumerated from the
writers and readers:

| Writer | Fact shape | Can release the hold? |
| --- | --- | --- |
| `memory.migrateFromMappings` (memory.js:967-976) | `KEY merchant maps to VALUE payee` | YES |
| `memory.migrateFromMappings` (memory.js:974) | `KEY maps to VALUE category` | YES |
| `learn_fact` (:2749) | `NAME is a TYPE account` | NO — names an account |
| `_learnSuffixFact` (:2819) | `... ending NNNN belongs to NAME` | NO — no counterparty name |
| legal-name fact (read at :751) | `Legal name: NAME -> PASS (statement password)` | NO — names the holder |

**Release (book normally) when** a `list_facts` fact matches BOTH:

1. **Grammar** — it is a `KEY (merchant )?maps to VALUE (payee|category)` fact.
   This is the only grammar in the module whose key is a counterparty name and
   whose presence asserts that name is a known non-person entity.
2. **Identity** — `normalizeIdentityName(key) === normalizeIdentityName(counterparty)`
   (`normalizeIdentityName` is defined at orchestrator.js:290 and already used for
   exactly this comparison at :759).

Matching is on the fact's KEY, compared whole after normalisation. A substring or
token-overlap match is explicitly forbidden: `Legal name: CHONG JIN HENG -> CHON
(statement password)` shares a token with the counterparty, and an overlap rule
would release a real person transfer — re-opening F1 behind F1.

**Hold** in every other case, including an unrecognised grammar, an unavailable
`list_facts`, and any fact whose key does not normalise equal to the counterparty.
The predicate is fail-closed by construction.

#### F1 — the `paid` sentence form (the third Ryt verb)

`bank-movement.js:275` accepts `received|sent|paid`, but the flag at `:292-293` is
`/^(received|sent)$/i.test(rytSentence[1]) && looksLikePersonName(counterparty)`,
so `paid` is excluded by construction: `You've paid RM100.00 to LEE WEI LING …
using your Ryt Credit` parses with `person_transfer: false` (verified live against
the parser at this revision). That is a hole in the Critical, so the verb list is
widened to `/^(received|sent|paid)$/i`.

This does not disturb the must-book merchant pins, because they reach a different
branch: the `was paid at MERCHANT` form is parsed at bank-movement.js:250-252,
which carries no `person_transfer` key at all, and `looksLikePersonName("CFF
UNITED PLT")` is false (pinned at production-incidents.test.js:113-136). Both
pins are listed in Tests so neither is amended.

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

**Boundary — a sibling drop this plan does NOT close.** The block has a second
null exit: an outgoing movement that *names* a source account which resolves to
nothing (no live account, no suffix fact). That is the phantom-expense family of
issue #592, described in the comment at orchestrator.js:705-711. Closing it is a
separate change with its own reproduction, because the predicate can also fire on
a genuine one-off account the holder has not registered — the opposite trade from
this fix. It is listed in "Not in scope" and pinned by a test so the boundary is
visible in the suite, not only in prose.

### F1b — say why, using a field that actually renders

All three hold sites set `notify_message: ""` (`:735`, `:783`, `:905`), and the
notify path at `:2395-2406` ignores that field anyway, hardcoding
`Held: transfer destination for ... was not safe to resolve`. For a person-shaped
hold that text is wrong: the destination was never the problem, the counterparty
identity was.

Add a dedicated internal flag `_hold_person_identity: true` to the person hold,
stripped alongside `_card_repayment` in F3, and branch the notify template at
`:2395-2406` on it: keep the existing destination text for the two
account-resolution holds (`:737`, `:907`) and add a person-identity variant naming
the counterparty and the cause. `payee_source` gets its own value for the same
reason.

**Do NOT branch on `reasoning`.** It is a literal for the Phase-1 hold but
LLM-authored free text for the three Phase-2 holds (`:2142`, `:2167`, `:2234` all
set `payee_source = "transfer_destination_refused"`), so keying the notification on
it makes the wrong-text failure mode untestable. A dedicated boolean plus
`payee_source` matches the existing vocabulary and the F3 hygiene.

The notification does NOT instruct the user to teach the counterparty: there is no
reply path and no auto-learn (`learn_fact` is called only at :2749 and :2822, and
the payee-mapping grammar is migration-only per memory.js:957-976), so such an
instruction would be a promise the system cannot keep.

Also mark the email read on the hold path. The hold branch never called
`mark_email_read`, while `imap.js:86` re-fetches `{ unseen: true }` on every idle
poll — so a held alert notifies repeatedly today, and with change #1 that would
become the most common merchant shape. The hold is already journaled via
`log_decision` at `:2403`, so nothing is lost by marking it read.

### H4 — set the flag on the LLM-extractor path

`person_transfer` is written only at bank-movement.js:301,347 and read nowhere.
Set it in `_llmExtractMovement` where that route builds its movement
(orchestrator.js:1040-1052), from the same `looksLikePersonName` check the
deterministic parser uses, so the value exists BEFORE `:1053` calls
`_resolveMovementToOutput` and the F1 hold applies to that route too.

It must NOT be set at the Phase-1 sanitize block (`:1297-1303`). Every
`_resolveMovementToOutput` caller — `_runStructuredMovement` (:667-673),
`_llmExtractMovement` (:1053), `_runLegacyBillPaymentMovement` (:1070) — is
reached from `_runPhase1` (:1084-1106) before that block, and nothing feeds its
output back through the resolver, so a value set there could never reach the hold.

The generic full Phase-1 LLM path (loop at :1128, taken when `MOVEMENT_LIKE` does
not match) never enters the resolver at all, so no movement-shaped hold can reach
it. That boundary is stated in "Not in scope" and pinned by a test.

### F3 — sanitize

Add `delete output._card_repayment;` and `delete output._hold_person_identity;` to
the list at `orchestrator.js:1297-1303`, and extend the existing sanitizer test
rather than adding a file, so the invariant stays pinned next to its siblings.

## Tests

RED first, each failing on real code at the revision named in Evidence:

1. `tests/transfer-person-hold-red.test.js` — transfer to the holder with no
   legal-name fact is held, not inserted; transfer to a NON-holder person is
   held. (currently 2 failed / 1 passed at this revision)
2. `tests/transfer-ambiguity-hold-red.test.js` — two Ryt accounts must produce
   a held row, never a null phase1; `_card_repayment` cannot survive Phase 1.
   (currently 2 failed at this revision)
3. `tests/llm-output-sanitizer.test.js` — add BOTH flags to the existing
   "strips the other LLM-injectable internal flags too" case.
4. NEW — F1b: a hold carries a notification naming the counterparty and the
   cause, and the held email is marked read. H4: an LLM-routed person-shaped
   alert is held, not booked.
5. NEW — the release predicate, BOTH directions, so the hold cannot be
   over-broad either way:
   - person counterparty, no fact → held;
   - the same counterparty with a `... merchant maps to ... payee` fact in
     memory → books normally;
   - the same counterparty with ONLY a legal-name fact
     (`Legal name: CHONG JIN HENG -> CHON (statement password)`) → still held
     (the case an overlap rule gets wrong, and F1's own regression guard);
   - an incoming person credit with no fact → held, and NOT booked as income.
6. NEW — boundary pins, so the gaps are visible in the suite and not only in prose:
   - `paid ... to LEE WEI LING` is held (the `:292-293` verb fix);
   - `was paid at CFF UNITED PLT` still books (must-book pin preserved);
   - `ACME CONSULTANCY` is now held (must-hold pin, amended — see Behaviour changes);
   - an outgoing movement naming an unresolvable source account still yields the
     current drop (the F2 boundary).

Items 1-2 are new whole test files under `tests/`, which the dev-loop policy
treats as a `tests_only` mutation, plus lines added to existing test files.

## Evidence

- **RED — this is the recorded reproduction.** Verified at revision `51a9498` on
  2026-10-05, with the two RED files present as untracked worktree files:

  ```
  cd modules/expense-transfer-shape-fix/modules/expense-tracker   # (worktree path)
  PATH=<node22>/bin:$PATH npx vitest run \
    tests/transfer-person-hold-red.test.js tests/transfer-ambiguity-hold-red.test.js
  → Test Files 2 failed (2) | Tests 4 failed | 1 passed (5)
  ```

  Failing assertions, named: `transfer-person-hold-red.test.js:57` and `:78`
  `expected false to be true`; `transfer-ambiguity-hold-red.test.js:96`
  `expected true to be undefined`; and the ambiguity case asserting the notify
  string `Couldn't understand this tran…` instead of a held row.
- **The `repro_evidence` in `.agents/dev-loop-state.json` is NOT used as the RED
  record.** Its output prints `FAIL:` and `PASS:` for the same `test_id` and it
  names base `f0b9a5b` rather than the branch tip, so it is non-atomic and cannot
  be read as a repro (gap G1 in `.agents/dev-loop/gap-findings-654.md`). The
  command above supersedes it.
- **GREEN (exact):** the same command must exit 0 after the change.
- **Full suite — named baseline, measured on this machine.** This container's own
  Node is v26.5.1, which cannot load the `better-sqlite3` binding (absent for
  that ABI), so a bare `npx vitest run` is not a valid baseline: it reported
  `12 failed | 32 passed (44)` files / `153 failed | 1055 passed | 5 skipped`
  tests, every failure a missing-bindings error that says nothing about the code.
  Baseline captured under **Node v22.20.0** (the version CI uses, `test.yml:24`),
  installed to `/workspace/.tools/node-v22.20.0-linux-x64`, after
  `npm rebuild better-sqlite3` in the gitignored `node_modules` — a local
  environment fix that touches no tracked file:

  ```
  cd modules/expense-tracker
  PATH=/workspace/.tools/node-v22.20.0-linux-x64/bin:$PATH npm test
  ```

  **Baseline at `51a9498`, WITH the two RED files present:**
  `1200 passed | 8 failed | 5 skipped (1213)`, `Test Files 4 failed | 40 passed (44)`.

  The 8 failures are NOT all this change's. Measured individually:
  - `transfer-person-hold-red.test.js` — 2 failed (the F1 RED, expected);
  - `transfer-ambiguity-hold-red.test.js` — 2 failed (the F2/F3 RED, expected);
  - `orchestrator.test.js` — 4 failed, all `Test timed out in 5000ms`
    (`:2726`, `:2835`, `:2907`, `:3078`, the #574 journal cases), and they fail
    when that file is run alone too;
  - `dedup.test.js` — worker-hook `onTaskUpdate` timeouts (`:14`, `:81`, `:177`).

  The last two are **pre-existing environment timeouts in this container, not
  code failures**: both files drive real sqlite/worker fixtures and are slow
  enough here (261s and 48s) to trip vitest's 5s per-test and worker-RPC
  deadlines. They do not reproduce in CI on Node 22 — the `expense-tracker`
  check passes on this branch — and their counts vary between runs on this box
  (`8 failed` and `11 failed` were both observed at the same revision). They are
  therefore excluded from the delta by name, not by a total.

  **GREEN is therefore:** the two RED files pass; the pins in Tests item 6 hold
  their new outcomes; no failure appears in any file this change touches
  (`bank-movement.js`, `orchestrator.js` and their suites); and the run's
  failures are exactly the two flaky files above, with no new file or test name
  among them. **CI on Node 22 (`npm ci && npm test`) is the authoritative
  full-suite gate**, because this container cannot produce a stable total.
- The earlier "42 files / 1203 passed / 5 skipped / 0 failed" figure was recorded
  against a different revision and is NOT inherited. It is replaced by the
  measured run above.

## Behaviour changes callers must know about

1. A transfer in EITHER direction to any unremembered person-shaped counterparty
   is HELD, not booked — outgoing stops being booked as spend, and incoming stops
   being booked as income. This closes the Critical, and it re-admits the
   name-shape sensitivity that `orchestrator.js:743-747` once removed to fix a real
   production incident (`CFF UNITED PLT` wrongly held). A counterparty with a
   `maps to ... payee|category` fact in memory books normally; a brand-new vendor
   is HELD every time until such a fact exists — which today means a
   migration-written or hand-written fact line, NOT a reply to the notification.
   The must-book pin at `production-incidents.test.js:663` (`ACME CONSULTANCY`)
   therefore changes from "must book" to "must hold" and is amended by this
   change — stated plainly here and in the PR body rather than buried. The
   `CFF UNITED PLT` pin at `:646-660` and the `was paid at` form are NOT affected.
2. `_card_repayment` and `_hold_person_identity` are stripped from LLM output
   (hardening, no booking change).
3. A hold now names the counterparty and the cause in its notification.
4. A held email is marked read, so it no longer re-notifies on every idle poll.
   This is new: today the hold branch never called `mark_email_read`.

## Not in scope

- The `#574` generic-PayNow hold asymmetry found during review
  (`byId` arm vs `:2155-2159`) — a separate defect with its own reproduction;
  it does not share a root cause with F1-F3 and mixing them would widen the
  diff past what the findings prove.
- The named-but-unresolvable source-account drop (the F2 boundary above, the
  issue #592 phantom-expense family) — pinned by a test, fixed separately.
- Person-shaped counterparties on the generic full Phase-1 LLM path (:1128),
  which never enters `_resolveMovementToOutput` and cannot reach a movement hold.
- `CARD_PRODUCT_RE`'s redundant alternation (`\bcredit\s+cards?\b` already
  covers `\bcredit\s+card\b`) — cosmetic, no behaviour change.
- A reply-to-teach resolution path for holds (Darren's Option 2, not chosen).
  Tracked in issue #670.