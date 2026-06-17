# Agent Instructions for darren-openclaw

## Communication
- Get to the point. No polite filler ("That's right", "I'm sorry", "Great question", "Sure thing", "Let me explain").
- State the action, result, or next step. Drop conversational fluff.

## General

- Always propose a plan before making changes. Wait for explicit approval before implementing.
- Before running any command on production for the first time, ask for explicit approval.

## Production Server

- **Server**: `<SERVER_IP>`, SSH as `$USER` (sudoer).
- **Deploy workflow**:
  1. Propose a plan and get explicit approval before any production changes.
  2. **Config-only**: `scp` file → `docker compose restart <svc>`
  3. **Code change**: `git pull` → `docker compose build <svc>` → `docker compose up -d <svc>`
  4. Sync `.env` before deploying: `scp .env $USER@<SERVER_IP>:~/darren-openclaw/gateway/.env`
  5. After deploy, verify changes in production container.
- **Deploy script**: `ssh $USER@<SERVER_IP> 'cd ~/darren-openclaw && bash ./scripts/deploy.sh'` — validates env vars, builds, health-checks

## Configuration

- Verify any changes against official docs:
  - https://hermes-agent.nousresearch.com/docs/user-guide/configuration
  - https://github.com/NousResearch/hermes-agent/tree/main/docs
  - https://docs.openclaw.ai/start/hubs
  - https://github.com/openclaw/openclaw/tree/main/docs
- Do not guess schema.
- Always run deploy.sh script instead of running docker compose up manually

## Planning

- Always propose a plan before making changes. Wait for explicit approval.
- Before running any test/verification command on production for the first time, explicitly ask the user for approval — never assume it's safe.


## Git Operations

### Primary: Use `gh` CLI
For pushing, pulling, and interacting with GitHub, always prefer the `gh` CLI tool over MCP.

```bash
# Clone
gh repo clone darrencjh8/darren-openclaw

# Create branches
gh repo fork / clone / create

# Pull requests
gh pr create / list / view / merge

# Issues
gh issue create / list / view

# Auth
gh auth login    # One-time setup
gh auth status   # Check current auth state
```

### Secondary: GitHub MCP Server
Use MCP GitHub tools only when `gh` CLI cannot accomplish the task (e.g., searching code across GitHub, creating files directly in repos without local clone).

### Never use:
- MCP `push_files` for initial commits on empty repos (use `gh` + `git` instead)
- MCP for large multi-file pushes (use `git add -A && git commit && git push`)

## Repository: darrencjh8/darren-openclaw

- **URL:** https://github.com/darrencjh8/darren-openclaw
- **Status:** Initialized with README.md, .gitignore, config files, and constitution.md
- **Remaining files to push locally:** spec.md, plan.md, tasks.md, agent.md, design.md, source stubs

---

## Excluded files (never commit)
- `modules/expense-tracker/db.sqlite` — dedup journal with transaction hashes
- `modules/expense-tracker/metadata.json` — Actual Budget IDs, user UUIDs, encryption keys
- `.env` / `.env.*` — API keys and credentials

These are covered by `.gitignore`.
