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

## Implementation (bug fixes / features)

- **TDD required**: write failing tests first, then implement. Run tests to confirm they fail before coding.
- **Agentic review loop**: after implementation and all tests pass, spin up 2 sub-agents to independently review the code for bugs, edge cases, and correctness.
- **Iterate until clean**: fix issues found by reviewers, re-run tests, and re-review. Repeat until 2 **consecutive** rounds produce zero findings from both agents.
- **Only bugs count as findings**: cosmetic notes, code style, and missing test-coverage suggestions do not block the loop.
- **After review**: raise a PR and merge (squash).
- **Never push directly to `main`**: all changes go through PRs. After committing to a feature branch, push it, create a PR, wait for required checks (gitleaks, CI), then merge.
- **Before creating a new branch**: check for pending work. You MUST be on a clean worktree — no uncommitted changes, no unstaged files. If there are, ask the user before proceeding.
