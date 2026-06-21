# Feature Specification: KTMB Module Restructure for OpenClaw Compliance

**Feature Branch**: `001-ktmb-module-restructure`

**Created**: 2026-06-12

**Status**: Draft

**Input**: User description: "Restructure the openclaw-module-ktmb repository to be an OpenClaw-compliant git submodule under ~/darren-openclaw, following the module conventions established by expense-tracker and portfolio-tracker."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Module Self-Contained Docker Deployment (Priority: P1)

As a system operator deploying the OpenClaw gateway, I want the ktmb-booking module to run as a standalone Docker container within the docker-compose network, so that it integrates with the gateway like all other modules without requiring host-level Python daemons or separate cron jobs.

**Why this priority**: This is the foundational change — all other requirements depend on the module being a proper Docker service. Without this, the module cannot participate in the compose network, cannot be health-checked by the parent deploy.sh, and cannot be auto-discovered.

**Independent Test**: `docker compose up -d ktmb-booking` starts the container, `curl http://localhost:8082/health` returns `{"status": "ok"}`, and the seat watcher worker runs inside the container as a background process.

**Acceptance Scenarios**:

1. **Given** the module is built as a Docker image, **When** the container starts, **Then** the aiohttp tools API server listens on port 8082 and the `/health` endpoint returns 200.
2. **Given** the container is running, **When** the seat watcher has watching jobs in the database, **Then** the watcher polls KTMB for seat availability and books when seats are found, without any host-level cron dependency.
3. **Given** the container receives SIGTERM, **When** graceful shutdown is triggered, **Then** the watcher logs out of KTMB, releases locks, and the API server stops cleanly within 5 seconds.

---

### User Story 2 - Gateway Notify Integration (Priority: P1)

As a system operator, I want all KTMB booking notifications (success, failure, error) to be sent through the gateway's `/api/notify` webhook, so that users receive alerts via their configured channel (Telegram, WhatsApp, etc.) without the KTMB module needing its own notification credentials.

**Why this priority**: The constitution (§2.1) mandates we configure OpenClaw — we don't build independent notification channels. Removing Telegram-specific code from the KTMB module eliminates credential sprawl and ensures a single audit trail through the gateway.

**Independent Test**: Trigger a booking success → verify the gateway's `notify-webhook.py` receives a POST to `/api/notify` with the booking details → verify the message appears in the user's Telegram chat (or whichever channel is configured).

**Acceptance Scenarios**:

1. **Given** a booking is successfully completed by the watcher, **When** the result is processed, **Then** a notification is sent to `http://openclaw:18800/api/notify` with a JSON body containing the booking success message.
2. **Given** a booking fails permanently (date expired, max retries reached), **When** the terminal error is recorded, **Then** a notification is sent to the gateway notify endpoint with the failure details.
3. **Given** the gateway notify endpoint is unreachable, **When** a notification is attempted, **Then** the error is logged and the module continues operating without crashing.
4. **Given** the module's codebase, **When** a developer searches for Telegram-related code, **Then** no `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `send_telegram`, or `api.telegram.org` references remain in source files, tests, or environment configuration.

---

### User Story 3 - Parent Deploy.sh Auto-Discovery (Priority: P1)

As a system operator running `~/darren-openclaw/scripts/deploy.sh`, I want the deploy script to automatically discover the ktmb-booking submodule when it is checked out under `modules/`, validate its environment, and start its container — without manual configuration.

**Why this priority**: This is the integration contract between the submodule and the parent repo. Without auto-discovery, operators must manually edit docker-compose files and remember to restart services, creating deployment fragility.

**Independent Test**: Check out the ktmb-booking repo as a git submodule at `~/darren-openclaw/modules/ktmb-booking`, create its `.env` file, run `scripts/deploy.sh --non-interactive`, and verify that the ktmb-booking container starts and passes health check.

**Acceptance Scenarios**:

1. **Given** the ktmb-booking submodule exists at `modules/ktmb-booking/` with a `module.env` metadata file, **When** `scripts/deploy.sh` runs, **Then** the script discovers the module, validates `KTMB_PASSWORD` and `KTMB_CAPTCHA_KEY` are present in its `.env`, and adds the service to the compose deployment.
2. **Given** the ktmb-booking submodule is NOT checked out, **When** `scripts/deploy.sh` runs, **Then** the script skips KTMB validation silently without errors.
3. **Given** the module is discovered and deployed, **When** the health check phase runs, **Then** `curl http://localhost:8082/health` returns 200 within the retry window.

---

### User Story 4 - Structured Observability (Priority: P2)

As a system operator troubleshooting a booking issue, I want the watcher to log every step it takes (login, poll, seat check, booking attempt, error) in structured JSON format, so that I can trace the exact sequence of events for any job.

**Why this priority**: While the module can function without structured logging, the constitution (§2.9) mandates JSON-line structured logging. Plain `print()` statements are not searchable, filterable, or machine-parseable.

**Independent Test**: Start a booking watch, check `docker compose logs ktmb-booking`, and verify each log line is valid JSON with `timestamp`, `level`, `logger`, `correlation_id` (job_id), `event`, and `data` fields.

**Acceptance Scenarios**:

1. **Given** the watcher logs in to KTMB, **When** the login attempt completes (success or failure), **Then** a JSON log entry is emitted with `event: "worker_login"` and the outcome in `data`.
2. **Given** the watcher polls for seats, **When** a poll cycle completes, **Then** a JSON log entry is emitted with `event: "worker_poll"`, the job_id as `correlation_id`, and seat counts in `data`.
3. **Given** the watcher books a ticket, **When** the booking API call returns, **Then** a JSON log entry is emitted with `event: "worker_booked"` and the payment URL in `data`.
4. **Given** any error occurs in the watcher, **When** the exception is caught, **Then** a JSON log entry is emitted with `level: "ERROR"`, the full traceback in `data`, and the job_id as `correlation_id`.

---

### User Story 5 - Worker Logs Inspection Tool (Priority: P2)

As the OpenClaw gateway (or an operator via the gateway), I want to query the ktmb-booking container for recent watcher log lines, so that the LLM agent can answer user questions like "what happened with my booking?" without needing `docker compose logs` access.

**Why this priority**: This closes the observability loop — structured logs exist (US4) but need an API endpoint to be consumed by the gateway. The gateway's LLM agent can then surface booking status to users conversationally.

**Independent Test**: `curl -X POST http://localhost:8082/tools/worker-logs -H "Content-Type: application/json" -d '{"lines": 50}'` returns the last 50 JSON log entries from the watcher.

**Acceptance Scenarios**:

1. **Given** the watcher has produced log entries, **When** the gateway calls `POST /tools/worker-logs` with `{"lines": 20}`, **Then** the response contains the 20 most recent JSON log entries in reverse chronological order.
2. **Given** a specific job_id is provided as `{"job_id": "abc-123"}`, **When** the gateway calls `POST /tools/worker-logs`, **Then** only log entries with that correlation_id are returned.
3. **Given** no logs exist (fresh container), **When** the gateway calls the endpoint, **Then** an empty array is returned with `{"success": true, "logs": []}`.

---

### Edge Cases

- What happens when the KTMB website is down during a poll cycle? The watcher logs the error, increments retry count, and continues polling. After max retries, the job is marked "error" and a notification is sent via gateway.
- What happens when the container runs out of disk space for the SQLite database? The `/tmp/ktmb_jobs.db` write fails, the watcher logs a CRITICAL error, and the health endpoint continues responding (it doesn't depend on the DB).
- What happens when the gateway notify endpoint returns a non-200 status? The notification is dropped and logged as a warning — notifications are best-effort.
- How does the watcher handle KTMB session expiry mid-poll? The watcher detects session invalidity via `session_alive()`, re-authenticates, and continues. If re-login fails, the job retries on the next cron tick.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST run as a Docker container with `python -m src` as its CMD, hosting an aiohttp API server on port 8082 with a `/health` endpoint returning `{"status": "ok"}`.
- **FR-002**: System MUST run the seat watcher worker (currently `ktmb_worker.py`) as a background thread or process INSIDE the Docker container, polling for seats every 60 seconds without external cron.
- **FR-003**: System MUST send all user-facing notifications (booking success, terminal failure, login failure) via HTTP POST to `http://openclaw:18800/api/notify` with a JSON body `{"message": "..."}`, using the gateway's notify-webhook service.
- **FR-004**: System MUST NOT contain any Telegram Bot API integration — no `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `send_telegram`, `api.telegram.org`, or `notify.py` file.
- **FR-005**: System MUST provide a `module.env` metadata file at the repo root containing `MODULE_NAME`, `MODULE_ENV_FILE`, `MODULE_REQUIRED_VARS`, and `MODULE_HEALTH_PORTS` for parent deploy.sh auto-discovery.
- **FR-006**: System MUST expose a `POST /tools/worker-logs` endpoint accepting `{"lines": N, "job_id": "optional"}` and returning recent watcher log entries as a JSON array.
- **FR-007**: System MUST use structured JSON-line logging (matching the convention in `modules/expense-tracker/src/utils/logging.py`) for all watcher activities, with fields: `timestamp`, `level`, `logger`, `correlation_id`, `event`, `data`.
- **FR-008**: System MUST preserve all 12 existing tool endpoints (`get-schedules`, `booking-window`, `validate-booking`, `create-booking`, `list-orders`, `order-status`, `cancel-order`, `save-passenger`, `get-passenger`, `system-status`, `system-pause`, `system-resume`) with unchanged request/response contracts.
- **FR-009**: System MUST remove host-level deployment scripts that become obsolete in Docker: `deploy.sh`, `deploy-with-openclaw.sh`, and `shutdown.sh`. Deployment is handled by the parent repo's `scripts/deploy.sh` via auto-discovery.
- **FR-010**: System MUST follow the directory layout convention matching `modules/expense-tracker/`: `docker/Dockerfile`, `src/main.py`, `src/config.py`, `src/tools_api.py`, `src/agent/tools.py`, `src/utils/logging.py`, `tests/`, `skills/SKILL.md`, `.env.example`, `pyproject.toml`, `requirements.txt`, `module.env`.
- **FR-011**: System MUST remove the following non-existent files' test suites: `tests/test_notify.py`, `tests/test_daemon.py`, `tests/test_watchdog.py` (these test files import modules that do not exist on disk and reference Telegram APIs).
- **FR-012**: System MUST make the gateway notify URL configurable via `KTMB_NOTIFY_URL` environment variable (default: `http://openclaw:18800/api/notify`), matching the existing pattern where `ktmb_core.py` reads `NOTIFY_URL` from environment.
- **FR-013**: System MUST update `skills/SKILL.md` to document all 12 tool endpoints (currently only 10 are listed; `save-passenger` and `get-passenger` are missing from the tool table).
- **FR-014**: System MUST remove Telegram-related references from documentation files: `.speckit/agent.md` (lines referencing Telegram Bot API) and `.speckit/features/ktmb-booking/tasks.md` (lines referencing `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `notify.py`).

### Key Entities

- **Booking Job**: A ticket-watching order stored in SQLite (`/tmp/ktmb_jobs.db`). Attributes: job_id (UUID), status (watching/processing/done/error), direction (jb-to-sg/sg-to-jb), target_date, target_time, passenger (JSON with name/passport/expiry/contact/gender), created_at, updated_at, result (JSON with retries/seat_map/payment_url/error).
- **Watcher Log Entry**: A structured JSON-line log record. Attributes: timestamp (ISO 8601), level (DEBUG/INFO/WARNING/ERROR), logger (module name), correlation_id (job_id), event (human-readable event name), data (arbitrary key-value context).
- **Module Metadata**: Key-value pairs in `module.env` consumed by parent deploy.sh. Attributes: MODULE_NAME, MODULE_ENV_FILE, MODULE_REQUIRED_VARS (array), MODULE_HEALTH_PORTS (array).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The KTMB module container starts, passes health check, and the watcher begins polling within 15 seconds of `docker compose up -d`.
- **SC-002**: All 13 tool endpoints (12 existing + 1 new worker-logs) return valid JSON responses within 500ms for read-only operations.
- **SC-003**: No `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `send_telegram`, or `api.telegram.org` strings exist anywhere in the repository (source files, tests, environment config, or documentation) after migration.
- **SC-004**: Every watcher log line emitted is valid JSON parseable by `jq` or equivalent JSON parser.
- **SC-005**: The parent `scripts/deploy.sh` auto-discovers the module when it exists under `modules/ktmb-booking/` and includes it in the deployment without manual configuration.
- **SC-006**: Deleting `tests/test_notify.py`, `tests/test_daemon.py`, and `tests/test_watchdog.py` leaves zero import errors — all remaining tests pass with `pytest`.

## Assumptions

- The parent `darren-openclaw` repo's `scripts/deploy.sh` will be modified to iterate `modules/*/module.env` for auto-discovery (this is a parent-side change, covered in a separate spec for that repo).
- The gateway's `notify-webhook.py` continues to listen on port 18800 inside the openclaw container and forward messages to Telegram via the gateway's bot token.
- The KTMB module's `.env` file will be placed at `modules/ktmb-booking/.env` (gitignored) with the same required variables as today: `KTMB_EMAIL`, `KTMB_PASSWORD`, `KTMB_CAPTCHA_KEY`.
- The existing `skills/SKILL.md` content remains valid — only its location changes to be volume-mounted from `gateway/workspace/skills/ktmb-booking/`.
- The `ktmb_core.py` scraping logic (login, seat search, captcha, booking, payment) remains unchanged — only the notification and logging layers are refactored.
- The `ktmb_server.py` file is retained as a library (its functions are called by `src/agent/tools.py`), but its standalone HTTP server mode (`if __name__ == "__main__"` block running on port 47079) is unused in Docker and may be removed.
- The `src/__main__.py` entrypoint already exists and correctly delegates to `src.main.main()`. No changes needed.
- The module will be added as a git submodule to `darren-openclaw` at path `modules/ktmb-booking` AFTER the restructuring is complete and tested.
