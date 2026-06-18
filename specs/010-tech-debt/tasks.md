# Tech Debt Tasks

**Status:** Open
**Migrated from:** 006-balance-sync, 008-cron-automation, 009-ibkr-import, 014-portfolio-tracker-fixes, 005-portfolio-balance-sync-cron

---

## From 006 — Balance Sync

### T5.3 — Integration Smoke Test Against Real Portfolio File
- [ ] Run pp-sync-all against real Portfolio.portfolio (requires PP_PASSWORD env var)
- **Why tech debt:** Test gap — feature works but untested against real data

### E1 — Budget API Down: Retry Backoff Test
- [ ] Test that Budget API down triggers retry with exponential backoff (already handled in `_fetch_budget`, needs test)
- **Why tech debt:** Code handles it, test missing

### E2 — PP File Corrupted: OneDrive Recovery Test
- [ ] Test auto-recovery from OneDrive when PP file is corrupted (already handled in `java_bridge.py`, needs test)
- **Why tech debt:** Code handles it, test missing

### E3 — OneDrive Refresh Token Expired Test
- [ ] Test that expired refresh token logs error and continues with local file (already handled, needs test)
- **Why tech debt:** Code handles it, test missing

### E4 — AB Category Not Found: Graceful Degradation
- [ ] When AB category is not found, report error for that account and continue with others (not yet handled)
- **Why tech debt:** Edge case, not blocking

### E5 — Consecutive Sync Runs: Idempotency Test
- [ ] Test that consecutive sync runs produce delta=0 on second run (ensure idempotent)
- **Why tech debt:** Test gap — idempotency assumed but not verified

### E6 — OneDrive Pull Timeout: Longer Timeout
- [ ] Add retry with longer timeout (60s) when OneDrive pull times out
- **Why tech debt:** Edge case hardening

---

## From 008 — Cron Automation

### T4.7 — Integration Test: Cron Triggers pp-sync-all
- [ ] End-to-end test verifying cron triggers pp-sync-all (requires all services running)
- **Why tech debt:** Test gap — requires full integration environment

---

## From 009 — IBKR Import

### T5.4 — Integration Test: Real IBKR Flex Query XML
- [ ] Integration test with real IBKR flex query XML → PP (requires real PP file + LLM)
- **Why tech debt:** Test gap — tested with mocks only

---

## From 014 — Portfolio Tracker Fixes

### T1.1 — Add imap_mailbox to Portfolio-Tracker Config
- [ ] `modules/portfolio-tracker/src/config.py`: Add `imap_mailbox: str = "INBOX"` field, read from `IMAP_MAILBOX` env var
- **Why tech debt:** Spec drift — duplicate of 011-email-pdf-routing T1.2

### T1.2 — Update EmailHandler to Use Mailbox Param
- [ ] `__init__()`: Accept `mailbox` param, `connect()`: use `self._mailbox`, `_process_email()`: add `mark_read`
- **Why tech debt:** Spec drift — duplicate of 011-email-pdf-routing T2.2

### T1.3 — Pass Mailbox from main.py
- [ ] Pass `mailbox=config.imap_mailbox` to EmailHandler constructor
- **Why tech debt:** Spec drift — duplicate of 011-email-pdf-routing T2.2

### T1.4 — Validate IMAP_MAILBOX in deploy.sh
- [ ] Add `IMAP_MAILBOX` to portfolio-tracker required vars in `modules/deploy.sh`
- **Why tech debt:** Spec drift — duplicate of 011-email-pdf-routing T1.3

### T2.1 — Update SYSTEM_PROMPT with Bookend Workflow
- [ ] `prompts.py`: Replace IBKR workflow steps with bookend pattern (pp-sync-all → insert → pp-push → pp-sync-all)
- **Why tech debt:** Workflow improvement on existing IBKR feature

### T2.2 — Update FEW_SHOT_EXAMPLES with Bookend Pattern
- [ ] Add pp-sync-all/pp-push calls to IBKR insertion examples
- **Why tech debt:** Workflow improvement, paired with T2.1

### T3.2 — Add Test for fetch_pp_securities
- [ ] Write test mocking Java bridge, verify valid JSON for empty/single/multi-item responses
- **Why tech debt:** Test gap — no test coverage for this path

### T4.1 — Filter Healthcheck from aiohttp Access Logs
- [ ] `main.py`: Add log filter suppressing `GET /health 200` entries
- **Why tech debt:** Minor noise reduction, low priority

---

## From 005 — Portfolio Balance Sync Cron

### T1.1 — Move Cron Scheduling to OpenClaw Gateway
- [ ] Migrate cron scheduling from internal apscheduler to OpenClaw gateway managed scheduling
- Gateway should invoke respective module APIs on a configurable schedule
- **Why tech debt:** Architectural improvement — centralized scheduling reduces per-module complexity and avoids duplicate scheduler instances

---

## Summary

| Source Spec | Items | Type |
|-------------|:-----:|------|
| 006-balance-sync | 7 | Test gaps + edge cases |
| 008-cron-automation | 1 | Missing integration test |
| 009-ibkr-import | 1 | Missing integration test |
| 014-portfolio-tracker-fixes | 8 | Spec drift + workflow fix + test gap + noise |
| 005-portfolio-balance-sync-cron | 1 | Architecture — move cron to gateway |
| **Total** | **20** | |
