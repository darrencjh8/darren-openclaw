# Tasks: Merchant Resolver

**Input**: Design documents from `/specs/015-merchant-resolver/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/
**Tests**: TDD — test tasks precede implementation. Failures must be confirmed before writing code.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- All tasks include exact file paths

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Keyword table extraction and config

- [ ] T001 Create shared keyword table at `modules/expense-tracker/src/keywords.js` — extract keyword→payee mappings from `modules/expense-tracker/src/prompts.js`
- [ ] T002 Update `modules/expense-tracker/src/prompts.js` to import keyword table from `src/keywords.js` instead of inline keywords
- [ ] T003 Verify `modules/expense-tracker/src/config.js` has `this.braveSearchApiKey = env.BRAVE_SEARCH_API_KEY || ""`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Prove the DeepSeek client can be reused for classification and Brave API works

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 [P] Write failing test for Brave Search API call in `modules/expense-tracker/tests/resolve-merchant.test.js` — mock fetch, verify correct endpoint, headers, query params
- [ ] T005 [P] Write failing test for DeepSeek classification prompt in `modules/expense-tracker/tests/resolve-merchant.test.js` — verify prompt structure includes merchant, snippets, payee list
- [ ] T006 Implement Brave Search helper in `modules/expense-tracker/src/tools.js` — function that queries `https://api.search.brave.com/res/v1/web/search` with `X-Subscription-Token` header
- [ ] T007 Implement classification helper in `modules/expense-tracker/src/tools.js` — calls DeepSeek with structured prompt, parses JSON response
- [ ] T008 Verify T004 and T005 pass (Brave search + LLM classification pattern proven)

**Checkpoint**: External API pattern proven. Ready for pipeline implementation.

---

## Phase 3: User Story 1 — Deterministic Merchant Resolution (Priority: P1) 🎯 MVP

**Goal**: `resolve_merchant` tool with 4-step pipeline (memory → keyword → web → fallback)

**Independent Test**: `curl -X POST :8080/tools/resolve-merchant -d '{"merchant":"KOUFU PTE LTD"}'` → `{"payee":"Food","source":"memory"}`

### Tests for US1 (TDD — write first, confirm failure)

- [ ] T009 [P] [US1] Write failing test for memory step — `MemoryStore.search()` hit returns `source: "memory"` in `modules/expense-tracker/tests/resolve-merchant.test.js`
- [ ] T010 [P] [US1] Write failing test for keyword step — keyword match returns `source: "keyword"` in `modules/expense-tracker/tests/resolve-merchant.test.js`
- [ ] T011 [P] [US1] Write failing test for full pipeline — unknown merchant falls through to web/fallback in `modules/expense-tracker/tests/resolve-merchant.test.js`
- [ ] T012 [P] [US1] Write failing test for short-circuit — memory hit skips keyword + web in `modules/expense-tracker/tests/resolve-merchant.test.js`
- [ ] T013 [US1] Run tests and confirm they fail (resolve_merchant not registered yet)

### Implementation for US1

- [ ] T014 [US1] Implement `_handle_resolve_merchant` in `modules/expense-tracker/src/tools.js` — 4-step pipeline: MemoryStore.search → keyword match → Brave + LLM → "Misc" fallback
- [ ] T015 [US1] Add `resolve_merchant` tool schema to TOOLS array in `modules/expense-tracker/src/tools.js`
- [ ] T016 [US1] Register `resolve_merchant` route in `modules/expense-tracker/src/index.js` (`POST /tools/resolve-merchant`)
- [ ] T017 [US1] Run all tests and confirm they pass (memory, keyword, web, fallback all working)

**Checkpoint**: `resolve_merchant` tool functional. Pipeline enforced by code.

---

## Phase 4: User Story 2 — Automatic Learning (Priority: P2)

**Goal**: `resolve_merchant` auto-learns to MEMORY.md after keyword/web resolution

**Independent Test**: After resolving via "web", check MEMORY.md → new fact exists. Second call returns `source: "memory"`.

### Tests for US2 (TDD — write first, confirm failure)

- [ ] T018 [P] [US2] Write failing test for auto-learn after keyword match in `modules/expense-tracker/tests/resolve-merchant.test.js`
- [ ] T019 [P] [US2] Write failing test for auto-learn after web resolution in `modules/expense-tracker/tests/resolve-merchant.test.js`
- [ ] T020 [P] [US2] Write failing test for no-learn on memory hit (already learned) in `modules/expense-tracker/tests/resolve-merchant.test.js`
- [ ] T021 [P] [US2] Write failing test for no-learn on fallback in `modules/expense-tracker/tests/resolve-merchant.test.js`
- [ ] T022 [US2] Run tests and confirm they fail (learning not implemented yet)

### Implementation for US2

- [ ] T023 [US2] Add `MemoryStore.add()` call after keyword match in `modules/expense-tracker/src/tools.js` (`_handle_resolve_merchant`)
- [ ] T024 [US2] Add `MemoryStore.add()` call after successful LLM classification in `modules/expense-tracker/src/tools.js`
- [ ] T025 [US2] Run tests and confirm they pass (learning triggers correctly for keyword/web, not for memory/fallback)

**Checkpoint**: Auto-learning works. Second call returns `source: "memory"`.

---

## Phase 5: User Story 3 — Plugin Integration (Priority: P2)

**Goal**: `budget_resolve_merchant` tool in Gateway plugin

**Independent Test**: `openclaw plugins inspect expense-tracker-tools --runtime --json` shows `budget_resolve_merchant`

### Tests for US3

- [ ] T026 [P] [US3] Write failing test for `budget_resolve_merchant` registration in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [ ] T027 [P] [US3] Write failing test for `budget_resolve_merchant` HTTP call shape in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [ ] T028 [US3] Run tests and confirm they fail (tool not registered yet)

### Implementation for US3

- [ ] T029 [US3] Implement `budget_resolve_merchant` in `gateway/plugins/expense-tracker-tools/index.js` — `api.registerTool()` with TypeBox schema, POST to expense-tracker
- [ ] T030 [US3] Add `budget_resolve_merchant` to `contracts.tools` in `gateway/plugins/expense-tracker-tools/openclaw.plugin.json`
- [ ] T031 [US3] Update safety net test — change `expect(registeredTools.length).toBe(21)` to `.toBe(22)` in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [ ] T032 [US3] Run tests and confirm they pass

**Checkpoint**: Gateway agent can call `budget_resolve_merchant`.

---

## Phase 6: User Story 4 — User Corrections with update_transaction (Priority: P2)

**Goal**: `update_transaction` tool with payee/category validation, `PATCH /transactions/:id` in actual-api

**Independent Test**: Correct a misclassified transaction via Telegram. Agent calls `budget_update_fact` + `budget_update_transaction` → payee updated in Actual Budget.

### Tests for US4 (TDD — write first, confirm failure)

- [ ] T033 [P] [US4] Write failing test for `PATCH /transactions/:id` in `gateway/actual-api/__tests__/server.test.js` — verify partial update calls `actual.updateTransaction`
- [ ] T034 [P] [US4] Write failing test for `update_transaction` tool registration in `modules/expense-tracker/tests/update-transaction.test.js`
- [ ] T035 [P] [US4] Write failing test for payee validation (unknown payee → reject) in `modules/expense-tracker/tests/update-transaction.test.js`
- [ ] T036 [P] [US4] Write failing test for category validation (unknown category → reject) in `modules/expense-tracker/tests/update-transaction.test.js`
- [ ] T037 [P] [US4] Write failing test for category validation on insert (unknown category → "Fun Money") in `modules/expense-tracker/tests/update-transaction.test.js`
- [ ] T038 [P] [US4] Write failing test for `budget_update_transaction` registration in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [ ] T039 [US4] Run tests and confirm they fail (tools not implemented yet)

### Implementation for US4

- [ ] T040 [US4] Add `PATCH /transactions/:id` route in `gateway/actual-api/server.js` — accepts partial fields, calls `actual.updateTransaction(id, fields)`
- [ ] T041 [US4] Implement `_handle_update_transaction` in `modules/expense-tracker/src/tools.js` — validates payee, validates category, calls actual-api PATCH
- [ ] T042 [US4] Add `update_transaction` tool schema to TOOLS array in `modules/expense-tracker/src/tools.js`
- [ ] T043 [US4] Register `update_transaction` route in `modules/expense-tracker/src/index.js` (`POST /tools/update-transaction`)
- [ ] T044 [US4] Add category validation to `_handle_insert_transaction` in `modules/expense-tracker/src/tools.js` — validate `category_id` against live categories, fall back to "Fun Money" if unknown
- [ ] T045 [US4] Implement `budget_update_transaction` in `gateway/plugins/expense-tracker-tools/index.js`
- [ ] T046 [US4] Add `budget_update_transaction` to `contracts.tools` in `gateway/plugins/expense-tracker-tools/openclaw.plugin.json`
- [ ] T047 [US4] Update safety net test — change `expect(registeredTools.length).toBe(22)` to `.toBe(23)` in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [ ] T048 [US4] Run all tests and confirm they pass

**Checkpoint**: User corrections flow works end-to-end.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, edge cases, final validation

- [ ] T049 Update `gateway/workspace/skills/expense-tracker/SKILL.md` — add correction workflow, update payee matching to reference `budget_resolve_merchant`
- [ ] T050 Update orchestrator prompt in `modules/expense-tracker/src/prompts.js` — replace multi-step payee matching with `resolve_merchant` call
- [ ] T051 [P] Verify graceful degradation — test `resolve_merchant` without BRAVE_SEARCH_API_KEY set, confirm fallback to "Misc"
- [ ] T052 [P] Verify payee validation — test `update_transaction` rejects unknown payee, `insert_transaction` falls back to "Fun Money" for unknown category
- [ ] T053 Run quickstart.md validation — confirm all 7 VS scenarios pass
- [ ] T054 Git commit all changes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup
- **US1 (Phase 3)**: Depends on Foundational — P1
- **US2 (Phase 4)**: Depends on US1 — P2
- **US3 (Phase 5)**: Depends on US1 — P2 (parallel with US2)
- **US4 (Phase 6)**: Depends on US1 — P2 (parallel with US2, US3)
- **Polish (Phase 7)**: Depends on all stories

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational. No dependencies on other stories.
- **US2 (P2)**: Can start after US1. Independent of US3/US4.
- **US3 (P2)**: Can start after US1. Independent of US2/US4.
- **US4 (P2)**: Can start after US1. Independent of US2/US3.

### Parallel Opportunities

- T004, T005 can run in parallel (Foundational tests)
- T009-T012 can run in parallel (US1 tests, same file but independent)
- T018-T021 can run in parallel (US2 tests)
- T026-T027 can run in parallel (US3 tests)
- T033-T038 can run in parallel (US4 tests)
- Phase 4, 5, 6 can run in parallel after Phase 3 completes

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2: Foundational (T004-T008) — API patterns proven
3. Complete Phase 3: US1 (T009-T017) — resolve_merchant working
4. **STOP and VALIDATE**: Test via curl, verify all 4 pipeline paths

### Incremental Delivery

1. Setup + Foundational → API patterns proven
2. US1 → resolve_merchant tool → MVP!
3. US2 → Auto-learning → Deploy
4. US3 → Plugin integration → Agent can call it
5. US4 → update_transaction + validation → Correction flow
6. Polish → Docs, edge cases, final validation

---

## Notes

- All tasks include exact file paths for immediate execution
- TDD enforced: tests written before implementation in every phase
- `config.js` already has `braveSearchApiKey` from spec 015 setup
- `resolve_merchant` accepts optional `budget_id` for payee validation (consistent with all other budget tools)
- Safety net test (exact tool count) must be updated when adding new plugin tools (T031, T047)
- `insert_transaction` category validation is added in US4 (T044) since it shares the same validation pattern
