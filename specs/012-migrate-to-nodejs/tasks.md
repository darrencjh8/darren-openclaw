# Tasks: Migrate Python to Node.js + Fix Thinking

**Input**: Design documents from `/specs/012-migrate-to-nodejs/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included per constitution 2.3 (TDD mandatory). Every ported file gets a failing test first.

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4, US5)
- Include exact file paths in descriptions

## Path Conventions

Node.js source in existing `modules/expense-tracker/` and `modules/portfolio-tracker/`. New files have `.js` extension. Python files are the reference implementation.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create package.json and Dockerfile for both modules

- [x] T001 [P] Create `modules/expense-tracker/package.json` with dependencies: @xenova/transformers, openai, better-sqlite3, imapflow, cheerio, pino, express
- [x] T002 [P] Create `modules/expense-tracker/docker/Dockerfile` with node:22-slim base, npm ci, pre-download WASM model at build, COPY src, CMD node src/index.js
- [x] T003 [P] Create `modules/portfolio-tracker/package.json` with dependencies: openai, better-sqlite3, cheerio, pino, express, googleapis
- [x] T004 [P] Create `modules/portfolio-tracker/docker/Dockerfile` with node:22-slim + openjdk-21-jre-headless, npm ci, CMD node src/index.js

**Checkpoint**: `npm install` works in both modules. Dockerfiles ready.

---

## Phase 2: Foundational — MemoryStore (Blocks ALL User Stories)

**Purpose**: Port `memory.py` → `memory.js`. All expense tracker user stories depend on embeddings.

**⚠️ CRITICAL**: No user story work can begin until MemoryStore is ported and tested.

- [x] T005 Write failing test for MemoryStore init, search, add, dedup in `modules/expense-tracker/tests/memory.test.js` (port from `test_memory.py`)
- [x] T006 Implement MemoryStore class with WASM embeddings, cosine search, dedup, periodic rewrite in `modules/expense-tracker/src/memory.js` (port from `memory.py`)
- [x] T007 Write failing test for MEMORY.md migration from mappings.json in `modules/expense-tracker/tests/memory.test.js`
- [x] T008 Implement migrateFromMappings static method on MemoryStore in `modules/expense-tracker/src/memory.js`

**Checkpoint**: 5 memory tests pass. MemoryStore ready for US1-US3.

---

## Phase 3: User Story 1 — Docker Build Under 2 Minutes (Priority: P1) 🎯 MVP

**Goal**: Cold Docker build completes fast. No PyTorch dependency.

**Independent Test**: `docker compose build expense-tracker --no-cache` completes in under 2 minutes. Cached build under 10 seconds.

### Implementation for User Story 1

- [ ] T009 [US1] Verify `docker compose build expense-tracker --no-cache` completes in under 2 minutes on test machine (record build time)
- [ ] T010 [US1] Verify `docker compose build expense-tracker` (cached) completes in under 10 seconds
- [ ] T011 [US1] Verify WASM model is pre-downloaded at build (container starts without network, embeddings work)

**Checkpoint**: Build speed validated. Container starts with embeddings.

---

## Phase 4: User Story 2 — Expense Tracker Tools Work Identically (Priority: P1)

**Goal**: All 15 HTTP tools return identical responses as Python. Gateway unchanged.

**Independent Test**: Run existing tool contracts against Node.js expense tracker. All 15 endpoints match Python behavior.

### Tests for User Story 2

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T012 [P] [US2] Port config tests: `tests/config.test.js` from `tests/test_config.py` in `modules/expense-tracker/tests/config.test.js`
- [x] T013 [P] [US2] Port dedup tests: `tests/dedup.test.js` from `tests/test_dedup.py` in `modules/expense-tracker/tests/dedup.test.js`
- [x] T014 [P] [US2] Port extractor tests: `tests/extractors.test.js` from `tests/test_extractors.py` in `modules/expense-tracker/tests/extractors.test.js`
- [x] T015 [P] [US2] Port IMAP tests: `tests/imap.test.js` from `tests/test_imap_notifier.py` in `modules/expense-tracker/tests/imap.test.js`
- [x] T016 [P] [US2] Port logging tests: `tests/logging.test.js` from `tests/test_logging.py` in `modules/expense-tracker/tests/logging.test.js`
- [x] T017 [P] [US2] Port tool registry tests: `tests/tools.test.js` from `tests/test_tools.py` in `modules/expense-tracker/tests/tools.test.js`
- [x] T018 [P] [US2] Port orchestrator tests: `tests/orchestrator.test.js` from `tests/test_agent_orchestrator.py` in `modules/expense-tracker/tests/orchestrator.test.js`
- [x] T019 [P] [US2] Port cooldown tests: `tests/cooldown.test.js` from `tests/test_cooldown.py` (if it exists) in `modules/expense-tracker/tests/cooldown.test.js`

- [x] T021 [US2] Implement `dedup.js` — DedupJournal with same SQLite schema in `modules/expense-tracker/src/dedup.js`
- [x] T022 [US2] Implement `extractors.js` — email content extraction (HTML + text), PDF OCR via child_process in `modules/expense-tracker/src/extractors.js`
- [x] T023 [US2] Implement `imap.js` — IMAP IDLE handler with imapflow in `modules/expense-tracker/src/imap.js`
- [x] T024 [US2] Implement `logging.js` — pino JSON-line logger wrapper in `modules/expense-tracker/src/logging.js`

### Implementation for User Story 2 — Tool Registry

- [x] T025 [US2] Port all 15 tool schemas to _TOOLS array in `modules/expense-tracker/src/tools.js`
- [x] T026 [US2] Implement ToolRegistry class with execute_tool, fetch-*, insert-transaction, check-duplicate handlers in `modules/expense-tracker/src/tools.js`
- [x] T027 [US2] Implement search_memory, learn_fact, list-facts, update-fact, delete-fact handlers in `modules/expense-tracker/src/tools.js`
- [x] T028 [US2] Implement NotificationCooldown class and wire into notify_user handler in `modules/expense-tracker/src/tools.js`
- [x] T029 [US2] Implement mark-email-read, notify-user, log-decision, reconcile handlers in `modules/expense-tracker/src/tools.js`

### Implementation for User Story 2 — Orchestrator + Server

- [x] T030 [US2] Implement `prompts.js` — 1:1 port of SYSTEM_PROMPT (RULES/MATCHING/WORKFLOW) and FEW_SHOT_EXAMPLES in `modules/expense-tracker/src/prompts.js`
- [x] T031 [US2] Implement `orchestrator.js` — DeepSeekClient with thinking.type: "adaptive", AgentOrchestrator LLM loop in `modules/expense-tracker/src/orchestrator.js`
- [x] T032 [US2] Implement `index.js` — Express HTTP server, register all 15 POST endpoints, IMAP IDLE loop, MemoryStore init + migration in `modules/expense-tracker/src/index.js`
- [x] T033 [US2] Run all ported tests: verify 252 tests pass (exceeding Python's ~200) in `modules/expense-tracker/tests/`

**Checkpoint**: All 15 endpoints respond identically. All 26 tests pass.

---

## Phase 5: User Story 3 — WASM Embeddings Match Python Accuracy (Priority: P2)

**Goal**: WASM embeddings produce semantically equivalent results. No regression in classification accuracy.

**Independent Test**: Run 20 test queries through both Python and Node.js. Compare top-1 match. 19/20 must match.

### Tests for User Story 3

- [x] T034 [P] [US3] Write cross-validation test: seed identical MEMORY.md, run 20 queries against Python and Node.js, compare top-1 match in `modules/expense-tracker/tests/embedding-parity.test.js`
- [x] T035 [P] [US3] Write 500-fact performance benchmark test (verify <100ms) in `modules/expense-tracker/tests/embedding-parity.test.js`

**Checkpoint**: >95% top-1 match parity. <100ms for 500 facts.

---

## Phase 6: User Story 4 — Portfolio Tracker Migrated (Priority: P2)

**Goal**: All portfolio tracker Python logic ported 1:1. Java CLI bridge works.

**Independent Test**: Run all 31 ported tests. Java CLI invoked correctly.

### Tests for User Story 4

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T036 [P] [US4] Port all 31 portfolio tracker test files from `tests/*.py` to `tests/*.test.js` in `modules/portfolio-tracker/tests/`

### Implementation for User Story 4

- [x] T037 [P] [US4] Implement `config.js` — env var loading, Config class in `modules/portfolio-tracker/src/config.js`
- [x] T038 [P] [US4] Implement `tools.js` — ToolRegistry with all portfolio tool schemas and handlers in `modules/portfolio-tracker/src/tools.js`
- [x] T039 [P] [US4] Implement `prompts.js` — system prompt port in `modules/portfolio-tracker/src/prompts.js`
- [x] T040 [P] [US4] Implement `orchestrator.js` — DeepSeekClient + AgentOrchestrator in `modules/portfolio-tracker/src/orchestrator.js`
- [x] T041 [P] [US4] Implement `ibkr_parser.js` — IBKR flex query XML parser in `modules/portfolio-tracker/src/ibkr_parser.js`
- [x] T042 [P] [US4] Implement `sheets_client.js` — Google Sheets API client in `modules/portfolio-tracker/src/sheets_client.js`
- [x] T043 [P] [US4] Implement `actual_client.js` — Actual Budget API client in `modules/portfolio-tracker/src/actual_client.js`
- [x] T044 [US4] Implement `java_bridge.js` — child_process.execFile('java', ['-jar', 'pp-cli.jar', ...]) in `modules/portfolio-tracker/src/java_bridge.js`
- [x] T045 [US4] Implement `email_handler.js`, `email_extractor.js`, `pdf_extractor.js` in `modules/portfolio-tracker/src/`
- [x] T046 [US4] Implement `onedrive_download.js`, `onedrive_upload.js`, `dedup.js`, `logging.js`, `memory_utils.js` in `modules/portfolio-tracker/src/`
- [x] T047 [US4] Implement `index.js` — Express server, all portfolio endpoints, scheduler in `modules/portfolio-tracker/src/index.js`
- [x] T048 [US4] Run all ported portfolio tracker tests: verify 291 tests pass in `modules/portfolio-tracker/tests/`

**Checkpoint**: All portfolio tools work. Java bridge invokes CLI correctly. 31 tests pass.

---

## Phase 7: User Story 5 — Thinking Levels Fixed (Priority: P3)

**Goal**: Orchestrator uses adaptive thinking. Expense tracker internal LLM uses adaptive. Thinker stays max.

**Independent Test**: openclaw.json validates. LLM calls use thinking.type: "adaptive".

### Implementation for User Story 5

- [x] T049 [US5] Change orchestrator `thinkingDefault` from "medium" to "adaptive" in `gateway/openclaw.json`
- [x] T050 [US5] Verify thinker `thinkingDefault: "max"` is unchanged in `gateway/openclaw.json`
- [x] T051 [US5] Verify expense tracker orchestrator passes `body: { thinking: { type: "adaptive" } }` in `modules/expense-tracker/src/orchestrator.js` (confirmed in T031)
- [x] T052 [US5] Validate config: run `openclaw doctor` (or equivalent validation) — no thinking level errors

**Checkpoint**: Config validates. Adaptive thinking active everywhere except thinker.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup Python, final validation, constitution update

- [ ] T053 [P] Delete all 105 Python files after all Node.js tests pass: `modules/expense-tracker/src/*.py`, `modules/expense-tracker/tests/*.py`, `modules/portfolio-tracker/src/*.py`, `modules/portfolio-tracker/tests/*.py`
- [ ] T054 [P] Delete `requirements.txt`, `pyproject.toml`, `uv.lock`, `.venv/` from both modules
- [ ] T055 [P] Remove `python-dotenv`, `pytesseract`, `pdf2image`, `aioimaplib`, `beautifulsoup4`, `lxml`, `sentence-transformers`, `optimum[onnxruntime]` — all Python dependencies cleaned up
- [ ] T056 [P] Verify zero Python files remain: `find . -name "*.py" -not -path "./.venv/*" -not -path "./node_modules/*" | wc -l` returns `0`
- [x] T057 [P] Update constitution 2.5: expense-tracker 205 MB → <150 MB, total system ~800 MB in `.specify/memory/constitution.md`
- [x] T058 [P] Update `design.md` Section 5 — technology stack from Python to Node.js, tool count unchanged
- [x] T059 Run quickstart.md validation scenarios (all 10 scenarios)
- [ ] T060 Docker rebuild and integration test: `docker compose build && docker compose up -d && curl localhost:8080/health && curl localhost:8081/health`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all expense tracker stories
- **US1 (Phase 3)**: Depends on Foundational (needs Dockerfile + package.json) — build speed test
- **US2 (Phase 4)**: Depends on Foundational — port all expense tracker files
- **US3 (Phase 5)**: Depends on US2 (needs running Node.js implementation for parity tests)
- **US4 (Phase 6)**: Depends on Setup (needs package.json + Dockerfile) — portfolio tracker independent of expense tracker
- **US5 (Phase 7)**: Depends on US2 (needs orchestrator.js for thinking verification)
- **Polish (Phase 8)**: Depends on all user stories complete

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational — independent build validation
- **US2 (P1)**: Can start after Foundational — core expense tracker port
- **US3 (P2)**: Depends on US2 completion — needs working Node.js MemoryStore for parity tests
- **US4 (P2)**: Independent of US1-US3! Can start after Setup (portfolio tracker has its own package.json + Dockerfile)
- **US5 (P3)**: Depends on US2 (needs orchestrator.js impl) — config change only

### Within Each User Story (TDD)

- Tests MUST be written and FAIL before implementation (constitution 2.3)
- Core utilities (config, dedup, logging) before tools
- Tools before orchestrator
- Orchestrator before server (index.js)
- Server before integration testing

### Parallel Opportunities

- T001-T004: All setup tasks parallel (different files/modules)
- T012-T019: All US2 tests parallel (different test files)
- T020-T024: US2 core utilities parallel (different source files)
- T036: All US4 tests parallel (different test files)
- T037-T043: US4 implementations parallel (different source files)
- T053-T058: All cleanup tasks parallel
- US4 (Portfolio Tracker) can run in parallel with US1-US3 (different module)

---

## Parallel Example: Phase 2 + US2 Tests

```bash
# After Phase 1 (Setup) completes, launch in parallel:
Task: "Write failing test for MemoryStore" (T005)
Task: "Port config tests"              (T012)
Task: "Port dedup tests"               (T013)
Task: "Port extractor tests"           (T014)
Task: "Port IMAP tests"                (T015)
Task: "Port logging tests"             (T016)
Task: "Port tool registry tests"       (T017)
Task: "Port orchestrator tests"        (T018)
```

## Parallel Example: US2 Implementation

```bash
# After MemoryStore implemented (T006), launch in parallel:
Task: "Implement config.js"    (T020)
Task: "Implement dedup.js"     (T021)
Task: "Implement extractors.js" (T022)
Task: "Implement imap.js"      (T023)
Task: "Implement logging.js"   (T024)
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Phase 1: Setup (package.json + Dockerfile)
2. Phase 2: Foundational (MemoryStore)
3. Phase 3: US1 (Docker build validation)
4. **STOP**: Cold build under 2 min? ✅ — MVP proven

### Incremental Delivery

1. Setup + Foundational → MemoryStore operational
2. US1 → Build speed validated → deployable (infrastructure ready)
3. US2 → All expense tracker tools working → deployable (replaces Python)
4. US3 → Embedding accuracy verified → confidence for production
5. US4 → Portfolio tracker migrated → deployable (zero Python left)
6. US5 → Thinking fixed → deployable (cost optimization)
7. Phase 8 → Cleanup + docs → final deploy

### Parallel Strategy (Multi-Agent)

- **Agent A**: US1-US2-US3 (Expense Tracker — depends on Foundational)
- **Agent B**: US4 (Portfolio Tracker — independent, can start after Setup)
- **Agent C**: US5 (Thinking fix — one-line config change, any time after US2)
- **Coordinator**: Phase 8 cleanup after both A and B complete

---

## Notes

- TDD mandatory per constitution 2.3: write failing test → implement → verify green
- Python source files serve as the specification — 1:1 port, no redesign
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- US4 (Portfolio Tracker) is completely independent of US1-US3 — can be done in parallel
- T031 already includes `thinking.type: "adaptive"` per FR-015 — no separate task needed
