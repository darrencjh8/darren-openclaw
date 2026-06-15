# Plugin Contract: expense-tracker-tools

**Feature**: expense-plugin-tools
**Date**: 2026-06-15

## Tool Schema Contract

The plugin exposes 21 tools to the Gateway agent. Each tool follows the OpenClaw tool contract:
- **Name**: `budget_<name>` (snake_case, `budget_` prefix)
- **Parameters**: TypeBox Object schema → JSON Schema at runtime
- **Return**: `{ content: [{ type: "text", text: "<response>" }] }`

### Example: budget_fetch_accounts

```typescript
// Registration
api.registerTool({
  name: "budget_fetch_accounts",
  description: "Fetch all accounts from Actual Budget. Optionally filter by budget_id.",
  parameters: Type.Object({
    budget_id: Type.Optional(Type.String({
      description: "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
    })),
  }),
  async execute(_id, params) {
    const body = JSON.stringify(params);
    const res = await fetch("http://expense-tracker:8080/tools/fetch-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
});
```

### HTTP Contract

Every tool makes a POST request to `http://expense-tracker:8080/tools/<endpoint>` with:
- **Headers**: `Content-Type: application/json`
- **Body**: JSON-serialized parameters (empty object `{}` for no-param tools)
- **Response**: Raw text from expense-tracker (typically JSON), passed through to agent

### Error Contract

The plugin does not transform errors. HTTP errors (4xx, 5xx) and network errors (connection refused) are propagated as tool results. The Gateway agent handles error interpretation.

### Activation Contract

- The plugin is enabled via `plugins.entries.expense-tracker-tools.enabled: true` in `openclaw.json`
- Tools are required (non-optional) — always available when plugin is loaded
- Plugin loads on gateway startup (`activation.onStartup: true`)
