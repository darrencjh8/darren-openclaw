# Architecture Review — Findings & Fix Plan

**Date:** 2026-06-05  
**Status:** Review complete, fixes pending  

## Files Reviewed

| File | Status |
|---|---|
| `design.md` | Minor issues |
| `gateway/.speckit/constitution.md` | ✅ Clean |
| `gateway/.speckit/agent.md` | ✅ Clean |
| `gateway/.speckit/features/expense-tracker-skill/spec.md` | ✅ Clean |
| `gateway/.speckit/features/expense-tracker-skill/plan.md` | ✅ Clean |
| `gateway/.speckit/features/expense-tracker-skill/tasks.md` | ✅ Clean |
| `modules/expense-tracker/.speckit/constitution.md` | ❌ CRITICAL — Old architecture |
| `modules/expense-tracker/.speckit/agent.md` | ❌ CRITICAL — Old references |
| `modules/expense-tracker/.speckit/features/expense-tracking/spec.md` | ✅ Clean |
| `modules/expense-tracker/.speckit/features/expense-tracking/plan.md` | ✅ Clean |
| `modules/expense-tracker/.speckit/features/expense-tracking/tasks.md` | ✅ Clean |
| `modules/expense-tracker/src/config.py` | Minor (comment) |
| `modules/expense-tracker/.env.example` | ✅ Clean |
| `modules/expense-tracker/config/email_config.json` | ✅ Clean |
| `README.md` | ✅ Clean |
| `gateway/openclaw.json` | ✅ Clean |
| `gateway/docker-compose.yml` | ✅ Clean |

---

## Critical Issues

### 1. `modules/expense-tracker/.speckit/constitution.md` — Completely outdated architecture

This file still describes the **old Fly.io architecture** that no longer applies. It is the governing constitution for the expense-tracker module and must be corrected.

**Line 22 → Section 2.1 — Wrong host and RAM target:**
```
- The OpenClaw VM on Fly.io (free tier) is capped at 256MB RAM.
```
→ Fix: Change to `The expense-tracker container runs on Ubuntu laptop via Docker Compose, targeting ~150MB RAM.`

**Line 30–31 → Section 2.2 — Wrong networking:**
```
- Internal networking: OpenClaw communicates with Actual Budget over Fly.io's internal network (`http://actual-budget.internal:5006`). Actual Budget's API port is NOT exposed publicly for automation traffic.
```
→ Fix: Change to `The expense-tracker container accesses Actual Budget via HTTPS over the public internet with API authentication.`

**Line 34 → Section 2.2 — "Outlook burner inbox":**
```
- Burner email isolation: The Outlook burner inbox is a dedicated, isolated account.
```
→ Fix: `The Zoho burner inbox is a dedicated, isolated account.`

**Line 52–54 → Section 2.5 — "fly logs":**
```
- No third-party monitoring: No Sentry, no Datadog, no external telemetry. Logs are consumed via Fly.io's built-in `fly logs`.
```
→ Fix: `Logs are consumed via Docker's built-in logging (`docker compose logs`).`

**Lines 58–64 → Section 3 — Hosting Topology table:**
```
| Component | Host | Network |
|---|---|---|
| Actual Budget | Fly.io VM #1 (existing) | Public HTTPS for UI; internal for API |
| OpenClaw Agent | Fly.io VM #2 (free tier, 256MB) | Internal → Actual Budget; outbound HTTPS → DeepSeek API, IMAP → Outlook |
| Outlook Burner Inbox | Microsoft 365 (outlook.office365.com) | Public IMAP (outlook.office365.com:993) |
```
→ Fix: Replace with Docker Compose + Zoho topology matching the gateway constitution.

---

### 2. `modules/expense-tracker/.speckit/agent.md` — Outdated references

**Line 33 — "Outlook burner inbox":**
```
OpenClaw is an LLM-powered expense-tracking agent that monitors an Outlook burner inbox via IMAP IDLE.
```
→ Fix: `monitors a Zoho burner inbox`

**Line 49 — "Fly.io internal networking":**
```
| Fly.io internal networking | OpenClaw → Actual Budget over private `.internal` DNS. No public API exposure for automation |
```
→ Fix: Replace with Docker networking description.

**Line 79 — Wrong OS:**
```
- OS: Alpine Linux (Docker on Fly.io)
```
→ Fix: `- OS: Ubuntu laptop (Docker Compose)`

**Line 82 — Wrong IMAP host:**
```
- IMAP: `outlook.office365.com:993` (SSL)
```
→ Fix: `- IMAP: `imap.zoho.com:993` (SSL)`

**Line 100 — References deleted file:**
```
- `docker/fly.toml` references correct Actual Budget app name
```
→ Fix: `- `docker-compose.yml` correctly configured`

---

## High-Priority Issues

### 3. `design.md` line 537 — Wrong env var name:
```
- **Actual Budget API key** — `ACTUAL_BUDGET_API_KEY`
```
→ Fix: `- **Actual Budget server password** — `ACTUAL_BUDGET_PASSWORD``
(The env table at Section 5.7 already correctly shows `ACTUAL_BUDGET_PASSWORD`. This is a dangling inconsistency.)

### 4. `design.md` line 540 — References `fly secrets set`:
```
Secrets are set via `fly secrets set` in production and `.env` file locally.
```
→ Fix: `Secrets are set via `.env` file (Docker Compose mounts it as a read-only volume).`

### 5. `design.md` line 564 — References `fly logs`:
```
All logs are JSON-line format written to stdout and consumed via `fly logs`:
```
→ Fix: `All logs are JSON-line format written to stdout and consumed via `docker compose logs`:`

---

## Low-Priority Issues

### 6. `modules/expense-tracker/src/config.py` line 41 — Stale comment:
```python
# IMAP (Outlook)
```
→ Fix: `# IMAP (Zoho)`

---

## Speckit Compliance Check

| Check | Result |
|---|---|
| Constitution precedes spec/plan/tasks | ✅ Both modules have constitution at `.speckit/constitution.md` |
| Agent harness present with workflow state | ✅ Both modules have `.speckit/agent.md` with state machine |
| Features organized under `features/<name>/` | ✅ `expense-tracking/` and `expense-tracker-skill/` |
| Three-phase artifacts: spec → plan → tasks | ✅ All three present for both features |
| Constitution hash tracked in agent.md | ✅ Gateway: v3.0.0 matches; expense-tracker: v1.0.0 matches |
| Phase flow correct: 0→1→2→3→4→5 | ✅ Documented in both agent.md files |
| TDD mandated in constitution | ✅ Both constitutions require TDD |
| Non-goals defined in spec | ✅ Both specs have explicit non-goals |

**No Speckit compliance issues found.**

---

## Cross-File Consistency Check

| Claim | Files | Consistent? |
|---|---|---|
| Zoho IMAP (`imap.zoho.com:993`) | design.md, plan.md, spec.md, .env.example, email_config.json | ✅ |
| Docker Compose on Ubuntu laptop | design.md, gateway constitution, README | ✅ |
| 10 tools | design.md, plan.md, spec.md, SKILL.md, SKILL.js | ✅ |
| Gateway at :18789 | design.md, docker-compose.yml, openclaw.json | ✅ |
| Expense-tracker at :8080 | design.md, docker-compose.yml | ✅ |
| DeepSeek `deepseek-chat` | design.md, plan.md, openclaw.json | ✅ |
| `ACTUAL_BUDGET_PASSWORD` vs `ACTUAL_BUDGET_API_KEY` | design.md §5.7 ✅ vs design.md §8.1 ❌ | ❌ Mismatch |

---

## Implementation Task List (ordered)

### Phase 1: Critical — expense-tracker constitution
1. **Edit** `modules/expense-tracker/.speckit/constitution.md`:
   - §2.1: Replace Fly.io VM/256MB with Ubuntu laptop Docker/150MB
   - §2.2: Replace internal Fly.io networking with public HTTPS
   - §2.2: Replace "Outlook burner inbox" with "Zoho burner inbox"  
   - §2.5: Replace "fly logs" with "docker compose logs"
   - §3 Hosting Topology: Replace Fly.io VM #2 + Outlook with Docker Compose + Zoho
   - Increment version to 2.0.0, update date to 2026-06-05

### Phase 2: Critical — expense-tracker agent.md
2. **Edit** `modules/expense-tracker/.speckit/agent.md`:
   - Line 33: "Outlook" → "Zoho"
   - Line 49: "Fly.io internal networking" → "Docker networking" + update rationale
   - Line 79: "Alpine Linux (Docker on Fly.io)" → "Ubuntu laptop (Docker Compose)"
   - Line 82: "outlook.office365.com:993" → "imap.zoho.com:993"
   - Line 100: "docker/fly.toml" → "docker-compose.yml"
   - Update Constitution Hash to v2.0.0

### Phase 3: High — design.md
3. **Edit** `design.md`:
   - Line 537: `ACTUAL_BUDGET_API_KEY` → `ACTUAL_BUDGET_PASSWORD`
   - Line 540: "fly secrets set" → ".env file (Docker Compose volume mount)"
   - Line 564: "fly logs" → "docker compose logs"

### Phase 4: Low — config.py
4. **Edit** `modules/expense-tracker/src/config.py`:
   - Line 41: `# IMAP (Outlook)` → `# IMAP (Zoho)`

### Phase 5: Validate
5. Run `pytest modules/expense-tracker/tests -v -m "not integration"` — must pass 27/27
6. Run `pytest modules/expense-tracker/tests -v -m "integration"` — must pass 9/9
7. Commit and push
