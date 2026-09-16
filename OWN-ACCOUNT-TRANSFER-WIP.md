# WIP — own-account transfer holds (#574 / #575 / #576)

**Status: SUSPENDED for handoff.** Analysis complete, **no code changes yet**.
Branch `fix/own-account-transfer-holds` (from `origin/main` @ `b06946f`).
Worktree `/workspace/do-transfer-fix` — left in place for the next agent.

## What this fixes

Three related but distinct defects on the own-account-transfer path. All three
were observed live on 2026-09-15 (budget `Darren SGD`), each firing a spurious
"held" alert on a transfer that was **already booked**.

| issue | alert shape | failing gate | field set |
|---|---|---|---|
| #574 | SC: `received ... from CHONG JIN HENG` (holder's name = a person) | `payee_name` fell to `Misc`, so the transfer block at `orchestrator.js:1602` is skipped, the hold is never cleared (`:1652`), and the notify at `:1859` fires | `_hold_unresolved_paynow` |
| #575 | Trust: `received ... from Standard Chartered Bank (Singapore) Limited A/C ending 6445` | `transferDestinationIsAmbiguous` (`:288`) compares the bank-only **name** to account names and never reads the suffix in `raw_description` | `_hold_unresolved_transfer` / `payee_source: transfer_destination_refused` |
| #576 | Trust: `Your credit card repayment of S$ 1.00 ... is successful` | `_detectAccountType(...) === "credit card"` (`:1624`) refuses **any** credit-card destination, with no exception for a repayment — where the card *is* the destination | `_hold_unresolved_transfer` / `transfer_destination_refused` |

## Key finding (drives the fix)

**Phase 1 (the LLM) resolves all three destinations correctly.** From the live
module log for each uid, `phase1_output` already carries the right answer:

- uid 892 (#574): `merchant: "CHONG JIN HENG"`, `_is_paynow: true`, `account_id: <SC Bonus Saver>`, `amount_cents: 100`
- uid 895 (#575): `merchant: "Standard Chartered Bank (Singapore) Limited A/C ending 6445"`, `account_id: <SC Bonus Saver>`
- uid 896 (#576): `merchant: "Trust Card Repayment"`, `account_id/destination: Trust Card`, direction card-repayment

So the defects are **all in the Phase-2 deterministic gates**, which override a
correct Phase-1 answer with a refusal. Do **not** try to fix this in the prompt.

## Fix direction (aligned with the open direction in #569)

1. **Destination resolution precedence** — a structured destination (suffix in
   the body, e.g. `A/C ending 6445`, or a `_structured_movement`) must resolve
   the counterparty account *before* the bank-name ambiguity check runs. The
   repo already has the machinery: `suffix-facts.js` (`parseSuffixFact`,
   `canonicalSuffixFact`) and `bank-movement.js` (`resolveMovementAccounts`,
   suffix→account map). Wire it in; don't re-implement.
2. **Repayment exception (#576)** — a credit-card destination must be allowed
   when the alert is a repayment (move into the card), not refused on account
   type alone. #563's refusal was written for outgoing payments; a repayment is
   the case the card *is* the destination.
3. **Journal-aware suppression (#574)** — before notifying, consult the transfer
   journal for an already-`inserted` leg matching amount + booked account (+ a
   short date window) and suppress the hold. A working pattern already exists in
   `tools.js:1352 _handle_reserve_transfer` (it looks for `far_side_candidate`).
   Also drop the `payee_name !== "Misc"` gate at `:1602` so a person-name credit
   can still clear.

## Getting it green locally (important)

- **Node 22 is required.** Local node is **v26**; `better-sqlite3` has no
  prebuilt for it and `node-gyp` fails (`v8::Object has no member GetPrototype`).
  Use `/opt/data/tools/node-v22.20.0-linux-x64/bin` on `PATH` (already
  downloaded), then `npm ci`.
- **Baseline has 3 pre-existing failures, all environmental — not yours:**
  - `tests/statement/pdf-password.test.js` ×2 → `spawn qpdf ENOENT`
  - `tests/merchant-resolution.test.js` ×1 → needs live production memory
  CI installs `qpdf` and has the live services, so all three are green in CI.
  Anything else failing is a real regression.

## Where to add tests

- `tests/orchestrator.test.js` — the transfer-refusal block already lives around
  line 2885 (`refuses ambiguous, closed, credit-card, and self transfer
  destinations (#563)`). Add cases mirroring it for #574/#575/#576.
- `tests/bank-movement.test.js` — exercises `resolveMovementAccounts` with
  suffix evidence (see ~line 980+). The #575 suffix path belongs here.

## Real (redacted) alert shapes to drive the tests

Captured verbatim from the production inbox on 2026-09-15. Suffixes and product
names are non-secret and are what resolution keys on.

```
#575 — Trust inbound, counterparty named by SUFFIX
subject: KACHING. You've got a transfer
body:    Sweet! You have received SGD 1.00 from Standard Chartered Bank
         (Singapore) Limited A/C ending 6445 on 16 Sep 2026 07:47 SGT.
amount:  100 cents   expect: resolves to "SC Bonus Saver" via suffix 6445

#576 — Trust credit-card repayment
subject: Repayment successful
body:    Your credit card repayment of S$ 1.00 on 16 Sep 2026 07:55 SGT is
         successful.
amount:  100 cents   expect: destination card "Trust Card", booked, no hold

#574 — SC credit from the holder's own NAME (a person, not an account)
subject: Banking Transaction Email Alert
body:    You have received a PayNow/FAST transfer of SGD 1.00 from
         CHONG JIN HENG| on 16-Sep-26 07:19 AM.
amount:  100 cents   expect: hold suppressed when the journal already has the
                     matching inserted leg
```

## Evidence

- Live module log (`docker logs modules-expense-tracker-1`, 2026-09-15
  23:19–23:56Z) shows each `phase1_output`, then the Phase-2 refusal, then the
  `notify_user_sent`.
- Transfer journal `dedup.db` → `transfer_journal` ids 7 (100c) and 8 (1999900c),
  both `status: inserted`, are the transfers that were already booked.
- An opencode exploration run (~40 min) produced **no file changes**; its
  transcript is at `/opt/data/tmp/oc-transfer-fix.log` if useful.
