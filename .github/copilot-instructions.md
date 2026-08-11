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

Follow this sequence in order — do not skip steps.

1. **Clean worktree**: verify no uncommitted changes, no unstaged files. If dirty, ask the user before proceeding.
2. **Create branch**: from a clean worktree, create a feature branch (`feat/...` or `fix/...`). Never make changes on `main`.
3. **TDD — write failing tests**: on the feature branch, write tests first. Run them to confirm they fail before writing implementation code.
4. **Implement**: write the minimum code to make tests pass. Run tests to confirm green.
5. **Agentic review loop**: spin up 2 sub-agents to independently review the code for bugs, edge cases, and correctness.
6. **Iterate until clean**: fix issues found by reviewers, re-run tests, and re-review. Repeat until 2 **consecutive** rounds produce zero findings from both agents.
7. **PR & merge**: push the feature branch, create a PR, wait for required checks (gitleaks, CI), then squash-merge to `main`.

**Rules**:
- Only bugs count as findings — cosmetic notes, code style, and missing test-coverage suggestions do not block the loop.
- Never push directly to `main`. All changes go through PRs.
