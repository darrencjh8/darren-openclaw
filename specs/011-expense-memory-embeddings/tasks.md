# Tasks: Expense Tracker Memory with Embeddings

**Input**: Design documents from `/specs/011-expense-memory-embeddings/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included per constitution 2.3 (TDD mandatory — every line of implementation code must be preceded by a failing test).

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US5, US6)
- Include exact file paths in descriptions

## Path Conventions

All paths relative to repo root. Expense tracker source in `modules/expense-tracker/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add new dependencies and configuration before any feature code

- [x] T001 [P] Add `sentence-transformers` and `optimum[onnxruntime]` to `modules/expense-tracker/requirements.txt`
- [x] T002 [P] Add `MEMORY_PATH` env var with default `data/MEMORY.md` in `modules/expense-tracker/src/config.py`

**Checkpoint**: Dependencies installable, env var readable

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: MemoryStore class — the core infrastructure ALL user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Write failing tests for MemoryStore initialization and indexing in `modules/expense-tracker/tests/test_memory.py`
- [x] T004 Create MemoryStore class with ONNX model loading, embed(), index rebuild in `modules/expense-tracker/src/agent/memory.py`
- [x] T005 Write failing test for migration from mappings.json → MEMORY.md in `modules/expense-tracker/tests/test_memory.py`
- [x] T006 Implement migration: read `data/mappings.json`, convert to natural-language facts, write `data/MEMORY.md` in `modules/expense-tracker/src/agent/memory.py`
- [x] T007 [P] Register 5 new tool endpoints (search-memory, learn-fact, list-facts, update-fact, delete-fact) in `modules/expense-tracker/src/tools_api.py`. Endpoints return "UNKNOWN_TOOL" until their handlers are built (search-memory: Phase 3, learn-fact: Phase 4, list/update/delete: Phase 5). All 5 endpoints registered now so the route table is stable.
- [x] T008 [P] Instantiate MemoryStore in `modules/expense-tracker/src/main.py` and pass to orchestrator

**Checkpoint**: MemoryStore loads, indexes MEMORY.md, endpoints registered — ready for user stories

---

## Phase 3: User Story 1 - Semantic Memory Search During Email Processing (Priority: P1) 🎯 MVP

**Goal**: LLM can call search_memory(query) and get semantically relevant facts back, even with spelling variations

**Independent Test**: Seed MEMORY.md with "Card ending 4605 belongs to UOB Ladies credit card", query "UOB card 4605" → returns the fact with score > 0.8

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T009 [P] [US1] Test empty memory returns no results in `modules/expense-tracker/tests/test_memory.py`
- [x] T010 [P] [US1] Test semantic search across spelling variations in `modules/expense-tracker/tests/test_memory.py`
- [x] T011 [P] [US1] Test substring fallback when model unavailable in `modules/expense-tracker/tests/test_memory.py`

### Implementation for User Story 1

- [x] T012 [US1] Implement search(query, top_k) method on MemoryStore in `modules/expense-tracker/src/agent/memory.py`
- [x] T013 [US1] Implement ensure_loaded() lazy-init with ONNX model in `modules/expense-tracker/src/agent/memory.py`
- [x] T014 [US1] Add `search_memory` tool handler and schema to ToolRegistry in `modules/expense-tracker/src/agent/tools.py`

**Checkpoint**: LLM can call search_memory, get semantic matches back. Cold start (empty memory) works.

---

## Phase 4: User Story 2 - Self-Learning from Successful Transactions (Priority: P1)

**Goal**: After each successful insert, LLM calls learn_fact. Semantic dedup prevents duplicates. Periodic rewrite keeps file compact.

**Independent Test**: learn_fact("Grab → Transport") twice → first adds, second skips (cosine ≥ 0.95). MEMORY.md has exactly one Grab line.

### Tests for User Story 2

- [x] T015 [P] [US2] Test learn_fact appends to file and indexes in `modules/expense-tracker/tests/test_memory.py`
- [x] T016 [P] [US2] Test semantic dedup skips near-identical facts in `modules/expense-tracker/tests/test_memory.py`
- [x] T017 [P] [US2] Test periodic rewrite deduplicates file and rebuilds index in `modules/expense-tracker/tests/test_memory.py`

### Implementation for User Story 2

- [x] T018 [US2] Implement add(fact) with cosine-similarity dedup (threshold 0.95) on MemoryStore in `modules/expense-tracker/src/agent/memory.py`
- [x] T019 [US2] Implement periodic rewrite (every 50 facts): re-read, cross-deduplicate, rewrite compactly, rebuild index in `modules/expense-tracker/src/agent/memory.py`
- [x] T020 [US2] Add `learn_fact` tool handler and schema to ToolRegistry in `modules/expense-tracker/src/agent/tools.py`
- [x] T021 [US2] Remove `learn_mapping` tool handler, schema, and `load_mappings`/`save_mappings` from `modules/expense-tracker/src/agent/tools.py`

**Checkpoint**: Facts self-learn with dedup. File grows slowly, bounded by unique relationships. Note: learn_mapping→learn_fact prompt rename is handled by T042 (prompt restructure) in Phase 7.

---

## Phase 5: User Story 3 + 5 - User Feedback via Telegram + Notification Cooldown (Priority: P2)

**Goal**: User corrects mappings via Telegram → gateway calls update-fact/delete-fact. Ambiguous emails don't spam (1h cooldown). Cooldown clears on correction so email re-processes immediately.

**Independent Test**: Send ambiguous email → notify once. Re-scan → suppressed. User replies → cooldown clears. Next scan → inserts correctly.

### Tests for User Story 3 + 5

- [x] T023 [P] [US3] Test list-facts returns all facts from MEMORY.md in `modules/expense-tracker/tests/test_tools.py`
- [x] T024 [P] [US3] Test update-fact replaces text and rebuilds index in `modules/expense-tracker/tests/test_tools.py`
- [x] T025 [P] [US3] Test delete-fact removes matching lines and rebuilds index in `modules/expense-tracker/tests/test_tools.py`
- [x] T026 [P] [US5] Test cooldown suppresses repeat notify_user within 1 hour in `modules/expense-tracker/tests/test_cooldown.py`
- [x] T027 [P] [US5] Test cooldown clears on update-fact call in `modules/expense-tracker/tests/test_cooldown.py`
- [x] T028 [P] [US5] Test cooldown clears on delete-fact call in `modules/expense-tracker/tests/test_cooldown.py`
- [x] T029 [P] [US5] Test cooldown expires after 1 hour in `modules/expense-tracker/tests/test_cooldown.py`

### Implementation for User Story 3 + 5

- [x] T030 [US3] Implement remove(match_text) and rebuild() methods on MemoryStore in `modules/expense-tracker/src/agent/memory.py`
- [x] T031 [US3] Add `list-facts`, `update-fact`, `delete-fact` tool handlers and schemas to ToolRegistry in `modules/expense-tracker/src/agent/tools.py`
- [x] T032 [US5] Implement NotificationCooldown class (dict[str, float], should_suppress, record, clear) in `modules/expense-tracker/src/agent/tools.py`
- [x] T033 [US5] Wire cooldown check into `_handle_notify_user`: suppress if msg_id notified within 1h in `modules/expense-tracker/src/agent/tools.py`
- [x] T034 [US5] Wire cooldown.clear() into `_handle_update_fact` and `_handle_delete_fact` in `modules/expense-tracker/src/agent/tools.py`
- [x] T035 [P] [US3] Add memory feedback routing rules to `gateway/workspace/AGENTS.md`

**Checkpoint**: User corrections work end-to-end. No notification spam. Corrections trigger immediate re-processing.

---

## Phase 6: User Story 6 - Configurable Memory Path (Priority: P3)

**Goal**: MEMORY_PATH env var overrides default; directory auto-created. Not hardcoded.

**Independent Test**: Set MEMORY_PATH=/tmp/test-memory.md, verify facts written to and read from custom path.

### Tests for User Story 6

- [x] T036 [P] [US6] Test default path is data/MEMORY.md in `modules/expense-tracker/tests/test_memory.py`
- [x] T037 [P] [US6] Test MEMORY_PATH env var overrides path in `modules/expense-tracker/tests/test_memory.py`
- [x] T038 [P] [US6] Test directory auto-created when path doesn't exist in `modules/expense-tracker/tests/test_memory.py`

### Implementation for User Story 6

- [x] T039 [US6] Use config.memory_path in MemoryStore constructor, fallback to `data/MEMORY.md` in `modules/expense-tracker/src/agent/memory.py`
- [x] T040 [US6] Auto-create parent directory on learn_fact if path doesn't exist in `modules/expense-tracker/src/agent/memory.py`

**Checkpoint**: Path fully configurable via env var, no hardcoded strings in code.

---

## Phase 7: System Prompt Restructure + Medium Thinking

**Purpose**: FR-015 (medium thinking) and FR-016 (prompt restructure) — cross-cutting changes that affect all user stories

- [x] T041 Write failing test for prompt structure (RULES/MATCHING/WORKFLOW sections present, old learn_mapping absent) in `modules/expense-tracker/tests/test_prompts.py`
- [x] T042 Restructure SYSTEM_PROMPT in `modules/expense-tracker/src/agent/prompts.py`: orthogonal RULES (constraints), MATCHING (heuristics), WORKFLOW (13-step checklist). Remove learn_mapping references, add search_memory/learn_fact. Apply finalized rules from spec discussion (Misc fallback, classification-first rule 9, single mark_read rule 11).
- [x] T043 Add `extra_body="{"thinking": {"type": "medium"}}"` to DeepSeekClient.chat() in `modules/expense-tracker/src/agent/orchestrator.py`
- [x] T044 Remove `_load_learned_context()` and `LEARNED` injection from `modules/expense-tracker/src/agent/prompts.py`

**Checkpoint**: Prompt is clean, orthogonal, with new tools. LLM has medium thinking. All existing tests still pass.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, cleanup, and integration testing

- [x] T045 [P] Run all existing tests to confirm no regressions: `cd modules/expense-tracker && uv run pytest tests/ -v`
- [x] T046 [P] Validate prompt structure: `uv run python -c "from src.agent.prompts import SYSTEM_PROMPT; assert 'RULES:' in SYSTEM_PROMPT; assert 'search_memory' in SYSTEM_PROMPT; assert 'learn_mapping' not in SYSTEM_PROMPT"`
- [ ] T047 [P] Rebuild Docker image and verify container starts: `cd gateway && docker compose build expense-tracker && docker compose up -d expense-tracker`
- [ ] T048 Test new endpoint via curl: `curl -X POST http://localhost:8080/tools/search-memory -H "Content-Type: application/json" -d '{"query":"test"}'`
- [ ] T049 Run quickstart.md validation scenarios (all 8 scenarios)
- [ ] T050 [P] Benchmark search_memory latency with 500 synthetic facts — verify <100ms (SC-003) in `modules/expense-tracker/tests/test_memory.py`
- [ ] T051 [P] Update constitution 2.5 (memory budget: expense-tracker 205 MB) in `.specify/memory/constitution.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational — search only, no writes
- **US2 (Phase 4)**: Depends on Foundational — learn/write operations
- **US3+US5 (Phase 5)**: Depends on US2 (needs learn_fact infrastructure) — correction tools + cooldown
- **US6 (Phase 6)**: Depends on Foundational — minor config change, parallelizable with US1-US5
- **Prompt + Thinking (Phase 7)**: Depends on US1+US2 (needs new tool names) — restructure prompt
- **Polish (Phase 8)**: Depends on all user stories complete

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational — no dependencies on other stories
- **US2 (P1)**: Can start after Foundational — no dependency on US1 (reads/writes independently)
- **US3+US5 (P2)**: Depends on US2 (needs learn_fact/update/delete infrastructure). US3 and US5 are bundled because they share the ToolRegistry + cooldown wiring.
- **US6 (P3)**: Can start after Foundational — minor, parallelizable

### Within Each User Story

- Tests MUST be written and FAIL before implementation (constitution 2.3)
- Models/Functions before tools/endpoints
- Core implementation before integration
- Story complete before moving to next priority

### Parallel Opportunities

- T001, T002 can run in parallel (different files)
- T007, T008 can run in parallel within Phase 2
- All tests within a story marked [P] can run in parallel
- US1 and US2 can be implemented in parallel after Foundational (search vs write are independent on MemoryStore)
- US6 can run in parallel with US1/US2/US3 (isolated config change)
- All Phase 8 tasks marked [P] can run in parallel

---

## Parallel Example: Phase 2 (Foundational)

```bash
# In parallel after T003-T006 complete:
Task: "Register 5 new tool endpoints in modules/expense-tracker/src/tools_api.py"  (T007)
Task: "Instantiate MemoryStore in modules/expense-tracker/src/main.py"            (T008)
```

## Parallel Example: User Story 1 Tests

```bash
# Launch all US1 tests together:
Task: "Test empty memory returns no results"           (T009)
Task: "Test semantic search across spelling variations" (T010)  
Task: "Test substring fallback when model unavailable"  (T011)
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: US1 (Semantic Memory Search)
4. **STOP and VALIDATE**: Test search works with seeded facts
5. Deploy: expense tracker can search memory — immediate value even without learning

### Incremental Delivery

1. Setup + Foundational → MemoryStore operational
2. Add US1 → Search works → deploy (read-only memory)
3. Add US2 → Self-learning + dedup → deploy (memory grows)
4. Add US3+US5 → User corrections + cooldown → deploy (feedback loop closed)
5. Add US6 → Configurable path → deploy (operational flexibility)
6. Phase 7 → Prompt restructure + medium thinking → deploy (quality)
7. Phase 8 → Polish → final deploy

### Parallel Strategy

With multiple agents:
- Agent A: US1 (search) + US3/US5 (corrections/cooldown)
- Agent B: US2 (learning) + US6 (config)
- Both share MemoryStore (Phase 2), which must be complete first

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- TDD mandatory per constitution 2.3: write failing test → implement → verify green
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- US3 and US5 are bundled in Phase 5 — they share the same ToolRegistry code paths
- Remove the old `mappings.json` path in T021 (Phase 4) — after learn_fact is working
- Migration (T006) runs once on first start — data/mappings.json → data/MEMORY.md
