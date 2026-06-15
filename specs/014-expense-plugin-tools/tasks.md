# Tasks: Expense Tracker Plugin Tools

**Input**: Design documents from `/specs/014-expense-plugin-tools/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Tests**: TDD — test tasks precede implementation. Failures must be confirmed before writing code.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- All tasks include exact file paths

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Plugin scaffolding and test configuration

- [x] T001 Create plugin directory structure at `gateway/plugins/expense-tracker-tools/`
- [x] T002 [P] Create package.json with openclaw metadata at `gateway/plugins/expense-tracker-tools/package.json`
- [x] T003 [P] Create plugin manifest with tool contracts at `gateway/plugins/expense-tracker-tools/openclaw.plugin.json`
- [x] T004 [P] Add vitest config for plugin tests at `gateway/plugins/expense-tracker-tools/vitest.config.js`
- [x] T005 Create test directory at `gateway/plugins/expense-tracker-tools/tests/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Prove the plugin loads and a single tool works before scaling to 21 tools

**⚠️ CRITICAL**: No user story work beyond the first tool can begin until this phase is complete

- [x] T006 [P] Write failing test for `budget_fetch_accounts` tool registration in `gateway/plugins/expense-tracker-tools/tests/tools.test.js` (verify tool name, schema, endpoint mapping)
- [x] T007 Write failing test for `budget_fetch_accounts` HTTP call shape in `gateway/plugins/expense-tracker-tools/tests/tools.test.js` (verify POST to correct endpoint with correct body)
- [x] T008 Implement `budget_fetch_accounts` tool in `gateway/plugins/expense-tracker-tools/index.js` — `api.registerTool()` with TypeBox schema and fetch handler
- [x] T009 Verify T006 and T007 pass (first tool working, pattern proven)

**Checkpoint**: Single tool pattern proven. Ready to scale to all 21 tools.

---

## Phase 3: User Story 1 + 2 — Agent Calls Typed Tools / All 21 Tools Available (Priority: P1) 🎯 MVP

**Goal**: All 21 expense-tracker REST endpoints exposed as `budget_`-prefixed typed tools. Agent calls them without `exec curl`.

**Independent Test**: `openclaw plugins inspect expense-tracker-tools --runtime --json` shows all 21 tools with status `loaded`. Agent on Telegram calls `budget_fetch_accounts` and receives account list.

### Tests for US1+US2 (TDD — write first, confirm failure)

- [x] T010 [P] [US1] Write failing tests for Budget & Transactions tools (6 tools) in `gateway/plugins/expense-tracker-tools/tests/tools.test.js` — verify each tool name, required params, HTTP endpoint
- [x] T011 [P] [US1] Write failing tests for Memory & Learning tools (5 tools) in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [x] T012 [P] [US1] Write failing tests for Document tools (4 tools) in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [x] T013 [P] [US1] Write failing tests for Statement tools (5 tools) in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [x] T014 [P] [US1] Write failing test for Audit tool (`budget_log_decision`) in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [x] T015 [US1] Run all tests and confirm they fail with `Cannot find module` or similar (tools not registered yet)

### Implementation for US1+US2

- [x] T016 [US2] Implement Budget & Transactions tools (6 tools) in `gateway/plugins/expense-tracker-tools/index.js`
- [x] T017 [US2] Implement Memory & Learning tools (5 tools) in `gateway/plugins/expense-tracker-tools/index.js` (depends on T016 — same file, append after T016 block)
- [x] T018 [US2] Implement Document tools (4 tools) in `gateway/plugins/expense-tracker-tools/index.js` (depends on T017 — same file, append after T017 block)
- [x] T019 [US2] Implement Statement tools (5 tools) in `gateway/plugins/expense-tracker-tools/index.js` (depends on T018 — same file, append after T018 block)
- [x] T020 [US2] Implement Audit tool (`budget_log_decision`) in `gateway/plugins/expense-tracker-tools/index.js` (depends on T019 — same file, append after T019 block)
- [x] T021 [US2] Update plugin manifest `contracts.tools` to list all 21 tool names in `gateway/plugins/expense-tracker-tools/openclaw.plugin.json`
- [x] T022 [US1] Run all tests and confirm they pass (all 21 tools registered with correct schemas and endpoints)

**Checkpoint**: All 21 tools registered, all tests passing. Plugin ready for production deployment.

---

## Phase 4: User Story 3 — Plugin Survives Container Rebuilds (Priority: P2)

**Goal**: Plugin source bind-mounted and enabled in config so it loads on every gateway start without re-installation.

**Independent Test**: `docker compose down && docker compose up --build` — plugin loads with all 21 tools without running `openclaw plugins install`.

### Implementation for US3

- [x] T023 [US3] Add plugin bind-mount volume to openclaw service in `gateway/docker-compose.yml` (`./plugins/expense-tracker-tools:/home/node/plugins/expense-tracker-tools:ro`)
- [x] T024 [US3] Add `plugins.entries.expense-tracker-tools.enabled: true` to `gateway/openclaw.json`
- [ ] T025 [US3] Run one-time `openclaw plugins install /home/node/plugins/expense-tracker-tools --force` in gateway container
- [ ] T026 [US3] Verify plugin status: `openclaw plugins inspect expense-tracker-tools --runtime --json` shows `status: loaded` and all 21 `budget_*` tools
- [ ] T027 [US3] Verify rebuild persistence: `docker compose down && docker compose up -d --build`, confirm plugin loads without re-installation

**Checkpoint**: Plugin survives rebuilds. Source version-controlled and bind-mounted.

---

## Phase 5: User Story 4 — SKILL.md References Typed Tools (Priority: P2)

**Goal**: SKILL.md updated to instruct the agent to use typed `budget_*` tools instead of `exec curl`.

**Independent Test**: `grep -i "curl" gateway/workspace/skills/expense-tracker/SKILL.md` returns no matches. Agent processes a transaction email using typed tools.

### Implementation for US4

- [x] T029 [US4] Rewrite "exec Rules" section in `gateway/workspace/skills/expense-tracker/SKILL.md` — remove all `exec curl` instructions, replace with "use the `budget_*` typed tools"
- [x] T030 [US4] Update "Available Tools" tables in `gateway/workspace/skills/expense-tracker/SKILL.md` — replace HTTP endpoint references with `budget_*` tool names and parameter descriptions
- [x] T031 [US4] Update "Workflow" section in `gateway/workspace/skills/expense-tracker/SKILL.md` — replace `exec curl` parallel calls with typed tool parallel calls
- [x] T032 [US4] Update "Statement Reconciliation" section in `gateway/workspace/skills/expense-tracker/SKILL.md` — replace `exec curl` statement tool calls with `budget_*` tool names
- [x] T033 [US4] Retain `exec pdftotext` and `exec qpdf` instructions for PDF pre-processing (explicitly excluded from scope)
- [ ] T034 [US4] Deploy to production: `scp` plugin source and SKILL.md, `docker compose build openclaw`, `docker compose restart openclaw`
- [ ] T035 [US4] Verify: send "fetch my accounts" via Telegram, agent responds with account list using typed tools (check gateway logs for zero `exec.approval.*` events)

**Checkpoint**: SKILL.md has no `curl` references. Agent uses typed tools for expense-tracker operations.

---

## Phase 6: User Story 5 — Documentation Reflects the New Architecture (Priority: P3)

**Goal**: design.md and gateway baseline spec updated to describe plugin-based tool invocation.

**Independent Test**: `design.md` references `budget_fetch_accounts` and plugin architecture. Gateway baseline spec references expense-tracker plugin.

### Implementation for US5

- [x] T036 [US5] Update `design.md` section 5.4 — change tool count from 16 to 21 in `design.md`
- [x] T037 [US5] Update `design.md` section 5A.4 — add `check_statement_duplicate` to the new tools table in `design.md`
- [x] T038 [US5] Update `design.md` section 5 architecture diagram — replace `exec curl` flow with "Gateway agent → plugin tool → HTTP → expense-tracker" in `design.md`
- [x] T039 [US5] Update `specs/001-gateway-baseline/spec.md` — change expense-tracker-skill description from "10 deterministic tools, HTTP wrappers" to "21 typed plugin tools" in `specs/001-gateway-baseline/spec.md`

**Checkpoint**: All documentation reflects plugin-based architecture.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, cleanup, and edge-case hardening

- [x] T040 [P] Write failing test for error propagation — tool returns HTTP error when expense-tracker is unreachable in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [x] T041 [P] Write failing test for empty params — tools with no required params send `{}` body in `gateway/plugins/expense-tracker-tools/tests/tools.test.js`
- [x] T042 Verify all T040-T041 tests pass
- [ ] T043 Run quickstart.md validation — confirm all 6 VS scenarios pass on production
- [ ] T044 Verify zero `exec.approval.*` events in gateway logs after migration (confirm SC-003)
- [ ] T045 Clean up stale install backups from `/app/.openclaw/extensions/.openclaw-install-backups/` if present
- [ ] T046 Git commit all changes with message: "Add expense-tracker plugin tools with budget_ prefix"

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **US1+US2 (Phase 3)**: Depends on Foundational (single tool pattern proven). P1 priority.
- **US3 (Phase 4)**: Depends on US1+US2 (plugin must exist to bind-mount). P2 priority.
- **US4 (Phase 5)**: Depends on US1+US2 (tool names must be finalized before SKILL.md rewrite). P2 priority.
- **US5 (Phase 6)**: Depends on US4 (SKILL.md changes inform documentation updates). P3 priority.
- **Polish (Phase 7)**: Depends on all user stories being complete.

### User Story Dependencies

- **US1+US2 (P1)**: Can start after Foundational. No dependencies on other stories.
- **US3 (P2)**: Can start after US1+US2. Independent of US4/US5.
- **US4 (P2)**: Can start after US1+US2. Independent of US3.
- **US5 (P3)**: Depends on US4. Must be last documentation task.

### Within Each Phase

- **Tests MUST be written and FAIL before implementation** (TDD)
- Within Phase 3: T010-T014 (tests) → T015 (confirm failure) → T016-T020 (implementation) → T021 (manifest) → T022 (confirm pass)
- Within Phase 3: T016-T020 must run sequentially (same file: `index.js`)
- Phase 4 and Phase 5 can run in parallel after Phase 3 completes

### Parallel Opportunities

- T002, T003, T004 can run in parallel (Setup phase, different files)
- T010-T014 can run in parallel (test groups, same file but non-overlapping)
- T016-T020 must run sequentially (same file: `index.js`)
- Phase 4 and Phase 5 can run in parallel after Phase 3

---

## Parallel Example: Phase 3 Tests (US1+US2)

```bash
# Launch all test tasks together:
Task: "T010 Write failing tests for Budget & Transactions tools (6 tools)"
Task: "T011 Write failing tests for Memory & Learning tools (5 tools)"
Task: "T012 Write failing tests for Document tools (4 tools)"
Task: "T013 Write failing tests for Statement tools (5 tools)"
Task: "T014 Write failing test for Audit tool"
```

---

## Implementation Strategy

### MVP First (US1+US2 Only)

1. Complete Phase 1: Setup (T001-T005)
2. Complete Phase 2: Foundational (T006-T009) — single tool pattern proven
3. Complete Phase 3: US1+US2 (T010-T022) — all 21 tools working
4. **STOP and VALIDATE**: Verify via `openclaw plugins inspect`, test on Telegram
5. Deploy to production

### Incremental Delivery

1. Setup + Foundational → Single tool proven
2. Add US1+US2 → All 21 tools available → Deploy (MVP!)
3. Add US3 → Plugin survives rebuilds → Deploy
4. Add US4 → SKILL.md updated → Deploy
5. Add US5 → Documentation updated
6. Polish → Edge cases, validation, cleanup

### Parallel Team Strategy

With multiple developers after Phase 3 completes:

- Developer A: US3 (Phase 4 — docker config)
- Developer B: US4 (Phase 5 — SKILL.md rewrite)
- Both complete independently, then Developer A picks up US5 (Phase 6)

---

## Notes

- All tasks include exact file paths for immediate execution
- TDD enforced: tests (T006-T007, T010-T015) written before implementation (T008, T016-T022)
- `exec pdftotext` / `exec qpdf` are explicitly out of scope — retained in SKILL.md, not replaced
- `budget_extract_pdf_text` is email-path only: the `budget_extract_email_content` tool handles PDF attachments internally. On the Telegram path, the agent obtains base64-encoded PDFs via OpenClaw's `read` file tool (not shell commands). No additional task needed.
- The existing production prototype (`fetch_accounts`) provides the implementation pattern for T008
- Phase 3 tools (T016-T020) share the same `index.js` file — implement as sequential blocks within the same file, each block following the T008 pattern
- Quickstart.md VS-1 through VS-6 provide validation commands for each checkpoint
