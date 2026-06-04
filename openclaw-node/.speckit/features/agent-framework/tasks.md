# Implementation Tasks: Companion Service

**Feature:** companion-service  
**Tasks Version:** 2.0.0  
**Status:** Tasked  
**Constitution Hash:** v1.0.0  

---

## Task Dependency Graph

```
Phase 0: Foundation
  T0.1 (Project scaffold: npm init, Express, Jest, supertest)
    │
    ├── T0.2 (Health + Readiness endpoints)
    ├── T0.3 (Status endpoint)
    ├── T0.4 (Agent registration)
    └── T0.5 (Graceful shutdown)
          │
Phase 1: Agent Lifecycle
  T1.1 (Agent heartbeat)
          │
Phase 2: Webhook (Future)
  T2.1 (Webhook GET challenge + POST passthrough)
          │
Phase 3: Deploy
  T3.1 (Dockerfile + fly.toml)
  T3.2 (Integration tests)
```

---

## Phase 0: Foundation

### T0.1 — Project Scaffold

**Priority:** P0 (blocker)  
**Estimate:** 10 minutes  

- [ ] `npm init -y` in openclaw-node/
- [ ] `npm install express`
- [ ] `npm install --save-dev jest supertest`
- [ ] Add `"test": "jest"` to package.json scripts
- [ ] Create `src/index.js` (empty module)
- [ ] Create `.gitignore` (node_modules, .env)

**Validation:** `npm test` runs without errors (0 tests), `node -e "require('express')"` succeeds.

---

### T0.2 — Health + Readiness Endpoints (TDD)

**Priority:** P0 (blocker)  
**Estimate:** 20 minutes  

**RED:** Write `tests/health.test.js`:
- `GET /health returns 200 and {"status":"ok"}`
- `GET /ready returns 200 and {"status":"ready"} when server is ready`
- `GET /ready returns 503 when server is shutting down`

**GREEN:** Implement `/health` and `/ready` routes in `src/index.js`. Track ready state with a boolean flag.

**REFACTOR:** Extract route handler functions.

---

### T0.3 — Status Endpoint (TDD)

**Priority:** P0 (blocker)  
**Estimate:** 15 minutes  

**RED:** Write `tests/status.test.js`:
- `GET /status returns service info with uptime_seconds and agents`
- `GET /status returns empty agents map initially`
- `uptime_seconds increases between calls`

**GREEN:** Implement `/status` route with `process.uptime()` and agent map.

---

### T0.4 — Agent Registration (TDD)

**Priority:** P0 (blocker)  
**Estimate:** 20 minutes  

**RED:** Write `tests/agents.test.js`:
- `POST /agents/register with valid body returns 201`
- `POST /agents/register duplicate returns 200`
- `POST /agents/register with missing name returns 400`
- `POST /agents/register with invalid JSON returns 400`
- `Registered agent appears in GET /status agents map`

**GREEN:** Implement `/agents/register` route. Track agents in an in-memory Map.

---

### T0.5 — Graceful Shutdown (TDD)

**Priority:** P0 (blocker)  
**Estimate:** 15 minutes  

**RED:** Write `tests/shutdown.test.js`:
- `SIGTERM sets ready to false (GET /ready returns 503)`
- `Server closes after SIGTERM within kill_timeout`

**GREEN:** Implement SIGTERM handler. Set isReady = false, close HTTP server.

---

## Phase 1: Agent Lifecycle

### T1.1 — Agent Heartbeat (TDD)

**Priority:** P1 (high)  
**Estimate:** 15 minutes  

**RED:** Write `tests/heartbeat.test.js`:
- `POST /agents/{name}/heartbeat returns 200 for registered agent`
- `POST /agents/{name}/heartbeat returns 404 for unregistered agent`
- `Heartbeat updates last_heartbeat in /status`

**GREEN:** Implement `/agents/:name/heartbeat` route. Update timestamp on registered agent.

---

## Phase 2: Webhook (Future)

### T2.1 — Webhook Endpoint (TDD)

**Priority:** P2 (medium)  
**Estimate:** 25 minutes  

**RED:** Write `tests/webhook.test.js`:
- `GET /webhook?hub.mode=subscribe&hub.challenge=test returns 200 with "test"`
- `POST /webhook with valid body returns 202 with correlation_id`
- `POST /webhook with missing channel returns 400`
- `POST /webhook with missing from returns 400`
- `POST /webhook with missing text returns 400`
- `POST /webhook with invalid JSON returns 400`
- `POST /webhook forwards to expense-tracker URL` (mock external HTTP)

**GREEN:** Implement `/webhook` route. Validate body, generate correlation_id, forward to `EXPENSE_TRACKER_URL/process`.

---

## Phase 3: Deploy

### T3.1 — Dockerfile + fly.toml

**Priority:** P0 (blocker)  
**Estimate:** 10 minutes  

- [ ] Write `Dockerfile` (Node 22 Alpine, non-root user)
- [ ] Write `fly.toml` (internal port 8080, kill_timeout 10s)

---

### T3.2 — Integration Tests

**Priority:** P1 (high)  
**Estimate:** 15 minutes  

- [ ] Full lifecycle test: register → heartbeat → status → webhook → shutdown
- [ ] Run `npm test` — all tests pass

---

## Execution Sequence

| Order | Task | Phase | Can Parallelize With |
|---|---|---|---|
| 1 | T0.1 — Project Scaffold | Foundation | — |
| 2 | T0.2 — Health + Readiness | Foundation | T0.3 |
| 3 | T0.3 — Status | Foundation | T0.2 |
| 4 | T0.4 — Agent Registration | Foundation | After T0.3 |
| 5 | T0.5 — Graceful Shutdown | Foundation | After T0.2 |
| 6 | T1.1 — Agent Heartbeat | Agent | After T0.4 |
| 7 | T2.1 — Webhook | Webhook | After T0.4 |
| 8 | T3.1 — Docker + Fly | Deploy | After T0.1 |
| 9 | T3.2 — Integration Tests | Deploy | After all tasks |

## Total Estimated Effort: ~2.5 hours