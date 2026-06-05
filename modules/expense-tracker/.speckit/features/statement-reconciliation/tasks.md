# Implementation Tasks: Credit Card Statement Reconciliation

**Feature:** statement-reconciliation
**Tasks Version:** 2.0.0
**Status:** Tasked
**Constitution Hash:** v2.0.0

---

## Task Dependency Graph

```
Phase 0: Foundation (parallel)
  T0.1 (actual-api: /clear endpoint + GET filters)
  T0.2 (Statement journal SQLite class)
  T0.3 (Wire PDF extraction into extractors)
    │
Phase 1: Statement Tools
  T1.1 (Fuzzy matcher — fuzzy_match)
  T1.2 (Reconcile transaction tool — depends on T0.1)
  T1.3 (Fetch unreconciled txns tool — depends on T0.1)
  T1.4 (Record statement + fetch history tools — depends on T0.2)
  T1.5 (Register new tools + endpoints)
    │
Phase 2: Statement Agent
  T2.1 (Pre-classification prompt + statement prompt)
  T2.2 (StatementProcessor orchestrator — depends on T1.5, T2.1)
    │
Phase 3: Integration
  T3.1 (main.py: pre-classification + dispatch)
  T3.2 (Integration + classification tests)
  T3.3 (Full regression suite)
```

---

## Phase 0: Foundation

### T0.1 — actual-api: /clear Endpoint + GET Filters

**Priority:** P0 **Estimate:** 30m **Depends On:** None

- [ ] **RED** Write tests for `POST /transactions/:id/clear` and enhanced `GET /transactions`
  - Manual curl tests (actual-api has no test framework):
    - POST `/transactions/:id/clear` → 200 with `{ status: "cleared" }`
    - POST `/transactions/nonexistent/clear` → 404
    - GET `/transactions?cleared=false` → returns only uncleared txns
    - GET `/transactions?since_date=2026-05-01&until_date=2026-06-01` → date range filtering
    - Budget routing: GET `/transactions?budget_id=Darren+MYR` → switches to MYR budget
- [ ] **GREEN** Add `POST /transactions/:id/clear` to `gateway/actual-api/server.js`:
  - `ensureBudget(getBudgetId(req))`
  - `actual.getTransaction(req.params.id)` → 404 if not found
  - Append statement ref to notes, set `cleared: true`
  - `actual.updateTransaction(id, txn)`
- [ ] Add `cleared`, `since_date`, `until_date` query param support to existing `GET /transactions`

**Validation:** Manual curl test passes all 5 scenarios. Existing endpoints unchanged.

---

### T0.2 — Statement Journal SQLite Class

**Priority:** P0 **Estimate:** 45m **Depends On:** None

- [ ] Create `src/statement/__init__.py`, `tests/statement/__init__.py`
- [ ] **RED** Write `tests/statement/test_statement_journal.py`:
  - `test_journal_creates_tables` — `statement_journal` + `statement_transactions` exist
  - `test_record_statement_returns_id` — insert returns integer ID
  - `test_duplicate_period_rejected` — same (account, period_start, period_end) → UNIQUE violation
  - `test_check_processed_returns_record` — record → query → match
  - `test_check_processed_none_returns_none` — unrecorded period → None
  - `test_add_transaction_with_status` — insert with "reconciled" or "outlier"
  - `test_add_transaction_invalid_status` — invalid status → CHECK constraint error
  - `test_get_history_by_account` — all statements for account, newest first
- [ ] **GREEN** Implement `src/statement/journal.py`:
  - `StatementJournal(db_path: str)` — creates schema, thread-safe with lock
  - `record_statement(...)` — INSERT into `statement_journal`, return id
  - `check_processed(account_id, period_start, period_end) → dict | None`
  - `add_transaction(statement_id, date, description, amount_cents, status, ab_transaction_id, notes)` — INSERT into `statement_transactions`
  - `get_history(account_id) → list[dict]`

**Validation:** `pytest tests/statement/test_statement_journal.py -v` — 8 tests pass.

---

### T0.3 — Wire PDF Extraction

**Priority:** P0 **Estimate:** 20m **Depends On:** None

- [ ] **RED** Add tests to `tests/test_extractors.py`:
  - `test_pdf_attachment_extracted_via_ocr` — email with PDF attachment → OCR text in output
  - `test_pdf_and_text_mixed_email_extracts_both` — multipart/mixed text+PDF → both extracted
  - `test_pdf_ocr_unavailable_returns_marker` — Tesseract missing → `[PDF_OCR_UNAVAILABLE]`
- [ ] **GREEN** Add `elif content_type == "application/pdf":` branch in `extractors/__init__.py`:
  - Call `extract_pdf(payload)` from `pdf_extractor.py`
  - `clean_text()` the result, append to parts
  - Verify all existing tests still pass (new `elif`, no logic changes to existing branches)

**Validation:** `pytest tests/test_extractors.py -v` — 25 tests pass (22 existing + 3 new).

---

## Phase 1: Statement Tools

### T1.1 — Fuzzy Matcher

**Priority:** P1 **Estimate:** 45m **Depends On:** None

- [ ] **RED** Write `tests/statement/test_statement_matcher.py`:
  - `test_exact_amount_returns_high_score` — same amount → ≥80
  - `test_amount_within_tolerance_returns_medium_score` — ±20c → 50
  - `test_date_same_day_adds_bonus` — +30 for exact date
  - `test_date_within_2_days_adds_smaller_bonus` — +15 for ±2d
  - `test_merchant_overlap_adds_bonus` — "Toast Box" vs "toast box singapore" → +20
  - `test_score_below_threshold_excluded` — score < 50 → not in results
  - `test_returns_top_3_sorted` — 5 candidates → top 3, descending
  - `test_no_matches_returns_empty_list` — zero candidates → `[]`
  - `test_whitespace_and_case_normalized` — "  Toast Box  " vs "toast box"
- [ ] **GREEN** Implement `src/statement/matcher.py`:
  - `fuzzy_match(stmt_date, stmt_amount_cents, stmt_description, uncleared_txns) → list[dict]`
  - Amount score: exact=80, ±20=50
  - Date score: exact=30, ±2d=15
  - Merchant score: Jaccard token overlap > 0.5 → +20
  - Threshold: 50, top 3, sorted descending

**Validation:** `pytest tests/statement/test_statement_matcher.py -v` — 9 tests pass.

---

### T1.2 — Reconcile Transaction Tool

**Priority:** P1 **Estimate:** 30m **Depends On:** T0.1

- [ ] **RED** Write `tests/statement/test_statement_tools.py::TestReconcileTransaction`:
  - `test_reconcile_calls_clear_endpoint` — mock aiohttp, verify POST to `/clear`
  - `test_reconcile_passes_statement_ref` — statement_ref in body
  - `test_reconcile_not_found_returns_error` — mock 404 → error dict
  - `test_reconcile_no_statement_ref_works` — empty statement_ref, still 200
- [ ] **GREEN** Add to `src/agent/tools.py`:
  - `_handle_reconcile_transaction(ab_transaction_id, statement_ref="", budget_id="") → dict`
  - POST `{ACTUAL_API_URL}/transactions/{id}/clear` with `{ notes: statement_ref }`
  - Return response JSON or error dict

**Validation:** `pytest tests/statement/test_statement_tools.py::TestReconcileTransaction -v` — 4 tests pass.

---

### T1.3 — Fetch Unreconciled Transactions Tool

**Priority:** P1 **Estimate:** 30m **Depends On:** T0.1

- [ ] **RED** Write `tests/statement/test_statement_tools.py::TestFetchUnreconciled`:
  - `test_fetch_unreconciled_adds_cleared_false_param` — mock verifies `cleared=false` in URL
  - `test_fetch_unreconciled_sends_date_range` — mock verifies `since_date`/`until_date`
  - `test_fetch_unreconciled_returns_filtered_list` — mock returns only uncleared
  - `test_fetch_unreconciled_api_error_returns_error` — mock 500 → error dict
- [ ] **GREEN** Add to `src/agent/tools.py`:
  - `_handle_fetch_unreconciled_transactions(account_id, date_from, date_to, budget_id="") → list`
  - GET `{ACTUAL_API_URL}/transactions?account_id=X&cleared=false&since_date=Y&until_date=Z`

**Validation:** `pytest tests/statement/test_statement_tools.py::TestFetchUnreconciled -v` — 4 tests pass.

---

### T1.4 — Record Statement + Fetch History Tools

**Priority:** P1 **Estimate:** 30m **Depends On:** T0.2

- [ ] **RED** Write `tests/statement/test_statement_tools.py::TestRecordStatement`:
  - `test_record_statement_inserts_journal_row` — call → journal has entry
  - `test_record_statement_returns_id` — response includes statement id
  - `test_record_statement_duplicate_raises` — same period twice → error
- [ ] Write `tests/statement/test_statement_tools.py::TestFetchStatementHistory`:
  - `test_fetch_history_returns_record` — after record → query match
  - `test_fetch_history_no_record_returns_null` — unrecorded → None
- [ ] **GREEN** Add to `src/agent/tools.py`:
  - `_handle_record_statement(account_id, period_start, period_end, matched_count, outlier_count, ...) → dict`
  - `_handle_fetch_statement_history(account_id, period_start, period_end) → dict | None`

**Validation:** `pytest tests/statement/test_statement_tools.py::TestRecordStatement tests/statement/test_statement_tools.py::TestFetchStatementHistory -v` — 5 tests pass.

---

### T1.5 — Register New Tools + Endpoints

**Priority:** P1 **Estimate:** 20m **Depends On:** T1.2, T1.3, T1.4

- [ ] Add 4 tool schemas to `_TOOLS` list in `src/agent/tools.py` (schemas from plan.md §5)
- [ ] Add 4 routes to `src/tools_api.py`:
  - `/tools/reconcile-transaction`, `/tools/fetch-unreconciled-transactions`
  - `/tools/record-statement`, `/tools/fetch-statement-history`
- [ ] Update `tests/test_tools.py::test_registry_returns_10_schemas` → `test_registry_returns_15_schemas`
- [ ] Update `tests/test_integration.py::test_all_11_endpoints_accept_post` → `test_all_15_endpoints_accept_post`

**Validation:** `pytest tests/test_tools.py tests/test_integration.py -v` — 19 tests pass with updated counts.

**Regression check:** `pytest tests/ -v` — all 60+ existing tests still pass.

---

## Phase 2: Statement Agent

### T2.1 — Statement Prompts

**Priority:** P0 **Estimate:** 20m **Depends On:** None

- [ ] Create `src/statement/prompts.py`:
  - `CLASSIFICATION_PROMPT` — plan.md §8.1 (flash, single-word response)
  - `STATEMENT_PROMPT` — plan.md §8.2 (v4-pro, full reconciliation instructions)
  - `STATEMENT_FEW_SHOT` — 2 examples:
    1. 3 txn statement, 2 matched + 1 outlier → reconcile + insert → notify
    2. Duplicate period → fetch_statement_history returns record → stop
- [ ] Validation: `python -c "from src.statement.prompts import STATEMENT_PROMPT; assert 'reconcile' in STATEMENT_PROMPT.lower()"`

---

### T2.2 — StatementProcessor Orchestrator

**Priority:** P0 **Estimate:** 1.5h **Depends On:** T1.5, T2.1

- [ ] **RED** Write `tests/statement/test_statement_orchestrator.py`:
  - `test_process_statement_happy_path_3_txns` — 2 matched (reconciled), 1 outlier (inserted)
  - `test_process_statement_all_outliers_new_card` — 0 uncleared txns, all inserted as outliers
  - `test_process_statement_duplicate_period` — history returns record → stop
  - `test_process_statement_max_iterations_exceeded` — loops >20 → error → mark_read
  - `test_process_statement_notifies_and_marks_read_on_success` — verify notify_user + mark_email_read
  - `test_process_statement_notifies_and_marks_read_on_failure` — exception → notify + mark_read
  - `test_process_statement_uses_v4_pro_model` — verify DeepSeekClient constructed with v4-pro
- [ ] **GREEN** Implement `src/statement/orchestrator.py`:
  - `StatementProcessor(config, tools, llm_client)`
  - `async process_statement(msg_id, raw_email, imap_handler) → dict`
    - Extract email content (text or PDF OCR)
    - Build conversation with STATEMENT_PROMPT + few-shot
    - LLM loop (max 20 iter) with v4-pro model
    - Always `mark_email_read()` at end
    - Return `{ action, matched, outliers, details }`
  - LLM client constructed as `DeepSeekClient(config, model="deepseek-v4-pro")`
  - On any exception → `notify_user` + `mark_email_read` + log error

**Validation:** `pytest tests/statement/test_statement_orchestrator.py -v` — 7 tests pass.

---

## Phase 3: Integration

### T3.1 — main.py: Pre-classification + Dispatch

**Priority:** P0 **Estimate:** 45m **Depends On:** T2.2

- [ ] Add `_classify_email(email_text, subject, sender) → str` to `src/main.py`:
  - Sends single LLM call (flash model, no tools) with CLASSIFICATION_PROMPT
  - Includes: Subject + From + first 2000 chars of body
  - Returns: `"transaction"` | `"statement"` (defaults to `"transaction"` on error)
- [ ] Initialize `StatementProcessor` in `main()`:
  - `StatementJournal` with `data/statement.db`
  - `StatementProcessor(config, tools, deepseek_v4_pro_client)`
- [ ] Modify `on_new_email`:
  ```python
  async def on_new_email(msg):
      email_text = extract_content_from_raw_email(msg["raw_email"])
      classification = await _classify_email(
          email_text, msg.get("subject", ""), msg.get("from", "")
      )
      if classification == "statement":
          await statement_processor.process_statement(msg["msg_id"], msg["raw_email"], imap_handler)
      else:
          await orchestrator.process_email(msg["msg_id"], msg["raw_email"], imap_handler)
  ```
- [ ] Create `data/statement.db` directory on startup (same pattern as dedup.db)

**Validation:** Manual integration. Test suite covers `_classify_email` via `tests/statement/test_statement_classification.py`.

---

### T3.2 — Integration + Classification Tests

**Priority:** P1 **Estimate:** 45m **Depends On:** T3.1

- [ ] Write `tests/statement/test_statement_classification.py`:
  - `test_classify_statement_pdf` — statement text → "statement"
  - `test_classify_single_transaction` — "S$12.80 at Toast Box" → "transaction"
  - `test_classify_promo_email` — promo text → "transaction"
  - `test_classify_empty_falls_back_to_transaction` — empty text → "transaction"
  - `test_classify_api_error_defaults_to_transaction` — LLM error → "transaction"
- [ ] Write `tests/statement/test_statement_integration.py`:
  - `test_statement_classification_dispatches_correctly` — "statement" → StatementProcessor
  - `test_transaction_classification_dispatches_correctly` — "transaction" → AgentOrchestrator

**Validation:** `pytest tests/statement/ -v` — all ~35 statement tests pass.

---

### T3.3 — Full Regression Suite

**Priority:** P0 **Estimate:** 20m **Depends On:** All

- [ ] Run `pytest tests/ -v -m "not integration"`
- [ ] Verify ALL existing tests pass:
  - `test_dedup.py` — 11 tests (unchanged)
  - `test_extractors.py` — 25 tests (22 existing + 3 new PDF)
  - `test_tools.py` — 12 tests (renamed schema counts)
  - `test_agent_orchestrator.py` — 6 tests (unchanged)
  - `test_imap_notifier.py` — 16 tests (unchanged)
  - `test_config.py` — 9 tests (unchanged)
  - `test_logging.py` — 10 tests (unchanged)
  - `test_integration.py` — 7 tests (renamed endpoint counts)
  - `test_setup_validation.py` — 30+ tests (unchanged)
  - `tests/statement/` — ~35 new tests
  - **Total:** ~170 tests, 0 failures

**Intentional changes only:**
- `test_registry_returns_10_schemas` → `test_registry_returns_15_schemas`
- `test_all_11_endpoints_accept_post` → `test_all_15_endpoints_accept_post`

---

## Execution Sequence

| Order | Task | Can Parallelize |
|---|---|---|
| 1 | T0.1 (actual-api endpoints) | T0.2, T0.3 |
| 2 | T0.2 (Statement journal) | T0.1, T0.3 |
| 3 | T0.3 (Wire PDF extraction) | T0.1, T0.2 |
| 4 | T1.1 (Fuzzy matcher) | — |
| 5 | T1.2 (Reconcile tool) | After T0.1 |
| 6 | T1.3 (Fetch unreconciled) | After T0.1 |
| 7 | T1.4 (Record/history tools) | After T0.2 |
| 8 | T1.5 (Register tools) | After T1.2, T1.3, T1.4 |
| 9 | T2.1 (Prompts) | — |
| 10 | T2.2 (Orchestrator) | After T1.5, T2.1 |
| 11 | T3.1 (main.py dispatch) | After T2.2 |
| 12 | T3.2 (Integration tests) | After T3.1 |
| 13 | T3.3 (Regression suite) | After all |

---

## Total Estimated Effort

| Phase | Tasks | Estimate |
|---|---|---|
| Foundation | 3 | 1h 35m |
| Tools | 5 | 2h 35m |
| Agent | 2 | 1h 50m |
| Integration | 3 | 1h 50m |
| **Total** | **13** | **~7.8 hours** |
