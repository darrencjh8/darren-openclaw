# Technical Debt

Open items that cut across features or require architectural changes.

| Item | Priority | Est. |
|---|---|---|
| **Port to Node.js** — Consolidate expense-tracker + portfolio-tracker into a single Node.js service. `@actual-app/api` called directly in-process, eliminating the actual-api proxy layer entirely. Shrinks from 3 containers to 1. Single language, single test runner, single CI pipeline. Risk: regression from porting ~450 tests, IMAP IDLE reconnection semantics, OCR output differences (pytesseract vs tesseract.js). | P2 | 8-10h |
| **actual-api proxy exists** — The Python code talks to a Node.js proxy (`actual-api:3000`) because `@actual-app/api` is the only library with full read/write support for Actual Budget. The proxy handles multi-budget switching, retry with backoff, and crash resilience. Resolved by the Node.js port above. | — | — |
