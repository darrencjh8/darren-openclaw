# Research: Merchant Resolver

**Feature**: merchant-resolver
**Date**: 2026-06-15

## Decision 1: Nested LLM Classification

**Decision**: The `resolve_merchant` tool calls `deepseek-chat` internally for web search classification, rather than returning raw search results to the orchestrator.

**Rationale**: The orchestrator LLM already failed at payee matching (skips steps, hallucinates). Returning raw search results delegates classification back to the unreliable LLM. The nested call is focused (temperature 0.1, thinking disabled, structured JSON output) and costs one extra API call per unknown merchant. Known merchants hit memory and skip it entirely.

**Alternatives considered**:
- Return raw Brave snippets to orchestrator — reintroduces LLM unreliability
- Use a separate classification model — adds infrastructure complexity

## Decision 2: Keyword Table Extraction

**Decision**: Extract the keyword heuristic table from `prompts.js` into a new `src/keywords.js` shared constant.

**Rationale**: Currently the keyword rules live only in the LLM prompt. Extracting them into code enables the `resolve_merchant` tool to use them deterministically (step 2) while `prompts.js` imports the same table for the orchestrator prompt. Single source of truth, no drift.

**Alternatives considered**:
- Duplicate the table in the tool handler — drift risk
- Remove keywords from prompt entirely — the orchestrator still needs them as context for other decisions

## Decision 3: PATCH vs PUT for update_transaction

**Decision**: Use `PATCH /transactions/:id` for partial updates.

**Rationale**: User corrections typically change only the payee. A `PATCH` avoids requiring the agent to fetch and re-send all fields. `actual.updateTransaction(id, fields)` already supports partial updates (proven by the `clear` endpoint). The PATCH contract matches the underlying API semantics.

**Alternatives considered**:
- `PUT /transactions/:id` — requires full object, adds friction for partial corrections
- `POST /transactions/:id/update` — non-standard, verbose

## Decision 4: Category Validation Strategy

**Decision**: Fetch live categories from Actual Budget, validate `category_id` exists. On insert, unknown → "Fun Money". On update, unknown → reject.

**Rationale**: Insert is automated (email pipeline) — falling back to a default category is better than failing silently. Update is user-initiated (correction) — rejecting bad data is better than silently changing to a default. "Fun Money" exists in the budget and is the system's catch-all category.

**Alternatives considered**:
- Reject on both insert and update — email pipeline would fail on every unknown category
- Fall back on both — could silently miscategorize user corrections

## Decision 5: Brave Search API

**Decision**: Use Brave Search API `https://api.search.brave.com/res/v1/web/search` with `count=5` and `search_lang=en`. Header: `X-Subscription-Token`.

**Rationale**: Brave Search has a generous free tier ($5/month = 1,000 queries). The API returns structured results with title/description snippets suitable for LLM classification. DuckDuckGo Instant Answer API was tested and returned empty results for obscure Singapore merchants.

**Alternatives considered**:
- DuckDuckGo — tested, returns empty for Singapore businesses
- Google Custom Search — requires API key + CX setup, no free tier
- Skip web search — LLM alone hallucinated "waste management" for SGSUPERGREEN-B
