# Agent Harness: Portfolio Performance Sync

**Module:** portfolio-tracker
**Agent Version:** 1.0.0
**Constitution Hash:** v1.0.0

---

## 1. Agent Identity

**Name:** Portfolio Tracker Agent
**Role:** Investment portfolio automation assistant
**Model:** `deepseek-chat` (via DeepSeek API)
**Communication:** Telegram (primary), Email (secondary, for trade confirmations)
**Persona:** Professional, concise, financially literate, warm and human-like. Uses occasional emojis.

---

## 2. Agent Persona Guidelines

### Tone
- **Professional but not cold.** Use clear financial terminology correctly but explain when needed.
- **Concise.** Summarize actions, don't narrate every step.
- **Proactive.** Volunteer information the user might care about (new securities added, large trades, unusual fees).
- **Human-like.** Vary responses, use natural language. Not robotic bullet points.

### Example Messages

**Transaction confirmation:**
> "Imported 5 IBKR trades totaling S$12,450 across 8 securities. 1 new security added — VWRA (IE00BK5BQT80). All fees accounted for ✅"

**Balance sync:**
> "PP balances synced from Actual Budget:
> SGD Emergency: S$50,000
> MYR Emergency: RM 30,000
> Warchest: S$120,000"

**Ambiguous match:**
> "Found 2 matches for 'AAPL' — Apple Inc. (USD) and AAPL (SGD-listed). Which account should these go to?
> 1. IBKR USD
> 2. IBKR SGD"

**Error:**
> "Couldn't process that trade confirmation — the OCR was garbled on pages 2-3. Can you send a clearer scan or type in the trade details?"

### Entry Commands
- `/ibkr` — prompts user to send IBKR flex query XML
- `/sync` — triggers Actual Budget → PP balance sync
- `/sheet` — triggers taxonomy → Google Sheets update
- `/status` — shows recent activity + current PP snapshot
- `/help` — shows available commands

---

## 3. Workflow State Machine

```
                     ┌────────────────────┐
                     │      IDLE          │
                     │ waiting for events  │
                     └────────┬───────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌─────────────┐   ┌──────────────┐   ┌────────────────┐
   │ Telegram Msg │   │  IMAP Email  │   │ Scheduler Fire │
   └──────┬──────┘   └──────┬───────┘   └───────┬────────┘
          │                  │                    │
          ▼                  ▼                    ▼
   ┌──────────────────────────────────────────────────────┐
   │  CLASSIFY INTENT                                     │
   │  - ibkr_flex_query                                   │
   │  - pdf_receipt                                       │
   │  - email_trade                                       │
   │  - balance_sync                                      │
   │  - taxonomy_export                                   │
   │  - command (/sync, /ibkr, etc.)                      │
   └──────────────────────┬───────────────────────────────┘
                          │
                          ▼
   ┌──────────────────────────────────────────────────────┐
   │  EXTRACT CONTENT (deterministic)                     │
   │  - parse_ibkr_flex_query → structured transactions   │
   │  - extract_pdf_text → OCR text                       │
   │  - extract_email_content → plain text                │
   └──────────────────────┬───────────────────────────────┘
                          │
                          ▼
   ┌──────────────────────────────────────────────────────┐
   │  LLM PROCESSING LOOP (max 7 iterations)              │
   │                                                      │
   │  ┌─────────────────────────────────────────────┐     │
   │  │ System prompt + few-shot + learned mappings  │     │
   │  │ + extracted content + tool schemas          │     │
   │  └──────────────────┬──────────────────────────┘     │
   │                     │                                │
   │                     ▼                                │
   │  ┌─────────────────────────────────────────────┐     │
   │  │ DeepSeek returns tool_calls                  │     │
   │  └──────────────────┬──────────────────────────┘     │
   │                     │                                │
   │                     ▼                                │
   │  ┌─────────────────────────────────────────────┐     │
   │  │ Python executes tools, returns results       │     │
   │  └──────────────────┬──────────────────────────┘     │
   │                     │                                │
   │                     └────  repeat until LLM decides ─│
   └──────────────────────────────────────────────────────┘
                          │
                ┌─────────┼─────────┐
                ▼         ▼         ▼
          ┌─────────┐ ┌──────┐ ┌────────┐
          │ INSERT  │ │ SKIP │ │ NOTIFY │
          └────┬────┘ └──┬───┘ └───┬────┘
               │         │         │
               ▼         │         ▼
          ┌────────┐     │    ┌──────────────┐
          │ mark   │     │    │ leave unread  │
          │ read   │     │    │ (email) /     │
          │ notify │     │    │ notify user   │
          │ learn  │     │    └──────────────┘
          └────────┘     │
               │         │
               ▼         ▼
          ┌────────────────────┐
          │  RETURN TO IDLE    │
          └────────────────────┘
```

---

## 4. Pending Confirmation Sub-state

For IBKR flex queries and multi-trade PDFs, the agent enters a "waiting for confirmation" state:

```
LLM calls ask_user_confirmation(summary, context)
  → Agent stores pending confirmation
  → Agent sends Telegram message with Approve/Reject options
  → User types "approve" or "reject"
  → Telegram handler routes to pending confirmation handler
  → If approved: LLM resumes processing, calls insert tools
  → If rejected: LLM logs skip, notifies user
  → If user edits: LLM receives correction, resumes with updated data
```

---

## 5. Scheduled Tasks

### Balance Sync (daily, 9 AM by default)
```
Scheduler fires
  → Orchestrator processes "balance_sync" event
  → LLM calls: fetch_actual_budget_categories(SGD) + fetch_actual_budget_categories(MYR)
  → LLM extracts category amounts
  → LLM calls: update_pp_balance for each of 3 accounts
  → Log results
```

### Taxonomy Export (daily, 10 AM by default)
```
Scheduler fires
  → Orchestrator processes "taxonomy_export" event
  → LLM calls: query_pp_taxonomies([names from env])
  → LLM calls: update_google_sheet for each taxonomy
  → Log results
```

---

## 6. Context Dump (Debug)

When the agent encounters an error, it can dump its full context for debugging:

```python
{
    "constitution_version": "1.0.0",
    "agent_version": "1.0.0",
    "config_masked": {
        "actual_budget_url": "https://...",
        "pp_xml_path": "/data/portfolio.xml",
        "pp_xml_exists": true,
        "java_cli_jar": "/app/pp-cli.jar",
        "java_cli_exists": true,
        "telegram_enabled": true,
        "email_enabled": false,
        "google_sheets_enabled": true,
        "scheduler_enabled": true
    },
    "learned_mappings": {
        "securities_count": 15,
        "accounts_count": 5,
        "categories_count": 8,
        "brokers_count": 3
    },
    "dedup_journal_size": 234,
    "last_sync_times": {
        "balance_sync": "2026-06-05T09:00:01Z",
        "taxonomy_export": "2026-06-05T10:00:02Z"
    },
    "pp_portfolio_summary": {
        "accounts": 8,
        "securities": 45,
        "holdings": 42,
        "total_market_value_sgd": 520000
    }
}
```

---

## 7. Learned Mappings Structure (data/mappings.json)

```json
{
    "securities": {
        "AAPL": "sec-uuid-apple",
        "US0378331005": "sec-uuid-apple",
        "apple": "sec-uuid-apple"
    },
    "accounts": {
        "IBKR": "acct-uuid-ibkr-sgd",
        "interactive brokers": "acct-uuid-ibkr-sgd",
        "saxo": "acct-uuid-saxo"
    },
    "categories": {
        "tech": "Technology",
        "financial": "Financials",
        "healthcare": "Healthcare"
    },
    "brokers": {
        "IBKR": "acct-uuid-ibkr-sgd",
        "SAXO": "acct-uuid-saxo"
    }
}
```

---

## 8. Environment-Specific Configuration

All paths and credentials come from environment variables (see plan.md Section 7). The agent harness is configuration-driven — no hardcoded paths, account IDs, or taxonomy names.
