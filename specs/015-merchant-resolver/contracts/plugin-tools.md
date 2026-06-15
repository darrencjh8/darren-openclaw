# Plugin Contracts: resolve_merchant and update_transaction

**Feature**: merchant-resolver
**Date**: 2026-06-15

## resolve_merchant

**HTTP**: `POST /tools/resolve-merchant`
**Body**: `{ "merchant": "string" }`
**Response**: `{ "payee": "string", "source": "memory"|"keyword"|"web"|"fallback" }`

### Gateway Plugin: budget_resolve_merchant

```js
api.registerTool({
  name: "budget_resolve_merchant",
  description: "Resolve a raw merchant name to a canonical payee using memory, keywords, or web search.",
  parameters: Type.Object({
    merchant: Type.String({ description: "Raw merchant name from transaction" }),
  }),
  async execute(_id, params) {
    const res = await fetch("http://expense-tracker:8080/tools/resolve-merchant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
});
```

## update_transaction

**HTTP**: `POST /tools/update-transaction`
**Body**: `{ "id": "string", "budget_id?": "string", "payee_name?": "string", "notes?": "string", "amount?": "number", "date?": "string", "category_id?": "string", "account_id?": "string" }`
**Response**: `{ "status": "updated", "id": "string" }` or `{ "error": "string" }`

### actual-api: PATCH /transactions/:id

**Body**: Partial transaction fields (payee, notes, amount, date, category, account, cleared)
**Response**: `{ "status": "updated", "id": "string" }`

### Gateway Plugin: budget_update_transaction

```js
api.registerTool({
  name: "budget_update_transaction",
  description: "Update an existing transaction's fields. At least one field must be provided.",
  parameters: Type.Object({
    id: Type.String({ description: "Transaction UUID from Actual Budget" }),
    budget_id: Type.Optional(Type.String({ description: "Budget file name" })),
    payee_name: Type.Optional(Type.String({ description: "New payee name" })),
    notes: Type.Optional(Type.String({ description: "Updated notes" })),
    amount: Type.Optional(Type.Number({ description: "Updated amount in cents" })),
    date: Type.Optional(Type.String({ description: "Updated date YYYY-MM-DD" })),
    category_id: Type.Optional(Type.String({ description: "Updated category UUID" })),
    account_id: Type.Optional(Type.String({ description: "Updated account UUID" })),
  }),
  async execute(_id, params) {
    const res = await fetch("http://expense-tracker:8080/tools/update-transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
});
```
