# Quickstart: Merchant Resolver

**Feature**: merchant-resolver
**Date**: 2026-06-15

## Prerequisites

- `BRAVE_SEARCH_API_KEY` configured in `modules/expense-tracker/.env` (optional — tool degrades gracefully)
- Expense-tracker and gateway containers running
- Existing 21 budget_* tools loaded (spec 014)

## Validation Scenarios

### VS-1: resolve_merchant — memory hit

```bash
# Pre-condition: MEMORY.md contains "KOUFU PTE LTD maps to Food payee"
curl -s -X POST http://localhost:8080/tools/resolve-merchant \
  -H "Content-Type: application/json" \
  -d '{"merchant":"KOUFU PTE LTD"}'
```

**Expected**: `{"payee":"Food","source":"memory"}` in under 500ms.

### VS-2: resolve_merchant — keyword match

```bash
curl -s -X POST http://localhost:8080/tools/resolve-merchant \
  -H "Content-Type: application/json" \
  -d '{"merchant":"NTUC FairPrice"}'
```

**Expected**: `{"payee":"Groceries","source":"keyword"}` in under 500ms.

### VS-3: resolve_merchant — web search (requires API key)

```bash
curl -s -X POST http://localhost:8080/tools/resolve-merchant \
  -H "Content-Type: application/json" \
  -d '{"merchant":"SGSUPERGREEN-B PTE LTD"}'
```

**Expected**: `{"payee":"...","source":"web"}` or `{"payee":"Misc","source":"fallback"}` in under 20s.

### VS-4: resolve_merchant — auto-learn

```bash
# After VS-2 or VS-3, check MEMORY.md
docker exec gateway-expense-tracker-1 cat /app/data/MEMORY.md | grep -i "maps to"
```

**Expected**: New fact matching the resolved merchant appears.

### VS-5: update_transaction — payee correction

```bash
curl -s -X POST http://localhost:8080/tools/update-transaction \
  -H "Content-Type: application/json" \
  -d '{"id":"<transaction-uuid>","payee_name":"Food","notes":"Corrected: supergreen is food"}'
```

**Expected**: `{"status":"updated","id":"<transaction-uuid>"}`.

### VS-6: update_transaction — reject unknown payee

```bash
curl -s -X POST http://localhost:8080/tools/update-transaction \
  -H "Content-Type: application/json" \
  -d '{"id":"fake-id","payee_name":"NonExistentPayee"}'
```

**Expected**: Validation error — payee rejected.

### VS-7: Plugin tools loaded

```bash
ssh darren@192.168.68.51 'docker exec gateway-openclaw-1 openclaw plugins inspect expense-tracker-tools --runtime --json | grep -E "resolve_merchant|update_transaction"'
```

**Expected**: Both `budget_resolve_merchant` and `budget_update_transaction` appear.
