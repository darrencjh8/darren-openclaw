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

### What was measured, and what it changed

`tools/jev-account-poc.mjs` runs the shipped resolvers over the 69 real alert emails, building the
account list and the mappings from memory's own account facts (18 accounts) because the live
`/accounts` list needs the budget.

**Not one of the 69 alerts parses as a bank movement: 0/69.** `parseBankMovement` covers the Ryt
sentence forms (`… was paid at X using your Main Account on 2/9/2026 …`) and label-based alerts
(`Amount :`), while the corpus is dominated by this shape:

```text
A transaction of SGD 8.50 was made with your UOB Card ending 1234 on 26/08/26 at HAPPY HAWKER@289C COMP.
```

That returns `null`, so `resolveMovementAccounts` never runs for these emails and the deterministic
movement-to-account path is not what assigns their account. The account is instead placed by name
resolution over whatever Phase 1 extracted, through `matchAccountByName` / `resolveFactAccount`
against the live account list. So the seam a decision layer would join is the **name-matching
refusal**, not the movement parser.

This also corrects an earlier claim of mine in this plan: the account half is **not** measurable by
reusing `parseBankMovement` on this corpus. What is measurable is how often an alert names a known
account at all, and how often the resolver refuses the name it does see. The corpus still has no
record of which account each transaction was actually booked to, so it remains a resolution and
refusal rate, never an accuracy.

**Measured on the 69 real alerts:**

| | alerts |
|---|---|
| names one known account in full | 40 |
| names no account in full | 27 |
| names several accounts | 2 |

Of the 27 that do not name an account in full, the resolver places 12 from the partial name they do
give (8 `Citi Reward`, 2 `OCBC 90N`, 2 `HSBC Revolution`) and **refuses 14** — 9 `ambiguous`, 5
`no account matches those words`.

So about **14 of 69 alerts (20%) end in a name-matching refusal.** Three fifths of those are
ambiguity between real accounts, which is exactly the shape a typed `choice` over the candidate
accounts answers; two fifths are names no account carries at all, which no candidate list can fix.

Caveat, and it works against this number: the account list here is rebuilt from memory's account
facts and carries no card digits, while `accountMatches` keys on the digits in a live account name
(`bank-movement.js:404`). With the live list some of those 14 would resolve by suffix, so this is an
upper bound on the refusal rate — the opposite of the payee side, where the arms were an upper bound
on opportunity.

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

### The live payee list, and the defect it exposed

Read read-only from the production `actual-api` (which publishes `127.0.0.1:3000`, so it is reachable
only on the host it runs on):

| | |
|---|---|
| `Darren SGD` | 214 payees / 209 names |
| `Darren MYR` | 145 payees / 143 names |
| union | **301 names** |
| truth payee present in the live lists | **50/51 = 98.0%**, and **25/26 = 96.2%** on the memory-miss path |
| absent from both | `SHOPEE SINGAPORE MP` (1 case) |

So raw coverage is essentially complete. But the shipped `payeeCandidates` ranks by token overlap with
the merchant, breaks ties **alphabetically**, and caps at `jevMaxCandidates` (60). Against a 301-name
list that is broken:

| cap | all 51 cases | 26 memory-miss cases |
|---|---|---|
| 20 / 40 / **60** / 100 | **20/51 = 39%** | **17/26 = 65%** |
| no cap (301 offered) | **50/51 = 98%** | 25/26 = 96% |

Most merchants share no token with the payee name (`HAPPY HAWKER@289C COMP` vs `Food`), so almost
every candidate scores 0 and the cap keeps the alphabetically-first 60. It drops `Food`, `Public
Transport`, `Phone Bill`, `Shopee Wallet`, `Rent`, `Gym`, `Medicine`, `Insurance` and `Music` - which
is to say almost every payee that means anything.

**The arms could not see this.** Their candidate list was 54 names built from the corpus labels, so the
cap never bit. Two consequences:

1. The integration as shipped cannot be right on 61% of cases, because the answer is not offered.
   Coverage is a precondition for accuracy, so this has to be fixed before the threshold means
   anything.
2. The fix needs a decision and a measurement, not a guess: offer the whole list (301 criteria is a
   large question, and whether the model's accuracy holds at that width is unmeasured), or build the
   shortlist from a real relevance signal instead of token overlap plus alphabetical order.

The cleanest signal already in the module is `MemoryStore.search()`, which the plan called for and
which this implementation replaced with token overlap. That was the mistake.

**The cap is fixed, and the fix made the result worse - which is the finding.**

The provider refuses a choice question above **255 options** ("TypeSafe Choice questions support at
most 255 options"), so 255 is the widest usable list and `DEFAULT_MAX_CANDIDATES` is now 255. Coverage
at that width is 50/51, identical to offering everything, so the truncation costs nothing once the cap
is at the real ceiling.

Re-running the shipped path against the live list at cap 255:

| | 54-name label list | **301-name live list** |
|---|---|---|
| overall correct | 39/51 | **26/51** |
| memory-miss correct | 18/26 | **15/26** |
| memory hits broken | 4/25 | **14/25** |
| median latency | 710 ms | 785 ms |
| miss-path precision at >= 0.90 / 0.95 / 0.99 | 82% / 100% / 100% | **75% / 75% / 75%** |

**The gate in this plan is not met.** Precision is flat at 75% from 0.90 all the way to 0.99, so no
threshold separates a correct pick from an incorrect one: at 0.95 it would auto-resolve 16 of the 26
miss cases with 4 errors.

The four errors are all the same shape, and every one is at confidence **1.0**:

```text
Grab -> Grab              truth Grab Wallet     conf 1
Grab -> Grab              truth Grab Paylater   conf 1
Grab -> Grab              truth Grab Wallet     conf 1
Grab -> Grab              truth Grab Paylater   conf 1
```

The live list contains a payee literally named `Grab`, so the model picks the exact-name match with
full confidence while the human's payee is the more specific `Grab Wallet` or `Grab Paylater`. The
label-derived list had no bare `Grab`, which is exactly why the earlier arms looked clean. High
confidence here means "the merchant equals a payee name", not "this is the right payee".

**So the integration must not be enabled on this evidence.** The gate asks whether confidence
separates correct picks from incorrect ones, and it does not.

The arithmetic is more forgiving than that, and it should be stated honestly: every case on the miss
path is already wrong today, so resolving 16 with 12 right and 4 wrong is a net gain of 12 and **no new
errors** - the four are `Misc` either way. What the flat 75% denies is the thing the design was sold
on: a confident answer that can be trusted. A pick recorded as confident while being wrong one time in
four is not a control, and unlike the dev-loop's two-clean-rounds rule this design has no compensating
mechanism behind it. So it stays off until either the ambiguity below is handled and measured, or
someone accepts 75% on the record.

One targeted repair is visible and unmeasured: refuse when the chosen name is a stem of several
candidate payees (`Grab` against `Grab Wallet` and `Grab Paylater`), which is the same ambiguity rule
`resolvePayeeMatch` already applies to payee names (issue #483). That would have refused all four
errors, leaving 12 auto-resolutions at 12/12.

**Measured, with that guard in place** (live list, cap 255):

| threshold | auto-resolved | precision |
|---|---|---|
| >= 0.80 | 14/26 | 93% |
| >= 0.90 | 12/26 | **100%** |
| >= 0.95 | 12/26 | **100%** |
| >= 0.99 | 12/26 | **100%** |

The guard refused exactly the four errors and nothing else, so confidence now separates a correct pick
from an incorrect one and **the gate in this plan is met**: at 0.95 the layer auto-resolves 12 of the
26 cases that are wrong today with no incorrect resolution, and the other 14 fall through unchanged.

The cost is recall and it should be stated: a merchant genuinely booked to the general payee now falls
through as well. No such case appears in this corpus - the Grab-family truths are `Grab Wallet` and
`Grab Paylater`, never bare `Grab` - so that cost is unmeasured here and could be real in a budget
where a general payee is used deliberately.

Enabling it is still the operator's decision, not a conclusion of this POC. The layer remains off by
default, and turning it on changes production behaviour.

### The shipped path, on the same 51 cases

`tools/jev-integration-replay.mjs` calls the real `src/jev.js` over the same corpus, with the payee
universe the arms used and the merchant as the only state — because that is all
`_handle_resolve_merchant` receives. The earlier harness also passed the raw bank descriptor, so its
numbers are an upper bound on this input.

| | arm C (harness, merchant + descriptor) | shipped `src/jev.js` (merchant only) |
|---|---|---|
| overall correct | 41/51 | 39/51 |
| memory misses correct | 18/26 | 18/26 |
| miss path >= 0.95 | 13 auto, 100% | **12 auto, 100%** |
| memory hits broken | 2/25 | 4/25 |
| median latency | 724 ms | 710 ms |

So the artifact that would run reproduces the result: **12 of the 26 cases that today become `Misc`
are resolved correctly with no errors**, and the other 14 fall through unchanged. It also confirms the
constraint from the other direction — run over every case it broke 4 of the 25 memory hits, which is
exactly why it is wired only after the memory loop finds nothing.

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
