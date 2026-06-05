# Technical Plan: Portfolio Performance Sync

**Feature:** portfolio-sync
**Plan Version:** 1.0.0
**Status:** Planned
**Constitution Hash:** v1.0.0

---

## 1. Technology Stack

| Layer | Choice | Version | Rationale |
|---|---|---|---|
| Runtime | Python | 3.12-slim | Lightweight (~80MB base), async I/O, mature libraries |
| LLM Provider | DeepSeek | `deepseek-chat` | $0.14/1M input, $0.28/1M output, OpenAI-compatible |
| LLM Client | `openai` (Python SDK) | >=1.0 | DeepSeek is OpenAI-API-compatible |
| PP CLI | Java 17+ | JRE bundled in Docker | Uses PP's own model classes for safe XML I/O |
| Telegram Bot | `python-telegram-bot` | >=20.0 | Async, polling-based, handles file download |
| IMAP | `aioimaplib` | latest | Async IMAP IDLE for email monitoring |
| HTTP Client | `aiohttp` | latest | Actual Budget API, Google Sheets API, Telegram API |
| HTML Parsing | `beautifulsoup4` + `lxml` | latest | Email HTML extraction |
| PDF OCR | `pytesseract` + `pdf2image` | latest | Receipt/trade confirmation OCR |
| XML Parsing | `lxml` | latest | IBKR flex query XML parsing |
| Google Sheets | `google-api-python-client` | latest | Taxonomy export |
| Config | `.env` + `os.environ` | — | 12-factor app |
| Dedup DB | `sqlite3` (stdlib) | built-in | Zero-dependency journal |
| Logging | `json` + `logging` (stdlib) | built-in | JSON-line structured logs to stdout |
| Container | Docker | — | Dockerfile + docker-compose |

---

## 2. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  Ubuntu Server (Docker): portfolio-tracker (~256MB RAM)          │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  main.py (entry point)                                      │  │
│  │                                                             │  │
│  │  ┌───────────────┐  ┌───────────────┐  ┌────────────────┐  │  │
│  │  │ Telegram Poll  │  │ IMAP IDLE     │  │ Scheduler      │  │  │
│  │  │ (channels/     │  │ (channels/    │  │ (apscheduler)  │  │  │
│  │  │  telegram.py)  │  │  email.py)    │  │                │  │  │
│  │  │               │  │               │  │ - Daily: AB→PP │  │  │
│  │  │ on_message()  │  │ on_email()   │  │ - Daily: Tax→GS│  │  │
│  │  └───────┬───────┘  └───────┬───────┘  └───────┬────────┘  │  │
│  │          │                  │                   │           │  │
│  │          └──────────────────┼───────────────────┘           │  │
│  │                             ▼                               │  │
│  │  ┌──────────────────────────────────────────────────────┐   │  │
│  │  │  Agent Orchestrator (agent/orchestrator.py)           │   │  │
│  │  │                                                      │   │  │
│  │  │  For each inbound event:                             │   │  │
│  │  │  1. Classify intent (LLM)                            │   │  │
│  │  │  2. Extract content (deterministic tools)             │   │  │
│  │  │  3. Build system prompt + few-shot + context          │   │  │
│  │  │  4. Send to DeepSeek with tool schemas               │   │  │
│  │  │  5. LLM calls tools in sequence                      │   │  │
│  │  │  6. Execute tools, feed results back                  │   │  │
│  │  │  7. LLM makes final decision (insert/notify/skip)     │   │  │
│  │  └──────────────────────┬───────────────────────────────┘   │  │
│  │                         │                                   │  │
│  │  ┌──────────────────────┼───────────────────────────────┐   │  │
│  │  │  Tools (agent/tools.py)                               │   │  │
│  │  │                      ▼                                │   │  │
│  │  │  ┌─────────────────────────────────────────────────┐  │   │  │
│  │  │  │ Content Extraction Tools                        │  │   │  │
│  │  │  │  extract_pdf_text(pdf_bytes) → OCR              │  │   │  │
│  │  │  │  extract_email_content(raw_email) → text        │  │   │  │
│  │  │  │  parse_ibkr_flex(xml_bytes) → transactions[]    │  │   │  │
│  │  │  └─────────────────────────────────────────────────┘  │   │  │
│  │  │  ┌─────────────────────────────────────────────────┐  │   │  │
│  │  │  │ PP Java CLI Bridge (pp_client/java_bridge.py)     │  │   │  │
│  │  │  │  fetch_pp_accounts() → accounts[]                │  │   │  │
│  │  │  │  fetch_pp_securities() → securities[]            │  │   │  │
│  │  │  │  fetch_pp_portfolio() → holdings[]               │  │   │  │
│  │  │  │  insert_pp_transaction(...) → result             │  │   │  │
│  │  │  │  update_pp_balance(acct_id, amount, currency)    │  │   │  │
│  │  │  │  query_pp_taxonomies(tax_names[]) → data[]       │  │   │  │
│  │  │  └──────────────────────┬──────────────────────────┘  │   │  │
│  │  │                         │ subprocess                  │   │  │
│  │  │  ┌──────────────────────┼──────────────────────────┐  │   │  │
│  │  │  │  Java CLI (pp-cli/target/pp-cli.jar)              │  │   │  │
│  │  │  │  java -jar pp-cli.jar <command> <args>           │  │   │  │
│  │  │  │  Commands: accounts, securities, holdings,       │  │   │  │
│  │  │  │    insert, balance, taxonomy                     │  │   │  │
│  │  │  └─────────────────────────────────────────────────┘  │   │  │
│  │  │  ┌─────────────────────────────────────────────────┐  │   │  │
│  │  │  │ External API Tools                              │  │   │  │
│  │  │  │  fetch_actual_budget_categories(budget_id)      │  │   │  │
│  │  │  │  update_google_sheet(sheet_id, range, data)     │  │   │  │
│  │  │  │  notify_user(message) → Telegram                │  │   │  │
│  │  │  │  ask_user_confirmation(question, options)       │  │   │  │
│  │  │  └─────────────────────────────────────────────────┘  │   │  │
│  │  │  ┌─────────────────────────────────────────────────┐  │   │  │
│  │  │  │ Memory Tools                                    │  │   │  │
│  │  │  │  check_duplicate(hash_payload) → bool           │  │   │  │
│  │  │  │  learn_mapping(type, key, value)                │  │   │  │
│  │  │  │  log_decision(action, reasoning)                │  │   │  │
│  │  │  └─────────────────────────────────────────────────┘  │   │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐  │
│  │  SQLite Journal       │  │  PP XML File (volume mount)     │  │
│  │  (data/dedup.db)      │  │  /data/portfolio.xml            │  │
│  └──────────────────────┘  └─────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Flows

### 3.1 Telegram PDF Receipt Flow

```
User sends PDF to Telegram bot
  → Telegram poller receives message
  → Classify intent: "pdf_receipt"
  → Download PDF file from Telegram servers
  → extract_pdf_text() → OCR → raw text
  → LLM receives: system_prompt + OCR text
  → LLM calls: fetch_pp_accounts() + fetch_pp_securities()
  → LLM matches: security by name/ISIN/ticker, account by broker/currency
  → LLM calls: check_duplicate()
  → LLM calls: insert_pp_transaction(security_id, account_id, shares, price, currency, date, type, fees)
  → On success: notify_user("Logged BUY 100 AAPL @ $185.30 in IBKR SGD")
  → learn_mapping() for security, account
  → log_decision()
```

### 3.2 IBKR Flex Query Flow

```
User sends XML file to Telegram bot (or email)
  → Classify intent: "ibkr_flex_query"
  → parse_ibkr_flex(xml_bytes) → deterministic XML parse → transaction list
  → LLM receives: structured transaction list
  → LLM calls: fetch_pp_securities() + fetch_pp_accounts()
  → LLM matches each security, identifies new ones
  → LLM calls: ask_user_confirmation("Found 15 trades across 8 securities. 1 new: VWRA. Approve?")
  → User replies "approve" → LLM processes each transaction
  → For each: check_duplicate() → insert_pp_transaction()
  → notify_user("Imported 15 trades. 1 new security VWRA added.")
```

### 3.3 Actual Budget → PP Balance Sync (Scheduled)

```
Scheduler fires daily at configured time
  → Orchestrator builds context: "sync_balances"
  → LLM calls: fetch_actual_budget_categories("Darren-SGD-29ed82a")
  → LLM extracts: Emergency Fund SGD, General Investment Fund amounts
  → LLM calls: fetch_actual_budget_categories("Darren-MYR-*") for MYR budget
  → LLM extracts: Emergency Fund MYR amount
  → LLM calls: update_pp_balance("emergency-fund-sgd", amount, "SGD")
  → LLM calls: update_pp_balance("emergency-fund-myr", amount, "MYR")
  → LLM calls: update_pp_balance("warchest-sgd", amount, "SGD")
  → log_decision("synced_balances")
```

### 3.4 Taxonomy → Google Sheets (Scheduled)

```
Scheduler fires daily at configured time
  → Orchestrator builds context: "export_taxonomy"
  → LLM calls: query_pp_taxonomies(["Sector", "Geography", "Asset Class"])
  → Java CLI returns aggregated holdings per taxonomy value
  → LLM calls: update_google_sheet(SHEET_ID, "Sector!A1", sector_data)
  → LLM calls: update_google_sheet(SHEET_ID, "Geography!A1", geo_data)
  → LLM calls: update_google_sheet(SHEET_ID, "Asset Class!A1", asset_data)
  → notify_user("Taxonomy sheet updated. 3 sectors, 5 regions, 4 asset classes.")
```

---

## 4. Tool Schema Definitions

### 4.1 `extract_pdf_text`
```json
{
  "name": "extract_pdf_text",
  "description": "Extract text from a PDF file using OCR. Returns the extracted text.",
  "parameters": {
    "type": "object",
    "properties": {
      "file_id": {"type": "string", "description": "Telegram file_id for downloading the PDF"}
    }
  }
}
```

### 4.2 `extract_email_content`
```json
{
  "name": "extract_email_content",
  "description": "Extract and clean text from the current email, including PDF attachments.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

### 4.3 `parse_ibkr_flex_query`
```json
{
  "name": "parse_ibkr_flex_query",
  "description": "Parse an IBKR flex query XML file into a structured list of transactions.",
  "parameters": {
    "type": "object",
    "properties": {
      "xml_content": {"type": "string", "description": "Raw XML content of the flex query"}
    }
  }
}
```

### 4.4 `fetch_pp_accounts`
```json
{
  "name": "fetch_pp_accounts",
  "description": "Fetch all deposit/security accounts from Portfolio Performance XML via Java CLI.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

### 4.5 `fetch_pp_securities`
```json
{
  "name": "fetch_pp_securities",
  "description": "Fetch all securities from Portfolio Performance XML with ISIN, ticker, name, currency.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

### 4.6 `fetch_pp_portfolio`
```json
{
  "name": "fetch_pp_portfolio",
  "description": "Fetch the full portfolio structure: accounts, securities, holdings with market values.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

### 4.7 `insert_pp_transaction`
```json
{
  "name": "insert_pp_transaction",
  "description": "Insert a transaction into Portfolio Performance via Java CLI. Returns transaction ID.",
  "parameters": {
    "type": "object",
    "properties": {
      "account_id": {"type": "string", "description": "PP deposit account UUID"},
      "security_id": {"type": "string", "description": "PP security UUID (null for deposits/withdrawals)"},
      "type": {"type": "string", "enum": ["Buy", "Sell", "Dividend", "Deposit", "Withdrawal", "Fee", "Tax", "Interest"]},
      "date": {"type": "string", "description": "YYYY-MM-DD"},
      "shares": {"type": "number", "description": "Number of shares (0 for cash transactions)"},
      "price": {"type": "number", "description": "Price per share in transaction currency"},
      "currency_code": {"type": "string", "description": "ISO 4217 currency code (SGD, USD, MYR, etc.)"},
      "fees": {"type": "number", "description": "Total fees"},
      "taxes": {"type": "number", "description": "Total taxes"},
      "notes": {"type": "string", "description": "Optional notes for the transaction"}
    },
    "required": ["account_id", "type", "date", "shares", "price", "currency_code", "fees", "taxes"]
  }
}
```

### 4.8 `update_pp_balance`
```json
{
  "name": "update_pp_balance",
  "description": "Update a PP account balance to a specific amount on a given date.",
  "parameters": {
    "type": "object",
    "properties": {
      "account_id": {"type": "string", "description": "PP account UUID"},
      "amount": {"type": "number", "description": "Balance amount in account currency"},
      "currency_code": {"type": "string"},
      "date": {"type": "string", "description": "YYYY-MM-DD"},
      "notes": {"type": "string", "description": "Source of the balance (e.g., 'Actual Budget sync')"}
    },
    "required": ["account_id", "amount", "currency_code", "date"]
  }
}
```

### 4.9 `query_pp_taxonomies`
```json
{
  "name": "query_pp_taxonomies",
  "description": "Query Portfolio Performance for holdings aggregated by taxonomy values.",
  "parameters": {
    "type": "object",
    "properties": {
      "taxonomy_names": {"type": "array", "items": {"type": "string"}, "description": "Taxonomy names to query (e.g., ['Sector', 'Geography'])"}
    },
    "required": ["taxonomy_names"]
  }
}
```

### 4.10 `fetch_actual_budget_categories`
```json
{
  "name": "fetch_actual_budget_categories",
  "description": "Fetch category allocations from Actual Budget for a given budget.",
  "parameters": {
    "type": "object",
    "properties": {
      "budget_id": {"type": "string", "description": "Budget file name or ID"}
    },
    "required": ["budget_id"]
  }
}
```

### 4.11 `update_google_sheet`
```json
{
  "name": "update_google_sheet",
  "description": "Update a Google Sheet with data. Clears the specified range and writes new values.",
  "parameters": {
    "type": "object",
    "properties": {
      "spreadsheet_id": {"type": "string"},
      "range": {"type": "string", "description": "A1 notation range (e.g., 'Sector!A1:D50')"},
      "values": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}}
    },
    "required": ["spreadsheet_id", "range", "values"]
  }
}
```

### 4.12 `notify_user`
```json
{
  "name": "notify_user",
  "description": "Send a Telegram message to the user. Use for confirmations, questions, and errors.",
  "parameters": {
    "type": "object",
    "properties": {
      "message": {"type": "string"}
    },
    "required": ["message"]
  }
}
```

### 4.13 `ask_user_confirmation`
```json
{
  "name": "ask_user_confirmation",
  "description": "Ask the user a yes/no question and wait for response. Returns true/false.",
  "parameters": {
    "type": "object",
    "properties": {
      "question": {"type": "string"},
      "context": {"type": "string", "description": "Summary of what is being confirmed"}
    },
    "required": ["question", "context"]
  }
}
```

### 4.14 `check_duplicate`
```json
{
  "name": "check_duplicate",
  "description": "Check if a transaction already exists in the dedup journal.",
  "parameters": {
    "type": "object",
    "properties": {
      "date": {"type": "string"},
      "amount_cents": {"type": "integer"},
      "account_id": {"type": "string"},
      "security_id": {"type": "string"},
      "type": {"type": "string"}
    },
    "required": ["date", "amount_cents", "account_id", "type"]
  }
}
```

### 4.15 `learn_mapping`
```json
{
  "name": "learn_mapping",
  "description": "Persistently learn an association for future use.",
  "parameters": {
    "type": "object",
    "properties": {
      "type": {"type": "string", "enum": ["securities", "accounts", "categories", "brokers"]},
      "key": {"type": "string", "description": "What was matched (ticker, keyword, etc.)"},
      "value": {"type": "string", "description": "What it was matched to (PP ID, taxonomy value, etc.)"}
    },
    "required": ["type", "key", "value"]
  }
}
```

### 4.16 `log_decision`
```json
{
  "name": "log_decision",
  "description": "Log the final decision for audit trail.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {"type": "string"},
      "reasoning": {"type": "string"},
      "transaction_id": {"type": "string"}
    },
    "required": ["action", "reasoning"]
  }
}
```

---

## 5. Java CLI Design

### 5.1 Architecture

The Java CLI is a Maven project (`pp-cli/`) that depends on Portfolio Performance's model JAR (`name.abuchen.portfolio`). It loads the PP XML file, manipulates it using PP's model classes, and saves it back.

```
pp-cli/
├── pom.xml
└── src/main/java/name/abuchen/portfolio/cli/
    ├── Main.java              # Entry point, dispatches commands
    ├── PpClient.java          # Load/save XML, provide model access
    ├── AccountCommand.java    # List accounts, get by ID
    ├── SecurityCommand.java   # List securities, search by ISIN/ticker
    ├── TransactionCommand.java # Insert buy/sell/dividend/deposit/fee/tax
    ├── BalanceCommand.java    # Update account balance
    ├── TaxonomyCommand.java   # Query taxonomy aggregations
    └── PortfolioCommand.java  # Full portfolio structure dump
```

### 5.2 Commands & Output Format

All commands output JSON to stdout for Python to parse. Errors output JSON to stderr.

```bash
# List all accounts
java -jar pp-cli.jar accounts --file /data/portfolio.xml
# {"accounts":[{"id":"uuid-1","name":"IBKR SGD","currency":"SGD","type":"DEPOSIT"},...]}

# List all securities
java -jar pp-cli.jar securities --file /data/portfolio.xml
# {"securities":[{"id":"uuid-2","name":"Apple Inc.","isin":"US0378331005","ticker":"AAPL","currency":"USD"},...]}

# Insert a buy transaction
java -jar pp-cli.jar insert --file /data/portfolio.xml \
  --account-id uuid-1 --security-id uuid-2 --type Buy \
  --date 2026-06-05 --shares 100 --price 185.30 \
  --currency USD --fees 1.00 --taxes 0.00 \
  --notes "IBKR flex query import"
# {"transaction_id":"uuid-3","status":"inserted"}

# Update account balance
java -jar pp-cli.jar balance --file /data/portfolio.xml \
  --account-id uuid-4 --amount 50000.00 --currency SGD \
  --date 2026-06-05 --notes "Actual Budget emergency fund sync"
# {"status":"updated"}

# Query taxonomy
java -jar pp-cli.jar taxonomy --file /data/portfolio.xml \
  --names "Sector,Geography"
# {"taxonomies":[{"name":"Sector","values":[{"value":"Technology","market_value":125000.00,"allocation_pct":45.5,"count":8},...]},...]}

# Full portfolio dump
java -jar pp-cli.jar portfolio --file /data/portfolio.xml
# {"accounts":[...],"securities":[...],"holdings":[...]}
```

### 5.3 Safety

- Before any write, the Java CLI creates a backup: `portfolio.xml.backup`
- After write, validates the backup loads successfully
- On any write error, restores from backup
- File locking: if PP is running (file locked), exits with error code

### 5.4 Maven Dependencies

```xml
<dependency>
  <groupId>name.abuchen.portfolio</groupId>
  <artifactId>name.abuchen.portfolio</artifactId>
  <version>0.84.1</version>
</dependency>
```

The PP model JAR must be installed to local Maven repo from PP's source build.

---

## 6. System Prompt (LLM Instructions)

```
You are an investment portfolio automation agent connected to Portfolio Performance.
Your job is to process investment data from multiple sources:
- IBKR flex query XML files (uploaded via Telegram or email)
- Trade confirmation PDFs (via Telegram or email)
- Balance sync requests from Actual Budget
- Taxonomy export requests to Google Sheets

You communicate with the user via Telegram.

RULES:
1. NEVER insert a transaction unless you are confident in: type, date, security, account, shares, price, currency.
2. Always call fetch_pp_accounts() + fetch_pp_securities() before inserting.
3. Always call check_duplicate() before inserting.
4. For PDF OCR results, verify the extracted data makes sense. If OCR is garbled, notify_user().
5. For IBKR flex queries, present a confirmation summary before inserting. Wait for user approval.
6. For balance syncs, always verify the Actual Budget category exists. If not found, skip and notify.
7. For Google Sheets, format numbers as currency strings for readability.
8. After EVERY successful insert → notify_user() with a friendly summary.
9. After every ambiguous/error case → notify_user() explaining what went wrong.
10. Always explain your reasoning before making tool calls.

SECURITY MATCHING:
- Match securities by ISIN first (most reliable), then ticker, then name similarity.
- If a security is not found, ask the user with ISIN/ticker before creating.
- Do NOT guess security matches — ask if uncertain.

ACCOUNT MATCHING:
- Match accounts by broker name in the receipt/document → PP account name.
- IBKR flex queries typically go to "IBKR SGD" or "IBKR USD" accounts.
- Currency in the transaction must match the account currency.

CURRENCY HANDLING:
- Detect currency from document (SGD, USD, MYR, EUR, GBP, HKD, etc.).
- Match to PP accounts that support that currency.
- If no matching currency account, notify_user().

MEMORY:
- After every successful match, call learn_mapping().
- After user corrections, update the mapping.

WORKFLOW (per inbound event):
1. Classify intent: ibkr_flex_query | pdf_receipt | email_trade | balance_sync | taxonomy_export
2. Extract content (parse_ibkr_flex_query or extract_pdf_text or extract_email_content)
3. fetch_pp_accounts + fetch_pp_securities (parallel)
4. Match each transaction: security by ISIN/ticker, account by broker/currency
5. Present confirmation if >1 transaction or new securities
6. On approval: check_duplicate → insert_pp_transaction for each
7. notify_user with summary
8. learn_mapping for each successful match
9. log_decision
```

---

## 7. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | Yes | DeepSeek API key |
| `ACTUAL_BUDGET_URL` | Yes | Actual Budget server URL |
| `ACTUAL_BUDGET_PASSWORD` | Yes | Actual Budget server password |
| `ACTUAL_BUDGET_FILE` | Yes | SGD budget file name |
| `MYR_BUDGET_FILE` | Yes | MYR budget file name |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Yes | Authorized Telegram chat ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Yes | Path to Google service account JSON file |
| `GOOGLE_SHEET_ID` | Yes | Google Sheet ID for taxonomy export |
| `TAXONOMY_NAMES` | No | Comma-separated taxonomy names (default: "Sector,Geography,Asset Class") |
| `PP_XML_PATH` | Yes | Path to Portfolio Performance XML file |
| `AB_EMERGENCY_SGD_CATEGORY` | No | Actual Budget category name for SGD emergency fund (default: "Emergency Fund SGD") |
| `AB_EMERGENCY_MYR_CATEGORY` | No | Actual Budget category name for MYR emergency fund (default: "Emergency Fund MYR") |
| `AB_WARCHEST_CATEGORY` | No | Actual Budget category name for warchest (default: "General Investment Fund") |
| `PP_EMERGENCY_SGD_ACCOUNT` | Yes | PP account UUID for SGD emergency fund |
| `PP_EMERGENCY_MYR_ACCOUNT` | Yes | PP account UUID for MYR emergency fund |
| `PP_WARCHEST_SGD_ACCOUNT` | Yes | PP account UUID for SGD warchest |
| `DEDUP_DB_PATH` | No | Default: `data/dedup.db` |
| `MAPPINGS_PATH` | No | Default: `data/mappings.json` |
| `LOG_LEVEL` | No | Default: `INFO` |
| `BALANCE_SYNC_CRON` | No | Default: `0 9 * * *` (9 AM daily) |
| `TAXONOMY_SYNC_CRON` | No | Default: `0 10 * * *` (10 AM daily) |
| `USER_NAME` | No | User's name for notifications |
| `SYSTEM_PROMPT_EXTRA` | No | Extra instructions appended to system prompt |
| `IMAP_HOST` | No | IMAP host for email channel (default: imap.zoho.com) |
| `IMAP_PORT` | No | Default: 993 |
| `IMAP_USERNAME` | No | Burner email username |
| `IMAP_PASSWORD` | No | Burner email password |
| `NOTIFICATION_SMTP_HOST` | No | SMTP for email notifications |
| `NOTIFICATION_EMAIL` | No | User's main email |

---

## 8. Dedup Journal Schema

```sql
CREATE TABLE dedup_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT UNIQUE NOT NULL,
    correlation_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    security_id TEXT,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Hash computed over: `(date, amount_cents, account_id, security_id or '', type)`

---

## 9. Container Specifications

### Dockerfile
```
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr poppler-utils openjdk-17-jre-headless && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/
COPY pp-cli/target/pp-cli.jar ./pp-cli/
COPY config/ ./config/
RUN mkdir -p /app/data
EXPOSE 8081
CMD ["python", "-m", "src.main"]
```

---

## 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Java CLI corrupts PP XML | Low | High | Backup before write, validate load after save |
| OCR produces garbage text | Medium | Medium | LLM detects low confidence, notifies user |
| PP version upgrade breaks Java CLI | Medium | High | Pin PP version, recompile CLI against new version |
| IBKR changes flex query schema | Low | Medium | XML parser handles unknown elements gracefully |
| Google Sheets API quota exceeded | Low | Low | Retry, notify user |
| Telegram file download timeout | Low | Low | Retry with backoff |
| DeepSeek API downtime | Low | Medium | Retry 3x, leave event unprocessed, notify user |
| PP file locked by running application | Medium | Low | Java CLI detects lock, agent tells user to close PP |
