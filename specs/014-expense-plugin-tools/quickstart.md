# Quickstart: Expense Tracker Plugin Tools

**Feature**: expense-plugin-tools
**Date**: 2026-06-15

## Prerequisites

- Production server accessible via SSH (`darren@192.168.68.51`)
- Docker Compose running with `gateway-openclaw-1` and `expense-tracker-1` containers healthy
- Plugin source at `gateway/plugins/expense-tracker-tools/` (version-controlled)
- One-time plugin registration completed (`openclaw plugins install /path --force`)

## One-Time Setup

On first deployment, register the plugin in the gateway container:

```bash
ssh darren@192.168.68.51 'docker exec gateway-openclaw-1 openclaw plugins install /home/node/plugins/expense-tracker-tools --force'
```

This step persists across rebuilds (plugin source is bind-mounted, install record lives on the `openclaw_home` named volume). It does not need to be repeated on subsequent `docker compose up --build` cycles.

## Validation Scenarios

### VS-1: Plugin loads with all 21 tools

```bash
ssh darren@192.168.68.51 'docker exec gateway-openclaw-1 openclaw plugins inspect expense-tracker-tools --runtime --json'
```

**Expected**: Output shows `"status": "loaded"` and `"toolNames"` contains all 21 `budget_*` tools.

### VS-2: Individual tool calls the correct endpoint

```bash
ssh darren@192.168.68.51 'docker exec gateway-openclaw-1 curl -s -X POST \
  http://expense-tracker:8080/tools/fetch-accounts \
  -H "Content-Type: application/json" -d "{}" | head -c 200'
```

**Expected**: JSON array of account objects with `id`, `name`, `offbudget`, `closed` fields.

### VS-3: End-to-end expense tracking (Telegram)

1. Send "fetch my accounts" via Telegram to @AgentRhodeyBot
2. Agent responds with account list
3. Check gateway logs for zero `exec.approval.*` events related to the request

```bash
ssh darren@192.168.68.51 'cd ~/darren-openclaw/gateway && docker compose logs --since=5m openclaw --no-log-prefix | grep -c "exec.approval"'
```

**Expected**: Count is 0 (no exec approval events for expense-tracker operations).

### VS-4: Plugin survives rebuild without re-installation

```bash
# Stop, rebuild, and start
ssh darren@192.168.68.51 'cd ~/darren-openclaw/gateway && docker compose down && docker compose up -d --build'

# Wait for startup, then verify (no install command needed)
sleep 30
ssh darren@192.168.68.51 'docker exec gateway-openclaw-1 openclaw plugins inspect expense-tracker-tools --runtime --json | grep -E "status|toolNames"'
```

**Expected**: `"status": "loaded"`, toolNames contains all 21 tools. No `openclaw plugins install` command was run.

### VS-5: SKILL.md has no curl references

```bash
grep -i "curl" gateway/workspace/skills/expense-tracker/SKILL.md
```

**Expected**: No matches (all expense-tracker `exec curl` calls replaced with typed tools). `exec pdftotext` and `exec qpdf` lines are retained for PDF pre-processing and do not count as failures — they are explicitly excluded from scope.

### VS-6: design.md reflects plugin architecture

```bash
grep -c "budget_fetch_accounts\|plugin.*tool\|typed.*tool" design.md
```

**Expected**: At least 3 matches (design.md describes plugin-based tool invocation).

## Rollback

If validation fails, the plugin can be disabled without removing source:

```bash
ssh darren@192.168.68.51 'docker exec gateway-openclaw-1 openclaw plugins uninstall expense-tracker-tools --force'
```

The original `exec curl` pattern in SKILL.md can be restored from git history.
