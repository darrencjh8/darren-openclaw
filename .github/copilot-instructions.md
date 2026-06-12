<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/012-migrate-to-nodejs/plan.md`
<!-- SPECKIT END -->

## Commit message

You are an expert at writing Git commits. Your job is to write a short clear commit message that summarizes the changes.

If you can accurately express the change in just the subject line, don't include anything in the message body. Only use the body when it is providing *useful* information.

Don't repeat information from the subject line in the message body.

Follow good Git style:

- Separate the subject from the body with a blank line
- Try to limit the subject line to 50 characters
- Capitalize the subject line
- Do not end the subject line with any punctuation
- Use the imperative mood in the subject line
- Wrap the body at 72 characters
- Keep the body short and concise (omit it entirely if not useful)

## Node.js (Post-Migration)

- All modules are Node.js. No Python runtime remains.
- Always use `npm` for package management.
- Builds use `docker compose build` (no --no-cache — cached layers are 100x faster).

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
  - https://docs.openclaw.ai/start/hubs
  - https://github.com/openclaw/openclaw/tree/main/docs
- Do not guess schema.
- OpenClaw thinking levels: `off | minimal | low | medium | high | xhigh | adaptive | max`
- TTS auto modes: `off | always | inbound | tagged`

## Planning

- Always propose a plan before making changes. Wait for explicit approval.
- Before running any test/verification command on production for the first time, explicitly ask the user for approval — never assume it's safe.
