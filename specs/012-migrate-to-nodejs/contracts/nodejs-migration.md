# Contracts: Migrate Python to Node.js

**Feature**: 012-migrate-to-nodejs

## HTTP API Contracts (Unchanged)

All tool endpoint contracts are identical to the Python implementation. Verified against spec 011 contracts and spec 003 (expense-tracking).

### Tool Endpoints (Expense Tracker — port 8080)

```
POST /tools/search-memory          # Semantic search over MEMORY.md
POST /tools/learn-fact             # Append fact with dedup
POST /tools/list-facts             # Return all facts
POST /tools/update-fact            # Replace fact by match
POST /tools/delete-fact            # Remove facts by match
POST /tools/fetch-accounts         # GET AB accounts
POST /tools/fetch-categories       # GET AB categories
POST /tools/fetch-payees           # GET AB payees
POST /tools/fetch-recent-transactions  # GET recent AB transactions
POST /tools/insert-transaction     # POST AB transaction
POST /tools/check-duplicate        # Dedup journal check
POST /tools/mark-email-read        # IMAP \Seen flag
POST /tools/notify-user            # Gateway webhook
POST /tools/log-decision           # Structured log entry
POST /tools/reconcile-transaction  # Mark AB transaction cleared
POST /tools/fetch-unreconciled-transactions
POST /tools/record-statement
POST /tools/fetch-statement-history
POST /tools/check-statement-duplicate
```

### Tool Endpoints (Portfolio Tracker — port 8081)

All existing portfolio tracker tool contracts remain unchanged. Endpoints defined in spec 005-009 are preserved 1:1.

## Gateway Configuration Contract

### openclaw.json — Orchestrator Agent

```json5
{
  "agents": {
    "list": [
      {
        "id": "orchestrator",
        "thinkingDefault": "adaptive"  // was "medium"
      }
    ]
  }
}
```

**Validation**: Per OpenClaw docs (`docs/tools/thinking.md`), `adaptive` is a documented valid value. OpenClaw validates thinking levels against provider profiles at config load.

### openclaw.json — Thinker Agent

```json5
{
  "agents": {
    "list": [
      {
        "id": "thinker",
        "thinkingDefault": "max"  // unchanged
      }
    ]
  }
}
```

## Docker Compose Contract

```yaml
services:
  expense-tracker:
    build:
      context: ../modules/expense-tracker
      dockerfile: docker/Dockerfile     # Now node:22-slim (was python:3.12-slim)
    ports:
      - "127.0.0.1:8080:8080"           # Unchanged
    volumes:
      - ../modules/expense-tracker/data:/app/data  # Unchanged
      - ../modules/expense-tracker/.env:/app/.env:ro  # Unchanged
    environment:
      - ACTUAL_API_URL=http://actual-api:3000  # Unchanged

  portfolio-tracker:
    build:
      context: ../modules/portfolio-tracker
      dockerfile: docker/Dockerfile     # Now node:22-slim + openjdk (was python:3.12-slim + openjdk)
    ports:
      - "127.0.0.1:8081:8081"           # Unchanged
    volumes:                             # Unchanged
```

## package.json Contracts

### Expense Tracker

```json
{
  "name": "expense-tracker",
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@xenova/transformers": "^2.17.2",
    "openai": "^4.0.0",
    "better-sqlite3": "^11.0.0",
    "imapflow": "^1.0.0",
    "cheerio": "^1.0.0",
    "pino": "^9.0.0",
    "express": "^5.0.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

### Portfolio Tracker

Same as above, plus Google Sheets and child_process (stdlib).
