# Implementation Tasks: Balance Sync, Cron & Taxonomy Export

**Feature:** portfolio-sync-export
**Tasks Version:** 3.0.0
**Status:** Implemented
**Constitution Hash:** v1.0.0

---

## Phase 1: Foundation
- [x] T1.1 Java CLI balance command (PpClient.java updateBalance)
- [x] T1.2 Java CLI accounts command (list PP accounts)
- [x] T1.3 Fix balance formula to match PP UI (isDebit/isCredit, remove portfolio loop)

## Phase 2: OneDrive Integration
- [x] T2.1 onedrive_download.py (Microsoft Graph API download)
- [x] T2.2 onedrive_upload.py (Microsoft Graph API upload)
- [x] T2.3 PP_PASSWORD env var for encrypted .portfolio files
- [x] T2.4 pp-pull and pp-push methods in Java bridge (OneDrive sync via java_bridge.py)
- [x] T2.5 Auto pull before sync, auto push after sync

## Phase 3: Balance Sync
- [x] T3.1 _compute_sync_all method (fetch budgets + update 3 accounts)
- [x] T3.2 AB budget API client (actual-api:3000/budget-12m)
- [x] T3.3 Handle zero budget data
- [x] T3.4 Handle negative starting balances
- [x] T3.5 Pull failure doesn't block sync (continues with local file)
- [x] T3.6 Push failure reported but sync results preserved

## Phase 4: Tests
- [x] T4.1 PpClientUpdateBalanceTest.java (8 tests, all pass)
- [x] T4.2 PpClientUpdateBalanceEdgeTest.java (18 tests, all pass)
- [x] T4.3 test_pp_sync_all.py (13 tests, all pass)
- [x] T4.4 test_bridge.py (all pass)
- [x] T4.5 test_balance_sync.py (all pass)

## Phase 5: Docker
- [x] T5.1 pp-cli.jar in Docker image (COPY pp-cli/target/pp-cli.jar)
- [x] T5.2 portfolio-tracker service in gateway/docker-compose.yml
> **Migrated to specs/015-tech-debt/tasks.md:** T5.3, E1, E2, E3, E4, E5, E6

## Phase 6: Cron Automation
- [x] T6.1 apscheduler AsyncIOScheduler setup in main.py
- [x] T6.2 pp-sync-all cron job — default `0 3 * * *`
- [x] T6.3 Configurable cron via env var PP_SYNC_ALL_CRON
- [x] T6.4 Programmatic execution (tool_registry._compute_sync_all(), no LLM)
- [x] T6.5 Single consolidated job replaces legacy balance_sync + taxonomy_export
- [x] T6.6 Scheduler logs all job executions via logger("scheduler")
- [x] T6.7 Failed jobs don't crash the service
- [x] T6.8 Unit tests: scheduler starts, default cron, custom cron, calls _compute_sync_all, failure notification, parse_cron
- [ ] T6.9 Integration test: cron triggers pp-sync-all end-to-end → **Migrated to specs/015-tech-debt/tasks.md**

---

## Phase 7: Taxonomy Export
- [x] T7.1 taxonomy command in PpClient.java (queryTaxonomies, tree aggregation, weight proration)
- [x] T7.2 Native-currency values per classification with per-currency breakdown
- [x] T7.3 Most-recent-price from price history (not stale getLatest)
- [x] T7.4 Include Account balances for cash classifications
- [x] T7.5 Google Sheets client with update_range and service account auth
- [x] T7.6 Live FX conversion from open.er-api.com to SGD
- [x] T7.7 Sheet mapping configurable via TAXONOMY_SHEET_MAPPING env var
- [x] T7.8 query_pp_taxonomies and update_google_sheet tools for LLM agent
- [x] T7.9 taxonomy_export event type in orchestrator
- [x] T7.10 Programmatic export in _compute_sync_all (Step 4)
- [x] T7.11 Java unit tests: price selection, per-currency breakdown, weight proration, account balances
- [x] T7.12 Python unit tests: skip conditions, mapping, unmapped, failure handling
- [x] T7.13 Integration: real PP to test sheet (verified by user)

## Phase 8: Test Bugs
- [x] B7.1 Fix test_agent_orchestrator.py: FakeDeepSeekClient missing override_model param and _balance_sync_model attribute (fixed)

---

## Validation Checkpoints

### Checkpoint Alpha: Unit Tests
- Python: `pytest tests/test_pp_sync_all.py tests/test_bridge.py tests/test_balance_sync.py -v` — all pass
- Java: `mvn test -f pp-cli/pom.xml -Dtest=PpClientUpdateBalanceTest,PpClientUpdateBalanceEdgeTest` — all pass

### Checkpoint Beta: Edge Tests
- `pytest tests/test_balance_sync.py -v` — all pass including zero data, negative balances, pull failure

### Checkpoint Gamma: Integration Against Real File
- `pp-sync-all` runs against real Portfolio.portfolio (requires OneDrive + PP_PASSWORD)
- Warchest balance verified at 42,967.99 SGD in PP official UI
