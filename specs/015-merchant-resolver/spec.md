# Feature Specification: Merchant Resolver

**Feature:** merchant-resolver
**Spec Version:** 1.0.0
**Status:** Draft
**Created:** 2026-06-15
**Constitution Hash:** v4.0.0

---

## Overview

The expense-tracker orchestrator currently relies on its LLM to run a multi-step payee matching sequence: `search_memory` → keyword heuristics → `fetch_payees` → fallback to "Misc". This is fragile — the LLM can skip steps, hallucinate the fallback, or mis-sequence the calls. It also burns tokens on string matching that code can do deterministically.

Add a `resolve_merchant` tool inside the expense-tracker that runs the full pipeline in code: memory lookup → keyword heuristic → Brave web search → LLM classification → auto-learn. The orchestrator LLM calls one tool and gets one answer. The Gateway agent benefits via a `budget_resolve_merchant` plugin tool wrapping the same endpoint.

For obscure merchants like "SGSUPERGREEN-B PTE LTD" where neither memory nor keywords match, Brave Search provides real web data for LLM classification. Without a Brave API key, the pipeline degrades gracefully to LLM-only classification from the merchant name.

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

### Edge Cases

- **What happens when Brave Search returns zero results?** The tool skips to LLM classification with only the merchant name. If that also fails, falls back to `{ payee: "Misc", source: "fallback" }`.
- **What happens when the LLM classification call fails?** The tool catches the error and returns `{ payee: "Misc", source: "fallback" }`. No crash, no stuck pipeline.
- **What happens when the merchant name contains special characters?** The merchant string is sanitized before web search (trimmed, special chars stripped for query). Memory and keyword matching use the full original name.
- **What happens with very long merchant names (>200 chars)?** The full name is used for memory/keyword matching. The web search query uses the first 100 characters.
- **What if the LLM classifies to a payee not in the fetch_payees list?** The tool validates the classification against the live payee list. If no match, falls back to "Misc".
- **What happens during concurrent calls for the same merchant?** Each call runs independently. The first to complete calls `learn_fact`; subsequent calls may still run the pipeline but the second `learn_fact` call is a no-op (dedup).

---

## Requirements

### Functional Requirements

- **FR-001**: The expense-tracker MUST expose a `resolve_merchant` tool at `POST /tools/resolve-merchant` accepting `{ merchant: string }` and returning `{ payee: string, source: "memory"|"keyword"|"web"|"fallback" }`.
- **FR-002**: The tool MUST execute steps in this exact order, short-circuiting on first match: (1) `MemoryStore.search()` lookup in MEMORY.md, (2) keyword heuristic matching against a hardcoded table, (3) Brave web search + DeepSeek LLM classification, (4) "Misc" fallback.
- **FR-003**: Brave Search MUST be called only when `BRAVE_SEARCH_API_KEY` is configured in the expense-tracker's environment AND steps 1-2 have no match.
- **FR-004**: LLM classification MUST use the existing DeepSeek client (`deepseek-chat`, temperature 0.1) with a structured prompt: given the merchant name, top 5 Brave search result snippets (if available), and the list of available payee names from the internal payee list, return a JSON classification.
- **FR-005**: After resolving via `source: "web"` or `source: "keyword"`, the tool MUST call `MemoryStore.add()` to persist the mapping to MEMORY.md. Resolutions via `source: "memory"` or `source: "fallback"` MUST NOT trigger learning.
- **FR-006**: The tool MUST validate that the resolved payee exists in the live payee list from the expense-tracker's internal payee fetch. Unmatched classifications MUST fall back to "Misc".
- **FR-007**: The tool MUST return within 500ms (memory/keyword path) or 20 seconds (web search path). Timeout at any step MUST fall through to the next step, not crash.
- **FR-008**: The Gateway plugin MUST add `budget_resolve_merchant` tool wrapping `POST /tools/resolve-merchant` with the same `merchant` parameter.
- **FR-009**: The expense-tracker orchestrator prompt (`src/prompts.js`) MUST be updated to use `resolve_merchant` instead of the multi-step `search_memory` + keyword + `fetch_payees` payee matching sequence.
- **FR-010**: The SKILL.md MUST be updated to use `budget_resolve_merchant` in the Gateway agent's payee matching workflow.

### Key Entities

- **resolve_merchant tool**: A deterministic pipeline tool inside the expense-tracker container. Input: merchant name string. Output: payee classification with source. Registered as an HTTP endpoint and available to the orchestrator LLM as a callable tool.
- **Keyword heuristic table**: A hardcoded mapping in the tool code (not the LLM prompt). Maps keyword → payee name. Example: `["hawker", "food", "restaurant", "cafe"]` → "Food". Same keywords as the current orchestrator prompt in `src/prompts.js`.
- **Web search classification prompt**: A structured prompt sent to the existing `deepseek-chat` client with the merchant name, top 5 Brave search result snippets, and the list of available payee names. Returns a JSON `{ payee: string }` classification.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: `resolve_merchant("KOUFU PTE LTD")` returns `source: "memory"` with `payee: "Food"` in under 500ms.
- **SC-002**: `resolve_merchant("NTUC FairPrice")` returns `source: "keyword"` with `payee: "Groceries"` in under 500ms.
- **SC-003**: `resolve_merchant("SGSUPERGREEN-B PTE LTD")` returns a classification (from web search or fallback "Misc" if no API key) in under 20 seconds.
- **SC-004**: After a "web" or "keyword" resolution, MEMORY.md contains a new fact within 1 second.
- **SC-005**: Second call to `resolve_merchant` for the same merchant returns `source: "memory"` — no web search performed.
- **SC-006**: The orchestrator processes a transaction email using `resolve_merchant` instead of multi-step payee matching (confirmed by tool call log showing a single `resolve_merchant` call).

---

## Non-Goals

- Changing the orchestrator's LLM model or adding a new model provider
- Adding web search capability to the Gateway agent (already has `web_search` built-in)
- Replacing the keyword heuristic table with an external knowledge graph
- Caching Brave Search results beyond MEMORY.md learning
- Adding web search for purposes other than payee classification
- Supporting search providers other than Brave Search (single provider for v1)
- Resolving merchants to categories (only payees) — category assignment remains the agent's responsibility
- Batch resolution (multiple merchants in one call)

---

## Assumptions

- `BRAVE_SEARCH_API_KEY` is configured in `modules/expense-tracker/.env` (optional — tool degrades gracefully without it)
- The expense-tracker container has outbound HTTP access to `api.search.brave.com`
- The existing DeepSeek client in the orchestrator can be reused for classification (same API key, same base URL)
- The keyword heuristic table matches the current keywords in `src/prompts.js`
- `MemoryStore` (MEMORY.md) is accessible from the tool handler for both search and add operations
- The expense-tracker's internal payee fetch returns the current payee list from Actual Budget
- The Gateway plugin can call the expense-tracker's internal Docker network (`http://expense-tracker:8080`)
