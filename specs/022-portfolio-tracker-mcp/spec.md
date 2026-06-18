# Feature Specification: Portfolio Tracker MCP (Phase 1)

**Feature:** portfolio-tracker-mcp
**Spec Version:** 1.1.0
**Status:** Specified
**Created:** 2026-06-18
**Constitution Hash:** v4.0.0

---

## Overview

Add an MCP server to the portfolio-tracker module so Hermes Agent can trigger portfolio operations directly via MCP tool calls. Phase 1 exposes tools in three groups: **sync** (includes IBKR flex pull), **OneDrive auth** (interactive OAuth setup), and **OneDrive IO** (pull/push).

This follows the expense-tracker MCP pattern (spec 021): a thin SSE wrapper over existing tool logic. REST endpoints, IMAP IDLE, and the LLM orchestrator are all **preserved** — MCP is purely additive.

**Key design change from v1.0.0:** IBKR flex import is no longer a standalone MCP tool. Instead, `portfolio_sync` pulls the latest flex query XML from IBKR Flex Web Service (deterministic REST endpoint), imports it via the Java CLI's native `IBFlexStatementExtractor`, and then proceeds with the existing sync pipeline. The IMAP handler no longer processes IBKR flex emails — it only handles PDF trade confirmations.

---

## Use Cases

```mermaid
flowchart TB
    subgraph Triggers["Inbound Events"]
        CRON["Hermes Cron<br/>daily 3 AM SGT"]
        TG_SYNC["Telegram /sync"]
        TG_ONEDRIVE["Telegram /onedrive<br/>setup or pull/push"]
        IMAP["IMAP IDLE<br/>'Trades' folder<br/>PDF trade confirmations only"]
    end

    subgraph Hermes["Hermes Agent"]
        MCP_C["MCP Client"]
    end

    subgraph PT["Portfolio Tracker (Node.js)"]
        MCP_S["MCP Server<br/>GET /sse + POST /messages<span style='color:green'> (NEW)</span>"]
        REST["REST API<br/>19 /tools/*<br/>(unchanged)"]
        ORCH["LLM Orchestrator<br/>DeepSeek tool-call loop<br/>(unchanged — PDF only)"]
        TOOLS["Tool Registry<br/>(unchanged)"]
        IMAP_H["IMAP IDLE handler<br/>'Trades' folder<br/>(PDF only)"]
        SYNC["_computeSyncAll()<br/>flex pull → import → push → sync → taxonomy"]
        FLEX["IBKR Flex Web Service<span style='color:green'> (NEW)</span><br/>src/ibkr_flex.js"]
        OD["OneDrive Module<br/>src/onedrive.js<br/>Microsoft Graph API<br/>(unchanged)"]
    end

    subgraph External["External Systems"]
        MS["Microsoft Identity<br/>OAuth2 token endpoint"]
        GRAPH["Microsoft Graph<br/>OneDrive file API"]
        PP["Portfolio Performance<br/>via Java CLI bridge"]
        AB["Actual Budget<br/>via REST API"]
        GSHEETS["Google Sheets<br/>via Google API"]
        IBKR["IBKR Flex Web Service<br/>REST endpoint"]
    end

    CRON -->|"MCP: portfolio_sync()"| MCP_C
    TG_SYNC -->|"MCP: portfolio_sync()"| MCP_C
    TG_ONEDRIVE -->|"MCP: portfolio_onedrive_*"| MCP_C
    MCP_C <-->|"SSE transport"| MCP_S
    MCP_S -->|"portfolio_sync"| SYNC
    MCP_S -->|"portfolio_onedrive_*"| OD
    IMAP --> IMAP_H -->|"dispatchEmail()<br/>PDF only"| ORCH
    ORCH -->|"tool calls"| TOOLS
    TOOLS --> PP
    TOOLS --> AB
    TOOLS --> OD
    SYNC --> FLEX
    SYNC --> PP
    SYNC --> AB
    SYNC --> OD
    SYNC --> GSHEETS
    FLEX -->|"fetch flex XML"| IBKR
    OD <-->|"OAuth2"| MS
    OD <-->|"file operations"| GRAPH

    style MCP_S fill:#90EE90,stroke:#333
    style FLEX fill:#90EE90,stroke:#333
    style OD fill:#90EE90,stroke:#333
    style ORCH fill:#FFE4B5,stroke:#333
    style IMAP_H fill:#FFE4B5,stroke:#333
    style SYNC fill:#FFE4B5,stroke:#333
```

### Use Case 1: portfolio_sync (includes IBKR flex pull)

```
Trigger: Hermes cron (daily 3 AM SGT) OR Telegram /sync command
  → Hermes calls MCP tool portfolio_sync()
    → portfolio-tracker runs _computeSyncAll():
      1. OneDrive pull (latest Portfolio.portfolio)
      2. Fetch IBKR flex query XML from IBKR Flex Web Service
         → POST to IBKR endpoint with token + query ID
         → receive base64-encoded flex XML
      3. Import flex XML via Java CLI: java -jar pp-cli.jar import --ibkr-xml /tmp/ibkr.xml
         → PP native IBFlexStatementExtractor (same as PP desktop UI):
           a. Parse XML → trades, dividends, deposits, fees, interest, taxes, corp actions
           b. Match securities by CONID → ISIN → ticker + exchange suffix
           c. Auto-create missing securities
           d. Pair dividend taxes with dividends (post-processing)
           e. Handle currency conversion rates from XML
           f. Insert all items into Portfolio.portfolio
      4. Fetch AB budget targets (3 accounts)
      5. Update PP account balances via Java CLI
      6. OneDrive push (modified file back)
      7. Taxonomy export to Google Sheets
    → returns structured result to Hermes
```

**LLM orchestrator is NOT involved** — `_computeSyncAll()` is deterministic code. Flex fetch is REST-based.

### Use Case 2: OneDrive OAuth Setup (NEW)

```
Trigger: Hermes Telegram /onedrive setup command (first-time setup)
  → Hermes calls MCP tool portfolio_onedrive_auth_url()
    → returns { url: "https://login.microsoftonline.com/..." }
  → Hermes shows the URL to the user with instructions
  → User visits URL in browser, logs in, authorizes
  → Browser redirects to blank page
  → User copies the full redirect URL, sends it back via Telegram
  → Hermes extracts the authorization code from the URL
  → Hermes calls MCP tool portfolio_onedrive_auth_complete({redirect_uri: "..."})
    → exchanges code for refresh token
    → saves refresh token to ONEDRIVE_REFRESH_TOKEN_PATH on disk
    → returns { success: true }
  → Hermes confirms "OneDrive authorized! ✅"
```

**This is a one-time interactive setup** — after the refresh token is saved, all future
pulls and pushes are headless (token refresh via Microsoft Graph API).

### Use Case 3: Standalone OneDrive Pull/Push

```
Trigger: Hermes Telegram /onedrive pull (or push)
  → Hermes calls MCP tool portfolio_onedrive_pull() or portfolio_onedrive_push()
    → calls existing pullFromOneDrive() / pushToOneDrive() in src/onedrive.js
    → returns { success, path?, error? }
  → Hermes reports result to user
```

Useful for debugging or when the user only wants to sync the file without running the full balance sync.

---

## User Stories

### US-1: portfolio_sync via MCP (Priority: P1) 🎯 MVP

**As** Hermes Agent,
**I want** to call `portfolio_sync` via MCP to trigger the full one-shot sync cycle,
**So that** balances, IBKR trades, and taxonomies are all refreshed in a single call.

**Acceptance Criteria:**
- MCP tool `portfolio_sync` registered with no required parameters
- Internally calls the existing `_computeSyncAll()` pipeline, now extended with IBKR flex pull
- Pipeline: OneDrive pull → IBKR flex fetch → Java CLI import → AB sync → OneDrive push → taxonomy export
- Returns structured JSON with pull/push status, import results, sync targets, and taxonomy export result
- LLM orchestrator is NOT involved (deterministic code path)
- REST `/tools/pp-sync-all` endpoint remains functional

### US-2: IBKR Flex Web Service Pull (Priority: P1) 🎯 MVP

**As** the sync pipeline,
**I want** to pull the latest IBKR flex query XML from IBKR's Flex Web Service,
**So that** new trades are fetched automatically during sync without manual XML uploads.

**Acceptance Criteria:**
- New `src/ibkr_flex.js` module with a `pullFlexXml()` function
- POSTs to IBKR Flex Web Service endpoint with configured token + query ID
- Returns the flex XML response (base64-decoded if needed)
- Called from `_computeSyncAll()` between OneDrive pull and balance sync
- Handles network errors gracefully (non-fatal to sync — logs and continues)
- Config via env vars: `IBKR_FLEX_TOKEN`, `IBKR_FLEX_QUERY_ID`

### US-3: OneDrive OAuth Setup via MCP (Priority: P1) 🎯 MVP

**As** a user setting up portfolio-tracker for the first time,
**I want** Hermes to walk me through OneDrive OAuth authorization interactively via Telegram,
**So that** I don't need to SSH into the server or run shell scripts to authorize OneDrive.

**Acceptance Criteria:**
- `portfolio_onedrive_auth_url` returns the Microsoft OAuth URL (constructed from `ONEDRIVE_CLIENT_ID`)
- `portfolio_onedrive_auth_complete({redirect_uri})` extracts the authorization code from the redirect URL, exchanges it for a refresh token via `POST https://login.microsoftonline.com/common/oauth2/v2.0/token`, and saves it to `ONEDRIVE_REFRESH_TOKEN_PATH`
- Hermes orchestrates the interactive flow: URL → user visits → user pastes redirect → token saved
- After setup, `portfolio_onedrive_status` reports `{ authorized: true }`

### US-4: Standalone OneDrive Pull/Push (Priority: P2)

**As** a user who wants to manually sync the PP file,
**I want** to trigger OneDrive pull and push independently via MCP,
**So that** I can sync the file without running the full balance sync.

**Acceptance Criteria:**
- `portfolio_onedrive_pull` downloads latest `Portfolio.portfolio` from OneDrive (via Microsoft Graph API)
- `portfolio_onedrive_push` uploads the current local `Portfolio.portfolio` to OneDrive
- `portfolio_onedrive_status` reports whether OneDrive is configured and authorized
- All three use the existing `src/onedrive.js` functions (`pullFromOneDrive`, `pushToOneDrive`)

### US-5: Hermes MCP Registration (Priority: P1) 🎯 MVP

**As** the system operator,
**I want** portfolio-tracker's MCP server registered in Hermes configuration,
**So that** Hermes discovers and can invoke the portfolio tools.

**Acceptance Criteria:**
- `modules/hermes/config.yaml` lists `portfolio-tracker` under `mcp_servers:` with SSE transport
- Hermes auto-discovers all portfolio MCP tools
- MCP connection survives portfolio-tracker restarts (Hermes auto-reconnects)

### US-6: Cron via Hermes (Priority: P2)

**As** the system operator,
**I want** `portfolio_sync` triggered daily at 3 AM SGT via Hermes cron,
**So that** the sync schedule is managed in one place.

**Acceptance Criteria:**
- Hermes invokes `portfolio_sync` on schedule (configurable via `PP_SYNC_ALL_CRON`)
- Portfolio-tracker's internal apscheduler remains but can be deprecated later

### US-7: Telegram commands via Hermes (Priority: P2)

**As** a user on Telegram,
**I want** `/sync` and `/onedrive` commands routed through Hermes,
**So that** I can manage my portfolio without the OpenClaw gateway.

**Acceptance Criteria:**
- `/sync` → `portfolio_sync` (includes IBKR flex pull)
- `/onedrive setup` → interactive OAuth flow
- `/onedrive status` → `portfolio_onedrive_status`
- `/onedrive pull` → `portfolio_onedrive_pull`
- `/onedrive push` → `portfolio_onedrive_push`

### US-8: Backward Compatibility (Priority: P2)

**As** the system operator,
**I want** all existing functionality to remain intact alongside MCP.

**Acceptance Criteria:**
- All 19 REST `/tools/*` endpoints still work
- IMAP IDLE handler still monitors "Trades" folder (PDF trade confirmations only — IBKR flex is now pulled via web service)
- AgentOrchestrator and DeepSeek LLM loop continue to work (PDF only)
- Dedup journal and memory store unchanged

---

## What the LLM Orchestrator Does

The LLM orchestrator (`AgentOrchestrator.processEmail()`) handles **PDF trade confirmations only**.
IBKR flex processing is now done by PP's native `IBFlexStatementExtractor` via the Java CLI `import` command —
no LLM involvement. The orchestrator is preserved for:

| Step | What the LLM Decides |
|---|---|
| 1. Parse PDF | Extracts text from PDF trade confirmations via OCR |
| 2. Fetch context | Calls `fetch_pp_accounts` + `fetch_pp_securities` to get live PP data |
| 3. Match securities | LLM reasons over description text to find `security_id` |
| 4. Insert | Calls `insert_pp_transaction` for each matched trade (dedup-checked) |
| 5. Push + Sync | Calls `pp-push` + `pp-sync-all` |

---

## MCP Tool Reference

### Sync (includes IBKR flex pull)

| Tool | Params | Returns |
|---|---|---|
| `portfolio_sync` | none | `{pull, flex_import?, push, sync_targets, taxonomy_export, portfolio_status}` |

### OneDrive Auth

| Tool | Params | Returns |
|---|---|---|
| `portfolio_onedrive_auth_url` | none | `{url: string}` — Microsoft OAuth URL to visit |
| `portfolio_onedrive_auth_complete` | `redirect_uri: string` | `{success, error?}` — exchanges code for refresh token |
| `portfolio_onedrive_status` | none | `{authorized: boolean, token_path: string, client_id: string}` |

### OneDrive IO

| Tool | Params | Returns |
|---|---|---|
| `portfolio_onedrive_pull` | none | `{success, path?, error?}` — downloads from OneDrive |
| `portfolio_onedrive_push` | none | `{success, path?, error?}` — uploads to OneDrive |

---

## New Module: `src/ibkr_flex.js`

Fetches the latest IBKR flex query XML from the IBKR Flex Web Service REST endpoint.
This is a deterministic HTTP call — no LLM, no parsing, just fetch-and-return.

```
Environment variables:
  IBKR_FLEX_TOKEN      — IBKR Flex Web Service token (from Account Management)
  IBKR_FLEX_QUERY_ID   — The flex query ID to pull

Function:
  pullFlexXml() → returns { success: boolean, xml?: string, error?: string }
    → POST to https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService
       with parameters: t=<token>, q=<query_id>, v=3
    → IBKR responds with base64-encoded XML or a reference code requiring a second request
    → Returns the decoded XML string
```

---

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| OneDrive auth called when already authorized | `auth_url` still returns URL (can re-authorize); `auth_complete` overwrites existing token |
| `auth_complete` called with invalid/bad redirect URI | Returns `{success: false, error: "..."}` |
| `onedrive_pull` called before OAuth setup | Returns `{success: false, error: "refresh token not found"}` |
| MCP SSE connection drops mid-call | Hermes retries; portfolio-tracker handles same as REST timeout |
| IBKR Flex Web Service unreachable during sync | Logs warning, skips flex import, continues with balance sync + taxonomy |
| IBKR Flex Web Service returns no new trades | Import step returns `trades_imported: 0` — sync continues |
| Java CLI `import` with duplicate trades | PP native extractor handles dedup; returns `items_skipped > 0` |
| Hermes cron and apscheduler both trigger sync | Idempotent — delta = 0 if already synced |

---

## Non-Goals (Phase 1)

- ❌ Hermes handling email (email stays in portfolio-tracker's IMAP IDLE — PDF only)
- ❌ IMAP IDLE processing IBKR flex (now pulled via web service, not email)
- ❌ Removing the existing REST API
- ❌ Removing the IMAP IDLE handler
- ❌ Removing the LLM orchestrator
- ❌ Migrating memory to Hermes
- ❌ Adding CPF/POEMS tools via MCP
- ❌ `portfolio_ibkr_flex` as a standalone MCP tool (folded into `portfolio_sync`)

---

## References

- Hermes MCP Guide: https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes
- Spec 021: Hermes Migration (expense-tracker MCP pattern)
- Spec 007: IBKR Flex Query XML Import to PP
- Spec 005: Balance Sync, Cron & Taxonomy Export
- IBKR Flex Web Service: https://www.interactivebrokers.com/api/doc.html#tag/Flex-Web-Service
