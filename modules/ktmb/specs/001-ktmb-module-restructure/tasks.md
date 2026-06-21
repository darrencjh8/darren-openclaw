# Tasks: KTMB Module Restructure

**Input**: Design documents from `specs/001-ktmb-module-restructure/`

**Prerequisites**: plan.md ✅, spec.md ✅

**Tests**: TDD mandatory per constitution §2.3 — test tasks included for all new/changed code.

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US5)
- Include exact file paths in descriptions

---

## Phase 1: Setup — Project Cleanup

**Purpose**: Remove obsolete files before any new code is written. Creates clean baseline.

- [x] T001 Delete obsolete host-level deployment script `deploy.sh` per FR-009
- [x] T002 [P] Delete obsolete host-level deployment wrapper `deploy-with-openclaw.sh` per FR-009
- [x] T003 [P] Delete obsolete host-level shutdown script `shutdown.sh` per FR-009
- [x] T004 [P] Delete Telegram-only test file `tests/test_notify.py` per FR-011
- [x] T005 [P] Delete non-existent module test file `tests/test_daemon.py` per FR-011
- [x] T006 [P] Delete non-existent module test file `tests/test_watchdog.py` per FR-011
- [x] T007 Create directory `src/utils/` for structured logging module

**Checkpoint**: Obsolete files removed. Clean baseline ready for implementation.

---

## Phase 2: Foundational — Logging, Config, Dockerfile

**Purpose**: Core infrastructure that ALL user stories depend on. Must complete before any story work.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Tests for Foundational (write FIRST, confirm FAIL)

- [ ] T008 Write test for JSON-line log formatter output in `tests/test_logging.py` — verify `_JsonFormatter` produces valid JSON with required fields (timestamp, level, logger, correlation_id, event, data)
- [ ] T009 [P] Write test for `RingBufferHandler` in `tests/test_logging.py` — verify deque maxlen cap and log retrieval
- [ ] T010 [P] Write test for `Config.from_env()` reading new `KTMB_NOTIFY_URL` in `tests/test_config.py` — verify default `http://openclaw:18800/api/notify` and env override

### Implementation

- [ ] T011 Create `src/utils/logging.py` with `_JsonFormatter`, `setup_logging()`, `get_logger()` — copy from `modules/expense-tracker/src/utils/logging.py` and adapt module paths
- [ ] T012 [P] Add `RingBufferHandler` class to `src/utils/logging.py` — `logging.Handler` subclass that appends formatted records to a `collections.deque(maxlen=2000)` ring buffer; register handler with root logger inside `setup_logging()` so all log records are captured
- [ ] T013 Add `KTMB_NOTIFY_URL` env var to `src/config.py` with default `http://openclaw:18800/api/notify` per FR-012
- [ ] T014 Update `ktmb_core.py`: replace ALL `print()` / `log()` calls with `logging.getLogger("ktmb_core")` using structured `extra={"correlation_id": ..., "data": {...}}`; remove `def log()` function (L89-90); update `NOTIFY_URL` default to `http://openclaw:18800/api/notify` (overridable via `KTMB_NOTIFY_URL`); add notification events: `event: "notify_sent"`, `event: "notify_failed"`, `event: "notify_cooldown_skip"`
- [ ] T015 Update `ktmb_server.py`: remove `if __name__ == "__main__"` standalone server block (L422-428); convert remaining `print()` calls to `logging.getLogger("ktmb_server")` (L185 re-submit, L355/L379 server error, L404-405 log_message); keep all library functions (`handle_create`, `handle_query`, `handle_delete`, `handle_logs`, `validate`, `init_db`, `make_hash`) unchanged in behavior
- [ ] T016 Update `docker/Dockerfile`: add `COPY ktmb_core.py ktmb_worker.py ktmb_reset.py .`; remove `COPY .env.example` (not needed at build time); add `COPY src/utils/ ./src/utils/`
- [ ] T017 Update `.dockerignore`: add exclusions for dev tools (`ktmb_test.py`, `debug_update_passenger.py`, `ktmb_pw_up.js`, `node_modules/`, `scripts/`, `package.json`, `package-lock.json`, `specs/`, `.specify/`, `.github/`, `.zed/`, `.kilo/`)

**Checkpoint**: Logging infra ready, config updated, ktmb_core/server converted to structured logging, Dockerfile updated. Foundation complete — user stories can now begin.

---

## Phase 3: User Story 1 — Self-Contained Docker Deployment (Priority: P1) 🎯 MVP

**Goal**: KTMB module runs as a standalone Docker container with the seat watcher worker running as a background thread inside the aiohttp server process. No host-level cron, systemd, or Python daemon required.

**Independent Test**: `docker build -t ktmb-booking . && docker run -d --name ktmb-test -p 8082:8082 --env-file .env ktmb-booking && curl http://localhost:8082/health` returns `{"status": "ok"}`. Watcher starts polling if jobs exist in DB.

### Tests for User Story 1 (write FIRST, confirm FAIL)

- [ ] T018 [P] [US1] Contract test for `GET /health` in `tests/test_tools_api.py` — verify status 200, body `{"status": "ok"}`
- [ ] T019 [P] [US1] Unit test for worker thread startup/shutdown in `tests/test_worker.py` — mock `ktmb_core` functions, verify worker loop starts when `stop_event` is not set, stops when `stop_event.set()`
- [ ] T020 [US1] Integration test for graceful shutdown in `tests/test_main.py` — start server, send SIGTERM, verify worker thread joins within 5s, locks released

### Implementation

- [ ] T021 [US1] Convert `ktmb_worker.py` from cron-driven script to background thread: wrap `main()` logic in a `run_worker(stop_event: threading.Event)` function; replace `time.sleep()` with `stop_event.wait(timeout=...)` for interruptible polling; use structured logging from T014 (`correlation_id=job_id[:8]`) for all worker events (login, poll, seat check, booking, error)
- [ ] T022 [US1] Update `src/main.py`: import `threading`; create `worker_stop_event = threading.Event()`; launch `threading.Thread(target=run_worker, args=(worker_stop_event,), daemon=True)` after API server starts; in SIGTERM handler, set `worker_stop_event` and `thread.join(timeout=5)`
- [ ] T023 [US1] Add worker startup/shutdown log events in `src/main.py` using structured logger: `event: "worker_started"`, `event: "worker_stopped"` with port in data
- [ ] T024 [US1] Verify `src/__main__.py` correctly delegates to `src.main.main()` (already exists — validate no changes needed)

**Checkpoint**: Container starts, health endpoint responds, worker thread runs inside container. US1 independently testable.

---

## Phase 4: User Story 2 — Gateway Notify Integration (Priority: P1)

**Goal**: All KTMB notifications flow through the gateway's `/api/notify` webhook. Zero Telegram Bot API code remains in source, tests, docs, or env config.

**Independent Test**: `grep -r "TELEGRAM\|send_telegram\|api.telegram" --include="*.py" --include="*.md" --include="*.env*" .` returns zero matches. `grep -r "notify.py" .` returns zero matches (except in git history / specs documenting the removal).

### Tests for User Story 2 (write FIRST, confirm FAIL)

- [ ] T025 [P] [US2] Unit test for `send_notify()` posting to gateway in `tests/test_notify_gateway.py` — mock `requests.post`, verify URL is `http://openclaw:18800/api/notify`, body is `{"message": "..."}`
- [ ] T026 [P] [US2] Unit test for `notify_with_cooldown()` anti-spam in `tests/test_notify_gateway.py` — verify second call within cooldown window is suppressed
- [ ] T027 [P] [US2] Unit test for `notify_with_cooldown()` gateway unreachable in `tests/test_notify_gateway.py` — mock `requests.post` raising `ConnectionError`, verify returns False without crashing

### Implementation

- [ ] T028 [US2] Verify `ktmb_core.py` `send_notify()` uses correct gateway notify URL `http://openclaw:18800/api/notify` (set in T014); verify `KTMB_NOTIFY_URL` env var override works correctly
- [ ] T029 [P] [US2] Remove Telegram references from `.env.example` — delete any `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` lines; add `KTMB_NOTIFY_URL=http://openclaw:18800/api/notify` with comment
- [ ] T030 [P] [US2] Remove Telegram references from `.speckit/agent.md` per FR-014 — delete lines referencing "Telegram Bot API", "Telegram notifications", "api.telegram.org"
- [ ] T031 [P] [US2] Remove Telegram references from `.speckit/features/ktmb-booking/tasks.md` per FR-014 — delete lines referencing `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `notify.py`, `send_telegram`
- [ ] T032 [US2] Run verification: `grep -r "TELEGRAM\|send_telegram\|api.telegram\|notify\.py" --include="*.py" --include="*.md" --include="*.env*" --include="*.sh" . | grep -v "specs/" | grep -v ".git/"` must return zero matches per SC-003

**Checkpoint**: All notifications route through gateway. Zero Telegram code remains. US2 independently testable.

---

## Phase 5: User Story 3 — Parent Deploy.sh Auto-Discovery (Priority: P1)

**Goal**: The module provides a `module.env` metadata file at the repo root so the parent `scripts/deploy.sh` can auto-discover and deploy it without manual configuration.

**Independent Test**: `source module.env && echo $MODULE_NAME` outputs `ktmb-booking`. The parent deploy.sh can iterate `modules/*/module.env` and validate `KTMB_PASSWORD` and `KTMB_CAPTCHA_KEY` from the module's `.env`.

### Test for User Story 3 (config validation — write FIRST, confirm FAIL)

- [ ] T033 [US3] Write validation test for `module.env` in `tests/test_module_env.sh` — verify `bash -c 'source module.env && [[ "$MODULE_NAME" == "ktmb-booking" ]]'` succeeds

### Implementation

- [ ] T034 [US3] Create `module.env` at repo root with shell-sourceable format: `MODULE_NAME="ktmb-booking"`, `MODULE_ENV_FILE=".env"`, `MODULE_REQUIRED_VARS=(KTMB_PASSWORD KTMB_CAPTCHA_KEY)`, `MODULE_HEALTH_PORTS=(8082)`

**Checkpoint**: module.env exists and is valid. Parent deploy.sh can discover and validate the module.

---

## Phase 6: User Story 4 — Structured Observability (Priority: P2)

**Goal**: Every watcher step (login, poll, seat check, booking, error) emits a structured JSON log line with `timestamp`, `level`, `logger`, `correlation_id`, `event`, and `data` fields. Zero bare `print()` calls remain in runtime code.

**Independent Test**: Start a booking, check `docker compose logs ktmb-booking`, pipe through `jq .` — every line is valid JSON with all required fields.

### Tests for User Story 4 (write FIRST, confirm FAIL)

- [ ] T035 [P] [US4] Unit test for worker login logging in `tests/test_worker.py` — mock `do_login`, capture log output via `RingBufferHandler`, verify JSON contains `event: "worker_login"` with `correlation_id` and `data.outcome`
- [ ] T036 [P] [US4] Unit test for worker poll logging in `tests/test_worker.py` — mock `fetch_seats`, verify JSON contains `event: "worker_poll"`, `data.seat_map`, `correlation_id`
- [ ] T037 [P] [US4] Unit test for worker booking success logging in `tests/test_worker.py` — mock `book_ticket`, verify JSON contains `event: "worker_booked"`, `data.payment_url`
- [ ] T038 [P] [US4] Unit test for worker error logging in `tests/test_worker.py` — mock function raising exception, verify JSON contains `level: "ERROR"`, `data.traceback`

### Implementation (verification — logging already adopted in T014/T015/T021/T023)

- [ ] T039 [US4] Verify structured logging adoption in `ktmb_core.py`: confirm zero `print()` or `log()` calls remain (converted in T014); every log call uses `logging.getLogger("ktmb_core")` with structured `extra` fields
- [ ] T040 [P] [US4] Verify structured logging adoption in `ktmb_worker.py`: confirm zero `log()` calls remain (converted in T021); every log call uses structured logger with `correlation_id=job_id[:8]` per FR-007
- [ ] T041 [P] [US4] Verify structured logging in `src/main.py` and `ktmb_server.py`: confirm zero bare `print()` calls in runtime paths (converted in T015/T023)
- [ ] T042 [US4] Run verification: `grep -rn "print(\|^def log(" ktmb_core.py ktmb_worker.py src/main.py ktmb_server.py 2>/dev/null | grep -v "#" | grep -v "test"` must return zero matches

**Checkpoint**: All runtime log output is valid JSON. Zero `print()` in runtime code. US4 independently testable.

---

## Phase 7: User Story 5 — Worker Logs Inspection Tool (Priority: P2)

**Goal**: Gateway can query `POST /tools/worker-logs` to retrieve recent watcher log entries, filterable by job_id.

**Independent Test**: `curl -X POST http://localhost:8082/tools/worker-logs -H "Content-Type: application/json" -d '{"lines": 20}'` returns a JSON array of log entries. `curl -X POST ... -d '{"job_id": "abc123"}'` returns only entries with that correlation_id.

### Tests for User Story 5 (write FIRST, confirm FAIL)

- [ ] T043 [P] [US5] Contract test for `POST /tools/worker-logs` in `tests/test_tools_api.py` — verify returns `{"success": true, "logs": [...]}` with valid JSON array; verify 404 for unknown tool
- [ ] T044 [P] [US5] Unit test for `_handle_worker_logs` in `tests/test_tools_api.py` — populate ring buffer with sample entries, verify `{"lines": 5}` returns 5 most recent in reverse chronological order
- [ ] T045 [US5] Unit test for `_handle_worker_logs` with job_id filter in `tests/test_tools_api.py` — verify `{"job_id": "abc123"}` returns only matching entries by `correlation_id`

### Implementation

- [ ] T046 [US5] Add `_handle_worker_logs` method to `src/agent/tools.py` — import `get_log_buffer` from `src.utils.logging`; support `lines` (default 50) and optional `job_id` filter (matches against `correlation_id` field); return `{"success": true, "logs": [...]}`
- [ ] T047 [US5] Register `POST /tools/worker-logs` route in `src/tools_api.py` — add `("/tools/worker-logs", "worker-logs")` to routes list
- [ ] T048 [US5] Expose `get_log_buffer()` from `src/utils/logging.py` — returns the ring buffer deque for querying by `_handle_worker_logs` (ring buffer populated by `RingBufferHandler` registered in T012)

**Checkpoint**: Gateway can query worker logs via API. US5 independently testable.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, SKILL.md update, final validation.

- [ ] T049 [P] Update `skills/SKILL.md`: add `save-passenger` and `get-passenger` to tool table per FR-013; add `worker-logs` tool entry; verify all 13 tools are documented
- [ ] T050 [P] Verify `.gitignore` covers all patterns: `.env`, `__pycache__/`, `*.pyc`, `.venv/`, `node_modules/`, `data/`
- [ ] T051 Run full test suite: `pytest tests/ -v` — all remaining tests must pass per SC-006
- [ ] T052 Run tool regression test: verify all 12 existing tool endpoints return valid responses — `POST /tools/get-schedules`, `POST /tools/booking-window`, `POST /tools/validate-booking`, `POST /tools/create-booking`, `POST /tools/list-orders`, `POST /tools/order-status`, `POST /tools/cancel-order`, `POST /tools/save-passenger`, `POST /tools/get-passenger`, `POST /tools/system-status`, `POST /tools/system-pause`, `POST /tools/system-resume` — contracts unchanged per FR-008
- [ ] T053 Validate Docker build: `docker build -t ktmb-booking -f docker/Dockerfile .` succeeds
- [ ] T054 Run quickstart validation: start container, verify `/health` returns 200, verify `POST /tools/get-schedules` returns schedule data, verify `POST /tools/worker-logs` returns empty array
- [ ] T055 Verify SC-003 compliance: `grep -r "TELEGRAM\|send_telegram\|api.telegram" --include="*.py" --include="*.md" --include="*.env*" --include="*.sh" . | grep -v ".git/"` returns zero matches
- [ ] T056 Verify SC-004 compliance: start watcher with a test job, check container logs — every line must be valid JSON parseable by `python -m json.tool`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (cleanup first) — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 — Dockerfile + config + logging must be ready
- **US2 (Phase 4)**: Depends on Phase 2 — Can run parallel with US1 (different primary files)
- **US3 (Phase 5)**: No dependencies beyond Phase 1 — single file creation, can run anytime
- **US4 (Phase 6)**: Depends on US1+US2 (verifies logging adoption in files they touched)
- **US5 (Phase 7)**: Depends on Phase 2 (ring buffer must exist) + US4 (verifies buffer is populated)
- **Polish (Phase 8)**: Depends on all user stories complete

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2. No dependencies on US2-US5. Touches: `ktmb_worker.py`, `src/main.py`, `src/__main__.py`.
- **US2 (P1)**: Can start after Phase 2. No dependencies on US1. Touches: `.env.example`, `.speckit/agent.md`, `.speckit/features/ktmb-booking/tasks.md`. Verifies `ktmb_core.py` notify URL (already set in T014).
- **US3 (P1)**: Independent — can run anytime after Phase 1. Touches: `module.env` (new).
- **US4 (P2)**: Must run after US1+US2. Verifies (does not modify) files touched by US1/US2. Touches: `tests/test_worker.py` (adds tests).
- **US5 (P2)**: Must run after US4 (needs ring buffer populated). Touches: `src/agent/tools.py`, `src/tools_api.py`, `src/utils/logging.py`.

### Within Each User Story

- Tests MUST be written and FAIL before implementation (TDD per constitution §2.3)
- Tests → Implementation → Verification
- Story complete before moving to next priority (for sequential execution)

### Parallel Opportunities

- T001-T007 (Setup): All [P] — can run in any order
- T008-T010 (Foundational tests): All [P]
- T011-T013 (Foundational impl): T011+T012 are [P] together, T013 independent
- T018-T020 (US1 tests): T018+T019 [P], T020 depends on T019
- T025-T027 (US2 tests): All [P]
- T035-T038 (US4 tests): All [P]
- T039-T042 (US4 verification): T039+T040+T041 [P], T042 sequential
- T043-T045 (US5 tests): T043+T044 [P], T045 depends on T044
- T049-T050 (Polish): [P] together

---

## Parallel Example: Foundational Phase

```bash
# Launch all foundational tests together (TDD — write first, confirm they FAIL):
Task: "Write test for JSON-line log formatter in tests/test_logging.py"     # T008
Task: "Write test for RingBufferHandler in tests/test_logging.py"           # T009
Task: "Write test for Config.from_env() KTMB_NOTIFY_URL"                    # T010

# After tests fail, implement in parallel:
Task: "Create src/utils/logging.py"                                         # T011
Task: "Add RingBufferHandler to src/utils/logging.py"                       # T012
Task: "Add KTMB_NOTIFY_URL to src/config.py"                                # T013
```

---

## Implementation Strategy

### MVP First (User Stories 1-3 Only — All P1)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks everything)
3. Complete Phase 3: US1 (Docker container + worker thread)
4. Complete Phase 4: US2 (Gateway notify, zero Telegram)
5. Complete Phase 5: US3 (module.env)
6. **STOP and VALIDATE**: Container starts, health OK, notifications route through gateway, module.env exists
7. Deploy/demo if ready — this is the minimum viable restructuring

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 → Container runs with worker inside → Test independently → Deploy (container works!)
3. US2 → Notifications route through gateway, zero Telegram → Deploy (secure!)
4. US3 → module.env ready for parent auto-discovery → Deploy (discoverable!)
5. US4 → Structured logging verified everywhere → Deploy (observable!)
6. US5 → Worker logs queryable via API → Deploy (debuggable!)
7. Polish → SKILL.md updated, regression tests pass → Final release

### File Contention Notes

- `ktmb_core.py`: Fully converted in Phase 2 (T014). No further code changes in later phases — only verification (T028, T039). No contention.
- `ktmb_worker.py`: Converted in Phase 3 (T021) with logging built-in. Phase 4 (T040) only verifies. No contention.
- `src/main.py`: Updated in Phase 3 (T022-T023). Phase 4 (T041) only verifies. No contention.
- `ktmb_server.py`: Converted in Phase 2 (T015). Phase 4 (T041) only verifies. No contention.
- `src/utils/logging.py`: Created in Phase 2 (T011-T012), extended in Phase 7 (T048). Sequential — Phase 7 appends to Phase 2 file. OK.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Verify tests fail before implementing (TDD per constitution §2.3)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- **No file contention**: All code changes happen in their owning phase; later phases only verify
- Constitution §2.9 mandates JSON-line logging — verified in T035-T042 (US4)
- Constitution §2.3 TDD — every implementation task has a preceding test task that must FAIL first
- SC-003 (zero Telegram strings) verified in T032 (US2) and T055 (Polish)
- SC-006 (all tests pass) verified in T051 (Polish)
- Total tasks: 56 (T001-T056)
