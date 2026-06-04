# Feature Specification: Automated Expense Tracking

**Feature:** expense-tracking  
**Spec Version:** 1.0.0  
**Status:** Specified  
**Constitution Hash:** v1.0.0  

---

## Overview

An LLM-powered agent (OpenClaw) that monitors a dedicated Zoho burner inbox via IMAP IDLE. When a receipt or transaction alert email is forwarded to this inbox, the agent extracts structured transaction data and inserts it into the user's existing **Actual Budget** instance.

The intelligence layer is a **DeepSeek LLM** (`deepseek-chat`). The Python host provides 10 deterministic tools that the LLM calls to fetch live context and execute actions. No business rules (category mapping, account matching, currency detection) are hardcoded in Python.

---

## User Stories

### US-1: Real-Time Email Monitoring

**As a** user who receives transaction alerts by email,  
**I want** OpenClaw to detect new emails in the burner inbox in near-real-time,  
**So that** transactions appear in Actual Budget within seconds of the email arriving.

**Acceptance Criteria:**
- [ ] OpenClaw maintains a persistent IMAP IDLE connection to Zoho (`imap.zoho.com:993`)
- [ ] New emails are detected within 5 seconds of arrival
- [ ] If the IMAP connection drops, OpenClaw reconnects automatically and performs a catch-up fetch of any emails missed during the disconnection
- [ ] Each email is processed exactly once (idempotent via dedup)

---

### US-2: Intelligent Email Parsing via LLM

**As a** user who receives emails from multiple banks, payment apps, and merchants,  
**I want** OpenClaw to use an LLM to understand any email format without per-bank parser code,  
**So that** new senders and format changes don't require code changes.

**Acceptance Criteria:**
- [ ] Raw email content (HTML stripped to text; PDF attachments processed via OCR) is sent to DeepSeek
- [ ] The LLM extracts: amount, currency (SGD/MYR/other), merchant name, transaction date, and source account hints
- [ ] The LLM handles all common Singapore/Malaysia formats: DBS alerts, OCBC alerts, UOB alerts, Grab receipts, Shopee receipts, TNG eWallet alerts, Maybank alerts, generic forwarded receipts
- [ ] No bank-specific parser code exists in the Python layer
- [ ] If the LLM cannot confidently extract required fields, it calls `notify_user` instead of guessing

---

### US-3: Dual-Currency Budget Routing

**As a** user with SGD and MYR budgets in Actual Budget,  
**I want** OpenClaw to automatically route transactions to the correct budget based on currency,  
**So that** MYR expenses don't pollute the SGD budget and vice versa.

**Acceptance Criteria:**
- [ ] The LLM detects currency from the email content (explicit: "RM", "MYR", "SGD", "S$"; contextual: Malaysian merchants, Singaporean merchants)
- [ ] SGD transactions are routed to the `Darren-SGD-29ed82a` budget
- [ ] MYR transactions are routed to the corresponding MYR budget
- [ ] If currency is ambiguous or neither SGD nor MYR, the LLM calls `notify_user` and skips insertion
- [ ] The `notes` field on the Actual Budget transaction records the detected currency for audit

---

### US-4: Live Account Matching

**As a** user who may open, close, or rename accounts in Actual Budget,  
**I want** OpenClaw to always match transactions against the current list of accounts,  
**So that** renamed or new accounts work immediately without config changes.

**Acceptance Criteria:**
- [ ] The LLM calls `fetch_accounts` before matching any transaction
- [ ] Account matching is by name similarity (e.g., "DBS Yuu" in email → "DBS Yuu" in Actual Budget)
- [ ] If no clear account match exists, the LLM calls `notify_user` with available accounts listed
- [ ] No hardcoded account UUIDs or names exist in config or code

---

### US-5: Live Category Assignment

**As a** user who may restructure categories in Actual Budget,  
**I want** OpenClaw to assign categories based on the current category list and merchant context,  
**So that** category changes in Actual Budget are reflected immediately.

**Acceptance Criteria:**
- [ ] The LLM calls `fetch_categories` before assigning any category
- [ ] Category assignment is based on merchant context (e.g., "Toast Box" → "Food", "Grab" → "Transportation", "NTUC FairPrice" → "Household"/"Groceries")
- [ ] The LLM may leave `category` as `null` if uncertain — the user manually categorizes in Actual Budget
- [ ] No hardcoded category rules exist in config or code

---

### US-6: Duplicate Prevention

**As a** user who may accidentally forward the same email twice,  
**I want** OpenClaw to detect and skip duplicate transactions,  
**So that** my Actual Budget ledger stays clean.

**Acceptance Criteria:**
- [ ] Before insertion, a SHA-256 hash of `(date, amount_cents, account_id, imported_description)` is checked against a local SQLite journal
- [ ] If a duplicate is detected, the transaction is skipped and the email is marked as read without insertion
- [ ] The dedup check is a deterministic tool call — no LLM involvement
- [ ] The journal is persisted across restarts (SQLite file on Fly.io persistent volume)

---

### US-7: Notification for Ambiguous Emails

**As a** user who wants a clean Actual Budget ledger,  
**I want** OpenClaw to notify me when it cannot confidently process an email,  
**So that** I can manually review rather than having bad data silently inserted.

**Acceptance Criteria:**
- [ ] If the LLM detects unknown currency (not SGD, not MYR) → notification, no insert
- [ ] If the LLM cannot extract an amount → notification, no insert
- [ ] If the LLM cannot match an account → notification with available accounts listed, no insert
- [ ] If the LLM detects an actual error (API failure, network issue) → notification with error details
- [ ] Notifications are sent to the user's main email via SMTP
- [ ] The original email is left unread so the user can manually review it

---

### US-8: Idempotent Processing

**As a** user who wants the system to be robust,  
**I want** OpenClaw to be safe to restart at any time,  
**So that** crashes or redeploys don't cause duplicate or lost transactions.

**Acceptance Criteria:**
- [ ] Emails are marked as read (`\Seen` flag) only after successful transaction insertion
- [ ] Skipped emails (promos/spam) and uncertain emails remain unread — re-processed on restart
- [ ] On startup, OpenClaw fetches any unread emails and processes them
- [ ] The dedup journal prevents re-insertion of already-processed transactions
- [ ] If OpenClaw crashes mid-processing, the email remains unread and is re-processed on restart

---

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| Email with PDF receipt attachment | PDF → OCR via Tesseract → text sent to LLM. If OCR fails, notify user |
| Email with both SGD and MYR amounts | LLM detects ambiguity → notify user |
| Email from unknown sender | LLM attempts generic extraction. If confident, proceeds. If not, notifies user |
| Actual Budget API is down | Retry 3x with exponential backoff (1s, 2s, 4s). If all fail, leave email unread, notify user |
| DeepSeek API is down | Same retry strategy as above |
| Email body is base64-encoded | Extractors handle MIME decoding before LLM receives content |
| Email is a bank promo/ad (not a transaction) | LLM identifies it as non-transactional → skip, mark read, no insert |
| Two emails for the same transaction (e.g., SMS + email alert) | Dedup journal catches the duplicate → second one skipped |
| Amount in email includes thousands separator (e.g., "1,280.50") | LLM normalizes to numeric value |
| Email date is ambiguous (e.g., "03/04/2026" — is it March 4 or April 3?) | LLM uses the date format from Actual Budget's config (`dd/MM/yyyy`) as hint |

---

## Non-Goals (Explicitly Out of Scope)

- Multi-tenancy (only one user's Actual Budget instance)
- Direct bank API integration (only email-based ingestion)
- Mobile push notifications (email notification only)
- Web UI or dashboard
- Budget creation or account management (Actual Budget handles this)
- Historical email backfill beyond unread emails on startup
- Non-email sources (SMS, WhatsApp, bank APIs)