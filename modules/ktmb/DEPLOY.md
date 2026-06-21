# KTMB Booking Module — Deployment

## Architecture

```
openclaw-module-ktmb/
├── src/                    # Python aiohttp tools API server
│   ├── main.py             # Entrypoint — health + tool routes
│   ├── config.py           # Env var config + shuttle schedules
│   ├── tools_api.py        # POST /tools/<name> → ToolRegistry
│   └── agent/tools.py      # ToolRegistry: 7 tools for booking management
├── skills/                 # OpenClaw skill definitions
│   └── SKILL.md            # LLM instructions (schedules, API params, workflows)
├── docker/Dockerfile       # python:3.12-slim container
├── module.env              # Auto-discovery config for deploy.sh
├── .env.example            # Required env var template
├── ktmb_server.py          # Existing order management server (host-level)
├── ktmb_daemon.py          # Job queue daemon (host-level)
├── ktmb_worker.py          # Cron worker (host-level)
└── ktmb_client.py          # CLI client (host-level)
```

## Fresh Install

### Prerequisites
- Docker and Docker Compose installed
- OpenClaw gateway at `~/darren-openclaw` (this module is a git submodule under `modules/ktmb/`)
- Python 3.12+ on host (for daemon/worker)

### Steps

**1. Configure**
```bash
cd ~/darren-openclaw/modules/ktmb
cp .env.example .env
# Edit .env with KTMB_EMAIL, KTMB_PASSWORD, KTMB_CAPTCHA_KEY
# Optionally set KTMB_PAX_* for passenger defaults
```

**2. Deploy**
```bash
cd ~/darren-openclaw
./scripts/deploy.sh
```

This auto-discovers the module via `module.env`, validates env vars,
builds the Docker image, and starts the service as part of the gateway.

**3. Verify**
```bash
curl http://localhost:8082/health
# {"status": "ok"}

curl -X POST http://localhost:8082/tools/get-schedules \
  -H "Content-Type: application/json" -d '{}'
# Returns full shuttle schedules
```

**4. Start the existing daemon (optional — for ticket polling/booking)**
```bash
python3 ktmb_server.py --port 47079 &
python3 ktmb_daemon.py start
# Install cron worker
```

## Integration with OpenClaw

The module is defined as a service in `gateway/docker-compose.yml` and auto-discovered
by `deploy.sh` via `module.env`. Skills are mounted into the openclaw container through
the compose volume config.

OpenClaw discovers the skill on startup and routes KTMB-related queries to it.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KTMB_EMAIL` | Yes | — | KTMB account email |
| `KTMB_PASSWORD` | Yes | — | KTMB account password |
| `KTMB_CAPTCHA_KEY` | Yes | — | 2captcha API key |
| `KTMB_API_PORT` | No | `8082` | Tools API server port |
| `KTMB_SERVER_URL` | No | `http://localhost:47079` | Backend order server URL |
| `KTMB_DB_PATH` | No | `/tmp/ktmb_jobs.db` | SQLite database path |
| `KTMB_PAX_NAME` | No | — | Default passenger name |
| `KTMB_PAX_PASSPORT` | No | — | Default passport number |
| `KTMB_PAX_EXPIRY` | No | — | Default passport expiry |
| `KTMB_PAX_CONTACT` | No | — | Default contact number |
| `KTMB_PAX_GENDER` | No | — | Default gender (M/F) |
| `IMAP_HOST` | No | `imap.zoho.com` | IMAP host for password reset |
| `IMAP_PORT` | No | `993` | IMAP port |
| `IMAP_USERNAME` | No | — | IMAP username |
| `IMAP_PASSWORD` | No | — | IMAP password |

## Manual Uninstall

```bash
cd ~/darren-openclaw/gateway
docker compose rm -sf ktmb-booking
# Remove the ktmb-booking service block from docker-compose.yml
# Remove modules/ktmb/ directory
docker compose restart openclaw
```

## Tools Reference

| Tool | Route | Description |
|------|-------|-------------|
| `get-schedules` | `POST /tools/get-schedules` | Return shuttle schedules (18 jb-to-sg + 13 sg-to-jb slots) |
| `booking-window` | `POST /tools/booking-window` | Return today's date and max booking date |
| `validate-booking` | `POST /tools/validate-booking` | Validate date, direction, timeslot |
| `create-booking` | `POST /tools/create-booking` | Submit booking order (returns job_id) |
| `list-orders` | `POST /tools/list-orders` | List orders by passport |
| `order-status` | `POST /tools/order-status` | Get order status and logs |
| `cancel-order` | `POST /tools/cancel-order` | Cancel a watching order |
