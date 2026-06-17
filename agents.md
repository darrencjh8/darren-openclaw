# Agent Instructions for darren-openclaw



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
