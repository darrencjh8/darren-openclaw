# Technical Debt

Open items that cut across features or require architectural changes.

| Item | Priority | Est. |
|---|---|---|
| **Port to Node.js** — Consolidate expense-tracker + portfolio-tracker into a single Node.js service. `@actual-app/api` called directly in-process, eliminating the actual-api proxy layer entirely. Shrinks from 3 containers to 1. Single language, single test runner, single CI pipeline. Risk: regression from porting ~450 tests, IMAP IDLE reconnection semantics, OCR output differences (pytesseract vs tesseract.js). | P2 | 8-10h |
| **Portfolio tracker: integration tests for email pipeline** — No tests cover the full IMAP→dispatch→orchestrator→LLM→tools→notify flow end-to-end. All tests are unit-level with mocked dependencies. Add integration tests that: spin up express, mock IMAP responses, mock DeepSeek API, and verify the full pipeline produces expected tool calls and notifications. | P1 | 3-4h |
| **Portfolio tracker: orchestrator error path tests** — The try/catch around the LLM loop (added 2026-06-12) has no test coverage. Add tests for: LLM timeout mid-iteration, tool execution failure, extraction error fallback, and the `orchestrator_error` log path. | P1 | 1-2h |
| **Portfolio tracker: index.js startup tests** — No tests verify server startup behavior: IMAP enabled/disabled branching, missing config warning, route registration count. Currently only manually verified via production logs. | P2 | 1-2h |
| **Portfolio tracker: dispatchEmail safety-net tests** — The `notify_user` fallback on orchestrator error (added 2026-06-12) and the `portfolio_email_done` result logging have no test coverage. | P2 | 1h |
| **actual-api proxy exists** — The Python code talks to a Node.js proxy (`actual-api:3000`) because `@actual-app/api` is the only library with full read/write support for Actual Budget. The proxy handles multi-budget switching, retry with backoff, and crash resilience. Resolved by the Node.js port above. | — | — |
