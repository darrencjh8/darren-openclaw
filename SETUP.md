# Linux Machine Setup — darren-openclaw

Production server running Hermes Agent + 6 microservices via Docker Compose.

## Machine

| Detail | Value |
|--------|-------|
| Hostname | `darren` |
| IP | `192.168.68.51` |
| OS | Debian-based Linux |
| Docker | 26.1.5 |

---

## Users & Groups

| User | UID | Groups | Purpose |
|------|-----|--------|---------|
| `darren` | 1000 | `docker`, `sudo` | Admin SSH, git deploys |
| `runner` | 1001 | `docker` | GitHub Actions runner |

Both users are in the `docker` group — either can run `docker` commands.

---

## Directory Layout

```
/home/
├── darren/                        # darren home
│   └── darren-openclaw/           # Git repo (deployed from here)
└── runner/                        # runner home (drwx------)
    └── data/                      # Persistent data root
        ├── hermes/
        │   ├── data/              # → /opt/data in hermes container
        │   └── workspace/         # → /workspace in hermes container
        ├── expense-tracker/
        │   └── data/              # → /app/data in expense-tracker container
        ├── portfolio-tracker/
        │   ├── data/              # → /app/data in portfolio-tracker container
        │   ├── onedrive_token/    # → /app/config/onedrive in portfolio-tracker
        │   │   └── refresh_token  # OneDrive OAuth refresh token (file)
        │   └── google-service-account.json  # → /app/config/ in portfolio-tracker (ro)
        └── ktmb/
            ├── .env               # → /app/.env in ktmb-booking container
            └── data/              # → /app/data in ktmb-booking container
```

---

## Permissions Model

### Problem: Container UID ≠ Host UID

Docker containers create files owned by their internal user (e.g. `hermes` = UID 10000).
On the host, UID 10000 maps to `UNKNOWN`. Only root can access these files.

### Current State

| Directory | Host Permissions | Owner | Accessible by runner? |
|-----------|-----------------|-------|----------------------|
| `/home/runner/data/hermes/data` | `drwx------` (700) | 10000:10000 | ❌ |
| `/home/runner/data/hermes/workspace` | owned by runner | runner | ✅ |
| `/home/runner/data/expense-tracker/data` | (container creates) | 1000:1000 | ✅ |
| `/home/runner/data/portfolio-tracker/*` | (varies) | (varies) | TBD |

### How to Fix Cross-User Access

When container-created directories block host users, use the one-liner:

```bash
sudo find /home/runner/data -maxdepth 3 -type d ! -perm /g+r \
    -exec chgrp runner {} \; -exec chmod 750 {} \;
sudo find /home/runner/data -maxdepth 3 -type f ! -perm /g+r \
    \( -name "*.yml" -o -name "*.yaml" -o -name "*.md" \
       -o -name "*.json" -o -name ".gh_token" -o -name "*.env" \) \
    -exec chmod 640 {} \;
```

This changes the group to `runner` and adds group read permission without touching the owner.

> **Note**: Container recreates files on restart, so this may need to be re-run after container restarts. Consider adding to a boot script or cron.

---

## Docker Services

| Service | Container | Host Port | Internal Port | Healthcheck |
|---------|-----------|-----------|---------------|-------------|
| Hermes Gateway | `hermes` | 8642, 8644, 9119 | same | depends on others |
| Expense Tracker | `modules-expense-tracker-1` | 127.0.0.1:8080 | 8080 | `/health` |
| Portfolio Tracker | `modules-portfolio-tracker-1` | 127.0.0.1:8081 | 8081 | `/health` |
| Actual API | `modules-actual-api-1` | 127.0.0.1:3000 | 3000 | — |
| KTMB Booking | `modules-ktmb-booking-1` | 127.0.0.1:8082 | 8082 | `/health` |
| Image Gen | `modules-image-gen-1` | 127.0.0.1:8083 | 8083 | — |
| Kokoro TTS | `kokoro-tts` | 127.0.0.1:8880 | 8880 | — |

All services except Hermes bind to `127.0.0.1` (localhost only) — not exposed to the network.

---

## Named Volumes

| Volume | Mounted To | Service |
|--------|-----------|---------|
| `onedrive_data` | `/data/onedrive` | portfolio-tracker |
| `image_gen_media` | `/app/.openclaw/workspace/media` | image-gen |

Named volumes live at `/var/lib/docker/volumes/` — managed by Docker, not directly accessible.

---

## Deploy

```bash
# From /home/darren/darren-openclaw
git pull
./modules/deploy.sh --component all --non-interactive
```

Or per service:

```bash
./modules/deploy.sh --component hermes --non-interactive
```

---

## OneDrive Token Path

| Context | Path |
|---------|------|
| Host | `/home/runner/data/portfolio-tracker/onedrive_token/refresh_token` |
| Container (portfolio-tracker) | `/app/config/onedrive/refresh_token` |

---

## Key Files on Host

| File | Purpose |
|------|---------|
| `/home/runner/data/hermes/data/.gh_token` | GitHub App installation token (refreshed every 50 min) |
| `/home/runner/data/hermes/data/config.yaml` | Hermes gateway config |
| `/home/runner/data/hermes/data/SOUL.md` | Agent personality |
| `/home/runner/data/hermes/data/cron/jobs.json` | Cron job definitions |
| `/home/runner/data/hermes/data/memories/MEMORY.md` | Long-term memory (backed up to git) |
| `/home/runner/data/portfolio-tracker/onedrive_token/refresh_token` | OneDrive OAuth token |
| `/home/runner/data/portfolio-tracker/google-service-account.json` | Google Sheets API key |

---

## Cron Jobs (inside hermes container)

| Job | Schedule | Purpose |
|-----|----------|---------|
| `github-auth-refresh` | Every 50 min | Refresh GitHub App installation token |
| `memory-backup` | Every 360 min | Backup memories to private git repo |
| `portfolio-daily-sync` | Daily at 10:00 SGT | Full portfolio sync pipeline |

Check status:

```bash
docker exec hermes python3 -c "
import json
with open('/opt/data/cron/jobs.json') as f:
    data = json.load(f)
for j in data['jobs']:
    print(f\"{j['name']}: {j['last_status']}\")"
```
