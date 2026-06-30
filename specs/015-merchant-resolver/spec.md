# Feature Specification: Merchant Resolver

**Feature:** merchant-resolver
**Spec Version:** 1.1.0
**Status:** Implemented (partially superseded)
**Created:** 2026-06-15
**Constitution Hash:** v4.0.0
**Baseline:** `specs/002-expense-tracking/spec.md` (v2.0.0)

> **⚠️ Spec-drift corrections (see `specs/030-spec-drift/`). The code is the source of truth:**
> - **Keyword step REMOVED.** Spec 021 dropped the keyword heuristic from the resolution chain. The actual `resolve_merchant` chain is **memory → web search → `"Misc"` fallback** (`src/tools.js:_handle_resolve_merchant`). There is **no `src/keywords.js`** and **no `source: "keyword"`**. Therefore **FR-005 is void**, and the keyword references in FR-002, the Overview, Independent Tests, AC, and SC-002 no longer apply.
> - **Gateway plugin → MCP tool.** The OpenClaw Gateway was replaced by Hermes. There is no `budget_resolve_merchant` Gateway plugin; the functionality is exposed as the MCP tool **`resolve_merchant`** (`src/mcp-server.js`). FR-009/FR-011 and US about the Gateway plugin are historical.

---

## Overview

The expense-tracker orchestrator currently relies on its LLM to run a multi-step payee matching sequence: `search_memory` → keyword heuristics → `fetch_payees` → fallback to "Misc". This is fragile — the LLM can skip steps, hallucinate the fallback, or mis-sequence the calls. It also burns tokens on string matching that code can do deterministically.

Add a `resolve_merchant` tool inside the expense-tracker that runs the full pipeline in code: memory lookup → keyword heuristic → Brave web search → LLM classification → auto-learn. The orchestrator LLM calls one tool and gets one answer. The Gateway agent benefits via a `budget_resolve_merchant` plugin tool wrapping the same endpoint.

An `update_transaction` tool allows the agent to retroactively fix misclassified transactions, with validation to ensure only existing payees and categories are used. Both `insert_transaction` and `update_transaction` validate payees (fallback to "Misc" on insert, reject on update) and categories (fallback to "Fun Money" on insert, reject on update).

---

## User Stories

### US-1: Deterministic Merchant-to-Payee Resolution (Priority: P1)

**As the** expense-tracker orchestrator processing a transaction email,
**I want** to call a single `resolve_merchant` tool that returns a final payee classification,
**So that** I never need to orchestrate a multi-step payee matching sequence and the same merchant always maps to the same payee.

**Why this priority**: Current multi-step prompt is advisory — the LLM can skip `search_memory`, skip keyword heuristics, or jump straight to "Misc". A single deterministic tool call enforced by code eliminates this class of error.

**Independent Test**: Call `resolve_merchant("KOUFU PTE LTD")` → returns `{ payee: "Food", source: "memory" }`. Call `resolve_merchant("NTUC FairPrice")` → returns `{ payee: "Groceries", source: "keyword" }`. Call `resolve_merchant("SGSUPERGREEN-B PTE LTD")` → memory miss → keyword miss → Brave search → LLM classifies → returns `{ payee: "Misc", source: "web" }`.

**Acceptance Scenarios**:

1. **Given** a known merchant in MEMORY.md, **When** `resolve_merchant("KOUFU PTE LTD")` is called, **Then** it returns the learned payee with `source: "memory"` immediately (no API calls).
2. **Given** an unknown merchant with a keyword match (e.g., "NTUC FairPrice"), **When** `resolve_merchant` is called, **Then** it returns the keyword-matched payee with `source: "keyword"`.
3. **Given** an obscure merchant with no memory or keyword match, **When** `resolve_merchant` is called and BRAVE_SEARCH_API_KEY is configured, **Then** it searches the web, classifies via LLM, and returns a payee with `source: "web"`.
4. **Given** BRAVE_SEARCH_API_KEY is not configured, **When** `resolve_merchant` is called with an unknown merchant, **Then** it returns `{ payee: "Misc", source: "fallback" }` — no error.

---

### US-2: Automatic Learning from Resolutions (Priority: P2)

**As the** expense-tracker system,
**I want** `resolve_merchant` to automatically persist learned mappings to MEMORY.md,
**So that** the same merchant resolves instantly from memory next time without web search or LLM calls.

**Why this priority**: Without learning, every occurrence of the same obscure merchant triggers a costly web search + LLM call. Learning eliminates repeat costs.

**Independent Test**: Call `resolve_merchant` for a merchant resolved via "web" source, then check MEMORY.md — a fact like "SGSUPERGREEN-B PTE LTD maps to Misc payee" has been added. Second call to the same merchant returns `source: "memory"`.

**Acceptance Scenarios**:

1. **Given** a merchant resolved via `source: "web"` or `source: "keyword"`, **When** resolution completes, **Then** `learn_fact` is called with the mapping.
2. **Given** the same merchant is resolved a second time, **When** `resolve_merchant` is called, **Then** it returns `source: "memory"` — no web search performed.

---

### US-3: Plugin Tool Exposes Resolver to Gateway Agent (Priority: P2)

**As the** Gateway agent processing an expense-tracking request via Telegram,
**I want** a typed `budget_resolve_merchant` tool that wraps the expense-tracker's `resolve_merchant` endpoint,
**So that** the Gateway agent also benefits from deterministic merchant resolution.

**Why this priority**: The Gateway agent shares the same payee matching problem. Adding it to the plugin keeps the `budget_*` tool surface consistent.

**Independent Test**: Verify `budget_resolve_merchant` appears in `openclaw plugins inspect expense-tracker-tools --runtime --json`.

**Acceptance Scenarios**:

1. **Given** the updated plugin, **When** the Gateway agent needs to identify a merchant, **Then** it calls `budget_resolve_merchant` instead of multi-step tool calls.
2. **Given** the SKILL.md workflow, **When** the agent follows payee matching instructions, **Then** it uses `budget_resolve_merchant` as the single payee resolution step.

---

### US-4: User Corrections Update Transaction and Memory (Priority: P2)

**As a** user who spots a misclassification (e.g., "SGSUPERGREEN-B should be Food, not Misc"),
**I want** to send a correction message on Telegram and have the agent fix both the learned fact and the existing transaction,
**So that** future transactions for the same merchant are correct AND the past transaction is retroactively fixed.

**Why this priority**: Without `update_transaction`, user corrections only fix the memory (future transactions) but leave the misclassified transaction in Actual Budget. The user must manually fix it. Adding `update_transaction` closes this gap.

**Independent Test**: Send "no, supergreen is food" on Telegram. Agent calls `budget_update_fact` to fix the memory, `budget_fetch_recent_transactions` to find the wrong transaction, `budget_update_transaction` to fix its payee, and `budget_notify_user` to confirm. The transaction now shows the correct payee in Actual Budget.

**Acceptance Scenarios**:

1. **Given** a merchant was misclassified to "Misc" and a transaction was inserted, **When** the user sends a correction via Telegram, **Then** the Gateway agent calls `budget_update_fact` to update the memory, finds the transaction via `budget_fetch_recent_transactions`, calls `budget_update_transaction` with the corrected payee, and notifies the user.
2. **Given** the agent calls `budget_update_transaction` with a payee that does not exist in the payee list, **When** the tool validates it, **Then** the payee is rejected and the transaction is not updated — the agent must use a valid payee from `budget_fetch_payees`.
3. **Given** the agent calls `budget_update_transaction` with a category_id that does not exist, **When** the tool validates it, **Then** the category is rejected — the agent must use a valid category from `budget_fetch_categories` or omit the category.

---

### Edge Cases

- **What happens when Brave Search returns zero results?** The tool skips to LLM classification with only the merchant name. If that also fails, falls back to `{ payee: "Misc", source: "fallback" }`.
- **What happens when the LLM classification call fails?** The tool catches the error and returns `{ payee: "Misc", source: "fallback" }`. No crash, no stuck pipeline.
- **What happens when the merchant name contains special characters?** The merchant string is sanitized before web search (trimmed, special chars stripped for query). Memory and keyword matching use the full original name.
- **What happens with very long merchant names (>200 chars)?** The full name is used for memory/keyword matching. The web search query uses the first 100 characters.
- **What if the LLM classifies to a payee not in the fetch_payees list?** The tool validates the classification against the live payee list. If no match, falls back to "Misc".
- **What happens during concurrent calls for the same merchant?** Each call runs independently. The first to complete calls `learn_fact`; subsequent calls may still run the pipeline but the second `learn_fact` call is a no-op (dedup).
- **What if the user corrects a transaction that doesn't exist?** `update_transaction` returns an error from the actual-api. The agent reports the failure to the user.
- **What if `update_transaction` receives an empty body (no fields to update)?** The tool returns a validation error — at least one field (payee, notes, amount, date, category, account) must be provided.

---

## Requirements

### Functional Requirements

**resolve_merchant (FR-001 to FR-010):**

- **FR-001**: The expense-tracker MUST expose a `resolve_merchant` tool at `POST /tools/resolve-merchant` accepting `{ merchant: string, budget_id?: string }` and returning `{ payee: string, source: "memory"|"keyword"|"web"|"fallback" }`. The `budget_id` is used for payee list validation (FR-007) — when omitted, the default budget is used.
- **FR-002**: The tool MUST execute steps in this exact order, short-circuiting on first match: (1) `MemoryStore.search()` lookup in MEMORY.md, (2) keyword heuristic matching against a hardcoded table, (3) Brave web search + DeepSeek LLM classification, (4) "Misc" fallback.
- **FR-003**: Brave Search MUST be called only when `BRAVE_SEARCH_API_KEY` is configured in the expense-tracker's environment AND steps 1-2 have no match.
- **FR-004**: LLM classification MUST use the existing DeepSeek client with `temperature: 0.1` and `thinking: { type: "adaptive" }` (same as the orchestrator). For simple classifications, adaptive mode skips reasoning tokens automatically; for ambiguous results, it enables reasoning to disambiguate.
- **FR-005**: The keyword heuristic table MUST be extracted from the orchestrator prompt into a shared constant (e.g., `src/keywords.js`) imported by both `prompts.js` and the `resolve_merchant` handler, preventing drift between the LLM prompt and the tool code.
- **FR-006**: After resolving via `source: "web"` or `source: "keyword"`, the tool MUST call `MemoryStore.add()` to persist the mapping to MEMORY.md. Resolutions via `source: "memory"` or `source: "fallback"` MUST NOT trigger learning.
- **FR-007**: The tool MUST validate that the resolved payee exists in the live payee list. Unmatched classifications MUST fall back to "Misc" with `source: "fallback"`.
- **FR-008**: The tool MUST return within 500ms (memory/keyword path) or 20 seconds (web search path). Timeout at any step MUST fall through to the next step, not crash.
- **FR-009**: The Gateway plugin MUST add `budget_resolve_merchant` tool wrapping `POST /tools/resolve-merchant`.
- **FR-010**: The expense-tracker orchestrator prompt (`src/prompts.js`) MUST be updated to use `resolve_merchant` instead of the multi-step payee matching sequence.
- **FR-011**: The SKILL.md MUST be updated to use `budget_resolve_merchant` in the payee matching workflow.

**Transaction Validation (FR-012 to FR-016):**

- **FR-012**: The actual-api MUST expose a `PATCH /transactions/:id` endpoint accepting partial transaction fields (payee, notes, amount, date, category, account, cleared). Only provided fields are updated; omitted fields are left unchanged.
- **FR-013**: The expense-tracker MUST expose an `update_transaction` tool at `POST /tools/update-transaction` accepting `{ id: string, budget_id?, payee_name?, notes?, amount?, date?, category_id?, account_id? }`. At least one optional field must be provided.
- **FR-014**: Both `insert_transaction` and `update_transaction` MUST validate the resolved payee against the live payee list. On insert, the `imported_description` is resolved through `_validate_payee` → unknown payees fall back to "Misc". On update, the `payee_name` is validated directly → unknown payees are rejected.
- **FR-015**: Both `insert_transaction` and `update_transaction` MUST validate `category_id` against the live category list from Actual Budget. Unknown categories on insert fall back to "Fun Money". Unknown categories on update are rejected.
- **FR-016**: The Gateway plugin MUST add `budget_update_transaction` tool wrapping `POST /tools/update-transaction`.

### Key Entities

- **resolve_merchant tool**: A deterministic pipeline tool inside the expense-tracker container. Input: merchant name. Output: payee classification with source.
- **update_transaction tool**: A partial-update tool for correcting misclassified transactions. Validates payee and category against live lists before applying.
- **Transaction validation**: On insert, unknown payee → "Misc", unknown category → "Fun Money". On update, unknown payee or category → reject.
- **Keyword heuristic table**: A hardcoded mapping in the tool code. Maps keyword → payee name. Same keywords as the current orchestrator prompt.
- **Web search classification prompt**: A structured prompt sent to `deepseek-chat` with merchant name, Brave snippets, and payee list. Returns JSON classification.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: `resolve_merchant("KOUFU PTE LTD")` returns `source: "memory"` with `payee: "Food"` in under 500ms.
- **SC-002**: `resolve_merchant("NTUC FairPrice")` returns `source: "keyword"` with `payee: "Groceries"` in under 500ms.
- **SC-003**: `resolve_merchant("SGSUPERGREEN-B PTE LTD")` returns a classification in under 20 seconds (web search or fallback "Misc").
- **SC-004**: After a "web" or "keyword" resolution, MEMORY.md contains a new fact within 1 second.
- **SC-005**: `insert_transaction` with an unknown category_id falls back to "Fun Money" — transaction is inserted with the fallback category.
- **SC-006**: `update_transaction` with an unknown payee is rejected (returns validation error, does not call actual-api).
- **SC-007**: User correction flow completes: `update_fact` + `fetch_recent_transactions` + `update_transaction` + `notify_user` — the transaction's payee is updated in Actual Budget.

---

## Non-Goals

- Changing the orchestrator's LLM model or adding a new model provider
- Adding web search capability to the Gateway agent (already has `web_search` built-in)
- Replacing the keyword heuristic table with an external knowledge graph
- Caching Brave Search results beyond MEMORY.md learning
- Supporting search providers other than Brave Search (single provider for v1)
- Resolving merchants to categories (only payees) — category assignment remains the agent's responsibility
- Batch resolution or batch update (single merchant/transaction per call)
- Deleting transactions (use Actual Budget directly)

---

## Assumptions

- `BRAVE_SEARCH_API_KEY` is configured in `modules/expense-tracker/.env` (optional — tool degrades gracefully without it)
- The expense-tracker container has outbound HTTP access to `api.search.brave.com`
- The existing DeepSeek client in the orchestrator can be reused for classification (same API key, same base URL)
- The keyword heuristic table matches the current keywords in `src/prompts.js`
- `MemoryStore` (MEMORY.md) is accessible from the tool handler for both search and add operations
- The expense-tracker's internal payee fetch returns the current payee list from Actual Budget
- The Gateway plugin can call the expense-tracker's internal Docker network (`http://expense-tracker:8080`)
- Correcting a fact via `update_fact` / `delete_fact` is already a documented workflow in the SKILL.md
- `insert_transaction`'s existing `_validate_payee` fallback behavior (unknown → "Misc") remains unchanged
- Category "Fun Money" exists in the budget and is the system default for unknown categories on insert
