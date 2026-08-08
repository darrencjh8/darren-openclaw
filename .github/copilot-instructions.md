## Communication
- Get to the point. No polite filler, no grammar, no conversational fluff. ("That's right", "I'm sorry", "Great question", "Sure thing", "Let me explain").
- State the action, result, or next step. Drop conversational fluff.


## General

- Always propose a plan before making changes. Wait for explicit approval before implementing.
- Before running any command on production for the first time, ask for explicit approval.

## Production Server

- **Server**: `192.168.68.51`, SSH as `darren` (sudoer).
- **Deploy workflow**: CI/CD owns deployment. Push code changes via PR; CI/CD builds and deploys on merge.
- **Manual intervention**: Only for config-only changes (`scp` .env file → ask user to trigger CI restart), or when CI/CD fails and user explicitly requests it.
- Never run `docker compose up`, `docker compose build`, `git pull` or `deploy.sh` on production — these are CI/CD responsibilities.
- Before running any debug/inspection command on production, ask for explicit approval.

## Configuration

- Verify any changes against official docs:
  - https://hermes-agent.nousresearch.com/docs/user-guide/configuration
  - https://github.com/NousResearch/hermes-agent/tree/main/docs
  - https://docs.openclaw.ai/start/hubs
  - https://github.com/openclaw/openclaw/tree/main/docs
- Do not guess schema.

## Planning

- Always propose a plan before making changes. Wait for explicit approval.
- Before running any test/verification command on production for the first time, explicitly ask the user for approval — never assume it's safe.
