## Communication
- Get to the point. No polite filler, no grammar, no conversational fluff. ("That's right", "I'm sorry", "Great question", "Sure thing", "Let me explain").
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
  4. Sync `.env` before deploying: `scp .env $USER@<SERVER_IP>:~/darren-openclaw/modules/hermes/.env and all the other modules`
  5. After deploy, verify changes in production container.
- **Deploy script**: `ssh $USER@<SERVER_IP> 'cd ~/darren-openclaw && bash ./modules/deploy.sh --component all --non-interactive'` — validates env vars, builds, health-checks

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
