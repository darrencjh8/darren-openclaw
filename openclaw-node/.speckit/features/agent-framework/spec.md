# Feature Specification: Companion Service

**Feature:** companion-service  
**Spec Version:** 2.0.0  
**Status:** Specified  
**Constitution Hash:** v1.0.0  

---

## Overview

A lightweight Node.js HTTP **companion service** that runs alongside the Python expense-tracker on Fly.io's internal network. It provides health monitoring, agent status tracking, a simple agent registration API, and a generic webhook ingress for future channel expansion (WhatsApp, Telegram, etc.).

---

## User Stories

### US-1: Health Check Endpoint

**As a** Fly.io deployment,  
**I want** a liveness check at `GET /health`,  
**So that** Fly.io can automatically restart the service if it crashes.

**Acceptance Criteria:**
- [ ] `GET /health` returns 200 with `{"status": "ok"}`
- [ ] Response time under 10ms
- [ ] No authentication required (internal network only)
- [ ] Always returns 200 while the process is alive (liveness, not readiness)

### US-2: Readiness Endpoint

**As a** dependent service (expense-tracker),  
**I want** a readiness check at `GET /ready`,  
**So that** I can verify the companion service is accepting traffic before sending requests.

**Acceptance Criteria:**
- [ ] `GET /ready` returns 200 with `{"status": "ready"}`
- [ ] Returns 503 if the server is still starting up or shutting down
- [ ] Response time under 10ms

### US-3: Service Status Endpoint

**As an** operator or connected agent,  
**I want** `GET /status` returning service metadata,  
**So that** I can see what's connected without looking at logs.

**Acceptance Criteria:**
- [ ] `GET /status` returns:
  ```json
  {
    "service": "openclaw-node",
    "version": "1.0.0",
    "uptime_seconds": <integer>,
    "agents": {"<name>": {"version": "...", "last_heartbeat": "..."}}
  }
  ```
- [ ] `agents` maps each registered agent name to its version and last heartbeat
- [ ] `uptime_seconds` is computed from process start time
- [ ] Response time under 10ms

### US-4: Agent Registration

**As the** expense-tracker service,  
**I want** to `POST /agents/register` with my agent info,  
**So that** the status endpoint reflects that I'm connected.

**Acceptance Criteria:**
- [ ] `POST /agents/register` with body `{"name": "expense-tracker", "version": "1.0.0"}` returns 201
- [ ] Duplicate registration for the same agent name returns 200 (idempotent)
- [ ] Returns 400 if `name` is missing
- [ ] Returns 400 if body is not valid JSON
- [ ] Agent appears in `GET /status` → `agents` map after registration
- [ ] Registration is in-memory only — resets on restart

### US-5: Agent Heartbeat

**As a** registered agent,  
**I want** to `POST /agents/{name}/heartbeat` to signal I'm still alive,  
**So that** stale agents can be detected and removed.

**Acceptance Criteria:**
- [ ] `POST /agents/expense-tracker/heartbeat` returns 200 with `{"status": "ok"}`
- [ ] Returns 404 if agent was never registered
- [ ] Heartbeat timestamp is stored and visible in `/status` (per-agent `last_heartbeat` field)

### US-6: Graceful Shutdown

**As an** operator deploying updates,  
**I want** the service to drain connections and mark itself unready on SIGTERM,  
**So that** Fly.io can safely restart it without dropping in-flight requests.

**Acceptance Criteria:**
- [ ] On SIGTERM: `/ready` immediately returns 503
- [ ] Existing connections complete within `kill_timeout` seconds
- [ ] Process exits cleanly with code 0
- [ ] `/health` continues returning 200 until exit (process is still alive)

### US-7: Internal Networking Only

**As a** security-conscious operator,  
**I want** the service to listen only on Fly.io's internal network,  
**So that** no public internet traffic can reach it.

**Acceptance Criteria:**
- [ ] Server binds to `0.0.0.0:8080` (Fly.io routes internally)
- [ ] No public HTTPS endpoint configured in `fly.toml`
- [ ] Expense-tracker connects via `http://openclaw-node.internal:8080`

### US-8: Webhook Ingress (Future Channel Support)

**As a** future WhatsApp/Telegram handler,  
**I want** a generic `GET/POST /webhook` endpoint that accepts external messages,  
**So that** new channels can be added without changing the companion service core.

**Acceptance Criteria:**
- [ ] `GET /webhook?hub.mode=subscribe&hub.challenge=<challenge>` returns 200 with the challenge value
- [ ] `POST /webhook` accepts JSON body `{"channel": "whatsapp", "from": "+65xxxxxxxx", "text": "Track $12.80 at Toast Box from DBS Yuu", "timestamp": "2026-..."}`
- [ ] Forwards the message to the expense-tracker via `POST http://expense-tracker.internal:8080/process`
- [ ] Returns 202 `{"status": "accepted", "correlation_id": "<uuid>"}` to acknowledge receipt
- [ ] Returns 400 with error format if `channel`, `from`, or `text` is missing
- [ ] Returns 400 if body is not valid JSON
- [ ] No channel-specific logic in the companion service — pure validation + passthrough
- [ ] Webhook forward timeout: 10 seconds (fires and forgets — if expense-tracker is down, the message is lost; WhatsApp will retry)

---

## Error Response Format

All error responses follow this shape:
```json
{
  "error": "human_readable_message",
  "code": "ERROR_CODE"
}
```

| HTTP Status | code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Invalid JSON, missing required fields |
| 404 | `NOT_FOUND` | Agent not found for heartbeat |
| 503 | `NOT_READY` | Readiness check during startup/shutdown |

---

## Non-Goals (Explicitly Out of Scope)

- Persistent agent storage (in-memory only — resets on restart)
- Authentication/authorization (internal network trust model)
- Agent-to-agent message routing
- WebSocket or push notifications
- Public API endpoints
- HTTPS/TLS termination (handled by Fly.io)
- Agent deregistration endpoint (agents that restart will re-register)
- Message queue or persistence (lost messages on crash are acceptable — channels will retry)