# Research: Expense Tracker Plugin Tools

**Feature**: expense-plugin-tools
**Date**: 2026-06-15

## Decision 1: Plugin SDK Import Paths

**Decision**: Use `import { Type } from "typebox"` not `@sinclair/typebox`, and `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"`.

**Rationale**: The OpenClaw gateway image bundles `typebox` (not `@sinclair/typebox`) at `/app/node_modules/typebox/`. The `plugin-sdk` subpath resolves to `/app/node_modules/openclaw/dist/plugin-sdk/plugin-entry.js`. Both verified via `docker exec gateway-openclaw-1 node -e "import { Type } from 'typebox'"` during production prototype.

**Alternatives considered**:
- `@sinclair/typebox` — fails with `Cannot find module` in the gateway container
- Direct HTTP calls without TypeBox schemas — violates the typed-tool contract; the LLM needs structured parameter definitions

## Decision 2: Plugin Persistence Strategy

**Decision**: Bind-mount `./plugins/expense-tracker-tools/` into the gateway container at `/home/node/plugins/expense-tracker-tools/`, plus `plugins.entries.expense-tracker-tools.enabled: true` in `openclaw.json`. Use `openclaw plugins install /path --force` for one-time initial registration. After registration, subsequent rebuilds do not require re-installation.

**Rationale**: Bind-mount provides version-controlled source that survives `docker compose down && docker compose up --build`. The install record lives on the `openclaw_home` named volume and persists across rebuilds. The plugin directory is tracked in git.

| Strategy | Survives Rebuild? | Version-Controlled? | Install Step? |
|---|---|---|---|
| Bind-mount + config | Yes | Yes | One-time |
| Named volume copy | No (if volume wiped) | No | Every rebuild |
| `--link` to `/tmp` | No | No | Every restart |

**Alternatives considered**:
- Copy to `openclaw_home` named volume — survives rebuilds but not tracked in git; lost if volume is recreated
- `openclaw plugins install --link /tmp/...` — lost on container restart (tmpfs)

## Decision 3: Tool Name to HTTP Endpoint Mapping

**Decision**: OpenClaw tool names use `budget_` prefix with underscores (e.g., `budget_fetch_accounts`). The HTTP endpoint uses the expense-tracker's hyphenated path convention (`/tools/fetch-accounts`). The mapping is hardcoded in each tool's `execute` handler.

**Rationale**: OpenClaw tool names follow JavaScript identifier conventions (underscores, no hyphens). The expense-tracker API uses Express.js route conventions (hyphens). The plugin is a thin wrapper — it owns the mapping, not the API.

**Notable mappings** (shortened names):
- `budget_fetch_unreconciled` to `/tools/fetch-unreconciled-transactions` (shortened for readability)
- All others are 1:1 with underscore-to-hyphen substitution

**Alternatives considered**:
- Match OpenClaw names to HTTP paths exactly — would require hyphens in OpenClaw names, which is unconventional
- Auto-derive endpoints from names — fragile, adds indirection, harder to debug

## Decision 4: Plugin Activation Mode

**Decision**: `activation.onStartup: true` with all 21 tools declared as required (non-optional) in `contracts.tools`.

**Rationale**: All 21 tools are needed for the expense-tracker to function. No tool is optional. The plugin should load at gateway startup with no user opt-in beyond the config entry.

**Alternatives considered**:
- Optional tools with `tools.allow` — adds configuration friction; no benefit since all tools are always needed
- Lazy activation — adds cold-start latency on first tool call

## Decision 5: Testing Strategy

**Decision**: vitest with mocked global `fetch`. Each test verifies the tool calls the correct HTTP endpoint with the correct JSON body.

**Rationale**: The project uses vitest (`modules/expense-tracker/vitest.config.js`). The tools are thin HTTP wrappers — testing them means verifying HTTP request shape, not the expense-tracker's business logic (which has its own test suite).

**Test scope**:
- Each tool maps to the correct HTTP endpoint
- Required parameters are passed correctly
- Optional parameters are included when present, omitted when absent
- HTTP errors are propagated to the agent

**Alternatives considered**:
- Integration tests with a running expense-tracker — valuable but belongs in a separate integration test suite; unit tests prove the plugin's contract
- Jest — the project already uses vitest

## Decision 6: Binary Input Handling (budget_extract_pdf_text)

**Decision**: The plugin passes `pdf_bytes_b64` as a string parameter. On the email path, `budget_extract_email_content` handles PDFs internally so the agent never manually passes binary data. On the Telegram path, the agent obtains base64-encoded PDF content via OpenClaw workspace file tools (the `read` tool), not via shell commands.

**Rationale**: The plugin is a thin HTTP wrapper — it does not read files from disk. The expense-tracker API accepts base64-encoded PDFs. The agent uses existing OpenClaw file tools to read and encode files, which avoids the `exec curl` hallucination class entirely.

**Alternatives considered**:
- Accept a file path parameter — adds filesystem dependency to the plugin, violates thin-wrapper principle
- Require `exec base64` — reintroduces shell command hallucination risk
