# Feature Specification: Balance Sync, Cron & Taxonomy Export

**Feature:** portfolio-sync-export
**Spec Version:** 3.0.0
**Status:** Done
**Constitution Hash:** v1.0.0

---

## Overview

A deterministic Python module that synchronizes Actual Budget target allocations to Portfolio Performance account balances. The module pulls the latest `Portfolio.portfolio` from OneDrive before making changes, computes balance deltas from AB budget data, updates 3 PP accounts (Emergency SGD, Emergency MYR, Warchest), pushes the updated file back to OneDrive, and exports PP taxonomies to Google Sheets (Regions (Liquid) → cells G2:G5, B4) with live FX conversion to SGD.

A cron scheduler (apscheduler) runs `pp-sync-all` daily at 3 AM SGT, fully automated. The cron expression is configurable via `PP_SYNC_ALL_CRON` env var.

Unlike the agent-driven portfolio-sync feature, this is an **LLM agent tool** (`pp-sync-all`) registered in the tool registry and invoked via the orchestrator — all logic is deterministic Python + Java CLI bridge with no LLM chat involvement.

---

## User Stories

### US-1: Pull latest PP file from OneDrive before sync

**As a** user,
**I want** `pp-sync-all` to download the latest `Portfolio.portfolio` from OneDrive before making changes,
**So that** I never overwrite a newer version with stale local data.

**Acceptance Criteria:**
- `onedrive_download.py` is called first using Microsoft Graph API
- Local PP file is overwritten with the downloaded version
- If download fails (timeout, auth error, network down), sync continues with the existing local file
- Download success/failure is logged

### US-2: Sync Actual Budget targets to PP accounts

**As a** user,
**I want** to sync my AB budget targets to 3 PP accounts,
**So that** PP reflects my actual cash allocation without manual reconciliation.

**Acceptance Criteria:**
- Emergency SGD account gets the SGD emergency budget amount
- Emergency MYR account gets the MYR emergency budget amount
- Warchest account gets the general investment fund amount
- All 3 accounts are updated in a single invocation
- Deltas are computed correctly (target minus current balance)
- Currencies match: SGD amounts to SGD accounts, MYR amounts to MYR accounts

### US-3: Push updated PP file back to OneDrive after sync

**As a** user,
**I want** the updated `Portfolio.portfolio` pushed back to OneDrive after sync,
**So that** my PP application (which reads from OneDrive) always sees the latest data.

**Acceptance Criteria:**
- `onedrive_upload.py` is called after all 3 balance updates succeed
- If push fails (rejection, timeout), the sync results are preserved locally and the failure is reported
- Push is idempotent — re-running push with the same file is safe

### US-4: Balance matches PP official UI

**As a** user,
**I want** the PP account balance calculation to match the PP official application UI,
**So that** numbers in synced accounts match what I see when I open PP.

**Acceptance Criteria:**
- Balance uses `AccountSnapshot.create()` with `isDebit()`/`isCredit()` transaction type classification
- The `portfolio` loop for net worth is NOT used for account-level balance
- Warchest balance is exactly 42,967.99 SGD
- Verified against PP 0.84.1 official UI

### US-5: One-shot invocation via the orchestrator

**As a** user,
**I want** to invoke `pp-sync-all` through the orchestrator,
**So that** the LLM agent can trigger a full pull → sync → push cycle on demand.

**Acceptance Criteria:**
- Invoked via the orchestrator tool registry as `pp-sync-all` (or triggered by cron scheduler which sends a `balance_sync` event)
- Phase 1: `onedrive_download.py` — pull latest from OneDrive
- Phase 2: Compute budget targets from AB and update 3 PP accounts
- Phase 3: `onedrive_upload.py` — push updated file to OneDrive
- Results summary printed to stdout with per-account delta and status

### US-6: Daily cron automation

**As a** user,
**I want** `pp-sync-all` to run automatically every day at 3 AM SGT,
**So that** balances stay in sync without manual intervention.

**Acceptance Criteria:**
- apscheduler AsyncIOScheduler runs within the portfolio-tracker process
- Default cron: `0 3 * * *` (configurable via `PP_SYNC_ALL_CRON` env var)
- Configurable via `PP_SYNC_ALL_CRON` env var
- Failed jobs log errors and don't crash the service
- Single consolidated job (replaces legacy balance_sync + taxonomy_export split)

### US-7: Taxonomy export to Google Sheets

**As a** user,
**I want** PP taxonomy data exported to Google Sheets with live FX conversion,
**So that** I can see portfolio allocation breakdowns in a spreadsheet.

**Acceptance Criteria:**
- Java CLI queries "Regions (Liquid)" taxonomy → per-classification native values with per-currency breakdown
- Python converts to SGD using live exchange rates from open.er-api.com
- Writes to configured cells: Investable Cash→B4, America→G2, Developed ex-US→G3, Emerging→G4, Crypto→G5
- Uses most-recent-price-≤-today from price history (not stale getLatest())
- Includes both Security market values AND Account balances for Investable Cash
- Handles weight-based proration via Assignment.getWeight()

### US-8: LLM-triggered taxonomy query

**As a** user chatting via Telegram,
**I want** to trigger taxonomy export on demand,
**So that** I can refresh the Google Sheet without waiting for cron.

**Acceptance Criteria:**
- `query_pp_taxonomies` tool available to LLM agent
- `update_google_sheet` tool writes values to arbitrary cells
- `taxonomy_export` event type in orchestrator for LLM-driven export

---

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| Pull timeout (>30s) | Log warning, continue with local file |
| Push rejection (HTTP 4xx/5xx) | Log error, sync results preserved locally |
| Budget API down (AB server unreachable) | Log error, exit without modifying PP |
| Zero budget data (all categories = 0) | Report "All balances are 0 — may need review", skip update |
| Negative starting balances | Handle correctly (e.g., overdraft in warchest) |
| PP file corrupted (unparseable XML) | Java CLI exits with error, no write attempted |
| OneDrive refresh token expired | Log error, prompt user to re-authenticate |
| AB category not found for one account | Skip that account, update remaining 2, report partial success |
| MYR/SGD currency mismatch | Reject update, log error, do not write incorrect currency |
| Consecutive sync runs (no budget change) | Delta = 0, balance re-set to same value (idempotent) |

---

## Non-Goals

- No LLM chat involvement — `pp-sync-all` is invoked via the orchestrator tool registry, but all logic is deterministic Python
- No Telegram/email notification (may be added later)
- No multi-user support
- No reconciliation of individual transactions (only balance-level sync)
- No IBKR or PDF ingestion
