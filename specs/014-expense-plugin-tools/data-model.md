# Data Model: Expense Tracker Plugin Tools

**Feature**: expense-plugin-tools
**Date**: 2026-06-15

## Entities

### Plugin Tool Registration

Each tool registered via `api.registerTool()` has the following structure:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | OpenClaw tool name, `budget_` prefixed (e.g., `budget_fetch_accounts`) |
| `description` | string | ✅ | One-line description shown to the LLM when deciding which tool to call |
| `parameters` | TypeBox Object | ✅ | JSON Schema defining the tool's input parameters |
| `execute` | async function | ✅ | Handler that makes a POST request to the expense-tracker and returns the result |

### Plugin Configuration (openclaw.json)

```json5
{
  "plugins": {
    "entries": {
      "expense-tracker-tools": {
        "enabled": true
      }
    }
  }
}
```

### Plugin Manifest (openclaw.plugin.json)

```json5
{
  "id": "expense-tracker-tools",
  "name": "Expense Tracker Tools",
  "description": "Direct tool bindings for the expense-tracker REST API",
  "contracts": {
    "tools": [
      "budget_fetch_accounts",
      "budget_fetch_categories",
      // ... all 21 tool names
    ]
  },
  "activation": {
    "onStartup": true
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

### Tool Categories

Tools are grouped by functional category in the SKILL.md (not in the plugin itself):

| Category | Count | Tools |
|---|---|---|
| Budget & Transactions | 6 | `budget_fetch_accounts`, `budget_fetch_categories`, `budget_fetch_payees`, `budget_fetch_recent_transactions`, `budget_insert_transaction`, `budget_check_duplicate` |
| Memory & Learning | 5 | `budget_search_memory`, `budget_learn_fact`, `budget_list_facts`, `budget_update_fact`, `budget_delete_fact` |
| Documents | 4 | `budget_extract_pdf_text`, `budget_extract_email_content`, `budget_mark_email_read`, `budget_notify_user` |
| Statement | 5 | `budget_reconcile_transaction`, `budget_fetch_unreconciled`, `budget_record_statement`, `budget_fetch_statement_history`, `budget_check_statement_duplicate` |
| Audit | 1 | `budget_log_decision` |

### HTTP Endpoint Mapping

Each tool maps to an expense-tracker HTTP endpoint. The plugin owns this mapping. The expense-tracker API is unchanged.

| OpenClaw Tool | HTTP Endpoint | Key Parameters |
|---|---|---|
| `budget_fetch_accounts` | `/tools/fetch-accounts` | `budget_id?` |
| `budget_fetch_categories` | `/tools/fetch-categories` | `budget_id?` |
| `budget_fetch_payees` | `/tools/fetch-payees` | `budget_id?` |
| `budget_fetch_recent_transactions` | `/tools/fetch-recent-transactions` | `budget_id?, account_id?, days?` |
| `budget_insert_transaction` | `/tools/insert-transaction` | `budget_id?, account_id, date, amount_cents, imported_description, category_id?, notes?` |
| `budget_check_duplicate` | `/tools/check-duplicate` | `date, amount_cents, account_id, payee_name?, budget_id?` |
| `budget_search_memory` | `/tools/search-memory` | `query` |
| `budget_learn_fact` | `/tools/learn-fact` | `fact` |
| `budget_list_facts` | `/tools/list-facts` | *(none)* |
| `budget_update_fact` | `/tools/update-fact` | `old_text, new_text` |
| `budget_delete_fact` | `/tools/delete-fact` | `match_text` |
| `budget_extract_pdf_text` | `/tools/extract-pdf-text` | `pdf_bytes_b64, password?` |
| `budget_extract_email_content` | `/tools/extract-email-content` | `include_headers?` |
| `budget_mark_email_read` | `/tools/mark-email-read` | *(none)* |
| `budget_notify_user` | `/tools/notify-user` | `message` |
| `budget_log_decision` | `/tools/log-decision` | `action, reasoning, transaction_id?` |
| `budget_reconcile_transaction` | `/tools/reconcile-transaction` | `ab_transaction_id, statement_ref?, budget_id?` |
| `budget_fetch_unreconciled` | `/tools/fetch-unreconciled-transactions` | `account_id, date_from, date_to, budget_id?` |
| `budget_record_statement` | `/tools/record-statement` | `account_id, period_start, period_end, matched_count, outlier_count, budget_id?, total_amount_cents?, due_date?, currency?` |
| `budget_fetch_statement_history` | `/tools/fetch-statement-history` | `account_id, period_start, period_end` |
| `budget_check_statement_duplicate` | `/tools/check-statement-duplicate` | `date, amount_cents, account_id, budget_id?` |

### State & Persistence

The plugin itself has **no persistent state**. All state lives in the expense-tracker container (dedup.db, statement.db, MEMORY.md). The plugin is a pure function: parameters in → HTTP call → response out.

### Docker Integration

```yaml
# docker-compose.yml (openclaw service)
volumes:
  - ./plugins/expense-tracker-tools:/home/node/plugins/expense-tracker-tools:ro
```

The bind-mount makes the plugin source available inside the container at a fixed path. The `:ro` flag prevents the gateway process from modifying plugin source.
