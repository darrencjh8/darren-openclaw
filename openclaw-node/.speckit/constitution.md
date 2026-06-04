# Project Constitution — openclaw-node

**Project:** darren-openclaw — OpenClaw Gateway Node  
**Version:** 3.0.0  
**Last Amended:** 2026-06-05  
**Workflow:** Spec-Kit (Spec-Driven Development)

---

## 1. System Identity

openclaw-node is an **OpenClaw Gateway deployment** — it runs the official `openclaw` Node.js gateway (https://openclaw.ai) on Ubuntu/Docker, loaded with custom skills. It is NOT a custom-built companion service. The gateway provides channels (WhatsApp/Telegram/WebChat), agent orchestration, session management, and tool calling. WE provide the skills.

The gateway can be joined by **OpenClaw nodes** — separate machines (Windows/macOS/iOS/Android) that connect via WebSocket and expose device capabilities (camera, screen capture, canvas, voice).

---

## 2. Non-Negotiable Architecture Principles

### 2.1 We Do NOT Build HTTP Endpoints

The OpenClaw Gateway provides all infrastructure: channel handlers, webhook verification, agent orchestration, DM pairing, session management, logging, and graceful shutdown. We configure it — we do not build it.

### 2.2 We Build Skills + Deterministic Tools

| What We Build | Technology | Purpose |
|---|---|---|
| `SKILL.md` | Markdown | LLM instructions — how to use expense-tracker tools |
| `SKILL.js` | Node.js | Exports 10 async functions → HTTP calls to Python tool API |
| `tools_api.py` | Python (aiohttp) | HTTP endpoints for each deterministic tool |
| Custom `AGENTS.md` | Markdown | Agent personality/behavior guidance |

### 2.3 TDD Applies to OUR Code

The `RED → GREEN → REFACTOR` cycle applies to:
- `SKILL.js` (unit tests with Jest, mocking HTTP calls)
- `tools_api.py` (pytest, testing each tool endpoint)
- Any Python tools (dedup, extractors, IMAP, etc.)

Config files (`openclaw.json`, `SKILL.md`, `docker-compose.yml`) are validated via integration tests and manual review.

### 2.4 Docker-First

```
docker-compose.yml
├── openclaw (openclaw:latest)     # GitHub container registry
│   └── skills/expense-tracker/    # volume-mounted
└── expense-tracker (custom Dockerfile)
    └── Python 3.12 + tools_api.py
```

Everything runs in containers. This makes migration to any cloud provider trivial — the same `docker-compose.yml` works on Fly.io, GCP, OCI, or locally.

### 2.5 Memory Budget

| Container | RAM | Notes |
|---|---|---|
| openclaw | ~400MB | Gateway + agent session |
| expense-tracker | ~150MB | Python 3.12-slim + 10 tools |
| **Total** | **~550MB** | Fits on any laptop/RPi 4+ |

### 2.6 Security

- **Gateway security:** OpenClaw's built-in DM pairing (`dmPolicy="pairing"`), sandboxing (`non-main` sessions), and channel allowlists
- **Secrets:** All credentials via environment variables in `.env` (excluded from git)
- **Node connections:** WebSocket, authenticated by the gateway's pairing mechanism
- **Internal communication:** expense-tracker container only accessible within the Docker network — not exposed to host

---

## 3. Hosting Topology

| Component | Host | Role |
|---|---|---|
| **OpenClaw Gateway** | Ubuntu laptop (Docker) | Agent orchestration, channels, skills |
| **Expense-tracker** | Ubuntu laptop (Docker) | 10 deterministic Python tools |
| **Actual Budget** | Fly.io VM (existing) | Budget data via REST API |
| **Zoho Mail** | Zoho (zoho.com) | IMAP IDLE inbox |
| **DeepSeek** | DeepSeek Cloud | LLM inference |
| **Windows Node** (future) | Windows laptop | Canvas, camera, screen, voice |

---

## 4. Development Methodology

- **Spec-Kit framework:** All features specified, planned, tasked before implementation.
- **TDD mandatory for all code.**
- **OpenClaw Gateway is installed, not built.** We write skills and tools.