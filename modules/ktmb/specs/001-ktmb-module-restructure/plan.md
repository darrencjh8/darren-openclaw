# Implementation Plan: KTMB Module Restructure

**Branch**: `001-ktmb-module-restructure` | **Date**: 2026-06-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-ktmb-module-restructure/spec.md`

## Summary

Restructure the KTMB Shuttle Tebrau booking module from a standalone host-level Python project into an OpenClaw-compliant Docker submodule at `modules/ktmb-booking/`, following the conventions established by `modules/expense-tracker/`. The module becomes a self-contained Docker service with the seat watcher triggered by the gateway's built-in cron scheduler via `POST /tools/trigger-worker`, notifications flowing through the gateway's notify webhook, structured JSON-line logging, and a `module.env` metadata file for parent deploy.sh auto-discovery.

## Technical Context

**Language/Version**: Python 3.12 (matching expense-tracker and portfolio-tracker)
**Primary Dependencies**: aiohttp (API server), requests (KTMB scraping — kept for worker), beautifulsoup4 + lxml (HTML parsing), python-dotenv (env loading)
**Storage**: SQLite at `/tmp/ktmb_jobs.db` (WAL mode, existing schema unchanged)
**Testing**: pytest + pytest-asyncio + pytest-mock (TDD mandatory per constitution §2.3)
**Target Platform**: Linux/Docker (python:3.12-slim base image), Ubuntu host
**Project Type**: Docker microservice (Python aiohttp API + on-demand worker triggered by gateway cron)
**Performance Goals**: Health check <200ms, tool endpoints <500ms, poll cycle <55s (fits inside 60s cron interval)
**Constraints**: Container RAM budget ~150MB (matching expense-tracker), no host-level cron/systemd, no Playwright/Chromium in container
**Scale/Scope**: Single container, ~15 tool endpoints, worker triggered via `POST /tools/trigger-worker`, <100 concurrent booking jobs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| §2.1 Configure OpenClaw, don't build it | ✅ PASS | Notifications route through gateway's `/api/notify` webhook; no standalone Telegram integration |
| §2.2 Build Skills + Deterministic Tools | ✅ PASS | `SKILL.md` + `tools_api.py` + `ToolRegistry` pattern preserved |
| §2.3 TDD mandatory | ✅ PASS | All implementation tasks will have tests written first; existing test suite preserved |
| §2.4 Docker-First | ✅ PASS | Module runs as standalone Docker container in compose network |
| §2.5 Memory Budget | ✅ PASS | python:3.12-slim base, ~150MB expected (similar to expense-tracker) |
| §2.6 Security | ✅ PASS | .env gitignored, Docker network isolation, no secrets in source |
| §2.7 Data Integrity | ✅ N/A | Not applicable — this module manages KTMB bookings, not financial data |
| §2.8 LLM Agent Principles | ✅ PASS | Tools API exposes deterministic tools; LLM chooses which to call |
| §2.9 Observability | ✅ PASS | JSON-line structured logging with correlation_id (job_id), event, data fields |

**Gate Result**: ✅ ALL PASS — proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/001-ktmb-module-restructure/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (tool API contracts)
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root — AFTER restructure)

```text
openclaw-module-ktmb/              # Standalone git repo (added as submodule later)
├── docker/
│   └── Dockerfile                 # UPDATED: adds ktmb_core.py, ktmb_worker.py, ktmb_reset.py
├── src/
│   ├── __init__.py
│   ├── __main__.py                # EXISTS: delegates to main()
│   ├── main.py                    # UPDATED: structured logging, worker triggered by gateway cron
│   ├── config.py                  # UPDATED: adds KTMB_NOTIFY_URL, NOTIFY_URL config
│   ├── tools_api.py               # UPDATED: adds /tools/worker-logs, /tools/trigger-worker routes
│   ├── agent/
│   │   ├── __init__.py
│   │   └── tools.py               # UPDATED: adds _handle_worker_logs, _handle_notify_user
│   └── utils/
│       └── logging.py             # NEW: JSON-line structured logging (from expense-tracker)
├── tests/
│   ├── conftest.py                # KEPT
│   ├── test_client.py             # KEPT
│   ├── test_server.py             # KEPT
│   ├── test_tools_api.py          # KEPT
│   ├── test_worker.py             # KEPT
│   ├── test_notify.py             # DELETED (FR-011)
│   ├── test_daemon.py             # DELETED (FR-011)
│   └── test_watchdog.py           # DELETED (FR-011)
├── skills/
│   └── SKILL.md                   # UPDATED: documents all 12 tools (FR-013)
├── ktmb_core.py                   # REFACTORED: structured logging, gateway notify URL
├── ktmb_server.py                 # REFACTORED: remove standalone server block, keep library
├── ktmb_worker.py                 # REFACTORED: structured logging, triggered via API by gateway cron
├── ktmb_reset.py                  # KEPT: password reset utility (inside container)
├── .env.example                   # UPDATED: remove TELEGRAM_*, add KTMB_NOTIFY_URL
├── pyproject.toml                 # KEPT
├── requirements.txt               # KEPT (already has all needed deps)
├── module.env                     # NEW: module metadata for parent deploy.sh
├── .dockerignore                  # EXISTS
├── .gitignore                     # EXISTS
│
├── # --- HOST-LEVEL SCRIPTS (DELETED per FR-009) ---
├── deploy.sh              → DELETED
├── deploy-with-openclaw.sh → DELETED
├── shutdown.sh            → DELETED
│
├── # --- DEV TOOLS (kept in repo, NOT in Docker image) ---
├── ktmb_test.py                   # Manual test script
├── ktmb_client.py                 # CLI client (superseded by REST API, kept as reference)
├── debug_update_passenger.py      # Playwright reverse-engineering tool
├── ktmb_pw_up.js                  # Playwright reverse-engineering tool
├── package.json                   # Playwright dependency (dev only)
├── package-lock.json              # Playwright dependency (dev only)
├── scripts/
│   └── e2e_test.py                # E2E integration test
│
├── # --- SPEC-KIT INFRASTRUCTURE ---
├── .github/                       # Spec-Kit agent + prompt files
├── .specify/                      # Spec-Kit config + constitution + templates
└── specs/                         # Feature specs
```

**Structure Decision**: Single Python project with `src/` layout (matching expense-tracker convention). Host-level deployment scripts removed. Dev/reverse-engineering tools kept in repo root but excluded from Docker image via `.dockerignore`. Worker is triggered on-demand by the gateway cron scheduler via `POST /tools/trigger-worker` and runs as a daemon thread inside the container. The worker lock file prevents overlapping runs (singleton).

## Audit: File Inventory & Fate

Every file in the repository is accounted for:

| File | Fate | Justification |
|------|------|---------------|
| `deploy.sh` | **DELETE** | FR-009 — obsolete host-level deploy; parent handles via auto-discovery |
| `deploy-with-openclaw.sh` | **DELETE** | FR-009 — wrapper around deploy.sh, also obsolete |
| `shutdown.sh` | **DELETE** | FR-009 — manages host-level cron + server PID, both gone in Docker |
| `ktmb_client.py` | **KEEP** (dev tool) | CLI client superseded by REST API `POST /tools/create-booking`; kept as reference, excluded from Docker |
| `ktmb_reset.py` | **KEEP** (in container) | Password reset via IMAP; useful admin utility inside container; add to Dockerfile COPY |
| `ktmb_test.py` | **KEEP** (dev tool) | Manual real-world test; excluded from Docker |
| `debug_update_passenger.py` | **KEEP** (dev tool) | Playwright reverse-engineering; excluded from Docker |
| `ktmb_pw_up.js` | **KEEP** (dev tool) | Playwright reverse-engineering; excluded from Docker |
| `package.json` / `package-lock.json` | **KEEP** (dev tool) | Playwright deps; excluded from Docker |
| `node_modules/` | **KEEP** (gitignored) | Already in `.gitignore` |
| `ktmb_core.py` | **REFACTOR** | Core scraping library; replace `print()` with structured logging; update `NOTIFY_URL` default to `http://openclaw:18800/api/notify`; add to Dockerfile COPY |
| `ktmb_server.py` | **REFACTOR** | Keep library functions (called by `tools.py`); remove `if __name__ == "__main__"` standalone server block; already in Dockerfile COPY |
| `ktmb_worker.py` | **REFACTOR** | Convert from cron-driven script to background thread inside aiohttp server; replace `print()`/`log()` with structured logging; add to Dockerfile COPY |
| `src/main.py` | **REFACTOR** | Start worker thread on startup; configure structured logging; graceful shutdown of worker |
| `src/config.py` | **REFACTOR** | Add `NOTIFY_URL` / `KTMB_NOTIFY_URL` env var with Docker default |
| `src/tools_api.py` | **REFACTOR** | Add `POST /tools/worker-logs` route |
| `src/agent/tools.py` | **REFACTOR** | Add `_handle_worker_logs` method for log inspection tool |
| `tests/test_notify.py` | **DELETE** | FR-011 — tests non-existent `notify.py` with Telegram API |
| `tests/test_daemon.py` | **DELETE** | FR-011 — tests non-existent `ktmb_daemon.py` with `send_telegram` |
| `tests/test_watchdog.py` | **DELETE** | FR-011 — tests non-existent `ktmb_watchdog.py` with `send_telegram` |
| `skills/SKILL.md` | **UPDATE** | FR-013 — add `save-passenger` and `get-passenger` to tool table; add `worker-logs` tool |
| `.speckit/agent.md` | **UPDATE** | FR-014 — remove Telegram Bot API references |
| `.speckit/features/ktmb-booking/tasks.md` | **UPDATE** | FR-014 — remove `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `notify.py` references |
| `.dockerignore` | **UPDATE** | Add `ktmb_test.py`, `debug_update_passenger.py`, `ktmb_pw_up.js`, `node_modules/`, `scripts/`, `package.json`, `package-lock.json`, `specs/`, `.specify/` |
| `docker/Dockerfile` | **REFACTOR** | Add `COPY ktmb_core.py ktmb_worker.py ktmb_reset.py .`; remove `COPY .env.example` |
| `module.env` | **NEW** | FR-005 — module metadata for parent deploy.sh auto-discovery |

## Complexity Tracking

No constitution violations. No complexity justifications needed.

## Phase 0: Research

### Research Topics

1. **Async worker pattern**: The worker (`ktmb_worker.py`) uses synchronous `requests` for HTTP. Running it in a background thread via `asyncio.to_thread()` or `threading.Thread` is appropriate since `requests` is blocking. The alternative (rewriting the entire scraper to use `aiohttp`) would touch ~600 lines of battle-tested scraping code and introduce regression risk. **Decision**: Background thread with `threading.Thread`, signaled via `threading.Event` for graceful shutdown.

2. **In-memory log ring buffer**: For the `/tools/worker-logs` endpoint, we need to expose recent log entries without reading from disk. A `collections.deque` with maxlen (e.g., 1000 entries) serving as a ring buffer, populated by a custom `logging.Handler`. This avoids filesystem I/O and keeps the API fast. **Decision**: `collections.deque(maxlen=2000)` ring buffer with a `RingBufferHandler(logging.Handler)`.

3. **Structured logging format**: The expense-tracker uses JSON-line format with fields: `timestamp`, `level`, `logger`, `correlation_id`, `event`, `data`. We adopt this exactly. The `correlation_id` for watcher entries is the `job_id[:8]` (short ID). For API entries, it's the request path. **Decision**: Copy `src/utils/logging.py` from expense-tracker verbatim, then use it throughout.

4. **module.env format**: The parent `deploy.sh` needs to source a shell-compatible file. Current override.env uses bash array syntax `MODULE_REQUIRED_VARS=(...)`. The new `module.env` should use the same format so the parent can `source` it directly. **Decision**: Shell-sourceable key=value format with bash array syntax for lists.

5. **Docker compose service naming**: The service must be named `ktmb-booking` (matching the SKILL.md `api_base: http://ktmb-booking:8082`). The compose network resolves service names as hostnames, so internal API calls use `http://ktmb-booking:8082`. The gateway notify URL is `http://openclaw:18800/api/notify`. **Decision**: Service name `ktmb-booking`, image name `ktmb-booking:latest`.

### Research Output

See [research.md](./research.md) for consolidated findings.

## Phase 1: Design & Contracts

### Data Model

See [data-model.md](./data-model.md) for entity definitions.

### Interface Contracts

See [contracts/](./contracts/) for tool API contracts (request/response schemas for all 13 endpoints + the new `worker-logs`).

### Quickstart

See [quickstart.md](./quickstart.md) for end-to-end validation guide.

### Agent Context Update

Update `.github/copilot-instructions.md` SPECKIT block to reference `specs/001-ktmb-module-restructure/plan.md`.
