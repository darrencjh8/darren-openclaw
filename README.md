# OpenClaw

LLM-powered automation agents for personal finance and productivity.

## Architecture

```
Ubuntu Laptop (Docker Compose)
├── OpenClaw Gateway (:18789) — openclaw:latest image
│   └── workspace/skills/expense-tracker/ — skill (SKILL.md + SKILL.js)
│       └── HTTP → expense-tracker tools
├── expense-tracker (:8080) — Python 3.12 container
│   └── 10 deterministic tools + IMAP IDLE → Zoho
└── → Actual Budget (Fly.io VM)
```

## Structure

| Directory | Purpose |
|---|---|
| `gateway/` | OpenClaw Gateway config, docker-compose, workspace + skills |
| `modules/expense-tracker/` | Python tool backend (IMAP IDLE, Actual Budget client, extractors) |

## Setup

```bash
# Clone the repo
git clone https://github.com/darrencjh8/darren-openclaw.git
cd darren-openclaw

# Configure environment
cp modules/expense-tracker/.env.example modules/expense-tracker/.env
# Edit .env with your Zoho, DeepSeek, and Actual Budget credentials

# Run with Docker Compose
cd gateway
docker compose up -d
```

## Full Architecture

See [design.md](design.md) for the complete architecture document with Mermaid diagrams, data flow, security design, and cost model.
