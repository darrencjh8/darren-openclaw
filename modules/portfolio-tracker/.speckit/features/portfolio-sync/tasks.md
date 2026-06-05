# Implementation Tasks: Portfolio Performance Sync

**Feature:** portfolio-sync
**Tasks Version:** 1.0.0
**Status:** Tasked
**Constitution Hash:** v1.0.0

---

## Task Dependency Graph

```
Phase 0: Foundation
  T0.1 (Project scaffold)
    ├── T0.2 (Environment config)
    ├── T0.3 (Structured logging)
    └── T0.4 (Dedup journal + memory)
          │
Phase 1: Java CLI Tool
  T1.1 (Maven project + PP dependency)
  T1.2 (PPClient: load/save/backup)
  T1.3 (AccountCommand + SecurityCommand)
  T1.4 (TransactionCommand: insert buy/sell/dividend/deposit/fee/tax)
  T1.5 (BalanceCommand + TaxonomyCommand + PortfolioCommand)
  T1.6 (Java CLI integration tests)
          │
Phase 2: Python Deterministic Tools
  T2.1 (PDF extractor: OCR pipeline)
  T2.2 (IBKR flex query XML parser)
  T2.3 (PP Java bridge: subprocess execution)
  T2.4 (Actual Budget client)
  T2.5 (Google Sheets client)
  T2.6 (Email extractor: IMAP + HTML + PDF)
          │
Phase 3: Channels (optional, only if IMAP/Telegram enabled)
  T3.1 (Telegram handler: polling, file download, message routing)
  T3.2 (Email handler: IMAP IDLE integration)
          │
Phase 4: Agent Intelligence
  T4.1 (System prompt + few-shot examples)
  T4.2 (Agent orchestrator)
  T4.3 (Tool registry: all 16 tools)
  T4.4 (DeepSeek integration)
          │
Phase 5: Integration & Deploy
  T5.1 (main.py entry point + scheduler)
  T5.2 (Dockerfile + .env.example)
  T5.3 (Integration tests)
  T5.4 (README)
```

---

## Phase 0: Foundation

### T0.1 — Project Scaffold

**Priority:** P0 (blocker)
**Estimate:** 15 minutes
**Depends On:** None

- [ ] Create `pyproject.toml` with dependencies:
  - `openai>=1.0`, `aiohttp>=3.9`, `beautifulsoup4>=4.12`, `lxml>=5.0`
  - `python-dotenv>=1.0`, `pytesseract>=0.3`, `pdf2image>=1.16`
  - `python-telegram-bot>=20.0`, `google-api-python-client>=2.0`, `google-auth>=2.0`
  - `aioimaplib>=1.0`, `apscheduler>=3.10`
  - `pytest>=8.0`, `pytest-asyncio>=0.23`, `pytest-mock>=3.12` (dev)
- [ ] Create `requirements.txt` with pinned versions
- [ ] Create all `__init__.py` files (src, agent, channels, extractors, pp_client, google, utils)
- [ ] Create `tests/__init__.py`

**Validation:** `pip install -r requirements.txt` completes.

### T0.2 — Environment Configuration

**Priority:** P0 (blocker)
**Estimate:** 20 minutes
**Depends On:** T0.1

- [ ] Implement `src/config.py`:
  - `Config` dataclass with all env var fields
  - `Config.from_env()` classmethod: load `.env`, validate required vars
  - Clear error messages for missing required vars
- [ ] Create `.env.example` with all variables documented
- [ ] Write `tests/test_config.py`: loads from env, raises on missing, validates defaults

**Validation:** `pytest tests/test_config.py -v` passes.

### T0.3 — Structured Logging

**Priority:** P0 (blocker)
**Estimate:** 15 minutes
**Depends On:** T0.1

- [ ] Implement `src/utils/logging.py`:
  - `setup_logging(level)`: JSON-line format to stdout
  - `get_logger(name)`: returns logger with `correlation_id` support
  - Same format as expense-tracker: `{"timestamp", "level", "logger", "correlation_id", "event", "data"}`
- [ ] Write `tests/test_logging.py`: setup, get_logger, JSON output, correlation_id

**Validation:** `pytest tests/test_logging.py -v` passes.

### T0.4 — Dedup Journal & Memory

**Priority:** P0 (blocker)
**Estimate:** 30 minutes
**Depends On:** T0.2

- [ ] Implement `src/utils/dedup.py`:
  - `DedupJournal` class with SQLite
  - `compute_hash(date, amount_cents, account_id, security_id, type) -> str`
  - `check(...) -> bool`, `record(...) -> None`
  - Thread-safe with lock
- [ ] Implement `src/utils/memory.py`:
  - `MemoryStore` class: load/save `data/mappings.json`
  - Types: `securities`, `accounts`, `categories`, `brokers`
  - `learn(type, key, value)`, `recall(type, key) -> str|None`, `recall_all(type) -> dict`
- [ ] Write `tests/test_dedup.py` and `tests/test_memory.py`

**Validation:** `pytest tests/test_dedup.py tests/test_memory.py -v` passes.

---

## Phase 1: Java CLI Tool

### T1.1 — Maven Project + PP Dependency

**Priority:** P0 (blocker)
**Estimate:** 30 minutes
**Depends On:** None

- [ ] Create `pp-cli/pom.xml`:
  - Group: `name.abuchen.portfolio.cli`
  - Artifact: `pp-cli`
  - Dependencies: `name.abuchen.portfolio:name.abuchen.portfolio:0.84.1`
  - Build: shade plugin for fat JAR
  - Main class: `name.abuchen.portfolio.cli.Main`
- [ ] Create `pp-cli/src/main/java/name/abuchen/portfolio/cli/Main.java`:
  - CLI entry point using args
  - Dispatch to subcommands
  - `--help` flag
- [ ] Verify `mvn clean package -f pp-cli/pom.xml` builds JAR

**Validation:** Maven builds successfully, `java -jar pp-cli/target/pp-cli.jar --help` prints usage.

### T1.2 — PPClient: Load/Save/Backup

**Priority:** P0 (blocker)
**Estimate:** 45 minutes
**Depends On:** T1.1

- [ ] Implement `PpClient.java`:
  - `load(File)`: use PP's `Client.load()` to open XML
  - `save(File)`: use PP's `Client.save()` with backup
  - `backup()`: copy file to `.backup` before save
  - `validateBackup()`: load backup, verify it parses
  - `restoreFromBackup()`: on error, restore backup
  - Thread-safe singleton per file path
- [ ] Unit tests (JUnit):
  - Test: load valid XML returns Client
  - Test: save creates file
  - Test: backup created before save
  - Test: restore on corrupt save

**Validation:** `mvn test -f pp-cli/pom.xml` passes.

### T1.3 — AccountCommand + SecurityCommand

**Priority:** P0 (blocker)
**Estimate:** 45 minutes
**Depends On:** T1.2

- [ ] Implement `AccountCommand.java`:
  - List all accounts with name, UUID, currency, type
  - Output JSON
- [ ] Implement `SecurityCommand.java`:
  - List all securities with name, UUID, ISIN, ticker, currency
  - Search by ISIN or ticker
  - Output JSON
- [ ] Unit tests: list accounts, list securities, search by ISIN, search by ticker

**Validation:** `mvn test -f pp-cli/pom.xml` passes.

### T1.4 — TransactionCommand: Insert Trades

**Priority:** P0 (blocker)
**Estimate:** 1 hour
**Depends On:** T1.2, T1.3

- [ ] Implement `TransactionCommand.java`:
  - Insert Buy: `BuySellEntry` with PortfolioTransaction.Type.BUY
  - Insert Sell: PortfolioTransaction.Type.SELL
  - Insert Dividend: AccountTransaction.Type.DIVIDENDS
  - Insert Deposit: AccountTransaction.Type.DEPOSIT
  - Insert Withdrawal: AccountTransaction.Type.REMOVAL
  - Insert Fee: AccountTransaction.Type.FEES
  - Insert Tax: AccountTransaction.Type.TAXES
  - Insert Interest: AccountTransaction.Type.INTEREST
  - All with date, shares, price, currency, fees, taxes, notes
  - Returns JSON with transaction UUID and status
- [ ] Unit tests: insert buy, insert sell, insert dividend, insert fee, missing security, duplicate

**Validation:** `mvn test -f pp-cli/pom.xml` passes.

### T1.5 — BalanceCommand + TaxonomyCommand + PortfolioCommand

**Priority:** P1 (high)
**Estimate:** 45 minutes
**Depends On:** T1.2, T1.3

- [ ] Implement `BalanceCommand.java`:
  - Set account balance: create a "balance" transaction at given date
  - Only for DEPOSIT type accounts (not securities)
- [ ] Implement `TaxonomyCommand.java`:
  - Query all securities with taxonomy assignments
  - Aggregate by taxonomy value: sum market value, count holdings
  - Return JSON with taxonomy breakdown
- [ ] Implement `PortfolioCommand.java`:
  - Dump full portfolio: accounts, securities, holdings
  - Compact JSON format
- [ ] Unit tests: set balance, query taxonomies, dump portfolio

**Validation:** `mvn test -f pp-cli/pom.xml` passes.

### T1.6 — Java CLI Integration Tests

**Priority:** P1 (high)
**Estimate:** 30 minutes
**Depends On:** T1.3, T1.4, T1.5

- [ ] Test harness: use a sample PP XML file (committed to repo)
- [ ] Test: accounts command returns expected accounts
- [ ] Test: securities command returns expected securities
- [ ] Test: insert buy transaction and verify it appears in subsequent queries
- [ ] Test: balance command updates account balance
- [ ] Test: taxonomy command returns correct aggregation
- [ ] Test: portfolio command returns complete dump
- [ ] Test: backup created before save, loadable after save

**Validation:** `mvn test -f pp-cli/pom.xml` all tests pass.

---

## Phase 2: Python Deterministic Tools

### T2.1 — PDF Extractor: OCR Pipeline

**Priority:** P1 (high)
**Estimate:** 45 minutes
**Depends On:** T0.1

- [ ] Implement `src/extractors/pdf_extractor.py`:
  - `extract_pdf_text(pdf_bytes: bytes) -> str`:
  - pdf2image convert to images
  - pytesseract OCR each page
  - Concat all pages
  - Graceful fallback if tesseract not installed
- [ ] Write `tests/test_extractors.py` (PDF tests):
  - Test: text PDF extraction
  - Test: image PDF OCR
  - Test: multi-page PDF
  - Test: empty PDF
  - Test: tesseract unavailable

**Validation:** `pytest tests/test_extractors.py -v -k pdf` passes.

### T2.2 — IBKR Flex Query XML Parser

**Priority:** P1 (high)
**Estimate:** 1 hour
**Depends On:** T0.1

- [ ] Implement `src/extractors/ibkr_parser.py`:
  - `parse_ibkr_flex_query(xml_content: str) -> list[dict]`:
  - Parse IBKR flex query XML namespace
  - Extract all statement sections: Trades, Cash Transactions, Corporate Actions, etc.
  - Map IBKR trade types to PP types: BUY→Buy, SELL→Sell, DIVIDEND→Dividend, etc.
  - Extract: trade date, settle date, symbol, ISIN, description, quantity, price, currency, fees, taxes, total
  - Return normalized list of dicts
- [ ] Write `tests/test_ibkr_parser.py`:
  - Test: parse sample flex query XML (check for sample in fixtures)
  - Test: extract buy transaction
  - Test: extract sell transaction
  - Test: extract dividend
  - Test: extract fees
  - Test: empty flex query (0 transactions)
  - Test: malformed XML

**Validation:** `pytest tests/test_ibkr_parser.py -v` passes.

### T2.3 — PP Java Bridge

**Priority:** P0 (blocker)
**Estimate:** 1 hour
**Depends On:** T1.6 (Java CLI complete), T0.2

- [ ] Implement `src/pp_client/java_bridge.py`:
  - `PpJavaBridge` class:
  - `__init__(jar_path, xml_path)`: store paths
  - `async _run_command(command, *args) -> dict`: spawn Java subprocess, return parsed stdout JSON
  - Timeout: 30s per command
  - Error handling: parse stderr into structured error
  - `async get_accounts() -> list[dict]`
  - `async get_securities() -> list[dict]`
  - `async get_portfolio() -> dict`
  - `async insert_transaction(...) -> dict`
  - `async update_balance(...) -> dict`
  - `async query_taxonomies(names: list[str]) -> dict`
- [ ] Write `tests/test_java_bridge.py`:
  - Test: get_accounts returns list
  - Test: get_securities returns list
  - Test: insert_transaction returns transaction_id
  - Test: update_balance confirms updated
  - Test: command timeout
  - Test: invalid XML file raises error
  - Test: Java subprocess not found raises error

**Validation:** `pytest tests/test_java_bridge.py -v` passes.

### T2.4 — Actual Budget Client

**Priority:** P1 (high)
**Estimate:** 45 minutes
**Depends On:** T0.2

- [ ] Implement `src/client/actual_client.py`:
  - `ActualBudgetClient` class (or use actual-api Node.js bridge):
  - `async get_categories(budget_id: str) -> list[dict]`
  - `async get_category_balance(budget_id: str, category_name: str) -> float`
  - Thin HTTP wrapper around REST API
  - Retry 3x with exponential backoff
- [ ] Write `tests/test_actual_client.py`:
  - Test: get_categories returns list
  - Test: get_category_balance returns float
  - Test: missing budget raises error
  - Test: API down retries then raises

**Validation:** `pytest tests/test_actual_client.py -v` passes.

### T2.5 — Google Sheets Client

**Priority:** P1 (high)
**Estimate:** 45 minutes
**Depends On:** T0.2

- [ ] Implement `src/google/sheets_client.py`:
  - `GoogleSheetsClient` class:
  - `__init__(service_account_json_path)`: authenticate via service account
  - `async update_range(spreadsheet_id, range, values) -> dict`
  - Uses `google.oauth2.service_account` + `googleapiclient.discovery`
  - Retry 3x on quota errors
- [ ] Write `tests/test_sheets_client.py`:
  - Test: update_range sends correct API call (mock)
  - Test: auth failure raises error
  - Test: quota error retries

**Validation:** `pytest tests/test_sheets_client.py -v` passes.

### T2.6 — Email Extractor

**Priority:** P2 (medium)
**Estimate:** 30 minutes
**Depends On:** T0.1, T2.1

- [ ] Implement `src/extractors/email_extractor.py`:
  - `extract_email_content(raw_email: bytes) -> str`:
  - Parse MIME: text/plain preferred, fallback text/html
  - If PDF attachment: run OCR pipeline
  - Clean text: strip signatures, normalize whitespace
- [ ] Write `tests/test_email_extractor.py`:
  - Test: plain text email
  - Test: HTML email → clean text
  - Test: multipart with HTML and plain text
  - Test: email with PDF attachment → OCR
  - Test: email with IBKR XML attachment

**Validation:** `pytest tests/test_email_extractor.py -v` passes.

---

## Phase 3: Channels

### T3.1 — Telegram Handler

**Priority:** P1 (high)
**Estimate:** 1 hour
**Depends On:** T0.2

- [ ] Implement `src/channels/telegram_handler.py`:
  - `TelegramHandler` class:
  - Uses `python-telegram-bot` with async polling
  - `on_message(update, context)`: route by content type
  - File download: get file from Telegram servers, save bytes
  - Classify intent: IBKR XML → "ibkr_flex_query", PDF → "pdf_receipt", text command → "/ibkr", "/sync", etc.
  - Callback to orchestrator: `async process_telegram_event(intent, data, reply_callback)`
  - `send_message(text)`: send Telegram message
  - Track `update_id` for dedup (prevent double-processing)
- [ ] Write `tests/test_telegram_handler.py`:
  - Test: text message routing
  - Test: PDF document download
  - Test: XML document download
  - Test: update_id dedup
  - Test: unauthorized chat_id rejected

**Validation:** `pytest tests/test_telegram_handler.py -v` passes.

### T3.2 — Email Handler (IMAP)

**Priority:** P2 (medium)
**Estimate:** 45 minutes
**Depends On:** T0.2, T2.6

- [ ] Implement `src/channels/email_handler.py`:
  - `EmailHandler` class (similar to expense-tracker's IMAP handler):
  - IMAP IDLE connection to Zoho
  - `on_new_email(msg_id, raw_email)` → extract content → route to orchestrator
  - `mark_read(msg_id)`: set `\Seen`
  - Auto-reconnect with catch-up
- [ ] Write `tests/test_email_handler.py`:
  - Test: new email callback fires
  - Test: mark_read sets Seen flag
  - Test: reconnect on disconnect

**Validation:** `pytest tests/test_email_handler.py -v` passes.

---

## Phase 4: Agent Intelligence

### T4.1 — System Prompt & Few-Shot Examples

**Priority:** P0 (blocker)
**Estimate:** 45 minutes
**Depends On:** None (content only)

- [ ] Implement `src/agent/prompts.py`:
  - `SYSTEM_PROMPT`: rules from plan.md Section 6
  - `_load_learned_context()`: load from `data/mappings.json`
  - `FEW_SHOT_EXAMPLES`: 5 example conversations:
    1. Happy path: IBKR flex query with 3 trades, all matched, user approves
    2. PDF receipt: OCR text → extract buy → match → insert
    3. Balance sync: Actual Budget → update 3 PP accounts
    4. New security: flex query with unknown ticker → ask user → create security → insert
    5. Error path: garbled OCR → notify user
  - Each example: full message chain with tool_calls and tool responses
- [ ] No unit tests (content validation is manual)

**Validation:** `python -c "from src.agent.prompts import SYSTEM_PROMPT; assert len(SYSTEM_PROMPT) > 500"`

### T4.2 — Agent Orchestrator

**Priority:** P0 (blocker)
**Estimate:** 1.5 hours
**Depends On:** Phase 2 tools, T4.1

- [ ] Implement `src/agent/orchestrator.py`:
  - `AgentOrchestrator` class:
  - `__init__(deepseek_client, tool_registry, dedup_journal, memory_store)`
  - `async process_event(event_type, data, reply_callback)`:
    1. Build system prompt + few-shot + context
    2. Call DeepSeek with tool schemas
    3. Loop: execute tool_calls, feed results back (max 7 iterations)
    4. Track whether confirmation was asked and received
    5. Return final decision
  - Intent classifier: lightweight LLM call to classify event
  - Pending confirmation tracking: if `ask_user_confirmation` is called, wait for user response via Telegram
  - Guardrails: max iterations, must check_duplicate before insert, must fetch accounts before matching
- [ ] Write `tests/test_agent_orchestrator.py`:
  - Test: IBKR flex query happy path (mock LLM responses)
  - Test: PDF receipt → OCR → extract → match → insert
  - Test: new security → ask confirmation → proceed
  - Test: duplicate detection → skip
  - Test: garbled OCR → notify
  - Test: max iterations exceeded → error
  - Test: balance sync happy path
  - Test: taxonomy export happy path

**Validation:** `pytest tests/test_agent_orchestrator.py -v` passes.

### T4.3 — Tool Registry

**Priority:** P0 (blocker)
**Estimate:** 1 hour
**Depends On:** T2.1-T2.5, T3.1

- [ ] Implement `src/agent/tools.py`:
  - `ToolRegistry` class:
  - All 16 tools from plan.md Section 4
  - `execute_tool(name, arguments) -> dict` dispatcher
  - `get_tool_schemas() -> list[dict]` returns OpenAI-compatible function definitions
  - Context injection for tools that need current event data
- [ ] Write `tests/test_tools.py`:
  - Test: registry returns 16 schemas
  - Test: execute_tool dispatches correctly
  - Test: insert_pp_transaction calls Java bridge with correct args
  - Test: notify_user calls Telegram send_message
  - Test: check_duplicate calls dedup journal
  - Test: learn_mapping persists to memory store
  - Test: parse_ibkr_flex_query parses correctly

**Validation:** `pytest tests/test_tools.py -v` passes.

### T4.4 — DeepSeek Integration

**Priority:** P0 (blocker)
**Estimate:** 30 minutes
**Depends On:** T0.2, T4.2

- [ ] Implement in `src/agent/orchestrator.py`:
  - `DeepSeekClient` wrapper:
  - `__init__(api_key)`: base URL `https://api.deepseek.com/v1`
  - `async chat(messages, tools) -> response`: 30s timeout
  - Retry: 3 attempts (1s, 2s, 4s)
  - Log token usage
- [ ] No separate test file; tested via orchestrator integration tests

**Validation:** `pytest tests/test_agent_orchestrator.py -v` — mocked, verified correct base URL.

---

## Phase 5: Integration & Deploy

### T5.1 — Entry Point (main.py) + Scheduler

**Priority:** P0 (blocker)
**Estimate:** 1 hour
**Depends On:** T4.3, T3.1 (optional), T3.2 (optional)

- [ ] Implement `src/main.py`:
  - `async def main()`:
    1. Load config
    2. Setup logging
    3. Initialize DedupJournal, MemoryStore
    4. Initialize PpJavaBridge (with JAR path)
    5. Initialize ActualBudgetClient, GoogleSheetsClient
    6. Initialize DeepSeekClient
    7. Initialize ToolRegistry (inject all dependencies)
    8. Initialize AgentOrchestrator
    9. Start Telegram poller (if TELEGRAM_BOT_TOKEN configured)
    10. Start IMAP IDLE (if IMAP credentials configured)
    11. Start APScheduler for daily tasks:
        - balance_sync: Actual Budget → PP (cron from env)
        - taxonomy_export: PP → Google Sheets (cron from env)
    12. Start health check HTTP server on port 8081
    13. Graceful shutdown
- [ ] Implement `src/__main__.py`: `from src.main import main; asyncio.run(main())`
- [ ] Write `tests/test_main.py`:
  - Test: import chain works
  - Test: main() initializes without crash (all mocks)
  - Test: graceful shutdown

**Validation:** `pytest tests/test_main.py -v` passes.

### T5.2 — Docker Configuration

**Priority:** P1 (high)
**Estimate:** 30 minutes
**Depends On:** T5.1, T1.6

- [ ] Write `docker/Dockerfile`:
  - Python 3.12-slim + openjdk-17-jre-headless + tesseract-ocr + poppler-utils
  - Copy requirements, install pip deps
  - Copy src/, pp-cli/target/pp-cli.jar, config/
  - Create /app/data, /app/config
  - EXPOSE 8081
  - Non-root user
  - CMD: python -m src.main
- [ ] Write `.dockerignore`:
  - Exclude `.env`, `data/`, `.git/`, `__pycache__/`, `.speckit/`, `tests/`, `pp-cli/src/`, `pp-cli/target/` (except JAR)
- [ ] Write `.env.example` with ALL 27+ env vars

**Validation:** `docker build -f docker/Dockerfile .` succeeds.

### T5.3 — Integration Tests

**Priority:** P1 (high)
**Estimate:** 1 hour
**Depends On:** T5.1

- [ ] Write `tests/conftest.py`:
  - Fixtures: `mock_deepseek`, `mock_java_bridge`, `mock_actual_budget`, `mock_google_sheets`, `mock_telegram`
  - Fixtures: `sample_ibkr_xml`, `sample_pdf_receipt`, `sample_email_trade`
  - Fixture: `test_dedup_db`, `test_memory_store`
- [ ] Write `tests/test_integration.py`:
  - Test: full IBKR flow — parse → match → confirm → insert → notify
  - Test: full PDF receipt flow — OCR → extract → match → insert
  - Test: full email flow — extract → match → insert
  - Test: full balance sync flow — query AB → update PP
  - Test: full taxonomy flow — query PP → update Sheets
  - Test: duplicate detection across flows
  - Test: ambiguous match → ask user → proceed
  - Test: rejected confirmation → skip

**Validation:** `pytest tests/test_integration.py -v` passes.

### T5.4 — README

**Priority:** P2 (medium)
**Estimate:** 20 minutes
**Depends On:** T5.2

- [ ] Write `README.md`:
  - Project overview
  - Architecture diagram
  - Prerequisites: Java 17+, Docker, DeepSeek API key, Telegram bot, Google service account, PP XML file
  - Setup instructions:
    1. Build Java CLI: `mvn clean package -f pp-cli/pom.xml`
    2. Copy `.env.example` to `.env`
    3. Fill in all credentials
    4. `docker compose up -d` or `pip install -r requirements.txt && python -m src.main`
  - How to set up Telegram bot (@BotFather)
  - How to set up Google Sheets service account
  - How to configure Actual Budget categories
  - Commands reference
  - Troubleshooting

**Validation:** Another dev can follow README and set up the project.

---

## Execution Sequence

| Order | Task | Phase |
|---|---|---|
| 1 | T0.1 — Project Scaffold | Foundation |
| 2 | T0.2 — Environment Config | Foundation |
| 3 | T0.3 — Structured Logging | Foundation |
| 4 | T0.4 — Dedup Journal & Memory | Foundation |
| 5 | T1.1 — Maven Project | Java CLI |
| 6 | T1.2 — PPClient Load/Save | Java CLI |
| 7 | T1.3 — Account + Security Commands | Java CLI |
| 8 | T1.4 — Transaction Commands | Java CLI |
| 9 | T1.5 — Balance + Taxonomy Commands | Java CLI |
| 10 | T1.6 — Java CLI Tests | Java CLI |
| 11 | T2.1 — PDF Extractor | Python Tools |
| 12 | T2.2 — IBKR Parser | Python Tools |
| 13 | T2.3 — PP Java Bridge | Python Tools |
| 14 | T2.4 — Actual Budget Client | Python Tools |
| 15 | T2.5 — Google Sheets Client | Python Tools |
| 16 | T2.6 — Email Extractor | Python Tools |
| 17 | T3.1 — Telegram Handler | Channels |
| 18 | T3.2 — Email Handler | Channels |
| 19 | T4.1 — System Prompt | Agent |
| 20 | T4.2 — Agent Orchestrator | Agent |
| 21 | T4.3 — Tool Registry | Agent |
| 22 | T4.4 — DeepSeek Integration | Agent |
| 23 | T5.1 — Entry Point + Scheduler | Integration |
| 24 | T5.2 — Docker Config | Integration |
| 25 | T5.3 — Integration Tests | Integration |
| 26 | T5.4 — README | Integration |

---

## Validation Checkpoints

### Checkpoint Alpha: Foundation Complete (T0.1-T0.4)
- `pytest tests/test_config.py tests/test_logging.py tests/test_dedup.py tests/test_memory.py -v` — all pass

### Checkpoint Bravo: Java CLI Complete (T1.1-T1.6)
- `mvn test -f pp-cli/pom.xml` — all Java tests pass
- `java -jar pp-cli/target/pp-cli.jar --help` prints usage

### Checkpoint Charlie: Python Tools Complete (T2.1-T2.6)
- `pytest tests/test_extractors.py tests/test_ibkr_parser.py tests/test_java_bridge.py tests/test_actual_client.py tests/test_sheets_client.py -v` — all pass

### Checkpoint Delta: Channels Complete (T3.1-T3.2)
- `pytest tests/test_telegram_handler.py tests/test_email_handler.py -v` — all pass

### Checkpoint Echo: Agent Complete (T4.1-T4.4)
- `pytest tests/test_agent_orchestrator.py tests/test_tools.py -v` — all pass

### Checkpoint Foxtrot: Integration Complete (T5.1-T5.4)
- `pytest tests/ -v` — ALL tests pass
- `docker build -f docker/Dockerfile .` — succeeds
- README is complete

---

## Total Estimated Effort

| Phase | Tasks | Estimate |
|---|---|---|
| Foundation | 4 | 1h 20m |
| Java CLI | 6 | 4h 15m |
| Python Tools | 6 | 4h 45m |
| Channels | 2 | 1h 45m |
| Agent | 4 | 3h 45m |
| Integration | 4 | 2h 50m |
| **Total** | **26** | **~18.5 hours** |
