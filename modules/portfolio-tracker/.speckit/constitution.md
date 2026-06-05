# Project Constitution

**Project:** darren-openclaw — Portfolio Performance Sync Agent
**Version:** 1.0.0
**Last Amended:** 2026-06-05
**Workflow:** Spec-Kit (Spec-Driven Development)

---

## 1. System Identity

OpenClaw Portfolio Tracker is an **LLM-powered portfolio automation agent** that synchronizes investment data across multiple sources and targets: IBKR flex queries, PDF/email receipts, Actual Budget allocations, Portfolio Performance XML files, and Google Sheets taxonomies.

The intelligence layer is a **DeepSeek LLM agent** — the Python host provides deterministic tools (PDF OCR, IBKR XML parsing, Java CLI bridge for PP XML, Actual Budget API, Google Sheets API, Telegram callback). All classification, matching, routing, and decision-making is delegated to the LLM.

A **Java CLI tool** (headless, using Portfolio Performance's own model libraries) handles all PP XML read/write operations to avoid direct XML corruption.

---

## 2. Non-Negotiable Architecture Principles

### 2.1 Memory Constraint: 256MB RAM Target

- The portfolio-tracker container runs on Ubuntu server via Docker, targeting ~256MB RAM (includes Java subprocess overhead).
- Python 3.12-slim base image. Java 17+ JRE bundled for the PP CLI tool.
- Single-process Python architecture with subprocess calls to Java CLI.
- Dependencies: `aiohttp`, `beautifulsoup4`, `openai` (DeepSeek client), `pytesseract`, `pdf2image`, `python-telegram-bot`, `google-api-python-client`, `google-auth`.
- Tesseract and Poppler binaries for PDF OCR.

### 2.2 Deterministic Where Possible, LLM Where Needed

- **Deterministic tools (Python):** IBKR flex query XML parsing, PDF → OCR, Actual Budget REST API calls, Java CLI subprocess execution, Google Sheets API, hash-based dedup.
- **Java CLI (deterministic):** Load/save PP XML files, add transactions, update account balances, query portfolio structure — all using PP's own `name.abuchen.portfolio` model classes. Zero direct XML string manipulation.
- **LLM intelligence:** Classification (receipt vs IBKR vs query), account matching, merchant extraction from OCR text, currency detection, investment category assignment, taxonomy mapping.
- **No hardcoded business rules in Python.** The LLM owns all decision logic using live data fetched at runtime.

### 2.3 Security Isolation

- **Credentials via env vars only:** DeepSeek API key, Telegram bot token, Actual Budget password, Google Sheets service account JSON, Zoho IMAP password. Never committed.
- **Docker network isolation:** The container accesses Actual Budget and Google Sheets via HTTPS over the public internet.
- **Java CLI isolation:** The Java subprocess runs within the same container, communicating via stdin/stdout/stderr. No network socket.
- **PP XML file:** Mounted as a Docker volume read-write. Backups performed by the Java CLI before writes.

### 2.4 Data Integrity

- **Multi-currency:** SGD (warchest, emergency fund), MYR (emergency fund). Currency detected by LLM or parsed from source data.
- **Duplicate prevention:** SHA-256 hash over `(date, amount_cents, account_id, security_id, type)` checked against local SQLite dedup journal. Duplicates skipped silently.
- **PP XML safety:** Java CLI always writes to a backup file first, validates the result loads successfully, then atomically replaces the original. No direct XML manipulation from Python.
- **Idempotency:** Telegram messages processed exactly once via `update_id` tracking. Emails via IMAP `\Seen` flag. Scheduled tasks deduplicated by timestamp.
- **No silent failures:** If the LLM cannot confidently match an account or classify a transaction, it calls `notify_user` and does not write to PP XML.

### 2.5 LLM Agent Principles

- **Tools, not code.** The Python layer exposes 14+ deterministic tools. The LLM chooses which to call and in what order.
- **Auditability.** Every LLM decision logged as structured JSON with correlation ID.
- **Memory/learning.** The agent persistently learns account mappings, payee→security mappings, and taxonomy assignments via `learn_mapping()` — similar to expense-tracker.
- **Fallback safety:** DeepSeek API retries 3x with exponential backoff. Java CLI errors surfaced to LLM for recovery decisions.

### 2.6 Observability

- **Structured JSON-line logging** with fields: `timestamp`, `level`, `correlation_id`, `event`, `data`.
- **Correlation ID:** Telegram `update_id`, IMAP `msg_id`, or scheduled task name carried through full pipeline.
- **No third-party monitoring.** Logs consumed via `docker compose logs`.

---

## 3. Hosting Topology

| Component | Host | Network |
|---|---|---|
| Portfolio Performance | Ubuntu server (Java GUI or headless) | Local filesystem |
| portfolio-tracker | Ubuntu server (Docker) | Internal Docker network, port 8081 |
| Actual Budget | Fly.io VM #1 (existing) | Public HTTPS |
| Zoho Mail | Zoho (zoho.com) | Public IMAP (imap.zoho.com:993) |
| Telegram | Telegram API | Public HTTPS |
| Google Sheets | Google API | Public HTTPS |
| DeepSeek API | api.deepseek.com | Public HTTPS |

---

## 4. Development Methodology

### 4.1 TDD (Test-Driven Development) — Non-Negotiable

**Every line of implementation code MUST be preceded by a failing test. No exceptions.**

| Step | Description | Requirement |
|---|---|---|
| **RED** | Write a failing test first | Test must fail for the expected reason before implementation. |
| **GREEN** | Write minimum code to pass | Only enough to make the test pass. No speculative code. |
| **REFACTOR** | Clean up | Improve structure, remove duplication. All tests must remain green. |

**Enforcement Rules:**
1. No implementation without a test.
2. Tests must fail first — confirm with `pytest tests/test_<module>.py -v`.
3. All tests must pass — 100% pass rate before marking any task complete.
4. Test isolation — no shared mutable state between tests. Use fixtures/mocks.
5. Test coverage for edge cases — every edge case in spec.md must have a corresponding test.
6. Tests are documentation — descriptive function names.

---

## 5. Amendment Process

- This constitution can only be amended by re-running `/speckit.constitution`.
- Changes must be reflected in all downstream artifacts (spec, plan, tasks).
- The `agent.md` harness tracks the current constitution version hash.
