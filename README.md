# OpenClaw

LLM-powered automation agents for personal finance and productivity.

## Architecture

```
Ubuntu Laptop (Docker Compose)
├── OpenClaw Gateway (:18789) — openclaw:latest image
│   └── skills/expense-tracker/SKILL.js → HTTP → expense-tracker
├── expense-tracker (:8080) — Python 3.12 container
│   └── 10 deterministic tools + IMAP IDLE → Zoho
└── → Actual Budget (Fly.io VM)
```

## Modules

| Module | Description | Status |
|---|---|---|
| **expense-tracker** | Automated expense tracking via Zoho email → Actual Budget | Specified, Planned, Tasked — Implementation Pending |
| **openclaw-node** | OpenClaw Gateway + expense-tracker skill (Docker Compose) | Specified, Planned, Tasked |

## Setup

```bash
# Clone the repo
git clone https://github.com/darrencjh8/darren-openclaw.git
cd darren-openclaw

# Configure environment
cp modules/expense-tracker/.env.example modules/expense-tracker/.env
# Edit .env with your Zoho, DeepSeek, and Actual Budget credentials

# Run with Docker Compose
cd openclaw-node
docker compose up -d
```

## Full Architecture

See [design.md](design.md) for the complete architecture document with Mermaid diagrams, data flow, security design, and cost model.
