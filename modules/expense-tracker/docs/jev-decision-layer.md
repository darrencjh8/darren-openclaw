# A typed decision layer (jev) in payee and account resolution

Status: plan, with a POC that must pass before any integration lands.

## Why this is being considered

The dev-loop now reads a reviewer's verdict with a typed decision model (`typesafe/jev`,
`api.commandcode.ai/provider/v1/systemone`) instead of parsing prose, and that work produced a
short list of properties worth reusing:

- The model answers **typed questions only**: `noul` (a probability), `choice` (one of a declared
  `criteria` dict, with `confidence` and `probabilities`), and `score` (the **position** of the
  matching label in a declared `criteria` **array**, with a legend).
- It **cannot return sentences**, so it can never extract or invent a value. It decides over
  candidates the caller supplies.
- The question shape is a hard contract enforced by the server, and it is rejected **wholesale**:
  a `score` question without `criteria` answers `HTTP 400 questions.<name>.criteria: expected
  array, received undefined`, which failed every read until it was fixed.
- Answer confidence is the product: it is what lets a program auto-accept and queue separately.
- A failure or a timeout must never change an outcome; it falls through to the existing path.

Payee resolution in this module has the same shape as the dev-loop reviewer: a **closed list of
candidates** already exists, and the code currently asks a chat model to pick from it **in prose**.

`_classify_merchant` (`src/tools.js:1743`) fetches `/payees`, builds `payeeNames`, puts them in a
prompt, and demands `{"payee": "<name>"}`. It then parses the reply as JSON, falls back to a regex
over the prose, and discards any name outside the list (`return null`). That is a closed-list choice
implemented as text generation plus parsing, and it carries three failure modes: unparseable output,
a silently discarded answer, and **no confidence**, so a sure answer and a wild guess are recorded
identically as `source: "web"` and both are then learned into memory.

## How resolution works today

### Payee

`resolve_merchant` (`src/tools.js:1691`), short-circuits on the first hit:

1. **memory** — `MemoryStore.search(merchant)`, then every hit must pass `factNamesMerchant` before
   its `maps to X payee` line is read (issue #471: a weakly similar neighbour once booked an AliPay
   charge to the neighbour's payee). Memory path budget 500 ms; a failure falls through.
2. **`Misc`** — `source: "fallback"`. **There is no web + LLM step any more.**

`_classify_merchant` and `_handle_search_web` still exist in `src/tools.js` but nothing in `src/` calls
either: only `tests/resolve-merchant.test.js` does. The web path was removed from
`_handle_resolve_merchant` by `558b78a` (#589) as the fix for #587, a High-severity incident in which
Brave plus an LLM classifier answered `Petrol` for a clinic payment (`CFF UNITED PLT`, RM255) and the
answer was immediately learned as `CFF UNITED PLT maps to Petrol payee`, misbooking every later
charge. The code now says so in place:

```js
// An unverified web/LLM classification is not durable merchant evidence.
// Returning or learning it caused a clinic payment to become a permanent
// Petrol mapping (#587). Unknown merchants must remain Misc until confirmed.
return { payee: "Misc", source: "fallback" };
```

So the chain a merchant actually travels today is **memory, then `Misc`**, and the fallback that a
decision layer would replace is `Misc` itself. On the 26 cases in the POC where memory misses, the
human's payee is never `Misc`, so today's outcome is wrong for **all 26**.

This is also the argument for the change: the old mechanism was deleted because it had **no
confidence** — a guess was neither thresholded nor gated before it became permanent memory. A typed
`choice` carries `confidence` and `probabilities`, which is the control that was missing. Any
reintroduction must therefore resolve only above a threshold and must not learn at all until that
threshold is met.

`insert_transaction` uses a different order — live `/payees` list, then memory, then `Misc`
(`_validate_payee`) — and an ambiguous name **throws** `AMBIGUOUS_PAYEE` with the candidate IDs rather
than picking by list order (issue #483).

### Account

Entirely deterministic; no model makes the decision:

- `parseBankMovement` (`src/bank-movement.js:157`) extracts the movement shape.
- `suffix()` / `parseSuffixFact` / `canonicalSuffixFact`, `identityMappingsFromFacts`
  (`src/bank-movement.js:287`), `accountMatches` (`:273`), `resolveMovementAccounts` (`:370`).
- `accountAliases` / `accountTokens` / `matchAccountByName` (`src/suffix-facts.js:322`, `:64`, `:288`).
- `resolveFactAccount` (`src/suffix-facts.js:151`) resolves a fact's written account name and
  **refuses** when it is ambiguous (`:235`, `:274`).
- `orchestrator.js`: `_resolveMovementToOutput` (`:569`), `_collectSuffixMappings` (`:683`),
  cache-then-deterministic-suffix fallback (`:1067`). Accounts are pre-filtered by bank before any
  model sees them (`:180`), and the LLM-extractor fallback (`:801`) parses fields but resolves
  accounts in code.

## The seams, in the order they would be changed

| # | seam | change | risk |
|---|---|---|---|
| 1 | the `return { payee: "Misc", source: "fallback" }` in `_handle_resolve_merchant` (`src/tools.js:1866`) | a typed `choice` over the live payee shortlist, resolved only above the confidence threshold, otherwise `Misc` exactly as today | medium: it reintroduces automatic resolution that #587 removed, so the threshold and the no-learn rule carry the safety |
| 2 | the memory loop above it | **no change**: a memory hit must keep short-circuiting, and the decision must not be able to override one | none, and it must stay that way: even in arm C it broke 2 of 25 exact rules |
| 3 | `resolvePayeeMatch` ambiguity (`src/tools.js:234`) | resolve above the threshold, keep today's refusal below it | medium: changes a refusal into a resolution |
| 4 | `resolveFactAccount` ambiguity (`src/suffix-facts.js:235`, `:274`) and the account pick over the bank-filtered list | `noul` for "does this fact name this account?", `choice` over filtered account IDs | medium: accounts touch transfers |

`_classify_merchant` and `_handle_search_web` are **not** seams: they are dead code with no caller in
`src/`. Building on them would resurrect the #587 mechanism. Deleting them is separate cleanup.

Nothing here replaces discovery: the answer must be one of the declared candidates, so a genuinely new
merchant still becomes `Misc`, exactly as today.

## The POC, and the rule that gates the integration

**Integration happens only if the POC shows a confidence threshold that separates correct picks from
incorrect ones.** Otherwise the decision layer adds nothing over the existing chain.

### Data, all read-only, no production writes

- **Cases**: `~/.local/state/expense-corpus/review.json` — 69 real cases sampled from production
  email, each with the extracted `merchant`, the raw bank descriptor, the human's final `payee` and
  `category`, and `skip` for the ones the human did not book. 51 carry a payee.
- **Rules**: `darrencjh8/friday-memory` `expense-tracker/MEMORY.md`, fetched with `gh api`
  (read-only). This is the same memory the chain's step 1 reads.
- **Candidate payees**: the payees named by that memory, which is the set the system actually uses.
  The live `/payees` list needs the Actual service and is deliberately **not** required for this
  POC; `--payees-file` accepts it once it is available.
- No writes to the budget, no IMAP connection, no container restarts.

### Method

For each labelled case:

1. **Baseline (today)**: the memory lookup the chain performs, `factNamesMerchant` then
   `maps to X payee`, else `Misc`. This is what happens today for a merchant that is not in memory.
2. **jev**: one `choice` question over the candidate payees, with `instructions` that guide the
   choice and a `criteria` entry per payee, plus a `choice` question for the category.
3. Compare with the human's `payee`.

### Metrics reported

- baseline accuracy (memory-or-`Misc`) against the 51 labelled cases;
- **shortlist coverage**: how often the human's payee is even among the candidates — the hard
  ceiling on any decision layer;
- jev accuracy overall and among covered cases;
- a **threshold sweep**: at each confidence cut, how many cases are auto-resolved and what
  precision that buys;
- latency per call, and the list of confident-but-wrong picks, which is what an operator would
  actually have to live with.

### What would make this a no-go

- no threshold where precision is high enough to trust auto-resolution;
- coverage so low that most cases never reach the decision (the shortlist is the ceiling);
- latency or failure behaviour that would block an insert.

## Results of the first run

51 labelled real cases, 0 errors. Three arms, differing only in the candidate payee list and whether
`Misc` is offered.

**Arm A, candidates from memory alone** (47 payees, no labels used): coverage 54.9%. jev was correct
20/51 overall, but on the 26 cases memory misses only **1/26**, and no threshold rescued it — at
`>= 0.90` it auto-resolved 13 cases at **8%** precision. 23 of the 26 misses had no correct candidate
at all. The shortlist, not the decision, was the binding constraint.

**Arm B, candidates include every payee the budget used.** This is an upper bound, because that list
is built from the cases' own labels. It exists to answer one question: if the right payee is on the
list, can jev pick it? Coverage 100%, overall 37/51, and on the 26 memory misses **18/26**. Restricted
to the miss path, which is the seam that would actually change:

| threshold | auto-resolved | precision |
|---|---|---|
| >= 0.90 | 19/26 | 79% |
| >= 0.95 | 14/26 | 93% |
| >= 0.99 | 12/26 | **100%** |

So the gate in this plan is met on the miss path given a complete candidate list: 12 of 26 cases that
today become `Misc` are resolved correctly with no errors at all.

**Arm C, arm B with `Misc` removed from the offered payees** (and the "choose Misc only when nothing
else fits" sentence dropped from the instructions, since it would name a payee that is not offered).
Measured, not projected: overall **41/51**, and on the 26 memory misses:

| threshold | auto-resolved | precision |
|---|---|---|
| >= 0.90 | 16/26 | 94% |
| >= 0.95 | 13/26 | **100%** |
| >= 0.99 | 13/26 | **100%** |

Removing the attractor also repaired four of the memory-hit overrides (19/25 went to 23/25), so it is
not a trade. Median 724 ms.

**The gate in this plan is therefore met on the miss path**, given a complete candidate list: 13 of the
26 cases that today become `Misc` are resolved correctly with no errors at all, and the threshold is a
real cut rather than a fitted one.

### What the remaining errors are

- **`Misc` was an attractor, and arm C is the fix.** In arm B, 6 of the 26 miss answers were `Misc`
  and the truth is never `Misc` on that set, so every one was wrong. With `Misc` unoffered, precision
  at `>= 0.95` went from 93% to **100%** at the same 13 cases, and the memory-hit damage fell from 6
  broken rules to 2. The integration must not offer `Misc` as a resolvable pick; an unsure answer has
  to fall through to today's path.
- **`Grab` -> `Grab Wallet` when the truth was `Grab Paylater`** (twice, at 0.90 and 0.93) is genuine
  ambiguity between two similar payees; the human's choice there may itself be arbitrary, and no
  candidate list fixes it.
- **`CHONG YING SIANG` -> `Misc` when the truth was `Medicine`** (four times) sat at 0.50-0.56, so the
  threshold catches all of them.
- **Categories are not worth doing**: 25.5% in all three arms.

### Constraints this puts on any integration

1. It may run **only where memory misses**, and must never override a memory hit. Even in arm C it
   still broke 2 of 25 exact rules, four fewer than arm B but not zero.
2. `Misc` must be excluded as a resolvable pick, so an unsure answer falls through.
3. **Coverage is the one thing no arm can settle.** Arms B and C get 100% coverage only because their
   candidate list is built from the cases' own labels. The real candidate list is the live `/payees`
   list, and reading it once, read-only, is the next measurement.
4. **The incumbent is `Misc`, and what it is measured against is the removed web path.** Checked in
   the current revision rather than assumed: `_handle_resolve_merchant` returns `Misc` directly and
   the Brave + LLM branch is gone (#589 fixing #587), with `_classify_merchant` and
   `_handle_search_web` left behind as dead code. So the bar is `Misc` — 0/26 on the miss path — and
   arm C clears it at 13/26 with 100% precision. Measuring Brave + LLM anyway is still worth doing as
   a **counterfactual**: it says whether the new mechanism beats the one that was deleted for being
   unsafe, which is a different and weaker question than beating what runs today.
5. **Accounts cannot be evaluated on this corpus.** It has no account ground truth: `review.json`
   carries `merchant`, `raw`, `payee` and `category` only. `friday-memory`'s `mappings.json` does hold
   an `accounts` map, but the module migrated it into `MEMORY.md` and no longer reads it
   (`docs/design.md:163`), and `person-rules.json` is fetched but consumed by tests only. So the
   account seams stay unmeasured until the budget is read.

### The counterfactual is written but not measured

`tools/jev-baseline-web-llm.mjs` reproduces the removed Brave + LLM path, so the new mechanism can be
compared against the one that was deleted for #587. It is verified up to the LLM call — the case set,
the candidate list and the memory split all match this report exactly, and Brave returned snippets for
every case tried — but it produced **no accuracy numbers**, because no LLM route was reachable:

- the local router on `http://localhost:4100/v1` has no listener, and starting it needs docker;
- the module `.env`'s `DEEPSEEK_API_KEY` answers `HTTP 401 authentication_error` directly against
  `api.deepseek.com` for `deepseek-chat`, `deepseek-flash` and `deepseek-reasoner`.

Its report file holds 3 rows and a `credentialFailure` marker and must not be read as a measurement.
This does not weaken the result above, because the bar is `Misc`, not the deleted web path.

That credential matters beyond this POC: `config.js:27` defaults `llmProvider` to `deepseek` and
`config.js:36` falls back to the same key, so unless production overrides `LLM_PROVIDER`, every
classifier and extractor call is failing. Worth checking independently of this change.

## Surgical integration, if the POC passes

1. `src/jev.js` — one small client: question builder, envelope parser, timeout, and fall-through.
   It pins the shape rules learned above (a `score` needs a `criteria` array; a `choice` needs a
   `criteria` dict) because an invalid request fails whole.
2. `_classify_merchant` becomes a typed choice over the same list; the existing membership check
   stays as a second line of defence.
3. The memory-miss seam gains a shortlist decision before the Brave call.
4. The ambiguity seam resolves above the threshold and keeps today's refusal below it.
5. Accounts follow, last, in their own change.
6. Config: `JEV_ENABLED`, `JEV_THRESHOLD`, and a learning rule that persists a mapping **only**
   above the threshold. Today a `web` resolution is learned unconditionally, including when the
   model guessed; memory short-circuits on every later run, so a wrong learned mapping is permanent.
   A threshold makes learning strictly safer than it is now.
7. An answer outside the shortlist is rejected, never trusted; a timeout, a `429` or an invalid
   reply falls through to exactly today's path with no new failure mode.
8. Tests: the question shape and the envelope parsing asserted offline, one live smoke test per
   question type, and a control that a below-threshold pick neither resolves nor learns.

## Out of scope

- Replacing extraction or classification of the email itself; jev cannot produce text.
- Changing the account chain's deterministic order or its refusal rules.
- Any write to the budget, any deploy, and any production restart.
