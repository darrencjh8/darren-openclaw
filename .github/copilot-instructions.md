<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/012-migrate-to-nodejs/plan.md`
<!-- SPECKIT END -->

## Production Server

- **Server**: `<SERVER_IP>`, SSH as `$USER` (sudoer).
- **Deploy workflow**:
  1. Propose a plan and get explicit approval before any production changes.
  2. **Config-only**: `scp` file → `docker compose restart <svc>`
  3. **Code change**: `git pull` → `nohup docker compose build <svc> … &` → `docker compose up -d <svc>`
  4. Sync `.env` before deploying: `scp .env $USER@<SERVER_IP>:~/darren-openclaw/gateway/.env`
  5. After deploy, verify changes in production container.

## Python

- Always use `uv` — never `pip` or `pipx`.
- Always use `.venv/` at project root (shared by all modules).

## Configuration

- Verify any changes against official docs: 
  - https://docs.openclaw.ai/start/hubs
  - https://github.com/openclaw/openclaw/tree/main/docs
- Do not guess schema.

## Planning

- Always propose a plan before making changes. Wait for explicit approval.
- Before running any test/verification command on production for the first time, explicitly ask the user for approval — never assume it's safe.

## Worktrees

- **NEVER implement on `main`**. Always create a git worktree for each feature/bug:
  ```sh
  git worktree add ../darren-openclaw-<NNN> feature/<NNN-name>
  ```
- Open the worktree in a new Zed window before making any code changes.
- Delete the worktree after merge:
  ```sh
  git worktree remove ../darren-openclaw-<NNN>
  git branch -d feature/<NNN-name>
  ```
