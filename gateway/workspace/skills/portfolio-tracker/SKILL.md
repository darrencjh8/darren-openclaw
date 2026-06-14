---
name: portfolio-tracker
description: Manage Portfolio Performance investments via HTTP API.
metadata:
  api_base: http://portfolio-tracker:8081
user-invocable: true
---

# Portfolio Tracker Skill

You manage an investment portfolio in Portfolio Performance. ALL tools are at `http://portfolio-tracker:8081/tools/<name>`.

## CRITICAL: exec Rules

`exec` may ONLY be used for `curl` commands to `http://portfolio-tracker:8081/tools/*`.
NEVER use exec for find, cat, ls, grep, or any other command. Only `curl` to the portfolio-tracker API.

Send curl calls in PARALLEL when the calls are independent (e.g., pp-accounts + pp-securities together).

## Date Format

ALL dates MUST be `YYYY-MM-DD`.

## How to Call a Tool

```
exec: curl -s -X POST http://portfolio-tracker:8081/tools/<name> -H "Content-Type: application/json" -d '<json>'
```

## Available Tools

### Portfolio Performance (PP)

| Tool | Args | Description |
|---|---|---|
| `pp-accounts` | `{}` | List all accounts with UUIDs, names, currencies |
| `pp-securities` | `{}` | List all securities with ISIN, ticker, currency |
| `pp-portfolio` | `{}` | Full portfolio structure (accounts + securities + holdings) |
| `pp-insert-transaction` | `{account_id, security_id?, type(Buy\|Sell\|Dividend\|Deposit\|Withdrawal\|Fee\|Tax\|Interest), date, shares, price, currency_code, fees, taxes, notes?}` | Insert a transaction into PP |
| `pp-update-balance` | `{account_id, amount, currency_code, date, notes?}` | Update an account balance |
| `pp-taxonomies` | `{taxonomy_names:["Regions (Liquid)"]}` | Query holdings by taxonomy — returns per-currency native values |
| `pp-status` | `{}` | Portfolio performance: holdings with prices, total value |
| `pp-query-security` | `{search:"NVDA"}` | Query security by ticker/ISIN/name: shares, avg entry, price, value |
| `pp-pull` | `{}` | Pull latest PP file from OneDrive |
| `pp-push` | `{}` | Push PP file to OneDrive |

### IBKR & Documents

| Tool | Args | Description |
|---|---|---|
| `ibkr-import-xml` | `{xml_content:"<FlexQueryResponse>..."}` | Parse IBKR flex query XML into structured transactions |
| `extract-pdf-text` | `{pdf_bytes_b64:"..."}` | OCR a PDF trade confirmation |
| `extract-email-content` | `{}` | Extract text from current email (with PDF attachment support) |

### Actual Budget & Google Sheets

| Tool | Args | Description |
|---|---|---|
| `pp-sync-all` | `{}` | Compute all AB balance sync targets + export taxonomies to Google Sheets |
| `gs-update-sheet` | `{spreadsheet_id, range, values}` | Update Google Sheets (taxonomy export) |

### General

| Tool | Args | Description |
|---|---|---|
| `notify-user` | `{message:"..."}` | Send Telegram notification |
| `check-duplicate` | `{date, amount_cents, account_id, security_id?, type}` | Check if transaction exists |
| `learn-mapping` | `{type, key, value}` | Record a learned association |
| `log-decision` | `{action, reasoning, transaction_id?}` | Audit log entry |
| `ask-user-confirmation` | `{question:"Proceed with 3 trades?", options:["Approve","Reject"]}` | Ask user a yes/no question via Telegram |

## Taxonomy Export (/sheet)

`pp-sync-all` automatically exports taxonomy data to Google Sheets as Step 4:

1. Java queries taxonomy (Regions (Liquid)) → native values per classification per currency
2. Live exchange rates fetched from open.er-api.com (USD, MYR, GBP, EUR → SGD)
3. Classification→cell mapping from TAXONOMY_SHEET_MAPPING env:
   - America → G2
   - Developed ex-US → G3
   - Emerging → G4
   - Crypto → G5
   - Investable Cash → B4
4. Values written to Google Sheet with service account auth

No LLM orchestration needed — sheet writes are fully programmatic.

## Portfolio Query Workflow

When user asks about a security (e.g., "what's my NVDA position?"):

```
exec: curl -s -X POST http://portfolio-tracker:8081/tools/pp-query-security -H "Content-Type: application/json" -d '{"search":"NVDA"}'
```

Respond with: "NVDA: X shares @ $Y.ZZ avg entry. Current value $A,AAA."

When user asks for portfolio status (/status):

```
exec: curl -s -X POST http://portfolio-tracker:8081/tools/pp-status -H "Content-Type: application/json" -d '{}'
```

Respond with top holdings by value and total.

## IBKR Flex Query Workflow

1. User sends IBKR flex query XML → Gateway receives via Telegram
2. Call `pp-pull` — always pull latest PP file from OneDrive first
3. Call `ibkr-import-xml` to parse XML into structured transactions
4. Call `pp-accounts` + `pp-securities` in parallel to match securities
5. Present confirmation summary to user
6. On approval: call `check-duplicate` → `pp-insert-transaction` for each
7. Call `pp-push` — persist changes to OneDrive BEFORE running sync
8. Call `pp-sync-all` — sync AB balances + export taxonomy to Google Sheets
9. Call `notify-user` with summary
10. Call `learn-mapping` for each match
11. Call `log-decision`

## Balance Sync Workflow (/sync)

CRITICAL: DO NOT SWAP BUDGET VALUES. THIS IS THE MOST COMMON BUG.
- SGD budget response → EMERGENCY SGD ACCOUNT ONLY (verify via PP account UUID config)
- MYR budget response → EMERGENCY MYR ACCOUNT ONLY (verify via PP account UUID config)
- Each response says its budget_name. Match budget_name to account currency.
- SGD budget = SGD amounts → SGD accounts. MYR budget = MYR amounts → MYR accounts.
- The response includes exact account_mapping. USE IT EXACTLY.

1. Call `pp-sync-all` — this does the entire sync in one shot (fetch budgets + update PP + export taxonomies)
2. Call `notify-user` with the deltas from the response

## Trade Email with Missing PDF

If a trade email arrives with no PDF attachment → call `notify-user` asking the user to forward the PDF via Telegram. The email is marked read automatically by the dispatch wrapper — do NOT call `mark-email-read`.

User forwards PDF via Telegram → gateway activates this skill:
1. Call `extract-pdf-text` with `pdf_bytes_b64` from gateway
2. Match securities by ISIN/ticker (as normal trade workflow)
3. Call `check-duplicate` → `pp-insert-transaction`
4. Call `notify-user` with summary
5. Call `learn-mapping` for each match

## Security Matching Rules

- Match by ISIN first (most reliable)
- Then by ticker symbol
- If security not found, ask user before creating
- Match accounts by broker name/currency
- Currency in transaction must match account currency

## Multi-Currency

PP accounts span SGD, USD, MYR, GBP. Always check account currency before inserting.
