# KTMB MCP — Context Dump

## What We're Building

Replace the aiohttp REST server with a **FastMCP** server (Python `mcp` SDK). Exposes **15 MCP tools** via Streamable HTTP transport (`POST /mcp`). Existing REST endpoints preserved as Starlette routes. The MCP server wraps the existing Python `ToolRegistry`. The tool registry is refactored so it does NOT import from `ktmb_core` (except `reset_password`).

Worker lock is strictly singleton (PID-based lock file). Booking notifications go through the existing generic Hermes webhook (`POST /webhooks/notify`). Cron fires every 60s; worker runs 3-4 poll cycles per trigger.

## Current KTMB Architecture

### Language: Python (FastMCP / Starlette)
### Port: 8082
### Container: `ktmb-booking` in `modules/docker-compose.yml`

### Key Files

```
modules/ktmb/
├── src/
│   ├── main.py              # Removed (replaced by mcp_server.py)
│   ├── mcp_server.py         # FastMCP server — MCP tools + REST routes (NEW)
│   ├── config.py            # Config dataclass, env loading, schedules
│   ├── tools_api.py         # POST /tools/<name> → ToolRegistry
│   ├── agent/
│   │   ├── __init__.py
│   │   └── tools.py         # ToolRegistry: 15 _handle_* methods
│   └── utils/
│       ├── __init__.py
│       └── logging.py       # Structured JSON logging + circular buffer
├── ktmb_server.py           # SQLite order CRUD + validation + dedup
├── ktmb_core.py             # Session, login, seat scraping, captcha, booking, payment, password reset, lock helpers
├── ktmb_worker.py           # Background worker: poll → find seats → book → notify
├── ktmb_client.py           # Test client
├── ktmb_reset.py            # Password reset standalone script
├── ktmb_pw_up.js             # Playwright script for KTMB password update
├── skills/SKILL.md          # OpenClaw gateway skill (deprecated by MCP)
├── docker/Dockerfile        # Python 3.12-slim
├── requirements.txt         # mcp, python-dotenv (aiohttp removed)
├── package.json             # @playwright/test (for ktmb_pw_up.js)
└── .env.example             # KTMB_EMAIL, KTMB_PASSWORD, KTMB_CAPTCHA_KEY, IMAP_*
```

### Existing REST API (15 endpoints, all `POST`)

| Endpoint | Tool Name | Handler |
|----------|-----------|---------|
| `POST /tools/get-schedules` | get-schedules | Registry → config |
| `POST /tools/booking-window` | booking-window | Registry → config |
| `POST /tools/validate-booking` | validate-booking | Registry → config |
| `POST /tools/create-booking` | create-booking | Registry → ktmb_server |
| `POST /tools/list-orders` | list-orders | Registry → ktmb_server |
| `POST /tools/order-status` | order-status | Registry → ktmb_server |
| `POST /tools/cancel-order` | cancel-order | Registry → ktmb_server |
| `POST /tools/save-passenger` | save-passenger | Registry → JSON file |
| `POST /tools/get-passenger` | get-passenger | Registry → JSON file |
| `POST /tools/system-status` | system-status | Registry → lock files |
| `POST /tools/system-pause` | system-pause | Registry → lock files |
| `POST /tools/system-resume` | system-resume | Registry → lock files |
| `POST /tools/worker-logs` | worker-logs | Registry → log buffer |
| `POST /tools/trigger-worker` | trigger-worker | Registry → ktmb_worker |
| `POST /tools/reset-password` | reset-password | Registry → ktmb_core |

### Current Import Dependencies (to be refactored)

In `src/agent/tools.py`:

```python
from ktmb_server import handle_create, handle_delete, handle_logs, handle_query, validate
from ktmb_core import is_worker_running   # ← MOVE to worker_lock.py → import via ktmb_worker
from ktmb_core import reset_password       # ← KEEP (only exception)
from ktmb_worker import run_worker         # ← KEEP
```

In `ktmb_core.py`:

```python
def acquire_lock(): ...   # ← EXTRACT to src/worker_lock.py
def release_lock(): ...   # ← EXTRACT
def is_worker_running():  # ← EXTRACT (used by both core and tools)
def check_stop_file():    # ← EXTRACT
```

### Worker Lock Mechanism

Currently in `ktmb_core.py`:

- `acquire_lock()` — Creates `/tmp/ktmb_worker.lock` with PID. Stale lock detection via `os.kill(pid, 0)`. Busy-waits up to 30s.
- `release_lock()` — Removes the lock file.
- `is_worker_running()` — Checks lock file exists + PID is live. Handles stale lock (same-PID crash recovery).
- `check_stop_file()` — Checks `/tmp/ktmb_worker.stop` for emergency pause.

### Current Notification Flow

```
Worker books ticket successfully
  → notify_with_cooldown(dedup_key, message)
    → POST http://openclaw:18789/api/notify  (or KTMB_NOTIFY_URL env)
      → OpenClaw gateway receives, formats, sends via Telegram
```

**New flow:**

```
Worker books ticket successfully
  → notify_with_cooldown(dedup_key, message)
    → POST http://hermes:8644/webhooks/notify
      → Hermes webhook handler formats + delivers to Telegram
```

### Current Cron

Gateway cron module calls `POST /tools/trigger-worker` every 60 seconds. This migrates to Hermes cron calling `ktmb_trigger_worker` MCP tool every 15 seconds.

## 15 MCP Tools

All tools are thin wrappers over `ToolRegistry.execute_tool()`:

| Group | Tools |
|-------|-------|
| Booking Flow | `ktmb_get_schedules`, `ktmb_booking_window`, `ktmb_validate_booking`, `ktmb_create_booking`, `ktmb_save_passenger`, `ktmb_get_passenger` |
| Order Management | `ktmb_list_orders`, `ktmb_order_status`, `ktmb_cancel_order` |
| System | `ktmb_system_status`, `ktmb_system_pause`, `ktmb_system_resume`, `ktmb_worker_logs`, `ktmb_trigger_worker` |
| Auth | `ktmb_reset_password` |

### Key Architecture Decisions

1. **Streamable HTTP transport** (`POST /mcp`) — Single endpoint, firewall-friendly. Replaces SSE `GET /sse` + `POST /messages`.
2. **Cron: 60 seconds, POLL_INTERVAL=15** — Worker runs 3-4 poll cycles per trigger (55s max). Lock gate prevents overlap.
3. **Strictly singleton worker** — `acquire_lock()` PID-based gate. Cron fires every 60s but duplicate triggers are rejected.
4. **Tool registry isolation** — Lock helpers extracted to `src/worker_lock.py`. `ktmb_core` imports from it. Tools import from `ktmb_worker`. Only `reset_password` crosses the boundary.
5. **Generic Hermes webhook for notifications** — Existing `POST /webhooks/notify` route (shared with expense-tracker). Tight prompt: "Relay this notification. No questions, no follow-ups. One friendly line."
6. **aiohttp → FastMCP** — Full replacement. Single process, single port (8082). REST routes as Starlette endpoints.
7. **Python MCP SDK** — `mcp` PyPI package. Single source of truth: `ToolRegistry.execute_tool()`.

## Files Still To Create

- `modules/ktmb/src/worker_lock.py` — Lock helpers extracted from `ktmb_core.py` (move-only)
- `modules/ktmb/src/mcp_server.py` — FastMCP server wrapping `ToolRegistry` (replaces aiohttp main.py)

## Files Still To Modify

- `modules/ktmb/src/agent/tools.py` — Remove `ktmb_core` imports (except `reset_password`); import lock helpers from `worker_lock`; refactor `_handle_system_status`
- `modules/ktmb/src/main.py` — Replaced by `src/mcp_server.py`
- `modules/ktmb/src/tools_api.py` — Removed (merged into `mcp_server.py`)
- `modules/ktmb/ktmb_core.py` — Import lock helpers from `src/worker_lock.py`; update `NOTIFY_URL` default
- `modules/ktmb/ktmb_worker.py` — Notify → Hermes webhook (`POST /webhooks/notify`)
- `modules/ktmb/requirements.txt` — Replace `aiohttp` with `mcp` and `uvicorn`
- `modules/hermes/config.yaml` — Add `ktmb-booking` MCP server; rename `expense` webhook → `notify`
- `modules/docker-compose.yml` — Update `KTMB_NOTIFY_URL`, add `KTMB_NOTIFY_TOKEN`, add `KTMB_POLL_INTERVAL`

## Build & Test Commands

```bash
# Rebuild KTMB container
cd modules
docker compose build ktmb-booking
docker compose up -d ktmb-booking

# Verify REST API still works
curl -s -X POST http://localhost:8082/tools/get-schedules -H "Content-Type: application/json" -d '{}'

# Verify MCP server
curl -s -X POST http://localhost:8082/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Verify health
curl http://localhost:8082/health
```
