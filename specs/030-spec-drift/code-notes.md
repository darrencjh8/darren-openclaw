# Code Issues — Left Untouched (Docs-Only Fix Phase)

Per decision, the fix phase corrects **documentation only**. The code below is the source of truth and was **NOT modified**, but is recorded here so a future code-cleanup pass (or per-issue PR) can address it. Each needs a human decision (remove vs. wire-in), not just a doc edit.

## Portfolio-tracker (`modules/portfolio-tracker/src`)

| Ref | Location | Issue | Description | Suggested action |
|-----|----------|-------|-------------|------------------|
| C-1 | `tools.js:369-382` | #158 | `_abClient` constructor field is always `null` (never passed from `index.js`) and never read. Vestige of a planned AB-write path. | Remove field, OR build the AB-write path if PP→AB import is intended. |
| C-2 | `email_handler.js:126` | #216 | `classifyEmail(subject, body)` exported but has **zero** callers. | Remove, OR wire into `classify.js`/dispatch. |
| C-3 | `config.js:90` (`logLevel`), `config.js:93` (`balanceSyncModel`) | #217 | Read into config but never consumed anywhere. | Remove from config + docs, OR implement. |
| C-4 | `config.js:72-77` (`abEmergencyPrimaryCategory`, `abEmergencySecondaryCategory`, `abWarchestCategory`) | #211 | Category config set from `AB_*_CATEGORY` env vars but never consumed by sync logic (amounts come from `sgd/myr.*_total`). | Remove from config + docs, OR wire into sync. |
| C-5 | `index.js:195` (comment) | #220 | Comment reads `// Register MCP SSE transport (GET /sse + POST /messages)`; actual transport is Streamable HTTP at `/mcp` (POST/GET/DELETE). | Trivial comment fix when code is next touched. |
| C-6 | `index.js:21-46 guardEnv()` vs `tools.js:923-929` | #218 | `GOOGLE_SERVICE_ACCOUNT_JSON`/`GOOGLE_SHEET_ID` cause `process.exit(1)` at startup, but `_exportTaxonomiesToSheet()` skips gracefully at runtime, and README calls them "optional". Container can't start without them. | Make guard conditional on taxonomy config, OR accept as required (docs updated to "required"). |
| C-7 | `config.js:8-13` REQUIRED_ENV_VARS | #229 | Does not include `ACTUAL_SECONDARY_BUDGET_FILE` (it is still guarded by `index.js:27`). Defense-in-depth gap only. | Optional: add to `REQUIRED_ENV_VARS`. |
| C-8 | `prompts.js:43-148`, `prompts.js:152-221` | #213, #228 | System prompt + few-shot examples describe manual IBKR ingestion via email/Telegram, while `pp-sync-all` auto-pulls via the IBKR Flex Web Service (`ibkr_flex.js`). Not a hard contradiction (manual paths still exist) but trains a stale-leaning workflow. | Refresh prompt/examples toward the API-driven sync. |

## Expense-tracker

No dead-code issues identified that require a code decision; #232/#235/#236 are doc/spec-only (keyword table never existed; gateway plugin became an MCP tool). The 3-phase pipeline (`orchestrator.js:1-8`) is correct — only `SKILL.md` doc is stale.

## Doc-vs-doc reconciliation note (resolved in docs, no code change)
- Decision needed on whether `GOOGLE_SERVICE_ACCOUNT_JSON` should be "required" (matches current `guardEnv`) or "optional" (matches runtime skip). Docs are being set to **required** to match the running code; flip C-6 if you prefer optional.
