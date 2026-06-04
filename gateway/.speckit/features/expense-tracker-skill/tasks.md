# Implementation Tasks: Expense Tracker OpenClaw Skill

**Feature:** expense-tracker-skill  
**Tasks Version:** 3.0.0  
**Status:** Tasked  
**Constitution Hash:** v3.0.0  

---

## Task Dependency Graph

```
Phase 0: Foundation
  T0.1 (tools_api.py — HTTP endpoints for 10 tools)
    │
    ├── T0.2 (SKILL.js — tool wrappers, TDD with Jest)
    ├── T0.3 (SKILL.md — LLM instructions)
    └── T0.4 (openclaw.json — gateway config)
          │
Phase 1: Docker
  T1.1 (docker-compose.yml)
  T1.2 (Dockerfile for expense-tracker)
          │
Phase 2: Integration
  T2.1 (End-to-end test: SKILL.js → tools_api.py → Actual Budget)
  T2.2 (docker compose up — verify both containers)
```

---

## Phase 0: Foundation

### T0.1 — Tools HTTP API (TDD)

**Priority:** P0 (blocker)  
**Estimate:** 1.5 hours  

**RED:** Write `tests/test_tools_api.py`:
- `POST /tools/fetch-accounts returns account list`
- `POST /tools/insert-transaction creates transaction`
- `POST /tools/check-duplicate returns true for duplicate`
- `POST /tools/check-duplicate returns false for new transaction`
- `POST /tools/notify-user sends SMTP notification`
- `POST /tools/mark-email-read sets IMAP \Seen flag`
- Invalid JSON returns 400 with error format
- Unknown tool name returns 404

**GREEN:** Implement `src/tools_api.py`. Register routes on the existing aiohttp app. Each endpoint calls the corresponding client/service. Wire into `main.py`.

**REFACTOR:** Extract error handling middleware.

---

### T0.2 — SKILL.js Tool Wrappers (TDD)

**Priority:** P0 (blocker)  
**Estimate:** 1 hour  

**RED:** Write `skills/expense-tracker/tests/skill.test.js`:
- `fetch_accounts({budget_id}) returns account data`
- `insert_transaction(payload) returns created transaction`
- `check_duplicate(payload) returns true for known transaction`
- Network error propagates as thrown Error
- HTTP 500 propagates as thrown Error with message

**GREEN:** Implement `skills/expense-tracker/SKILL.js`. Export 10 async functions using Node `fetch`. Mock HTTP in tests.

---

### T0.3 — SKILL.md Instructions

**Priority:** P0 (blocker)  
**Estimate:** 20 minutes  

Write `skills/expense-tracker/SKILL.md` with clear LLM instructions:
- When to use each tool
- Currency detection rules (SGD/MYR)
- Account matching strategy
- Duplicate prevention workflow
- Notification rules for uncertain transactions

No tests (content reviewed manually).

---

### T0.4 — Gateway Config

**Priority:** P0 (blocker)  
**Estimate:** 10 minutes  

Write `openclaw.json`:
- Model: `deepseek/deepseek-chat`
- Workspace: `/app/workspace` (skills auto-discovered from `workspace/skills/`)
- Gateway port: 18789
- WhatsApp channel disabled by default

---

## Phase 1: Docker

### T1.1 — Docker Compose

**Priority:** P0 (blocker)  
**Estimate:** 20 minutes  

Write `docker-compose.yml`:
- openclaw service (image, volumes, ports)
- expense-tracker service (build, volumes, ports)
- Shared network
- Volume for openclaw_data

### T1.2 — Expense-tracker Dockerfile

**Priority:** P0 (blocker)  
**Estimate:** 10 minutes  

Already exists at `modules/expense-tracker/docker/Dockerfile`. Verify it builds.

---

## Phase 2: Integration

### T2.1 — End-to-End Test

**Priority:** P1 (high)  
**Estimate:** 30 minutes  

Write `tests/test_integration_api.py`:
- Start expense-tracker container, call all 10 tools, verify responses
- Verify health check endpoint

### T2.2 — Docker Compose Verification

**Priority:** P1 (high)  
**Estimate:** 5 minutes  

```bash
docker compose up -d
docker compose ps
curl http://localhost:8080/health
```

Both containers should be healthy.

---

## Execution Sequence

| Order | Task | Phase | Can Parallelize With |
|---|---|---|---|
| 1 | T0.1 — Tools HTTP API | Foundation | — |
| 2 | T0.2 — SKILL.js | Foundation | T0.3, T0.4 |
| 3 | T0.3 — SKILL.md | Foundation | T0.2 |
| 4 | T0.4 — openclaw.json | Foundation | T0.2 |
| 5 | T1.1 — Docker Compose | Docker | After T0.1 |
| 6 | T1.2 — Dockerfile | Docker | After T0.1 |
| 7 | T2.1 — Integration test | Integration | After T0.1, T0.2 |
| 8 | T2.2 — Compose verify | Integration | After T1.1 |

## Total Estimated Effort: ~3.5 hours