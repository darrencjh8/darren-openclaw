# Feature Specification: Expense Tracker Plugin Tools

**Feature:** expense-plugin-tools
**Spec Version:** 1.0.0
**Status:** Draft
**Created:** 2026-06-15
**Constitution Hash:** v4.0.0

---

## Overview

Replace the fragile `exec curl` pattern in the expense-tracker SKILL.md with typed OpenClaw plugin tools. The Gateway agent currently invokes the expense-tracker's 21 REST endpoints by constructing raw shell commands (`exec curl http://expense-tracker:8080/tools/...`), which is error-prone: the LLM hallucinates pipes (`| jq '.'`), flags, and shell syntax, causing cascading approval-timeout feedback loops.

The fix is an OpenClaw plugin that wraps each expense-tracker REST endpoint as a native typed tool. The agent sees structured function calls (`budget_fetch_accounts({ budget_id: "Darren SGD" })`) instead of raw shell commands. This eliminates shell hallucination, removes the `exec curl` allowlist dependency, and makes tool invocation reliable.

All tool names use a `budget_` prefix. This gives the LLM an immediate domain signal in its flat tool catalog — it sees `budget_fetch_accounts` alongside potential future skill plugins and instantly knows which domain each belongs to without reading every description. The prefix also prevents name collisions when portfolio-tracker and other skills are plugin-ified later.

---

## User Stories

### US-1: Agent Calls Tools Without Shell Commands (Priority: P1)

**As the** Gateway agent processing an expense-tracking request,
**I want** to call expense-tracker tools as typed function invocations instead of raw shell commands,
**So that** tool calls never fail due to shell syntax hallucination, pipe mismatches, or exec allowlist misses.

**Why this priority**: This is the root cause of the production incident (30-minute feedback loop from `| jq '.'` hallucination). Fixing it prevents all future `exec curl` failures.

**Independent Test**: Send "fetch my accounts" via Telegram. The agent calls `budget_fetch_accounts()` (typed tool) and returns the account list without any shell execution.

**Acceptance Scenarios**:

1. **Given** the expense-tracker plugin is loaded, **When** the agent needs to fetch accounts, **Then** it calls the `budget_fetch_accounts` tool with structured parameters, not `exec curl`.
2. **Given** any of the 21 tools is invoked, **When** the tool executes, **Then** the HTTP call to `expense-tracker:8080` succeeds and the result is returned to the agent.
3. **Given** the agent previously hallucinated `| jq '.'` on curl commands, **When** the plugin tools are used, **Then** no shell pipe, flag, or syntax errors occur because no shell is involved.

---

### US-2: All 21 Expense-Tracker Tools Are Available (Priority: P1)

**As the** Gateway agent,
**I want** all 21 expense-tracker REST endpoints exposed as typed plugin tools,
**So that** every tool the SKILL.md references is callable without `exec curl`.

**Why this priority**: Partial migration leaves some tools still on `exec curl`, creating a split brain where some calls work and others fail. All 21 must be migrated together.

**Independent Test**: Verify via `openclaw plugins inspect expense-tracker-tools --runtime --json` that all 21 tool names are listed under `toolNames`.

**Acceptance Scenarios**:

1. **Given** the plugin is loaded, **When** the agent lists available tools, **Then** all 21 budget-prefixed tools appear: `budget_fetch_accounts`, `budget_fetch_categories`, `budget_fetch_payees`, `budget_fetch_recent_transactions`, `budget_insert_transaction`, `budget_check_duplicate`, `budget_search_memory`, `budget_learn_fact`, `budget_list_facts`, `budget_update_fact`, `budget_delete_fact`, `budget_extract_pdf_text`, `budget_extract_email_content`, `budget_mark_email_read`, `budget_notify_user`, `budget_log_decision`, `budget_reconcile_transaction`, `budget_fetch_unreconciled`, `budget_record_statement`, `budget_fetch_statement_history`, `budget_check_statement_duplicate`.
2. **Given** the plugin is loaded, **When** each tool is called with valid parameters, **Then** it makes the correct POST request to `http://expense-tracker:8080/tools/<name>` with the JSON body matching the tool's parameter schema.

**Tool Name to HTTP Endpoint Mapping** (shortened names where different):

| OpenClaw Tool Name | HTTP Endpoint |
|---|---|
| `budget_fetch_accounts` | `/tools/fetch-accounts` |
| `budget_fetch_categories` | `/tools/fetch-categories` |
| `budget_fetch_payees` | `/tools/fetch-payees` |
| `budget_fetch_recent_transactions` | `/tools/fetch-recent-transactions` |
| `budget_insert_transaction` | `/tools/insert-transaction` |
| `budget_check_duplicate` | `/tools/check-duplicate` |
| `budget_search_memory` | `/tools/search-memory` |
| `budget_learn_fact` | `/tools/learn-fact` |
| `budget_list_facts` | `/tools/list-facts` |
| `budget_update_fact` | `/tools/update-fact` |
| `budget_delete_fact` | `/tools/delete-fact` |
| `budget_extract_pdf_text` | `/tools/extract-pdf-text` |
| `budget_extract_email_content` | `/tools/extract-email-content` |
| `budget_mark_email_read` | `/tools/mark-email-read` |
| `budget_notify_user` | `/tools/notify-user` |
| `budget_log_decision` | `/tools/log-decision` |
| `budget_reconcile_transaction` | `/tools/reconcile-transaction` |
| `budget_fetch_unreconciled` | `/tools/fetch-unreconciled-transactions` |
| `budget_record_statement` | `/tools/record-statement` |
| `budget_fetch_statement_history` | `/tools/fetch-statement-history` |
| `budget_check_statement_duplicate` | `/tools/check-statement-duplicate` |

---

### US-3: Plugin Survives Container Rebuilds (Priority: P2)

**As the** system operator,
**I want** the expense-tracker plugin to persist across `docker compose down && docker compose up --build`,
**So that** the plugin is not lost during routine deployments.

**Why this priority**: Without persistence, every rebuild would require manual re-installation. P2 because the immediate fix works without persistence, but long-term operation requires it.

**Independent Test**: Run `docker compose down && docker compose up --build`. Verify the plugin loads and all 21 tools are available without manual intervention.

**Acceptance Scenarios**:

1. **Given** the plugin source is bind-mounted into the gateway container and the one-time `openclaw plugins install` has been run, **When** the gateway starts (fresh build or restart), **Then** the plugin is auto-discovered and all tools load without additional manual steps.
2. **Given** a new deployment clones the repository, **When** `docker compose up` runs, **Then** the plugin is present and functional.

---

### US-4: SKILL.md References Typed Tools (Priority: P2)

**As the** Gateway agent reading the expense-tracker SKILL.md,
**I want** clear instructions to use typed tool calls instead of `exec curl`,
**So that** I never attempt to construct raw shell commands for expense-tracker operations.

**Why this priority**: The SKILL.md is the agent's instruction manual. Without updating it, the agent may still fall back to `exec curl` for undocumented tools.

**Independent Test**: Read `gateway/workspace/skills/expense-tracker/SKILL.md`. Verify it contains no `curl` references and instead lists tool names with their parameters.

**Acceptance Scenarios**:

1. **Given** the updated SKILL.md, **When** the agent reads it, **Then** it finds a "Tools" section listing `budget_`-prefixed tool names, descriptions, and key parameters — with no mention of `curl`, `exec`, or shell commands.
2. **Given** the agent processes a transaction email, **When** it follows the SKILL.md workflow, **Then** it calls `budget_fetch_accounts`, `budget_fetch_payees`, `budget_search_memory`, etc. as typed tools in parallel.

---

### US-5: Documentation Reflects the New Architecture (Priority: P3)

**As a** developer or operator reading the project documentation,
**I want** the design document and gateway baseline spec to reflect the plugin-based tool invocation pattern,
**So that** the documented architecture matches the actual system.

**Why this priority**: Documentation is important for maintainability but doesn't affect runtime behavior. P3 because the system works without doc updates.

**Independent Test**: Read `design.md` section 5 (expense-tracker) and `specs/001-gateway-baseline/spec.md`. Verify they describe plugin-based tool invocation, not `exec curl`.

**Acceptance Scenarios**:

1. **Given** the updated `design.md`, **When** a developer reads section 5, **Then** the architecture diagram shows the Gateway agent calling plugin tools (typed functions) rather than `exec curl`.
2. **Given** the updated gateway baseline spec, **When** a developer reads the skills section, **Then** it references the expense-tracker plugin as the tool invocation mechanism.

---

### Edge Cases

- **What happens when the expense-tracker container is down?** The plugin tool returns an HTTP error (connection refused). The agent reports the failure to the user. No shell-level errors or approval timeouts.
- **What happens when a tool receives unexpected parameters?** The expense-tracker API returns a 400/500 error. The plugin passes the error text through to the agent. Parameters are validated against TypeBox schemas before the HTTP call.
- **What happens if the plugin source has a syntax error?** The Gateway logs the plugin load failure at startup. Other plugins and skills are unaffected. The agent falls back to reporting "expense-tracker tools unavailable."
- **What happens with tools that take binary input (`budget_extract_pdf_text`)?** On the email path, `budget_extract_email_content` handles PDF attachments automatically — the agent never manually passes `pdf_bytes_b64`. On the Telegram path, the agent reads the PDF file and passes the raw bytes as a base64-encoded string in the `pdf_bytes_b64` parameter. The expense-tracker API handles base64 decoding internally.
- **What about `exec pdftotext` and `exec qpdf`?** These are **not replaced** by this feature. They are used for PDF decryption (`qpdf`) and local text extraction (`pdftotext`) as pre-processing steps before calling `budget_extract_pdf_text`. The `exec-approvals.json` allowlist entries for `pdftotext` and `qpdf` are retained. They are not expense-tracker API calls and do not suffer from the `| jq '.'` class of hallucination.

---

## Requirements

### Functional Requirements

- **FR-001**: The plugin MUST register all 21 expense-tracker REST endpoints as typed OpenClaw tools, each with a TypeBox parameter schema matching the existing API contract. All tool names MUST use the `budget_` prefix (e.g., `budget_fetch_accounts`) for LLM disambiguation. The prefix establishes a naming convention that future skill plugins (portfolio-tracker, image-gen) should follow.
- **FR-002**: Each tool MUST make a POST request to `http://expense-tracker:8080/tools/<hyphenated-name>` with a JSON body containing the tool parameters. The full tool-name-to-endpoint mapping is specified in US-2.
- **FR-003**: The plugin MUST be bind-mounted into the gateway container at a fixed path (e.g., `/home/node/plugins/expense-tracker-tools/`) so it survives container rebuilds.
- **FR-004**: The plugin MUST be enabled via the following `openclaw.json` configuration and loaded on Gateway startup:
  ```json5
  {
    "plugins": {
      "entries": {
        "expense-tracker-tools": { "enabled": true }
      }
    }
  }
  ```
- **FR-005**: The SKILL.md MUST be updated to remove all `exec curl` instructions and replace them with typed tool invocation guidance.
- **FR-006**: The SKILL.md MUST instruct the agent to call independent tools in parallel (e.g., `budget_fetch_accounts` + `budget_fetch_payees` + `budget_fetch_categories` together).
- **FR-007**: The `exec-approvals.json` allowlist MUST retain the `pdftotext` and `qpdf` entries (used for PDF decryption and local text extraction — not expense-tracker API calls). The `curl` entry MAY be retained for non-expense-tracker use but the SKILL.md MUST NOT reference it.
- **FR-008**: `design.md` MUST be updated: (a) section 5.4 tool count from 16 to 21, (b) section 5A.4 new tools table MUST include `check_statement_duplicate`, (c) architecture diagrams MUST show the Gateway agent calling plugin tools (typed functions) rather than `exec curl`.
- **FR-009**: `specs/001-gateway-baseline/spec.md` MUST be updated to reference the expense-tracker plugin in its skills architecture section.
- **FR-010**: The plugin source code MUST live at `gateway/plugins/expense-tracker-tools/` and be version-controlled in the repository.
- **FR-011**: Each tool's HTTP call MUST use the original endpoint name (e.g., `budget_fetch_accounts` -> `/tools/fetch-accounts`), independent of the OpenClaw tool name. Shortened OpenClaw names (e.g., `budget_fetch_unreconciled`) MUST map to the full hyphenated endpoint name (`/tools/fetch-unreconciled-transactions`).

### Key Entities

- **Plugin manifest** (`openclaw.plugin.json`): Declares the plugin identity (`expense-tracker-tools`), contracts (`tools: [...]` listing all 21 tool names), and activation (`onStartup: true`).
- **Plugin entry point** (`index.js`): Registers all 21 tools via `api.registerTool()`, each with a TypeBox parameter schema and an `execute` handler that makes an HTTP POST to the expense-tracker.
- **Tool schema**: Each registered tool has a `name`, `description`, `parameters` (TypeBox Object), and `execute` function. The Gateway agent sees these as structured function definitions in its tool catalog.
- **Bind mount**: A Docker volume mount in `docker-compose.yml` that maps `./plugins/expense-tracker-tools/` (host) to a path inside the gateway container, ensuring the plugin source persists across rebuilds.
- **SKILL.md**: The markdown instruction file at `gateway/workspace/skills/expense-tracker/SKILL.md` that teaches the Gateway agent how to use the expense-tracker tools.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: All 21 tools appear in `openclaw plugins inspect expense-tracker-tools --runtime --json` output with status `loaded`.
- **SC-002**: The Gateway agent completes an expense-tracking flow (email -> classify -> fetch accounts/payees/categories -> check duplicate -> insert -> notify) without any `exec` tool invocations — confirmed by gateway logs showing zero `exec.approval.*` events for expense-tracker operations.
- **SC-003**: Zero `exec curl` failures related to expense-tracker in gateway logs after migration (previously: 102+ `exec.approval.waitDecision` events in one incident).
- **SC-004**: `docker compose down && docker compose up --build` results in the plugin loading successfully with all 21 tools available, without manual `openclaw plugins install` commands.
- **SC-005**: The SKILL.md contains zero references to `curl`, `exec`, or shell commands.
- **SC-006**: A developer reading `design.md` can understand the tool invocation flow (Gateway agent -> plugin tool -> HTTP -> expense-tracker) without encountering `exec curl`.

---

## Non-Goals

- Changing the expense-tracker's internal API or adding new endpoints
- Replacing `exec pdftotext` or `exec qpdf` — these are PDF pre-processing tools, not expense-tracker API calls, and are not affected by the `| jq '.'` hallucination class
- Migrating the portfolio-tracker, image-gen, or ktmb-booking skills to plugin tools (separate features)
- Adding authentication between the plugin and expense-tracker (already on internal Docker network)
- Retrying failed HTTP calls within the plugin (the agent handles retry logic)
- Caching tool results (stateless tools, each call fetches live data)
- Publishing the plugin to ClawHub (internal use only)
- Adding the plugin to the `openclaw_home` named volume (bind-mount is simpler and version-controlled)

---

## Assumptions

- The expense-tracker container is reachable from the gateway container at `http://expense-tracker:8080` on the internal Docker network
- The expense-tracker's API uses POST with JSON bodies; tool names are hyphenated in URLs (e.g., `fetch-accounts` not `fetch_accounts`)
- The `openclaw` package's `plugin-sdk/plugin-entry` and `typebox` imports are available in the gateway container
- The Gateway's hot-reload mechanism will detect plugin source changes without a full restart
- The existing `exec-approvals.json` allowlist entries for `pdftotext` and `qpdf` are retained (not replaced by this feature)
- The plugin is a "non-capability" plugin (tool-only, no providers/channels/hooks)
- The Gateway agent (orchestrator) receives the plugin's tools in its tool catalog automatically when the plugin is enabled
