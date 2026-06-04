# Project Constitution

**Project:** darren-openclaw — OpenClaw Expense Tracking Agent  
**Version:** 2.0.0  
**Last Amended:** 2026-06-05  
**Workflow:** Spec-Kit (Spec-Driven Development)

---

## 1. System Identity

OpenClaw is an **LLM-powered expense-tracking agent** that reacts to receipt/transaction emails forwarded to a dedicated burner inbox. It extracts structured transaction data and inserts it into an existing **Actual Budget** instance via its REST API.

The intelligence layer is a **DeepSeek LLM agent** — the Python host provides deterministic tools (IMAP, Actual Budget API, dedup, notification). All parsing, classification, matching, and decision-making is delegated to the LLM.

---

## 2. Non-Negotiable Architecture Principles

### 2.1 Memory Constraint: 150MB RAM Target

- The expense-tracker container runs on Ubuntu laptop via Docker Compose, targeting ~150MB RAM.
- Python 3.12-slim base image. No heavyweight ORMs, no async frameworks that spawn thread pools.
- Single-process architecture: one IMAP IDLE connection, one LLM conversation at a time.
- Dependencies: `aiohttp`, `aioimaplib`, `beautifulsoup4`, `openai` (DeepSeek-compatible client), `pytesseract` (optional, for PDF).
- Tesseract binary only included if PDF parsing is enabled.

### 2.2 Security Isolation

- **Networking:** The expense-tracker container accesses Actual Budget via HTTPS over the public internet with API authentication (`ACTUAL_BUDGET_PASSWORD`).
- **Docker network isolation:** The expense-tracker container is only accessible within the Docker Compose network. The gateway container communicates with it via HTTP on the internal Docker network.
- **Secrets management:** All credentials (DeepSeek API key, IMAP password, Actual Budget password, notification SMTP credentials) are injected via environment variables. Never committed to source control. `.env` file is `.gitignore`d.
- **No database exposure:** The SQLite dedup journal is local to the expense-tracker container. Actual Budget's database is never accessed directly — only via its REST API.
- **Burner email isolation:** The Zoho burner inbox is a dedicated, isolated account. Compromise of this inbox does not expose any other services.

### 2.3 Data Integrity

- **Dual-currency:** The system supports SGD and MYR budgets (separate budget files in Actual Budget). Currency is detected by the LLM from email content. Unknown currencies are rejected and trigger a notification.
- **Duplicate prevention:** Every transaction is hashed via SHA-256 over `(date, amount_cents, account_id, imported_description)` before insertion. The hash is checked against a local SQLite dedup journal. Transactions that already exist are skipped silently.
- **Idempotency:** The pipeline is safe to re-run. IMAP emails are marked as read (`\Seen`) only after successful insertion. If the process crashes, unprocessed emails are re-fetched.
- **No silent failures:** If the LLM cannot confidently parse an email (ambiguous currency, unknown merchant, missing amount), it calls the `notify_user` tool and skips insertion. Bad data is never pushed to Actual Budget.

### 2.4 LLM Agent Principles

- **No hardcoded business rules in Python.** Category assignments, account matching, currency detection — all performed by the LLM using live data fetched from Actual Budget's API.
- **Tools, not code.** The Python layer exposes 10 deterministic tools (see Plan). The LLM chooses which to call and in what order.
- **Auditability.** Every LLM decision is logged as structured JSON (tool calls, reasoning, final action). The dedup journal stores the `msg_id` of the source email.
- **Fallback safety:** If the DeepSeek API is unreachable, the agent retries 3 times with exponential backoff (1s, 2s, 4s). If all retries fail, the email is left unread and a notification is sent.

### 2.5 Observability

- **Structured logging:** All output to stdout/stderr is JSON-line format with fields: `timestamp`, `level`, `correlation_id` (email msg_id), `event`, `data`.
- **Correlation ID:** Every email processed carries its IMAP `message_id` through the entire pipeline — logs, dedup journal, Actual Budget transaction `notes` field.
- **No third-party monitoring:** No Sentry, no Datadog, no external telemetry. Logs are consumed via Docker's built-in logging (`docker compose logs`).

---

## 3. Hosting Topology

| Component | Host | Network |
|---|---|---|
| Actual Budget | Fly.io VM #1 (existing) | Public HTTPS |
| OpenClaw Gateway | Ubuntu laptop (Docker) | Internal Docker network, port 18789 |
| expense-tracker | Ubuntu laptop (Docker) | Internal Docker network, port 8080; IMAP→Zoho |
| Zoho Mail Burner | Zoho (zoho.com) | Public IMAP (imap.zoho.com:993) |

---

## 4. Development Methodology

- **Spec-Kit framework:** All features are specified, planned, and tasked in `.speckit/features/<name>/` before implementation.
- **Feature namespace:** Each feature gets its own folder under `.speckit/features/`. Global constitution and agent harness live at `.speckit/` root.
- **Implementation phase:** A separate agent handles `/implement` after spec approval. This constitution governs all features.

### 4.1 TDD (Test-Driven Development) — Non-Negotiable

**Every line of implementation code MUST be preceded by a failing test. No exceptions.**

The TDD cycle is mandatory for all implementation work:

```
RED → GREEN → REFACTOR
```

| Step | Description | Requirement |
|---|---|---|
| **RED** | Write a failing test first | Test must fail for the expected reason before any implementation code is written. Tests must be run and confirmed failing. |
| **GREEN** | Write the minimum code to pass | Implement only enough code to make the test pass. No extra features, no speculative code. |
| **REFACTOR** | Clean up without changing behavior | Improve code structure, remove duplication, enhance readability. All tests must remain green after refactoring. |

**Enforcement Rules:**

1. **No implementation without a test.** Every function, class method, and module must have corresponding tests written *before* the implementation.
2. **Tests must fail first.** Run the test suite after writing each test and confirm it fails (`pytest tests/test_<module>.py -v`). If a test passes without implementation code, it is a false positive and must be fixed.
3. **All tests must pass.** Before marking any task complete, run `pytest tests/ -v` and verify 100% pass rate. No skipped tests (`xfail` without good reason), no ignored failures.
4. **Test isolation.** Each test must be independent — no shared mutable state between tests. Use fixtures and mocks to isolate external dependencies (Actual Budget API, IMAP, DeepSeek, SMTP).
5. **Test coverage for edge cases.** Every edge case listed in `spec.md` must have a corresponding test.
6. **Tests are documentation.** Test function names must clearly describe the scenario being tested (e.g., `test_insert_duplicate_returns_true` not `test_dedup_1`).

---

## 5. Amendment Process

- This constitution can only be amended by re-running `/speckit.constitution`.
- Changes must be reflected in all downstream artifacts (spec, plan, tasks) of affected features.
- The `agent.md` harness tracks the current constitution version hash.