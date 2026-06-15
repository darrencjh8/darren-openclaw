# Feature Specification: Merchant Resolver

**Feature:** merchant-resolver
**Spec Version:** 1.0.0
**Status:** Draft
**Created:** 2026-06-15
**Constitution Hash:** v4.0.0

---

## Overview

Add a `resolve_merchant` typed plugin tool that deterministically maps raw transaction merchant strings to canonical payee names. The expense-tracker's LLM agent currently performs payee matching inline during transaction classification — it calls `fetch_payees`, scans the list, and guesses. This is expensive (LLM cycles burned on string matching), inconsistent (same merchant may map to different payees across runs), and fragile (the LLM may hallucinate a payee that doesn't exist).

The fix is a 4-step resolution pipeline exposed as a single typed tool:

1. **Memory** — Check semantic memory (`search_memory`) for previously learned `merchant → payee` mappings. If a high-confidence match exists, return immediately (bypass LLM).
2. **Keyword** — Apply deterministic keyword-to-payee rules from the legacy `mappings.json` / `payees` dictionary. Fast, zero-cost fallback.
3. **Brave Web Search** — If memory and keyword both miss, query Brave Search API for the merchant name to discover context (what is this business? what category?). Configurable via `BRAVE_SEARCH_API_KEY`; degrades gracefully when absent.
4. **LLM Classification** — Feed the Brave search results (or raw merchant name if no API key) to the existing DeepSeek client with a compact classification prompt. The LLM returns a structured `{ payee_name, confidence }` response.

The result is cached in semantic memory via `learn_fact` so subsequent resolutions for the same merchant are instant (step 1 only). The tool returns both the resolved payee name and a confidence score, letting the caller decide whether to use the result or fall back to `"Misc"`.

---

## User Stories

### US-1: Deterministic Merchant-to-Payee Resolution (Priority: P1)

**As the** expense-tracker agent processing a transaction,
**I want** to call `resolve_merchant` with a raw merchant string and get back a canonical payee name with a confidence score,
**So that** the same merchant always maps to the same payee, regardless of which LLM invocation handles the transaction.

**Why this priority**: Inconsistent payee assignment is the #1 source of budget categorization errors. The LLM currently re-derives the mapping on every transaction, burning tokens and producing different results for "Toast Box", "TOAST BOX (JURONG)", and "Toast Box Pte Ltd". A deterministic resolver eliminates this class of error entirely.

**Independent Test**: Call `resolve_merchant({ merchant: "Toast Box" })` twice in succession. The first call runs the full pipeline (memory miss → keyword miss → search → LLM → learn). The second call hits memory and returns the same payee instantly without touching Brave or the LLM.

**Acceptance Scenarios**:

1. **Given** the plugin is loaded and memory contains `"Toast Box merchant maps to Food payee"`, **When** the agent calls `resolve_merchant({ merchant: "Toast Box" })`, **Then** the tool returns `{ payee_name: "Food", confidence: "high", source: "memory" }` without calling Brave Search or the LLM.
2. **Given** the plugin is loaded and memory is empty but `mappings.json` contains `{ "Toast Box": "Food" }`, **When** the agent calls `resolve_merchant({ merchant: "Toast Box" })`, **Then** the tool returns `{ payee_name: "Food", confidence: "high", source: "keyword" }` and auto-learns the mapping into memory.
3. **Given** BRAVE_SEARCH_API_KEY is configured and the merchant is unknown to both memory and keywords, **When** the agent calls `resolve_merchant({ merchant: "Oddly Named Cafe" })`, **Then** the tool queries Brave Search, feeds results to the LLM classifier, and returns `{ payee_name: "<best match>", confidence: "medium|low", source: "llm" }`.
4. **Given** BRAVE_SEARCH_API_KEY is not configured and the merchant is unknown, **When** the agent calls `resolve_merchant({ merchant: "Unknown Merchant" })`, **Then** the tool skips step 3 (Brave) and runs step 4 (LLM) with only the raw merchant name, returning whatever the LLM can infer.

---

### US-2: Automatic Learning from Resolutions (Priority: P2)

**As the** expense-tracker agent,
**I want** every successful `resolve_merchant` result to be automatically persisted into semantic memory,
**So that** the resolution cost is paid once per merchant and all future transactions for the same merchant resolve instantly.

**Why this priority**: Without auto-learning, every transaction for a recurring merchant re-runs the full pipeline, wasting Brave API quota and LLM tokens. P2 because the resolver works without learning, but the cost savings and latency reduction are significant.

**Independent Test**: Resolve "New Merchant X" (pipeline runs fully). Resolve "New Merchant X" again. Verify the second call returns `source: "memory"` and completes in <50ms.

**Acceptance Scenarios**:

1. **Given** `resolve_merchant` resolves a merchant via keyword, search, or LLM, **When** the result has confidence ≥ "medium", **Then** the tool calls `learn_fact` with `"<merchant> merchant maps to <payee> payee"` before returning.
2. **Given** `resolve_merchant` resolves a merchant with confidence "low", **When** the result is returned, **Then** the mapping is NOT auto-learned (prevents poisoning memory with bad mappings).
3. **Given** a previously learned mapping is wrong, **When** the agent corrects it via `update_fact` or `delete_fact`, **Then** the next `resolve_merchant` call for that merchant follows the corrected mapping.

---

### US-3: Plugin Integration with Expense Tracker Tools (Priority: P2)

**As a** developer extending the expense-tracker plugin,
**I want** `resolve_merchant` registered as a typed tool alongside the existing 21 `budget_` tools,
**So that** the expense-tracker agent discovers and uses it through its standard tool catalog without special configuration.

**Why this priority**: The resolver is only useful if the agent can call it. Registering it as a plugin tool makes it a first-class citizen in the tool catalog. P2 because the resolver is additive — existing workflows continue to work without it.

**Independent Test**: Run `openclaw plugins inspect expense-tracker-tools --runtime --json` and verify `resolve_merchant` appears in `toolNames` alongside the 21 `budget_` tools.

**Acceptance Scenarios**:

1. **Given** the expense-tracker plugin is loaded, **When** the agent lists available tools, **Then** `resolve_merchant` appears with a description, parameter schema (`merchant: string`), and return type.
2. **Given** the SKILL.md is updated, **When** the agent reads the workflow instructions, **Then** step 2 ("Call `budget_search_memory`...") is updated to include `resolve_merchant` for payee assignment.
3. **Given** the agent processes a transaction email, **When** it reaches the payee-matching step, **Then** it calls `resolve_merchant({ merchant: "<extracted merchant>" })` instead of manually scanning the `fetch_payees` result.

---

### Edge Cases

- **What happens when both memory and keyword return different results?** Memory takes precedence. Keyword is only checked on a memory miss. The memory-to-keyword precedence is: memory (step 1) → keyword (step 2) → search (step 3) → LLM (step 4). Each step is only reached if all previous steps produced no confident match.
- **What happens when Brave Search returns zero results?** The tool logs a warning and proceeds to step 4 (LLM classification) with only the raw merchant name. The LLM prompt includes instructions to handle the case where no context is available.
- **What happens when the Brave Search API is unreachable or returns a 4xx/5xx?** The tool catches the error, logs it, and degrades to step 4 without search context. The tool never throws due to a search failure — it always attempts LLM classification as a fallback.
- **What happens when the DeepSeek API call fails or times out?** The tool returns `{ payee_name: null, confidence: "low", source: "error" }`. The caller (expense-tracker agent) falls back to its existing payee-matching logic or assigns `"Misc"`.
- **What happens with merchants containing special characters (e.g., "T&T Supermarket", "H&M")?** The merchant string is passed as-is through all pipeline steps. The `search_memory` query and keyword lookup use the raw string. The Brave Search query and LLM prompt include the raw string. No sanitization or transformation is applied.
- **What happens with very long merchant names (>200 chars)?** The tool truncates the merchant name to 200 characters before passing it to Brave Search (URL query parameter limit) and the LLM prompt (context window efficiency). The full string is still used for memory and keyword lookups. Truncation is logged at debug level.
- **What happens if the resolved payee doesn't exist in the payee list?** The tool cross-references the resolved payee name against `fetch_payees` results. If the payee is not found in the active payee list, the tool sets confidence to `"low"` and includes a warning in the response. The caller decides whether to create the payee or fall back.
- **What happens when `resolve_merchant` is called with an empty or whitespace-only merchant string?** The tool returns `{ payee_name: null, confidence: "low", source: "validation", error: "Empty merchant string" }` without executing the pipeline.
- **What happens when the same merchant is resolved concurrently by two parallel agent invocations?** Each invocation runs the pipeline independently. The second invocation may encounter a race where the first's `learn_fact` completes mid-execution. This is acceptable — both results are correct, and the second invocation wastes at most one pipeline run before the learned fact is available for future calls.

---

## Requirements

### Functional Requirements

- **FR-001**: The tool MUST implement a 4-step resolution pipeline in strict order: memory lookup → keyword match → Brave Web Search → LLM classification. Each step MUST only execute if all previous steps produced no confident match (confidence ≥ `"high"` for memory/keyword, confidence ≥ `"medium"` for search-reinforced LLM).
- **FR-002**: The memory step (step 1) MUST call `budget_search_memory` with the merchant string as the query and parse results for facts matching the pattern `"<merchant> merchant maps to <payee> payee"`. If a match is found with score ≥ 0.85, the pipeline MUST short-circuit and return the payee immediately.
- **FR-003**: The keyword step (step 2) MUST load the legacy keyword-to-payee mappings (from `mappings.json` or equivalent data source) and perform a case-insensitive exact-match lookup against the merchant string. If a match is found, the pipeline MUST return the payee and auto-learn the mapping into memory via `budget_learn_fact`.
- **FR-004**: The Brave Search step (step 3) MUST be conditional on `BRAVE_SEARCH_API_KEY` being set. When the API key is present, the tool MUST query `https://api.search.brave.com/res/v1/web/search?q=<merchant>` and extract the top 3 result snippets. When the API key is absent, the step MUST be silently skipped (logged at debug level).
- **FR-005**: The LLM classification step (step 4) MUST call the existing DeepSeek client with a structured classification prompt that includes: the raw merchant name, any Brave Search snippets (if available), and the list of known payee names (from `budget_fetch_payees`). The LLM MUST respond with a structured JSON object `{ payee_name: string|null, confidence: "high"|"medium"|"low" }`.
- **FR-006**: The tool MUST auto-learn successful resolutions: when confidence is `"high"` or `"medium"`, the tool MUST call `budget_learn_fact` with the fact `"<merchant> merchant maps to <payee> payee"`. Low-confidence or error results MUST NOT be auto-learned.
- **FR-007**: The tool MUST validate resolved payees against the active payee list (from `budget_fetch_payees`). If the resolved payee does not exist in the list, confidence MUST be downgraded to `"low"` and the response MUST include a `payee_validated: false` field.
- **FR-008**: The tool MUST enforce timeouts: memory lookup (2s), keyword lookup (1s), Brave Search API call (5s), LLM classification (10s). Each step's timeout MUST be independent — a timeout in one step MUST cause degradation to the next step, not a tool-level failure.
- **FR-009**: The tool MUST include a `source` field in its response indicating which step produced the result: `"memory"`, `"keyword"`, `"llm"`, or `"error"`. This enables observability into pipeline behavior and cost attribution.
- **FR-010**: The tool MUST be registered in the expense-tracker plugin's `index.js` using `api.registerTool()` with a TypeBox parameter schema and an `execute` handler. The parameter schema MUST accept `merchant: string` (required) and return an object with `payee_name`, `confidence`, `source`, and optional `error` and `payee_validated` fields.

### Key Entities

- **`resolve_merchant` tool**: A typed OpenClaw tool registered in the expense-tracker plugin. Accepts a `merchant` string parameter. Returns a structured resolution result with payee name, confidence level, resolution source, and validation status.
- **Resolution pipeline**: The 4-step state machine (memory → keyword → Brave → LLM) that processes a merchant string into a payee name. Each step has a defined confidence threshold for short-circuiting and a timeout for graceful degradation.
- **Memory fact**: A string stored in the expense-tracker's semantic memory via `budget_learn_fact`, formatted as `"<merchant> merchant maps to <payee> payee"`. Queried via `budget_search_memory` in step 1 of the pipeline.
- **Keyword mappings**: A static dictionary of known merchant-to-payee mappings (originating from `mappings.json` / the legacy `payees` dict). Provides a zero-cost deterministic fallback before incurring API calls.
- **Brave Search API**: An external web search service queried in step 3. Requires `BRAVE_SEARCH_API_KEY` environment variable. Returns web page snippets that provide context for LLM classification.
- **DeepSeek LLM client**: The existing LLM client (reused, not a new model) called in step 4 with a compact classification prompt. Returns structured JSON with payee name and confidence.
- **Payee validation**: Cross-reference of the resolved payee against the active payee list from `budget_fetch_payees`. Ensures the resolver never returns a payee that doesn't exist in the budget system.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: `resolve_merchant` appears in `openclaw plugins inspect expense-tracker-tools --runtime --json` output with status `loaded`.
- **SC-002**: The same merchant string resolves to the same payee name on every invocation, regardless of which agent turn processes it — verified by running 10 sequential `resolve_merchant({ merchant: "Toast Box" })` calls and confirming all return identical `payee_name`.
- **SC-003**: A previously unseen merchant resolves via the full pipeline in <15 seconds (memory miss + keyword miss + Brave Search + LLM), verified by timing the first invocation.
- **SC-004**: A previously learned merchant resolves in <100ms (memory hit, no API calls), verified by timing the second invocation of the same merchant.
- **SC-005**: The tool returns a valid result (non-throwing) when `BRAVE_SEARCH_API_KEY` is unset, set to an invalid key, or set to a key for an account with zero quota — verified in all three configurations.
- **SC-006**: Low-confidence (`"low"`) results are never persisted to memory — verified by calling `budget_list_facts` after a low-confidence resolution and confirming no new facts were added.
- **SC-007**: The expense-tracker agent completes an email → classify → resolve_merchant → insert flow with the resolved payee, confirmed by gateway logs showing `resolve_merchant` tool calls with `source: "memory"|"keyword"|"llm"` in the response.
- **SC-008**: A resolved payee that doesn't exist in the active payee list returns `confidence: "low"` and `payee_validated: false`, preventing the agent from inserting a transaction with a non-existent payee.

---

## Non-Goals

- Introducing a new LLM model or API client — the resolver MUST reuse the existing DeepSeek client already configured in the expense-tracker plugin
- Supporting search providers other than Brave Search — no Google, Bing, DuckDuckGo, or other search APIs
- Caching results beyond semantic memory auto-learning — no Redis, in-memory LRU, or file-based cache
- Replacing the existing `mappings.json` or keyword-based payee resolution — the keyword step (step 2) preserves that logic as a fallback
- Modifying the expense-tracker's classification prompt to include merchant resolution logic inline — the resolver is a separate tool, not embedded prompt instructions
- Adding a confidence threshold configuration UI — thresholds are hardcoded (0.85 memory, high/medium/low LLM) until a concrete need for tunability arises
- Resolving merchants to categories (only payees) — category assignment remains the agent's responsibility using the existing `fetch_categories` tool
- Handling batch resolution (multiple merchants in one call) — each call resolves exactly one merchant

---

## Assumptions

- `BRAVE_SEARCH_API_KEY` is an optional environment variable. When absent, the pipeline degrades from step 3 (Brave Search) directly to step 4 (LLM classification) without erroring.
- The existing DeepSeek client (used by the expense-tracker's classification prompts) is accessible from the plugin's tool handler and can be reused for the compact classification prompt in step 4.
- `budget_search_memory` and `budget_learn_fact` are available as internal plugin functions (not requiring HTTP calls) so the memory steps add negligible latency.
- `budget_fetch_payees` returns the complete list of active payee names and is callable from within the `resolve_merchant` execute handler for payee validation (FR-007).
- The keyword mappings (`mappings.json` or equivalent) are accessible at plugin load time and can be loaded into memory for fast lookups.
- The expense-tracker agent (LLM) can discover `resolve_merchant` through its standard tool catalog and understands when to call it (updated SKILL.md provides guidance).
- The Gateway container has outbound internet access to reach `api.search.brave.com` for Brave Search API calls.
- Merchant names in the expense-tracker are typically ≤200 characters. Longer names are rare edge cases handled by truncation (see Edge Cases).
- No authentication is needed between the plugin and the expense-tracker API — both run on the internal Docker network.
- The `resolve_merchant` tool is registered as part of the existing `expense-tracker-tools` plugin, not as a separate plugin, following the pattern established in spec 014.
