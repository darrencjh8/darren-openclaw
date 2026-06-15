# Requirements Quality Checklist: Merchant Resolver

**Feature:** merchant-resolver
**Spec Version:** 1.0.0
**Checklist Version:** 1.0.0
**Reviewed:** 2026-06-15

---

## Checklist

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Spec structure follows project template (Overview, User Stories, Requirements, Success Criteria, Non-Goals, Assumptions) | ✅ Pass | Matches `specs/014-expense-plugin-tools/spec.md` section structure exactly |
| 2 | Overview clearly states the problem and the solution at a high level | ✅ Pass | Problem (LLM payee matching is expensive, inconsistent, fragile) and solution (4-step pipeline as a single tool) are clearly articulated |
| 3 | Every user story has: role, want, benefit, priority, why-this-priority, independent test, and acceptance scenarios | ✅ Pass | All 3 user stories follow the template format with full acceptance scenarios in Given/When/Then form |
| 4 | User story priorities are justified and reflect real business value | ✅ Pass | P1 deterministic resolution prevents the #1 source of budget errors; P2 auto-learning saves API costs; P2 plugin integration ensures discoverability |
| 5 | Acceptance scenarios are testable (Given/When/Then with concrete inputs and expected outputs) | ✅ Pass | Each scenario specifies concrete merchant names, tool parameters, expected responses, and observable side effects |
| 6 | Edge cases cover: zero results, API failures, special chars, long names, payee validation, empty input, concurrent calls | ✅ Pass | 9 edge cases explicitly enumerated with resolution behavior for each |
| 7 | Functional requirements are numbered, unambiguous, and testable | ✅ Pass | FR-001 through FR-010 each contain a MUST with specific behavior, thresholds, or API contracts |
| 8 | FR-001 (4-step pipeline order) is enforced by code, not prompt | ✅ Pass | Pipeline is a tool-internal state machine — the LLM calls one tool and the code deterministically runs the 4 steps in order |
| 9 | FR-004 (Brave Search conditional on API key) degrades gracefully | ✅ Pass | When API key absent, step 3 is silently skipped; the pipeline continues to step 4 without error |
| 10 | FR-006 (auto-learning) has a minimum confidence gate to prevent bad data poisoning | ✅ Pass | Only confidence ≥ "medium" triggers `learn_fact`; low-confidence and error results are not persisted |
| 11 | FR-007 (payee validation) prevents returning non-existent payees | ✅ Pass | Cross-references against `budget_fetch_payees`; downgrades confidence and sets `payee_validated: false` on mismatch |
| 12 | FR-008 (per-step timeouts) prevents a single slow step from failing the entire tool | ✅ Pass | Each of the 4 steps has an independent timeout; a timeout degrades to the next step, not a tool-level failure |
| 13 | Success criteria are measurable with concrete thresholds | ✅ Pass | SC-003 (<15s full pipeline), SC-004 (<100ms memory hit), SC-002 (10 identical results), SC-005 (3 API key configurations) |
| 14 | Non-goals explicitly exclude out-of-scope work to prevent scope creep | ✅ Pass | 8 items: no new model, no other search providers, no cache beyond memory, no batch resolution, no category resolution, etc. |
| 15 | Assumptions state what the feature depends on (environment, services, data) | ✅ Pass | 10 assumptions covering API key optionality, DeepSeek client reuse, memory tool availability, Docker network, etc. |
| 16 | Key entities are defined with their role in the system | ✅ Pass | 7 entities: tool, pipeline, memory fact, keyword mappings, Brave API, DeepSeek client, payee validation |
| 17 | No ambiguous terms — all domain concepts (merchant, payee, confidence, source) are defined | ✅ Pass | `source` values (`memory`, `keyword`, `llm`, `error`) and confidence levels (`high`, `medium`, `low`) are explicitly enumerated |
| 18 | Tool name (`resolve_merchant`) follows project naming conventions | ✅ Pass | Consistent with `budget_` prefixed tools in the expense-tracker plugin; registered via `api.registerTool()` with TypeBox schema |
| 19 | Works without BRAVE_SEARCH_API_KEY — no hard dependency on external service | ✅ Pass | FR-004 conditionally skips Brave; US-1 scenario 4 and SC-005 verify graceful degradation without the key |
| 20 | Auto-learning is automatic — no manual step required by the agent or user | ✅ Pass | FR-006 auto-calls `budget_learn_fact` within the tool handler; US-2 confirms learning happens without agent orchestration |
| 21 | DeepSeek client reuse (no new LLM dependency) | ✅ Waived | **Technical domain concern** — how the plugin accesses the existing DeepSeek client instance is an implementation detail of the plugin architecture, not a spec-level requirement |
| 22 | Memory/keyword steps call internal plugin functions (not HTTP to expense-tracker) | ✅ Waived | **Technical domain concern** — whether `search_memory`/`learn_fact` are internal JS functions or HTTP calls to the expense-tracker container is an implementation decision that doesn't affect the spec's behavioral contract |

---

## Summary

- **Pass**: 20 / 22
- **Waived**: 2 (items 21, 22 — technical domain / implementation detail)
- **Fail**: 0

## Waiver Notes

### Item 21 — DeepSeek client reuse

The spec states the resolver MUST reuse the existing DeepSeek client (Non-Goals, Assumptions). How the plugin's `execute` handler obtains a reference to that client (import from shared module, pass via plugin context, instantiate from env vars) is an implementation architecture decision. The behavioral contract — "step 4 calls DeepSeek with a classification prompt" — is covered by FR-005. The reuse mechanism is implementation detail.

### Item 22 — Internal vs HTTP for memory tools

The spec assumes `budget_search_memory` and `budget_learn_fact` are available as internal plugin functions with negligible latency (Assumptions). Whether these are JS functions within the plugin process or HTTP calls to `expense-tracker:8080/tools/search-memory` is an implementation choice. The behavioral contract — "step 1 queries memory, step 6 writes facts" — is covered by FR-002 and FR-006. The call mechanism (direct function vs HTTP) affects latency but not correctness.

## Key Design Notes

1. **4-step pipeline is code-enforced**: Unlike the current multi-step payee matching prompt (which the LLM can skip or mis-sequence), the `resolve_merchant` tool executes the 4 steps deterministically in its `execute` handler. The LLM calls one tool and gets one answer — no orchestration responsibility.

2. **Learning is automatic**: The tool calls `budget_learn_fact` internally after every medium/high-confidence resolution. The expense-tracker agent does not need to separately call `learn_fact` after `resolve_merchant` — the tool handles it. This eliminates the class of bugs where the agent forgets to persist the mapping.

3. **Works without API key**: The Brave Search step is entirely optional. When `BRAVE_SEARCH_API_KEY` is absent, the pipeline runs memory → keyword → LLM (with raw merchant name only). The LLM classification prompt is designed to handle both cases (with and without search context). This ensures the resolver is usable in environments without a Brave API key, albeit with reduced accuracy for unknown merchants.

4. **Graceful degradation at every step**: Each pipeline step has an independent timeout and error handler. A Brave API outage doesn't crash the tool — it degrades to LLM-only classification. A DeepSeek API failure returns a structured error with `source: "error"`. The tool never throws an unhandled exception.
