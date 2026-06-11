# Feature Specification: IBKR Flex Query XML Import to PP

**Feature:** ibkr-import
**Spec Version:** 1.1.0
**Status:** Specified
**Constitution Hash:** v1.0.0

---

## Overview

Import IBKR trade, dividend, and corporate action data into Portfolio Performance by sending IBKR flex query XML files via Telegram or automated email (IMAP). The import must respect OneDrive as the source of truth — always pull the latest PP file before inserting, push changes back after insertion, and run a full balance sync to update Google Sheets.

Additionally, the portfolio-tracker module must use the OpenClaw gateway webhook for all user notifications instead of implementing its own Telegram sender.

---

## User Stories

### US-1: Parse IBKR Flex Query XML

**As a** user,
**I want** to send my IBKR flex query XML and have trades, cash transactions, and corporate actions parsed,
**So that** the raw XML is converted into structured transaction records ready for PP insertion.

**Acceptance Criteria:**
- Parser handles Trades (BUY/SELL), CashTransactions (Dividends, Interest, Fees, Tax, Deposits), CorporateActions (Dividends, Splits)
- Handles namespaced XML (`xmlns="..."`)
- Handles non-namespaced XML (actual IBKR flex query output)
- Empty sections (no trades, no cash transactions) return empty list without error
- Missing symbol/ISIN on a trade → trade is skipped (not inserted) and user is notified

### US-2: Ingest via Telegram

**As a** user,
**I want** to forward the IBKR flex query XML file to the Telegram bot and have it auto-processed,
**So that** I can import trade data from my phone without opening the PP desktop application.

**Acceptance Criteria:**
- Telegram handler accepts XML files (.xml)
- Gateway routes XML content as `ibkr_flex_query` event to portfolio-tracker
- LLM agent processes the XML and presents a confirmation summary to the user before inserting

### US-3: Ingest via Email (IMAP)

**As a** user,
**I want** IBKR to auto-forward flex queries to my burner inbox and have them processed automatically,
**So that** recurring flex query deliveries are imported without manual intervention.

**Acceptance Criteria:**
- IMAP IDLE handler monitors the correct folder (default: "Trades", configurable via `IMAP_FOLDER`)
- Emails containing IBKR flex query XML are routed to the orchestrator as `email_trade` events
- After processing, the email is marked as read

### US-4: Map IBKR symbols to PP securities

**As a** user,
**I want** IBKR trade symbols to be matched to existing PP securities by ISIN → ticker → name,
**So that** trades are automatically assigned to the correct security without manual lookup.

**Acceptance Criteria:**
- LLM resolves `security_id` for each parsed trade using available PP security data
- Match priority: ISIN (most reliable) → ticker symbol → name similarity
- Unmatched securities trigger a user notification (do not guess or auto-create)
- Learned mappings persist in `data/mappings.json` for future accuracy

### US-5: Insert trades into PP via Java CLI

**As a** user,
**I want** each parsed trade to be inserted into PP with correct type, price, shares, currency, fees, taxes,
**So that** my PP portfolio accurately reflects all IBKR trading activity.

**Acceptance Criteria:**
- `insert_pp_transaction` tool creates PP transactions via Java CLI
- Dedup check runs before each insert; duplicates are silently skipped
- Multi-currency trades route to the correct PP account (USD → IBKR USD, SGD → IBKR SGD)
- Fees and taxes from IBKR are included in the inserted transaction

### US-6: Pull latest PP from OneDrive before processing

**As a** user,
**I want** the LLM agent to always pull the latest `Portfolio.portfolio` from OneDrive before inserting IBKR trades,
**So that** I never overwrite a newer version of my portfolio with stale local data.

**Acceptance Criteria:**
- The IBKR flex query workflow calls `pp-pull` before fetching accounts/securities
- If pull fails (timeout, auth error), processing continues with the local file and a warning is logged
- The pull step is included in the SYSTEM_PROMPT workflow for both Telegram and email event paths

### US-7: Push changes and run full sync after insertion

**As a** user,
**I want** the modified PP file pushed back to OneDrive after IBKR trades are inserted, followed by a full `pp-sync-all`,
**So that** OneDrive has the latest data, balance targets are recalculated, and Google Sheets taxonomy is updated.

**Acceptance Criteria:**
- After all `insert_pp_transaction` calls succeed, `pp-push` is called to persist changes to OneDrive
- After `pp-push` succeeds, `pp-sync-all` is called to sync AB balances and export taxonomies
- If `pp-push` fails, the LLM notifies the user and does not call `pp-sync-all` (to avoid overwriting local changes)
- The push-then-sync sequence is included in the SYSTEM_PROMPT workflow

### US-8: Notifications via gateway webhook

**As a** user,
**I want** the portfolio-tracker to send user notifications through the OpenClaw gateway webhook,
**So that** all Telegram messages go through a single, consistent channel managed by the gateway.

**Acceptance Criteria:**
- `notify_user` tool posts to the gateway webhook URL (`OPENCLAW_GATEWAY_URL`) instead of using a custom Telegram sender
- The gateway relays the message to the user via its active Telegram bot connection
- The broken `_telegram_sender` callback pattern is removed from `tools.py`, `orchestrator.py`, and `email_handler.py`
- Email-triggered events can send notifications (previously broken because `notify_callback` was never set)
- Cron `pp-sync-all` sends a notification on **both** success and failure

---

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| OneDrive pull fails (timeout >30s) | Log warning, continue with local file |
| OneDrive push fails (HTTP 4xx/5xx) | Notify user, skip `pp-sync-all` to preserve local changes |
| `pp-sync-all` called without prior push | `pp-sync-all` pulls from OneDrive first → overwrites un-pushed local inserts — prevented by US-7 push-before-sync sequence |
| IMAP folder "Trades" does not exist | Log error, fall back to "INBOX" |
| Gateway webhook unreachable | Log error, `notify_user` returns failure status |
| Duplicate IBKR flex query (re-sent) | Dedup journal catches all duplicates; silently skipped |
| Multi-currency trades in same XML | Each trade routes to correct PP account by currency |
| Missing ISIN on a trade | LLM matches by ticker; if no match, user is notified |
| Empty flex query (no trades) | Parser returns empty list; user notified "no transactions found" |
| Confirmation timeout (user doesn't respond in 5 min) | Agent aborts without inserting |

---

## Non-Goals

- No PDF trade confirmation parsing (handled by email_trade flow separately)
- No CPF or POEMS statement ingestion
- No automated security creation (unmatched securities require user intervention)
- No manual PP XML editing — all writes go through Java CLI
- No direct Telegram Bot API calls from portfolio-tracker (gateway handles all channel communication)
