# Data Model: Merchant Resolver

**Feature**: merchant-resolver
**Date**: 2026-06-15

## Entities

### resolve_merchant Tool

| Field | Type | Required | Description |
|---|---|---|---|
| `merchant` | string | ✅ | Raw merchant name from transaction email |
| `budget_id` | string | ❌ | Budget file name (e.g., "Darren SGD") — used for payee validation |
| → `payee` | string | ✅ | Resolved payee name or "Misc" |
| → `source` | enum | ✅ | `"memory"`, `"keyword"`, `"web"`, or `"fallback"` |

**Pipeline states**:

```
INPUT: merchant string
  → STEP 1: MemoryStore.search(merchant) — hit? → return { payee, source: "memory" }
  → STEP 2: KeywordTable.match(merchant) — hit? → learn → return { payee, source: "keyword" }
  → STEP 3: BraveSearch(merchant) → DeepSeek.classify(snippets, payeeList) → return { payee, source: "web" }
  → STEP 4: return { payee: "Misc", source: "fallback" }
```

### update_transaction Tool

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | Transaction UUID in Actual Budget |
| `budget_id` | string | ❌ | Budget file name |
| `payee_name` | string | ❌ | New payee name (validated) |
| `notes` | string | ❌ | Updated notes |
| `amount` | number | ❌ | Updated amount in cents |
| `date` | string | ❌ | Updated date YYYY-MM-DD |
| `category_id` | string | ❌ | Updated category UUID (validated) |
| `account_id` | string | ❌ | Updated account UUID |

**Validation**: At least one optional field required. Payee validated against live payee list (reject unknown). Category validated against live category list (reject unknown).

### Keyword Table (src/keywords.js)

```js
export const KEYWORD_TABLE = {
  Food: ["hawker", "food", "restaurant", "cafe", "kitchen", "eatery", "dining", "kopitiam"],
  Transport: ["petrol", "shell", "caltex", "spc", "esso", "grab", "taxi", "bus", "mrt", "ride", "gojek"],
  Groceries: ["grocery", "ntuc", "fairprice", "supermarket", "cold storage"],
  Utilities: ["water", "electric", "utility", "internet", "phone", "bill", "telco", "telecom"],
  Coffee: ["coffee", "starbucks", "bubble tea"],
  Shopping: ["shopping", "clothes", "mall", "retail", "shopee"],
  Healthcare: ["doctor", "medical", "pharmacy", "clinic", "watson", "guardian"],
};
```

### PATCH /transactions/:id (actual-api)

| Field | Type | Description |
|---|---|---|
| `payee` | string | Payee name (optional) |
| `notes` | string | Transaction notes (optional) |
| `amount` | number | Amount in cents (optional) |
| `date` | string | Date YYYY-MM-DD (optional) |
| `category` | string | Category UUID (optional) |
| `account` | string | Account UUID (optional) |
| `cleared` | boolean | Cleared status (optional) |

Only provided fields are updated. Omitted fields are left unchanged. The endpoint calls `actual.updateTransaction(id, fields)`.

### Transaction Validation Rules

| Context | Payee unknown | Category unknown |
|---|---|---|
| `insert_transaction` | → "Misc" | → "Fun Money" |
| `update_transaction` | → reject (400) | → reject (400) |
