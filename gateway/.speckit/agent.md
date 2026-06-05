# Spec-Kit Agent Harness — gateway

**Project:** darren-openclaw (umbrella)  
**Module:** gateway  
**Current Features:** gateway-baseline, expense-tracker-skill  
**Constitution Hash:** `v3.0.0`  
**Last Updated:** 2026-06-05T02:40:00+08:00  

---

## Workflow State Machine

```
/constitution  →  /specify  →  /plan  →  /tasks  →  /implement  →  /validate
     ✅              ✅          ✅         ✅          ⬜             ⬜
```

| Phase | Command | Status | Artifact |
|---|---|---|---|
| 0: Constitution | `/speckit.constitution` | ✅ Complete | `.speckit/constitution.md` |
| 1: Specify | `/speckit.specify` | ✅ Complete | `.speckit/features/gateway-baseline/spec.md`, `expense-tracker-skill/spec.md` |
| 2: Plan | `/speckit.plan` | ✅ Complete | `.speckit/features/gateway-baseline/plan.md`, `expense-tracker-skill/plan.md` |
| 3: Tasks | `/speckit.tasks` | ✅ Complete | `.speckit/features/gateway-baseline/tasks.md`, `expense-tracker-skill/tasks.md` |
| 4: Implement | `/speckit.implement` | ⬜ Pending | openclaw.json, AGENTS.md, docker-compose, SKILL.md, SKILL.js, tools_api.py |
| 5: Validate | `/speckit.validate` | ⬜ Pending | Test results |

---

## Context Dump

The gateway deploys the **OpenClaw Gateway** with a custom **expense-tracker skill**. The skill wraps 10 deterministic Python tools behind HTTP endpoints.

### Architecture

```
OpenClaw Gateway (Container)
  └── skills/expense-tracker/
      ├── SKILL.md   → LLM instructions
      └── SKILL.js   → 10 tool functions, each calls HTTP

expense-tracker (Container)
  └── tools_api.py   → HTTP endpoints for each tool
      └── calls: @actual-app/api (Node.js WebSocket sync), dedup, extractors, imap, notifier
```

### Key Decisions

| Decision | Rationale |
|---|---|
| Gateway is installed, not built | OpenClaw provides all infra |
| Skills call Python over HTTP | Separation of concerns — Node.js shouldn't run Python tools |
| Deterministic tools in Python | Same code works standalone or as skill backend |
| Docker Compose | Two containers, one network |

### Target Environment

- **Gateway:** Ubuntu laptop, Docker, Node.js 24 (via openclaw image)
- **Expense-tracker:** Python 3.12-slim, Docker
- **Actual Budget:** Fly.io existing instance