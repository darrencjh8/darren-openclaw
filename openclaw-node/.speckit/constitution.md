# Project Constitution — openclaw-node

**Project:** darren-openclaw — openclaw-node  
**Version:** 1.0.0  
**Last Amended:** 2026-06-05  
**Workflow:** Spec-Kit (Spec-Driven Development)

---

## 1. System Identity

openclaw-node is a **Node.js-based companion service** that runs alongside openclaw (the Python expense-tracker). It provides an HTTP server for:

1. Health/readiness probes for Fly.io monitoring
2. Agent registration and heartbeat tracking
3. A generic webhook ingress for future channel expansion (WhatsApp, Telegram)

The expense-tracker connects to openclaw-node over Fly.io's internal network for cross-service communication. Future channel handlers (WhatsApp webhook) will also route through openclaw-node.

---

## 2. Non-Negotiable Architecture Principles

### 2.1 Memory Constraint: 256MB RAM

- The openclaw-node VM on Fly.io (free tier) is capped at 256MB RAM.
- Node.js 22 LTS with minimal dependencies (Express only).
- Single-process event loop architecture.
- In-memory state only — no database, no persistent queues.

### 2.2 Security Isolation

- **Internal networking only:** openclaw-node listens on Fly.io's internal network. No public HTTP endpoints.
- **No secrets in code:** All configuration via environment variables injected by Fly.io.
- **Webhook is validated but not authenticated:** Channel-specific auth (WhatsApp token verification) handled at the webhook layer.

### 2.3 Communication

- **Expense-tracker → openclaw-node:** HTTP over Fly.io internal network (`http://openclaw-node.internal:8080`)
- **External channels → openclaw-node:** webhook POSTs to `POST /webhook` (forwarded to expense-tracker)
- **Protocol:** REST/JSON

### 2.4 Minimal Scope (v2.0.0)

- Health/readiness endpoints
- Agent registration + heartbeat tracking
- Generic webhook ingress (passthrough — no channel-specific logic)
- Graceful shutdown on SIGTERM

### 2.5 TDD (Test-Driven Development) — Non-Negotiable

**Every line of implementation code MUST be preceded by a failing test. No exceptions.**

The TDD cycle is mandatory for all implementation work:

```
RED → GREEN → REFACTOR
```

| Step | Description | Requirement |
|---|---|---|
| **RED** | Write a failing test first | Test must fail for the expected reason before any implementation code is written. Tests must be run and confirmed failing. |
| **GREEN** | Write the minimum code to pass | Implement only enough code to make the test pass. No extra features, no speculative code. |
| **REFACTOR** | Clean up without changing behavior | Improve code structure, remove duplication, enhance readability. All tests must remain green after refactoring. |

**Enforcement Rules:**

1. **No implementation without a test.** Every function, route handler, and middleware must have corresponding tests written *before* the implementation.
2. **Tests must fail first.** Run the test suite after writing each test and confirm it fails (`npm test`). If a test passes without implementation code, it is a false positive and must be fixed.
3. **All tests must pass.** Before marking any task complete, run `npm test` and verify 100% pass rate. No skipped tests, no ignored failures.
4. **Test isolation.** Each test must be independent — use supertest for HTTP tests, mock external HTTP calls.
5. **Tests are documentation.** Test descriptions must clearly describe the scenario (e.g., `"POST /agents/register with valid body returns 201"` not `"test registration 1"`).

---

## 3. Hosting Topology

| Component | Host | Network |
|---|---|---|
| openclaw-node | Fly.io VM #3 (free tier, 256MB) | Internal HTTP only |
| Expense-tracker | Fly.io VM #2 (free tier, 256MB) | Connects to openclaw-node.internal:8080 |
| WhatsApp (future) | Meta Cloud API | Webhooks → openclaw-node.internal:8080/webhook |

---

## 4. Development Methodology

- **Spec-Kit framework:** All features specified, planned, and tasked before implementation.
- **TDD mandatory:** Tests first, then implementation, then refactor.