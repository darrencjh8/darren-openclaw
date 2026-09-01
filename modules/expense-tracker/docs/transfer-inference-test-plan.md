# Internal Transfer Inference and Test Plan

## Goal

Correctly infer internal transfers from bank alerts, create exactly one Actual transfer, and deduplicate the counterpart alert from the receiving bank. Preserve external bank payments as ordinary expenses.

An internal transfer is only created when both sides resolve deterministically to two distinct, open Actual accounts.

## Scope

This work covers structured movement alerts from OCBC, Trust Bank, and DBS, including DBS successful bill-payment alerts.

The DBS fixture below must be handled without an LLM when its source and destination account identities are configured and resolve uniquely:

```text
Transaction Ref: 17881959177693481349

You’ve successfully made a bill payment.

Date and Time: 01 Sep 01:05 (SGT)
Amount: SGD 1299.29
From: Altitude (A/C ending 9302)
To: UOB CREDIT CARDS (Ref ending 4605)
```

Expected normalized movement:

```text
source: DBS Altitude, suffix 9302
destination: UOB CREDIT CARDS, suffix 4605
amount: -129929 cents
currency: SGD
time: 2026-09-01T01:05:00+08:00
reference: 17881959177693481349
```

If `UOB CREDIT CARDS` plus suffix `4605` resolves to an open Actual account, send an Actual transfer from `DBS Altitude` to that account. If destination account identity is absent or ambiguous, do not guess a transfer; send it through review/normal fallback.

The same generic flow must support these sanitized fixture variants:

```text
DBS:  Altitude (A/C ending <source>) -> CITI CREDIT CARDS (Ref ending <destination>)
OCBC: 360 Account (-<source>) -> OCBC <card product> Visa Card (-<destination>)
```

Both become Actual transfers only when each destination issuer + suffix maps uniquely to an open Actual account and a live transfer payee exists. The parser must not contain card-product-specific logic for `Altitude`, `CITI CREDIT CARDS`, or an OCBC Visa product.

## Non-goals

- Do not infer an internal transfer from words such as "transfer" or "PayNow" alone.
- Do not identify an Actual account from a recipient display name alone.
- Do not silently deduplicate ambiguous candidates.
- Do not require a staging Actual server. Tests assert the exact command sent to the Actual adapter.

## Examples

### Internal transfer

OCBC outgoing alert:

```text
Amount : SGD 14.25
From your account : 360 Account (-869001)
To account : Darren Trust (-310980) at TRUST BANK SINGAPORE LIMITED
Date of Transfer : 01 Sep 2026
Time of Transfer : 01.06 AM SGT
Reference number : 2609010016652878
```

Trust incoming alert:

```text
You have received SGD 14.25 from OverseaChinese Banking Corporation Ltd
A/C ending 9001 on 01 Sep 2026 01:06 SGT.
```

Expected result: one Actual transfer between `OCBC 360` and `Trust Card`; the second alert is recorded as its counterpart and sends no second transaction to Actual.

### External payment

```text
The following PayNow transfer has been made to SIONG93 LLP using their
Unique Entity Number (UEN) T20LL0428K289.

Amount : SGD 7.30
From your account : 360 Account (-869001)
Description : T20LL0428K289QLW511452054
```

Expected result: ordinary outgoing expense from `OCBC 360`, with `SIONG93 LLP` as display merchant and the UEN description retained as raw merchant descriptor. It is not an Actual transfer.

### One-sided deposit / credit

```text
A deposit was made in your account.
Time of deposit : 11:59 PM
Amount : SGD 0.20
Account that money was deposited in : (-869001)
Reference :
```

Expected normalized movement:

```text
direction: incoming
amount: +20 cents
currency: SGD
own account: OCBC, suffix 869001
counterparty: unknown
reference: empty
```

Expected result: one ordinary positive transaction in `OCBC 360`, marked as an unidentified deposit/credit. It is not an internal transfer and must never be auto-deduplicated against a transfer because the alert supplies no source account, counterparty, or reference. Use the received email timestamp in `Asia/Singapore` for the date when body contains time but no date.

## Design

### 1. Extract bank-movement evidence

Add a pure parser that emits normalized movement evidence when an alert has a supported, structured layout. The parser must return `null` when required evidence is absent so existing LLM flow remains available.

```js
{
  kind: "bank_movement",
  direction: "outgoing" | "incoming",
  amount_cents: -1425 | 1425,
  currency: "SGD",
  occurred_at: "2026-09-01T01:06:00+08:00",
  own_account: { bank: "OCBC", suffix: "869001" },
  counterparty: {
    name: "Darren Trust",
    bank: "TRUST BANK SINGAPORE LIMITED",
    suffix: "310980",
  },
  reference_number: "2609010016652878",
  merchant_display_name: null,
  raw_merchant_descriptor: "",
}
```

Supported field variants include:

```text
From:
From your account:
To:
To account:
Account that money was deposited in:
Date:
Date of Payment:
Date and Time:
Time:
Time of Payment:
(A/C ending 5750)
(Ref ending 3255)
(-869001)
A/C ending 9001
```

For a date without a year, derive the year in `Asia/Singapore` from the email received timestamp, with an explicit year-boundary test. Do not use container-local time. Time parsing accepts `01:05`, `01:05 AM`, `01:05 am`, and `01.05 AM` with an explicit timezone marker where present.

Implement extraction in layers: generic labelled-field parser first, reusable account-identifier parser second, and small sender-bank adapters only for layouts that cannot be expressed as labels (for example, Trust's natural-language received alert). Card products and issuer names are extracted values, not parser branches.

The parser extracts evidence only. It does not decide that a movement is internal. A one-sided credit with only `own_account` is classified as ordinary incoming transaction, never as internal transfer.

### 2. Resolve account identity

Resolve account identity from live open Actual accounts first, then use an explicit verified identity registry only when Actual account names do not contain sufficient bank/suffix evidence. Unknown card products require no parser changes.

For every alert, fetch the live Actual account list and normalize each account name into bank aliases and any full/last-four account identifiers present in its name. Match bank + full suffix first, then bank + unique last-four suffix. Confirm that the selected account has a live transfer payee when it is used as an internal-transfer destination.

Supported verified registry facts, used only as deterministic fallback:

```text
Account ending 869001 belongs to OCBC 360
Trust Bank Singapore Limited account ending 310980 belongs to Trust Card
Trust Bank alert recipient maps to Trust Card account
DBS account ending 9302 belongs to DBS Altitude
UOB CREDIT CARDS account ending 4605 belongs to UOB Card
CITI CREDIT CARDS account ending 4756 belongs to Citi Card
OCBC Visa Card account ending 1149 belongs to OCBC Visa Card
```

For the DBS layout, resolve the source by verified DBS + suffix `9302`; do not require the live Actual account name to contain the literal string `DBS`. `Altitude` and `DBS Altitude` must be normalized equivalent account labels only after suffix and sender-bank validation. For destination cards, issuer plus suffix is identity evidence; labels such as `CITI CREDIT CARDS` and card product text are not enough without suffix mapping.

Rules:

1. Live Actual account match with full suffix exact match wins.
2. Live Actual account match with short suffix is permitted only when unique within the same bank.
3. Verified registry fallback may map a bank + suffix to one specific live Actual account ID only; LLM or semantic memory cannot authorize this mapping.
4. The sender/counterparty bank must match.
5. The target account must be open and in the selected budget.
6. Destination must have a live transfer payee whose `transfer_acct` equals target account ID.
7. Multiple candidates are unresolved.
8. Recipient display names such as `Darren Trust` are not account identity.

`9001` may resolve to account suffix `869001` only if it is the unique OCBC account with that last-four suffix. Do not persist a new alias based on one alert.

For a receiving-bank alert with no destination account number, use an explicit verified recipient-account mapping only. Sender domain alone is insufficient when multiple accounts at that bank exist.

### 3. Classify movement

Use normalized evidence and account resolution:

```text
source Actual account and destination Actual account resolve uniquely:
  internal transfer candidate

only source account resolves:
  external payment / ordinary merchant transaction

only destination/own account resolves and direction is incoming:
  ordinary unidentified deposit/credit; never transfer counterpart

ambiguous or insufficient account evidence:
  existing LLM flow or review notification
```

The PayNow UEN example has no destination Actual account, so it must follow ordinary merchant resolution.

### 4. Persist and create an internal transfer exactly once

Store correlation and recovery state in the existing persistent SQLite database at `data/dedup.db`. In production, `data` is bind-mounted into `/app/data`, so state survives container recreation. This is not a wait queue: every counterpart alert checks the journal immediately.

Create a `transfer_journal` table containing:

```text
id
budget_id
source_account_id
destination_account_id
currency
amount_cents
occurred_at_sgt
status                 -- pending | inserted | failed
actual_transaction_id  -- when returned by adapter
source_alert_seen      -- boolean
counterpart_alert_seen -- boolean
last_error
created_at
updated_at
```

Keep account direction ordered. Both bank-side emails reconstruct the same logical movement:

```text
OCBC outgoing:  source OCBC 360, destination Trust Card
Trust incoming: source OCBC 360, destination Trust Card
```

A real reverse movement is distinct:

```text
Trust outgoing: source Trust Card, destination OCBC 360
```

This prevents a real reverse transfer from being discarded as a counterpart.

Use an atomic SQLite `BEGIN IMMEDIATE` transaction to query and reserve a matching transfer domain:

```text
budget + ordered source/destination account IDs + currency + absolute amount
+ Singapore timestamp within 10 minutes
```

The transaction serializes candidate lookup and `pending` insertion. It covers neighbouring time windows, so alerts at `01:06` and `01:07` cannot reserve different exact-timestamp keys and insert duplicates concurrently.

Insertion workflow:

1. In `BEGIN IMMEDIATE`, locate candidate journal rows in the 10-minute domain.
2. If exactly one `inserted` candidate exists, reconcile this alert as counterpart; do not call Actual.
3. If exactly one fresh `pending` candidate exists, leave it pending and retry/reconcile later; do not call Actual.
4. If no candidate exists, insert a `pending` journal row and commit reservation.
5. Send one transfer command to Actual using destination account's transfer payee.
6. On confirmed adapter success, save returned Actual transaction ID and mark row `inserted`.
7. On a definite non-commit failure, such as validated local input failure or an explicit non-retriable client response, mark row `failed`.
8. On ambiguous result, such as timeout, connection reset, or retriable server response, retain `pending`. Before any retry, query Actual for the exact matching transfer and mark `inserted` if found. Retry only after proving it is absent.

### 5. Reconcile counterpart alert and clean journal

A counterpart candidate must have:

- Same ordered source and destination Actual account IDs.
- Same currency.
- Same absolute amount.
- Timestamp within 10 minutes when both alerts include a timestamp.
- Exactly one matching `inserted` transfer.
- Complementary bank-side evidence: source-bank outgoing alert versus destination-bank incoming alert.

If all conditions pass, mark the alert processed, set `counterpart_alert_seen`, and log `transfer_counterpart_deduplicated`. Do not call Actual insertion.

If timestamp is absent, or zero/multiple candidates match, do not silently deduplicate.

Recovery and cleanup:

1. On startup and before retrying a stale `pending` row, reconcile it against Actual using account IDs, amount, currency, date/time window, and transfer payee.
2. A `pending` row is never converted to `failed` merely because it is old.
3. Retain `inserted` and verified `failed` rows for 90 days, matching existing dedup retention, then delete them in the existing periodic cleanup.
4. Retain unreconciled `pending` rows for 90 days and surface them in logs/health diagnostics; delete only after explicit operator review or confirmed absence from Actual.

Use `Asia/Singapore` time for matching; do not compare bare UTC dates.

### 6. Harden merchant inference

For ordinary payments, payee resolution order is:

1. Exact normalized raw descriptor mapping.
2. Exact normalized merchant display-name mapping.
3. Semantic memory only when score is at least `0.75`, meaningful tokens overlap, and processor-prefixed descriptors match their suffix exactly.
4. `resolve_merchant` fallback.
5. `Misc` or review.

This must reject `AMAZE* OPENCODE` mapping to `Wallet` from a low-score (`0.427`) `AMAZE* ALIPAYPROGRA` result.

Remove or replace the unsafe generic fact:

```text
Darren Trust maps to Charity payee
```

Use structured account identity facts instead.

## Test Plan

All test emails are sanitized synthetic fixtures. No production email content, credentials, or account identifiers are committed.

### Test layers

| Layer | Network | Purpose |
| --- | --- | --- |
| Parser unit tests | No | Validate exact extraction and null fallthrough. |
| Account resolver unit tests | No | Validate bank/suffix uniqueness and ambiguity safeguards. |
| Orchestrator integration tests | No | Validate transfer classification, deduplication, recovery, and outbound Actual command. |
| Real-LLM contract tests | Optional manual/nightly | Validate fallback behavior using sanitized fixtures. |

### Fixtures

Create sanitized fixtures for:

- OCBC outgoing transfer to Trust Bank.
- Trust incoming transfer from OCBC.
- Existing DBS bill-payment transfer format, including `Date and Time` and transaction reference.
- DBS Altitude to Citi Credit Cards bill payment.
- OCBC 360 to OCBC Visa card bill payment using `Date of Payment` / `Time of Payment`.
- OCBC PayNow UEN external payment.
- OCBC one-sided deposit alert with account suffix and empty reference.
- Ordinary merchant purchase alert.
- Ambiguous suffix and ambiguous counterpart cases.

### Parser assertions

```text
PASS: OCBC `From your account` / `To account` extracts source, destination, amount, date, time, currency, and reference.
PASS: Existing DBS `A/C ending` / `Ref ending` format remains supported.
PASS: DBS `Date and Time: 01 Sep 01:05 (SGT)` produces `2026-09-01T01:05:00+08:00` from fixture receive timestamp.
PASS: DBS transaction reference is extracted unchanged.
PASS: DBS Altitude -> CITI CREDIT CARDS extracts source suffix, destination issuer/suffix, and transfer timestamp without card-product-specific parser logic.
PASS: OCBC `Date of Payment` / `Time of Payment`, lower-case `am`, and card suffix `(-<suffix>)` extract source/destination identity and timestamp.
PASS: Trust `Sweet! You have received ... from ... A/C ending <suffix> on <date> <time> SGT` alert extracts incoming direction, source bank, suffix, amount, date, and time.
PASS: Trust incoming transfer fixture never calls Phase 1 LLM and never runs memory-driven account override.
PASS: PayNow UEN extracts source account, merchant display name, and raw descriptor but no destination account.
PASS: OCBC one-sided deposit extracts incoming amount, own-account suffix, and body time; it uses fixture received timestamp for date when body omits date.
PASS: Ordinary purchase returns null from movement parser.
PASS: Missing required account evidence returns null.
```

### Account-resolution assertions

```text
PASS: Previously unseen card account in live Actual context resolves without registry when account name contains matching bank + suffix.
PASS: Full suffix `869001` resolves OCBC 360.
PASS: `9001` resolves OCBC 360 only when it uniquely matches that bank's last four digits.
PASS: `9001` is unresolved when two OCBC accounts match.
PASS: Exact Trust Bank + `310980` resolves Trust Card.
PASS: Exact DBS + `9302` resolves DBS Altitude even if live Actual name is `Altitude`.
PASS: Exact UOB CREDIT CARDS + `4605` resolves UOB Card only when configured and open.
PASS: Exact CITI CREDIT CARDS + `4756` resolves Citi Card only when configured and open.
PASS: Exact OCBC card issuer + last-four `1149` resolves its card only when configured and open.
PASS: `Darren Trust` display name alone does not resolve Trust Card.
PASS: Card known only by generic Actual name with no matching suffix remains unresolved until explicit verified registry mapping exists.
PASS: Closed accounts do not resolve.
PASS: Cross-bank suffix matches do not resolve.
```

### Internal-transfer assertions

```text
PASS: OCBC outgoing first creates one transfer command.
PASS: Trust incoming second sends no Actual command and is marked counterpart-deduplicated.
PASS: Trust incoming alert resolves source OCBC 9001 to OCBC 360 only through unique bank+suffx identity, never through a `maps to ... payee` memory fact.
PASS: DBS bill payment from Altitude (`9302`) to UOB CREDIT CARDS (`4605`) sends one transfer command when both accounts resolve.
PASS: Same DBS bill payment with missing or ambiguous UOB `4605` mapping sends no transfer command and enters review/normal fallback.
PASS: DBS Altitude -> Citi Credit Cards sends one transfer command when Citi `4756` resolves uniquely.
PASS: OCBC 360 -> OCBC Visa card sends one transfer command when card `1149` resolves uniquely.
PASS: Either card payment with missing/ambiguous destination mapping sends no transfer command.
PASS: One-sided OCBC deposit creates one ordinary positive transaction in OCBC 360 and sends no transfer payee.
PASS: One-sided OCBC deposit with same amount/time as an internal transfer is not counterpart-deduplicated.
PASS: Trust incoming first creates a transfer only with explicit verified recipient-account mapping.
PASS: Trust incoming first without recipient-account mapping does not create a transfer.
PASS: Same ordered source/destination accounts, amount, currency, and timestamp create one transfer.
PASS: Counterpart timestamps one to ten minutes apart create one transfer, including concurrent processing.
PASS: Timestamps more than ten minutes apart create two transfers.
PASS: Same accounts and amount but transfers 30 minutes apart create two transfers.
PASS: Real reverse transfer (Trust Card -> OCBC 360) within ten minutes creates a second transfer.
PASS: Same amount/date with different destination account IDs creates two transfers.
PASS: Concurrent processing of both alerts sends exactly one transfer command.
```

### Actual adapter HTTP-boundary assertions

Mock `fetch` at the Actual adapter boundary and assert the exact HTTP request body after MCP/schema transformation. No staging Actual server is needed. Add schema coverage so transfer payee selection is not stripped before it reaches the adapter.

For the OCBC-to-Trust transfer, assert the request uses the field names and body shape the Actual adapter actually sends, including:

```text
account: OCBC_360_ID
date: 2026-09-01
amount: -1425
payee: TRUST_CARD_TRANSFER_PAYEE_ID
category: omitted or null according to Actual adapter contract
notes: contains 2609010016652878
```

Required assertions:

```text
PASS: source account is OCBC 360.
PASS: amount is -1425 cents.
PASS: payee is Trust Card's live Actual transfer payee, whose `transfer_acct` equals Trust Card's account ID.
PASS: no ordinary expense category is sent for the transfer.
PASS: Charity payee is never sent.
PASS: exactly one HTTP insertion request is sent.
PASS: transfer payee selection survives MCP/schema and adapter transformations.
```

For the Trust counterpart:

```js
expect(actualFetch).not.toHaveBeenCalled();
expect(markEmailRead).toHaveBeenCalledTimes(1);
expect(logDecision).toHaveBeenCalledWith(
  expect.objectContaining({
    action: "transfer_counterpart_deduplicated",
  }),
);
```

For PayNow UEN, assert final HTTP body has OCBC 360, amount `-730`, the resolved ordinary merchant payee, and `SIONG93 LLP` as imported description. It must not contain a transfer payee or destination Actual account ID.

For one-sided OCBC deposit, assert final HTTP body has OCBC 360, amount `+20`, an unidentified-deposit description, no transfer payee, and no ordinary expense category unless an explicit user-approved deposit rule exists.

Required assertions:

```text
PASS: no transfer payee is sent.
PASS: no destination Actual account ID is sent.
PASS: raw UEN descriptor is preserved in final adapter notes/body.

For the DBS bill-payment fixture, assert final Actual HTTP body uses DBS Altitude as source, amount `-129929`, UOB Card's verified transfer payee, no ordinary category, and notes containing transaction reference `17881959177693481349`.
```

### Recovery and safety assertions

```text
PASS: definite non-commit insertion failure marks journal `failed`; a retry may insert.
PASS: remote commit followed by client timeout remains `pending`, reconciles Actual, and never duplicates.
PASS: recovery of every stale `pending` journal entry checks Actual before retrying.
PASS: journal failure after Actual success reconciles with Actual and prevents duplicate insert.
PASS: multiple counterpart candidates do not silently deduplicate.
PASS: low-score `AMAZE* OPENCODE` -> Wallet mapping is rejected.
PASS: exact `AMAZE* ALIPAYPROGRA` -> Wallet mapping remains accepted.
PASS: a merchant/payee memory result cannot override source or destination account identity for a structured bank movement.
```

## Real LLM Contract Tests

Real LLM tests are optional manual or nightly checks, not required CI gates. They are useful only for fallback layouts that deterministic parsers do not support.

They must:

- use sanitized synthetic fixtures only;
- use a test API key supplied through environment variables;
- mock `fetch_context` with fixed accounts, categories, and payees;
- run each fixture three times;
- assert invariant structured fields, never wording of model reasoning.

For deterministic OCBC/Trust transfer fixtures, assert that no LLM request occurs:

```js
expect(llm.chat).not.toHaveBeenCalled();
```

This is stronger and more stable than relying on an LLM to parse known bank formats.

## Validation Gate

Implementation is complete only when:

1. All existing expense-tracker tests pass.
2. All parser, resolver, transfer, deduplication, recovery, merchant-resolution, and adapter-payload regressions above pass.
3. Transfer fixtures prove exactly one outbound Actual command for an internal transfer pair.
4. PayNow UEN fixture proves ordinary expense payload and no transfer payee.
5. Optional real-LLM contract suite passes when invoked with configured test credentials.

Production memory cleanup and historical transaction correction are separate, explicit production mutations after code validation.
