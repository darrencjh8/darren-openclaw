# Tasks: KTMB MCP Conversion

**Spec**: 023-ktmb-mcp
**Spec Version**: 1.0.0
**Status**: Draft

---

## Phase 1: Refactor

### T001: Extract worker_lock.py from ktmb_core.py

- **File**: `modules/ktmb/src/worker_lock.py` (NEW)
- **Action**: Extract four functions from `ktmb_core.py`:
  - `acquire_lock()` — Creates `/tmp/ktmb_worker.lock` with PID, stale lock detection via `os.kill(pid, 0)`
  - `release_lock()` — Removes lock file
  - `is_worker_running()` — Checks lock file + PID liveness
  - `check_stop_file()` — Checks `/tmp/ktmb_worker.stop`
- **Detail**: Re-export constants `WORKER_LOCK_FILE`, `WORKER_STOP_FILE`. **Move-only — zero logic changes.**
- **Effort**: 15 min

### T002: Update ktmb_core.py to import from worker_lock.py

- **File**: `modules/ktmb/ktmb_core.py`
- **Action**: Replace local definitions of `acquire_lock`, `release_lock`, `is_worker_running`, `check_stop_file` with `from src.worker_lock import ...`
- **Detail**: Verify all call sites within `ktmb_core.py` unchanged. `ktmb_worker.py` imports these from `ktmb_core` — verify it still works.
- **Effort**: 10 min

### T003: Clean tool registry imports

- **File**: `modules/ktmb/src/agent/tools.py`
- **Action**: 
  - Remove `from ktmb_core import is_worker_running` 
  - Import lock helpers from `src.worker_lock`: `is_worker_running`, `check_stop_file`
  - Keep `from ktmb_core import reset_password` (only exception)
  - Refactor `_handle_system_status` to call `is_worker_running()` and `check_stop_file()` instead of raw file I/O
- **Detail**: Verify all 15 `_handle_*` methods still compile and work. No behavior changes.
- **Effort**: 15 min

### T004: Rename Hermes webhook route to generic notify

- **File**: `modules/hermes/config.yaml`
- **Action**: Rename `expense` webhook route → `notify`. Tighten prompt:
  ```yaml
  notify:
      secret: ${HERMES_WEBHOOK_SECRET}
      prompt: |
          {SOUL_MD}

          SYSTEM: Relay this notification. No questions, no follow-ups. One friendly line.

          NOTIFICATION: {message}
      deliver: telegram
      deliver_extra:
          chat_id: "${TELEGRAM_HOME_CHANNEL}"
  ```
- **Detail**: Shared by both expense-tracker and KTMB. Update expense-tracker's `NOTIFY_URL` to `http://hermes:8644/webhooks/notify`.
- **Effort**: 5 min

---

## Phase 2: MCP Server

### T005: Add `mcp` Python package dependency

- **File**: `modules/ktmb/requirements.txt`
- **Action**: Add `mcp` to requirements
- **Detail**: Also update `pyproject.toml` if needed. Lock with `uv.lock` if using uv.
- **Effort**: 5 min

### T006: Create FastMCP server module

- **File**: `modules/ktmb/src/mcp_server.py` (NEW — replaces aiohttp `main.py`)
- **Action**: Create FastMCP server using `mcp` Python SDK with streamable HTTP transport (`POST /mcp`).
- **Tools**: Define all 15 `ktmb_*` tools as `@mcp.tool()` decorated async functions. Each calls `await registry.execute_tool(name, args_dict)`.
- **REST routes**: Reimplement all 15 `POST /tools/*` endpoints as Starlette HTTP routes (FastMCP is built on Starlette).
- **Pattern**:
  ```python
  from mcp.server.fastmcp import FastMCP

  mcp = FastMCP("ktmb-booking")

  @mcp.tool()
  async def ktmb_get_schedules(direction: str | None = None) -> dict:
      return await registry.execute_tool("get-schedules", {"direction": direction} if direction else {})

  # ... 14 more tools ...

  # REST routes (backward compat)
  async def get_schedules_rest(request): ...
  ```
- **Transport**: Streamable HTTP via `mcp.run(transport="streamable-http", ...)` on port 8082.
- **Effort**: 1h 30m

### T007: Replace main.py with FastMCP entrypoint

- **File**: `modules/ktmb/src/main.py` — Replaced
- **File**: `modules/ktmb/src/tools_api.py` — Removed (merged into `mcp_server.py`)
- **Action**: Remove aiohttp `main.py`. `mcp_server.py` becomes the single entrypoint — starts FastMCP (MCP tools + REST routes) on port 8082.
- **Detail**: `GET /health` endpoint preserved. All 15 `POST /tools/*` routes preserved as Starlette endpoints. `ToolRegistry` initialized once, shared between MCP and REST.
- **Effort**: 15 min

---

## Phase 3: Worker Updates

### T008: Update worker notifications to Hermes webhook

- **Files**: 
  - `modules/ktmb/ktmb_core.py` — Change `NOTIFY_URL` default to `http://hermes:8644/webhooks/notify`
  - `modules/ktmb/src/config.py` — Change `notify_url` default to `http://hermes:8644/webhooks/notify`
- **Action**: Replace `http://openclaw:18789/api/notify` with `http://hermes:8644/webhooks/notify`
- **Detail**: 
  - `send_notify()` already sends `{"message": "..."}` and `Authorization: Bearer` header — compatible with Hermes webhook
  - Keep `notify_with_cooldown` cooldown logic unchanged
  - Update related tests (`test_config.py`, `test_notify_gateway.py`)
- **Effort**: 15 min

### T009: Verify singleton worker lock

- **Action**: Confirm `acquire_lock()` gate works correctly:
  - First trigger: acquires lock → processes jobs → releases
  - Concurrent trigger (within 55s runtime): `is_worker_running()` → True → returns `{running: true}`
  - Stale lock recovery: lock file exists but PID dead → `os.kill(pid, 0)` fails → removes lock → re-acquires
- **Detail**: Existing tests cover lock behavior. Run `python -m pytest` to verify.
- **Effort**: 15 min

---

## Phase 4: Hermes Configuration

### T010: Add KTMB MCP server to Hermes config

- **File**: `modules/hermes/config.yaml`
- **Action**: Add under `mcp_servers:`:
  ```yaml
  ktmb-booking:
      url: http://ktmb-booking:8082/mcp
      tools:
          exclude: []
      supports_parallel_tool_calls: false
  ```
- **Detail**: No `transport` field needed — Hermes auto-detects streamable HTTP. Hermes auto-discovers all 15 tools.
- **Effort**: 5 min

### T011: Add Hermes cron for ktmb_trigger_worker

- **File**: `modules/hermes/50-seed-defaults`
- **Action**: Add cron job seed (writes to `/opt/data/cron/jobs.json`):
  ```json
  {
    "id": "ktmb-worker-trigger",
    "name": "KTMB Worker Trigger",
    "schedule": "*/60 * * * * *",
    "action": "mcp_tool_call",
    "server": "ktmb-booking",
    "tool": "ktmb_trigger_worker",
    "params": {}
  }
  ```
- **Detail**: Every 60 seconds. Worker lock gate prevents duplicate processing. Worker runs 3-4 poll cycles per trigger.
- **Effort**: 10 min

### T012: Update docker-compose.yml env vars

- **File**: `modules/docker-compose.yml`
- **Action**: Change `ktmb-booking` service environment:
  ```yaml
  environment:
      - KTMB_DB_PATH=/app/data/ktmb_jobs.db
      - KTMB_NOTIFY_URL=http://hermes:8644/webhooks/notify
      - KTMB_NOTIFY_TOKEN=${HERMES_WEBHOOK_SECRET}
      - KTMB_POLL_INTERVAL=15
  ```
- **Effort**: 5 min

---

## Phase 5: Validation & Deploy

### T013: Rebuild and deploy KTMB

- **Action**:
  1. `cd modules/ktmb && pip install mcp` (adds MCP SDK)
  2. `cd modules && docker compose build ktmb-booking`
  3. `docker compose up -d ktmb-booking`
  4. Verify health: `curl http://localhost:8082/health`
- **Effort**: 10 min

### T014: Verify MCP discovery in Hermes

- **Action**: Check Hermes logs for MCP server connection/discovery messages
- **Expected**: All 15 `mcp_ktmb_booking_*` tools appear as available
- **Detail**: Also verify REST API still works:
  ```bash
  curl -s -X POST http://localhost:8082/tools/get-schedules -H "Content-Type: application/json" -d '{}'
  ```
- **Effort**: 10 min

### T015: End-to-end test — booking flow via Hermes

- **Action**: Trigger booking via Hermes Telegram:
  1. `/ktmb schedules jb-to-sg` → verify schedule returned
  2. `/ktmb book` with test booking details → verify `job_id` returned + status `watching`
  3. Wait for cron to trigger worker → verify job processes
  4. Check notification delivered via Hermes webhook → Telegram
- **Effort**: 10 min

---

## Summary

| Phase | Tasks | Total Effort |
|-------|-------|-------------|
| 1 — Refactor | T001-T004 | 45m |
| 2 — MCP Server | T005-T007 | 1h 30m |
| 3 — Worker Updates | T008-T009 | 30m |
| 4 — Hermes Config | T010-T012 | 20m |
| 5 — Validation | T013-T015 | 30m |
| **Total** | **15 tasks** | **~3h 35m** |

## New Code Estimate

| File | LOC |
|------|-----|
| `src/worker_lock.py` | ~40 |
| `src/mcp_server.py` | ~180 |
| **Total new code** | **~220 LOC** |

## Modified Code Estimate

| File | Lines Changed |
|------|--------------|
| `src/agent/tools.py` | ~15 (import changes + system_status refactor) |
| `src/main.py` | Removed (replaced by mcp_server.py) |
| `src/tools_api.py` | Removed (merged into mcp_server.py) |
| `ktmb_core.py` | ~10 (import from worker_lock, NOTIFY_URL) |
| `ktmb_worker.py` | ~5 (import from worker_lock) |
| `src/config.py` | ~2 (notify_url default) |
| `requirements.txt` | ~2 (mcp, uvicorn replace aiohttp) |
| `hermes/config.yaml` | ~10 |
| `docker-compose.yml` | ~3 |
| **Total modified** | **~47 lines + 2 files removed** |
