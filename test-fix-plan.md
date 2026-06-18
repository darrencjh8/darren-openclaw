# Remaining Test Failures — Context & Fix Plan

> Saved 2026-06-18 after fixing budget_id, config, imap, portfolio-tracker issues.
> 12 failures remaining (down from 44). Pino delegated to another agent.

---

## 1. `memory.test.js` — 5 failures: `add()` returns extra `compacted` field

### Root Cause: Code Drift

`MemoryStore.add()` returns THREE different shapes depending on code path:

| Path | Condition | Return |
|------|-----------|--------|
| A | Empty input | `{ added: false, skipped: false, reason: "empty fact" }` |
| B | Duplicate | `{ added: false, skipped: true, reason: "duplicate" }` |
| C | Success | `{ added: true, skipped: false, compacted }` ← **`compacted` is extra** |

- `skipped` **IS** returned (as `false` in path C). Not missing.
- `reason` **IS** returned for paths A and B. The duplicate tests already expect it and **pass**.
- The 5 failing tests all hit path C where `compacted` (a boolean, usually `false`) is present but tests use strict `.toEqual()` without it.

### Which is correct?

**Code is correct.** `compacted` was added when auto-compaction (`_compact()`) was implemented. It tells the caller whether facts were trimmed due to exceeding `maxFacts`. The test was ported from Python before this feature existed.

### Fix

Change 3 assertions from `.toEqual()` to `.toEqual(expect.objectContaining(...))`:

```js
// tests/memory.test.js lines ~291, ~325, ~337
// Before:
expect(r1).toEqual({ added: true, skipped: false });
// After:
expect(r1).toEqual(expect.objectContaining({ added: true, skipped: false }));
```

### Failing tests (5):
1. "rejects exact duplicate facts" — checks `r1` (success path C), `r2` already passes (path B)
2. "allows re-adding a fact after it was removed" — checks `r` (path C)
3. "maintains dedup set when a fact is updated" — checks `r1` (path C), `r2` already passes (path B)
4. "returns results sorted by similarity score when model is loaded" — semantic search test
5. "invalidates cache for removed facts" — cache invalidation test

(Items 4-5 may be separate issues; need to re-check after fixing 1-3.)

---

## 2. `orchestrator.test.js` — 1 failure: "skip" returns "notified" instead of "skipped"

### Root Cause: `getSubmitDecisionTool()` missing from test mocks

The orchestrator now has a **Phase 1b** step where it forces the LLM to produce structured output via a `submit_decision` tool:

```js
// src/orchestrator.js line 362
const submitTool = this._tools.getSubmitDecisionTool();
```

The test mocks (`orchestrator.test.js` line 98-103 and `deterministic-orchestrator.test.js` throughout) don't include `getSubmitDecisionTool`, causing:

```
event: "phase1_error", error: "this._tools.getSubmitDecisionTool is not a function"
```

Phase 1 throws → caught → `notify_user` called → returns `{ action: "notified" }` instead of `{ action: "skipped" }`.

### Fix

Add `getSubmitDecisionTool` to all mock tools objects in both test files. The real implementation returns:

```js
getSubmitDecisionTool() {
    const t = TOOL_MAP["submit_decision"];
    return { type: "function", function: { name: t.name, description: t.description, parameters: t.schema } };
}
```

Mock:
```js
getSubmitDecisionTool: vi.fn(() => ({
    type: "function",
    function: { name: "submit_decision", description: "...", parameters: { ... } },
})),
```

### Also affects `deterministic-orchestrator.test.js` (6 failures, SAME root cause)

Same fix — add `getSubmitDecisionTool` to mock tools objects in that file too.

---

## 3. `statement/prompts.test.js` — 1 failure: env var substitution

Test expects `STATEMENT_PROMPT` to contain `"Custom Budget"` after setting env vars, but the dynamic import doesn't pick up the stubbed env. Likely a module caching issue with `vi.stubEnv`.

---

## 4. `deterministic-orchestrator.test.js` — 6 failures (SAME as #2)

All caused by missing `getSubmitDecisionTool` in mock tools objects. Fixing #2 will fix these too.

---

## Orchestrator Flow (for reference)

```
Phase 1a: LLM info gathering loop (search_memory, fetch_accounts, fetch_categories)
    ↓
Phase 1b: Force decision via submit_decision tool (schema-enforced JSON)
    ↓  [skip/unsure → straight to Phase 2]
    ↓  [insert → Phase 1.5]
    ↓
Phase 1.5: Deterministic payee resolution
    Step 1: Memory regex ("X maps to Y payee")
    Step 2: Keyword table (matchKeyword)
    Step 3: Web search + AI classification (resolve_merchant)
    ↓  Validate account_id is active
    ↓
Phase 2: Deterministic execution
    skip   → mark_read + log → "skipped"
    unsure → notify_user (NOT marked read) → "notified"
    insert → check_duplicate → insert → mark_read → notify → learn ×3 → "inserted"
```

### Email marking safety:
- ✅ Marked read: skip, insert-success, insert-duplicate
- ❌ NOT marked read: unsure, insert-error (stays unread for retry)
