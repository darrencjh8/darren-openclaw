# Spec-Kit Agent Harness — openclaw-node

**Project:** darren-openclaw (umbrella)  
**Module:** openclaw-node  
**Current Feature:** companion-service  
**Constitution Hash:** `v1.0.0`  
**Last Updated:** 2026-06-05T01:22:00+08:00  

---

## Workflow State Machine

```
/constitution  →  /specify  →  /plan  →  /tasks  →  /implement  →  /validate
     ✅              ✅          ✅         ✅          ⬜             ⬜
```

| Phase | Command | Status | Artifact |
|---|---|---|---|
| 0: Constitution | `/speckit.constitution` | ✅ Complete | `.speckit/constitution.md` |
| 1: Specify | `/speckit.specify` | ✅ Complete | `.speckit/features/agent-framework/spec.md` |
| 2: Plan | `/speckit.plan` | ✅ Complete | `.speckit/features/agent-framework/plan.md` |
| 3: Tasks | `/speckit.tasks` | ✅ Complete | `.speckit/features/agent-framework/tasks.md` |
| 4: Implement | `/speckit.implement` | ⬜ Pending | Source files |
| 5: Validate | `/speckit.validate` | ⬜ Pending | Test results |

---

## Context Dump

openclaw-node is a Node.js 22 companion service that provides:

- `GET /health` — Fly.io liveness probe
- `GET /ready` — Readiness probe (503 during shutdown)
- `GET /status` — Service metadata + registered agents
- `POST /agents/register` — Dynamic agent registration
- `POST /agents/{name}/heartbeat` — Agent heartbeat
- `GET/POST /webhook` — Generic webhook ingress for future channels

### Key Decisions

| Decision | Rationale |
|---|---|
| Express 4.x | Minimal, well-known, no overhead |
| In-memory state only | No database — resets on restart is acceptable |
| Agent registration | expense-tracker registers on startup + sends heartbeats |
| Webhook passthrough | No channel-specific logic — forwards to expense-tracker |
| Graceful shutdown | SIGTERM → mark unready → drain connections → exit |
| TDD mandatory | RED → GREEN → REFACTOR for every task |

### Target Environment

- **OS:** Alpine Linux (Docker on Fly.io)
- **Runtime:** Node.js 22 LTS
- **Port:** 8080 (internal only)
- **Expense-tracker URL:** `http://expense-tracker.internal:8080`