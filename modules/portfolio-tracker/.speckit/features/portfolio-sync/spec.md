# Feature Specification: Portfolio Performance Sync

**Feature:** portfolio-sync
**Spec Version:** 1.0.0
**Status:** Specified
**Constitution Hash:** v1.0.0

---

## Overview

An LLM-powered agent that manages a Portfolio Performance investment tracking file via a deterministic Java CLI bridge. The agent ingests data from multiple sources — IBKR flex queries, PDF receipts via Telegram, email alerts — and inserts structured transactions into Portfolio Performance. It also synchronizes budget allocations from Actual Budget into PP account balances and exports taxonomy data to Google Sheets.

The intelligence layer is a **DeepSeek LLM** (`deepseek-chat`). The Python host provides deterministic tools (OCR, XML parsing, Java CLI execution, Google Sheets API, Actual Budget API). A **Java CLI** built on PP's own model libraries handles all PP XML read/write safely.

---

## User Stories

### US-1: IBKR Flex Query Import

**As a** user who receives IBKR flex query XML reports,
**I want** the agent to parse the flex query, identify all transactions, match securities to PP's portfolio, handle multi-step confirmation screens, and insert trades,
**So that** monthly IBKR statements are imported without manual data entry.

**Acceptance Criteria:**
- Agent receives IBKR flex query XML (via Telegram file upload or email attachment)
- XML is parsed deterministically by Python — no LLM needed for XML parsing
- LLM reviews extracted transactions: identifies buys, sells, dividends, fees, withholding tax, deposits, withdrawals
- LLM matches each security ticker/ISIN against PP's existing securities list (fetched via Java CLI)
- If a security is not found, LLM notifies user with the ISIN/ticker and asks for confirmation before creating a new security
- Agent presents a confirmation summary to the user (via Telegram) for each transaction batch
- User can approve all, reject specific transactions, or request edits
- On approval, each transaction is inserted via Java CLI into PP XML
- Transaction types supported: Buy, Sell, Dividend, Deposit, Withdrawal, Fee, Tax, Interest
- Dedup prevents re-importing the same flex query report
- Multi-currency detected from flex query (base currency + trade currency)

---

### US-2: PDF Receipt via Telegram → Transaction

**As a** user who receives trade confirmation PDFs from brokers,
**I want** to forward the PDF to the Telegram bot and have the agent OCR it, extract trade details, match accounts/securities, and insert into PP,
**So that** I can log investment transactions from my phone without opening PP.

**Acceptance Criteria:**
- User sends a PDF file to the Telegram bot
- Agent receives PDF bytes, runs deterministic OCR (pytesseract + pdf2image)
- OCR text is sent to LLM for structured extraction: trade type, security name/ticker/ISIN, quantity, price, currency, date, broker, fees, total
- LLM calls `fetch_pp_accounts()` and `fetch_pp_securities()` to match deposit account and security
- If multiple matches found, LLM asks user to disambiguate (via Telegram)
- LLM calls `insert_pp_transaction()` via Java CLI for each extracted trade
- After successful insert, agent confirms via Telegram with transaction summary
- Handles multi-page PDFs (concat all pages before OCR)
- Handles image-based PDFs (scanned documents) and text-based PDFs
- Currency detection: LLM identifies currency from OCR text, maps to PP accounts by currency
- Edge case: PDF in unsupported language → notify user

---

### US-3: Email PDF/Text → Transaction

**As a** user who receives trade confirmations and account statements by email,
**I want** to forward them to the burner inbox and have the agent process them like Telegram PDFs,
**So that** email-based broker confirmations are automatically logged in PP.

**Acceptance Criteria:**
- Agent monitors burner inbox via IMAP IDLE (same Zoho infrastructure as expense-tracker)
- On new email: extract content — HTML body → plain text, PDF attachment → OCR
- Content sent to LLM for structured extraction (same pipeline as US-2)
- LLM matches accounts/securities via PP live data
- Transaction inserted via Java CLI, dedup checked
- On success, email marked as read
- On ambiguity, user notified (Telegram or email), email left unread
- Supported email formats: any broker trade confirmation, bank statement transaction, dividend notice
- Plain text emails (no PDF) handled directly without OCR

---

### US-4: Actual Budget → PP Balance Sync

**As a** user who maintains emergency funds (SGD + MYR) and a warchest (SGD) in PP,
**I want** the agent to query Actual Budget daily for allocated budget amounts and update PP account balances,
**So that** PP reflects the latest cash allocation without manual reconciliation.

**Acceptance Criteria:**
- Agent queries Actual Budget API: fetch categories "Emergency Fund SGD", "Emergency Fund MYR", "General Investment Fund" (or names configurable via .env)
- Agent extracts allocated amounts for the current/next month
- Agent calls Java CLI to update PP account balances:
  - `emergency-fund-sgd` account → SGD emergency fund amount
  - `emergency-fund-myr` account → MYR emergency fund amount
  - `warchest-sgd` account → SGD general investment fund amount
- Balance updates are recorded as PP "balance" transactions (not buy/sell)
- Timestamped — agent records when each balance was synced
- If any of the 3 categories are not found in Actual Budget, agent notifies user and skips that account (partial update)
- Currency consistency: SGD amounts → SGD PP accounts, MYR amounts → MYR PP accounts
- Scheduled to run daily (configurable cron via env var)

---

### US-5: Taxonomy → Google Sheets Daily

**As a** user who tracks investments by custom taxonomies (e.g., sector, geography, asset class),
**I want** the agent to query PP for holdings matching a configured taxonomy and update a Google Sheet daily,
**So that** I have a live dashboard of portfolio allocation.

**Acceptance Criteria:**
- Taxonomy names configurable in `.env` (e.g., `TAXONOMY_NAMES=Sector,Geography,Asset Class`)
- Agent queries PP via Java CLI: get all securities with taxonomy assignments
- Agent aggregates holdings by taxonomy value: market value, allocation %, count
- Agent calls Google Sheets API to update specified sheet/cell range
- Sheet ID and range configurable in `.env`
- Format: one sheet per taxonomy, with columns: Taxonomy Value | Market Value | Allocation % | # of Securities
- Daily scheduled run (configurable via env var)
- If Google Sheets API fails, retry 3x, then notify user
- Sheet structure preserved (don't overwrite user formatting if possible)

---

### US-6: Continuous Memory / Learning

**As a** user who wants the agent to improve over time,
**I want** the agent to learn from successful matches and user corrections,
**So that** ambiguous matches become automatic over time.

**Acceptance Criteria:**
- `learn_mapping()` tool persists learned associations to `data/mappings.json`
- Mappings types: `securities` (ticker/ISIN → PP security ID), `accounts` (keyword → PP account ID), `categories` (keyword → taxonomy value), `brokers` (broker name → PP account)
- On every successful match, agent calls `learn_mapping()` to record the association
- On user correction (via Telegram "that's wrong, use account X"), agent learns the corrected mapping
- Learned mappings are loaded into system prompt at startup (like expense-tracker)
- Dedup: learned mappings are json-serializable, human-readable
- Re-learn protection: if a mapping changes, the old one is overwritten

---

### US-7: Agent Persona & Telegram Interface

**As a** user who interacts with the agent primarily via Telegram,
**I want** the agent to be conversational, proactive, and clear in its communication,
**So that** the experience feels natural and trustworthy.

**Acceptance Criteria:**
- Agent responds to Telegram messages within 5 seconds for simple queries
- Agent persona: professional, concise, financially literate, but warm and human-like
- Agent proactively summarizes actions taken (e.g., "Imported 5 IBKR trades totaling S$12,450. 1 security (AAPL) was new — added to PP.")
- Agent asks clarifying questions when ambiguous (with emoji sparingly)
- Agent understands natural language quitting requests: "yes", "approve", "ok", "go ahead", "proceed", "confirm" → proceed with pending action
- Agent understands rejections: "no", "cancel", "stop", "skip", "reject" → abort pending action
- Agent supports these entry commands:
  - `/ibkr` — "send me your IBKR flex query XML file"
  - `/sync` — triggers Actual Budget → PP balance sync immediately
  - `/sheet` — triggers taxonomy → Google Sheets update immediately
  - `/status` — shows recent activity + current PP snapshot
  - `/help` — shows available commands

---

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| IBKR flex query with 0 transactions (empty period) | Agent reports "No transactions found" |
| PDF with multiple trades (e.g., buy + fee on same page) | LLM extracts each trade separately |
| PDF in unsupported language | Agent notifies user, does not attempt insert |
| Security found in PP but currency mismatch | LLM asks user which account to use |
| PP XML file locked by running PP application | Java CLI detects lock, agent tells user to close PP first |
| Same PDF sent twice (duplicate detection) | Dedup journal catches hash, agent reports "Already imported" |
| OCR produces garbled text | Agent detects low confidence, notifies user with OCR raw text |
| Actual Budget API returns 0 for all categories | Agent reports "All balances are 0 — may need review" |
| Google Sheets API quota exceeded | Agent notifies user, schedules retry for next window |
| Java CLI fails with unexpected error | Error captured and surfaced to LLM; LLM decides whether to retry or notify |
| Telegram file >50MB (Bot API limit) | Agent rejects with "File too large" message |
| Multiple Telegram users in group chat | Agent only responds to configured `TELEGRAM_CHAT_ID` |
| IBKR flex query contains delisted/invalid securities | LLM flags them, asks user whether to skip or create placeholder |

---

## Non-Goals (Explicitly Out of Scope)

- Direct PP GUI automation (only Java CLI + XML manipulation)
- Real-time WebSocket connection to PP (file-based only; PP must be closed during writes)
- Multi-tenancy (single user's PP file, Actual Budget, Google Sheet)
- Historical backfill beyond what the user manually triggers
- Tax calculation or P&L reporting (PP handles this natively)
- Stock price fetching (PP handles this)
- Bank API integration (only email/Telegram/IBKR XML ingestion)
- Web UI or dashboard (Google Sheets can be used as dashboard)
