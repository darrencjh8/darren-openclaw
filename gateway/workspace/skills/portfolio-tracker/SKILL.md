---
name: portfolio-tracker
description: Manage Portfolio Performance investments via HTTP API.
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
| `pp-taxonomies` | `{taxonomy_names:["Sector","Geography"]}` | Query holdings by taxonomy |
| `pp-status` | `{}` | Portfolio performance: holdings with prices, total value |
| `pp-query-security` | `{search:"NVDA"}` | Query security by ticker/ISIN/name: shares, avg entry, price, value |

### IBKR & Documents

| Tool | Args | Description |
|---|---|---|
| `ibkr-import-xml` | `{xml_content:"<FlexQueryResponse>..."}` | Parse IBKR flex query XML into structured transactions |
| `extract-pdf-text` | `{pdf_bytes_b64:"..."}` | OCR a PDF trade confirmation |
| `extract-email-content` | `{}` | Extract text from current email (with PDF attachment support) |

### Actual Budget & Google Sheets

| Tool | Args | Description |
|---|---|---|
| `ab-categories` | `{budget_id:"Darren SGD"}` | Fetch categories/allocations from Actual Budget |
| `gs-update-sheet` | `{spreadsheet_id, range, values}` | Update Google Sheets (taxonomy export) |

### General

| Tool | Args | Description |
|---|---|---|
| `notify-user` | `{message:"..."}` | Send Telegram notification |
| `check-duplicate` | `{date, amount_cents, account_id, security_id?, type}` | Check if transaction exists |
| `learn-mapping` | `{type, key, value}` | Record a learned association |
| `log-decision` | `{action, reasoning, transaction_id?}` | Audit log entry |

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
2. Call `ibkr-import-xml` to parse XML into structured transactions
3. Call `pp-accounts` + `pp-securities` in parallel to match securities
4. Present confirmation summary to user
5. On approval: call `check-duplicate` → `pp-insert-transaction` for each
6. Call `notify-user` with summary
7. Call `learn-mapping` for each match
8. Call `log-decision`

## Balance Sync Workflow (/sync)

1. Call `ab-categories` for "Darren SGD" + "Darren MYR" in parallel
2. Extract Emergency Fund SGD, Emergency Fund MYR, General Investment amounts
3. Call `pp-update-balance` for each of the 3 PP accounts
4. Call `notify-user` with updated balances

## Security Matching Rules

- Match by ISIN first (most reliable)
- Then by ticker symbol
- If security not found, ask user before creating
- Match accounts by broker name/currency
- Currency in transaction must match account currency

## Multi-Currency

PP accounts span SGD, USD, MYR, GBP. Always check account currency before inserting.
