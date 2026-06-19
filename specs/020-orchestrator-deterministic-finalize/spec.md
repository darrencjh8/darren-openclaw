# Feature Specification: Deterministic Orchestrator Finalization

**Feature:** orchestrator-deterministic-finalize
**Spec Version:** 2.0.0
**Status:** Draft
**Created:** 2026-06-16
**Constitution Hash:** v4.0.0

---

## Problem

The current `AgentOrchestrator.processEmail()` delegates **everything** to the LLM via a tool-call loop (max 5 iterations). The LLM decides which tools to call, when to stop, and how to report. This violates the original design (design.md §5.5) which specified:

1. **Tool Call Loop** — LLM gathers information only
2. **After Loop** — Deterministic code handles: check_duplicate → insert_transaction → mark_read → notify_user → log_decision

Additionally, `resolve_merchant` (added in spec 015) is called by the LLM even when `search_memory` already has a payee mapping. The LLM shouldn't decide *whether* to resolve — the code should short-circuit when memory already has the answer.

### Concrete Failures

| Symptom | Cause |
|---|---|
| LLM re-checks duplicates after inserting | No deterministic guard — LLM keeps iterating |
| LLM reports "skipping silently" after successful insert | LLM confused by its own duplicate check result |
| LLM sometimes forgets notify_user or learn_fact | LLM non-deterministic behavior |
| `resolve_merchant` called even when memory has answer | LLM decides whether to call, wastes API calls |
| Unnecessary iteration 2 always runs | Orchestrator can't tell when work is done |

---

## Design

### New Flow (3 Phases)

```
Email arrives (already classified as "transaction")
│
├── Phase 1: LLM ANALYSIS
│   │  LLM receives: system prompt + email content
│   │  LLM can call: search_memory, fetch_accounts, fetch_categories
│   │  LLM returns: structured JSON with extracted fields
│   │
│   └── Output: { action, merchant, raw_description, amount_cents,
│                  date, currency, account_hint, notes, reasoning,
│                  notify_message }
│
├── Phase 1.5: DETERMINISTIC PAYEE RESOLUTION (no LLM)
│   │
│   │  // Step 1: Check if search_memory already returned a mapping
│   │  memoryPayee = findPayeeInMemoryResults(searchMemoryResults)
│   │  if (memoryPayee) → payee = memoryPayee, source = "memory"
│   │
│   │  // Step 2: Check hardcoded keyword table
│   │  keywordPayee = matchKeyword(merchant)
│   │  if (keywordPayee) → payee = keywordPayee, source = "keyword"
│   │                    → auto-learn to MEMORY.md
│   │
│   │  // Step 3: Last resort — web search + LLM classify
│   │  if (neither matched) → payee = resolve_merchant(merchant)
│   │                         → auto-learn if source = "web"
│   │
│   │  // Step 4: Match category from payee name
│   │  category_id = matchCategory(payee, categories) // or null → skip category
│   │
│   └── Result: { payee_name, category_id?, payee_source }
│
├── Phase 2: DETERMINISTIC EXECUTION (no LLM)
│   │
│   ├── action = "insert"
│   │   ├── check_duplicate() [automatic, not an LLM tool]
│   │   │   ├── duplicate → mark_read, log "duplicate", stop
│   │   │   └── not duplicate → continue
│   │   ├── insert_transaction(account, payee, category, amount, date)
│   │   ├── mark_email_read()
│   │   ├── notify_user(notify_message)
│   │   ├── learn_fact() × 3
│   │   └── log_decision("inserted")
│   │
│   ├── action = "skip" (promo, non-expense)
│   │   ├── mark_email_read()
│   │   └── log_decision("skipped")
│   │
│   └── action = "unsure" (can't extract details)
│       ├── notify_user(explanation)
│       └── DO NOT mark as read
│
└── Return result
```

### Phase 1.5: Payee Resolution Logic (in detail)

```javascript
async function resolvePayee(merchant, searchMemoryResults, budgetId) {
  // Step 1: Memory hit — search_memory already returned a mapping
  for (const r of searchMemoryResults) {
    const match = r.text.match(/maps to (.+?) payee/i);
    if (match) return { payee: match[1], source: "memory" };
  }

  // Step 2: Keyword table (hardcoded, no LLM, no API)
  const kw = matchKeyword(merchant);  // from keywords.js
  if (kw) {
    await memory.add(merchant + " maps to " + kw + " payee");
    return { payee: kw, source: "keyword" };
  }

  // Step 3: Brave web search + LLM classify (expensive, last resort)
  const result = await resolveMerchant(merchant, budgetId);
  // result: { payee, source: "web"|"fallback" }
  // auto-learning happens inside resolve_merchant
  return result;
}
```

### Tool Visibility Changes

| Tool | Phase 1 (LLM sees) | Phase 1.5 (code only) | Phase 2 (code only) |
|---|---|---|---|
| `search_memory` | ✅ | reads results | — |
| `fetch_accounts` | ✅ | — | — |
| `fetch_categories` | ✅ | — | — |
| `resolve_merchant` | ❌ hidden | ✅ calls if needed | — |
| `check_duplicate` | ❌ hidden | — | ✅ automatic |
| `insert_transaction` | ❌ hidden | — | ✅ automatic |
| `mark_email_read` | ❌ hidden | — | ✅ automatic |
| `notify_user` | ❌ hidden | — | ✅ automatic |
| `learn_fact` | ❌ hidden | — | ✅ automatic |
| `log_decision` | ❌ hidden | — | ✅ automatic |

### LLM Output Schema (Phase 1 → 1.5)

The LLM returns structured JSON — no execution tools:

```json
{
  "action": "insert",
  "merchant": "SGSUPERGREEN-B PTE LTD",
  "raw_description": "SGSUPERGREEN-B PTE LTD | UOB alert SGD",
  "amount_cents": -1030,
  "date": "2026-06-16",
  "currency": "SGD",
  "account_id": "uuid-from-fetch_accounts",
  "notes": "UOB Ladies card",
  "reasoning": "S$10.30 at SGSUPERGREEN-B on UOB Ladies credit card",
  "notify_message": "Got a UOB alert — S$10.30 at SGSUPERGREEN-B. Logged under Misc! 💳"
}
```

Actions: `"insert"`, `"skip"`, `"unsure"`

Note: `payee_name` and `category_id` are NOT in the LLM output — they are resolved deterministically in Phase 1.5.

### System Prompt Changes

The system prompt no longer describes payee matching rules or `resolve_merchant` as a tool. The LLM only needs to:

1. Extract: merchant, amount, currency, date, account hint
2. Call: `search_memory`, `fetch_accounts`, `fetch_categories`
3. Return: structured JSON

All payee/category resolution happens in code. The prompt shrinks significantly.

---

## User Stories

### US-1: Single-Pass LLM Analysis (Priority: P1)

**As a** system that processes transaction emails,
**I want** the LLM to analyze the email in one pass and return structured extracted fields,
**So that** the LLM never decides execution — only extraction.

**Acceptance Criteria:**
- [ ] LLM tool list is only: `search_memory`, `fetch_accounts`, `fetch_categories`
- [ ] LLM returns JSON with `action`, `merchant`, `amount_cents`, `date`, `currency`, `account_id`, `notify_message`
- [ ] Orchestrator does NOT loop — after Phase 1 returns, Phase 1.5 + 2 run deterministically
- [ ] `resolve_merchant`, `check_duplicate`, `insert_transaction`, `notify_user`, `learn_fact`, `log_decision`, `mark_email_read` are NOT in the LLM's tool list

### US-2: Deterministic Payee Resolution (Priority: P1)

**As a** system that matches merchants to payees,
**I want** payee resolution to follow a fixed 3-step pipeline enforced by code,
**So that** the same merchant always maps to the same payee, and `resolve_merchant` is only called when both memory and keywords fail.

**Acceptance Criteria:**
- [ ] Step 1: `search_memory` results checked for existing payee mappings → if found, use it
- [ ] Step 2: `matchKeyword()` from `keywords.js` → if match, auto-learn and use it
- [ ] Step 3: `resolve_merchant()` → only called if steps 1-2 fail
- [ ] LLM cannot call `resolve_merchant` (not in tool list)
- [ ] Payee resolution runs between Phase 1 and Phase 2, not during LLM analysis

### US-3: Deterministic Duplicate Checking (Priority: P1)

**As a** user who wants clean data,
**I want** duplicate checking to be automatic and unavoidable,
**So that** the LLM can never skip or forget the duplicate check.

**Acceptance Criteria:**
- [ ] `check_duplicate` runs automatically before every `insert_transaction` in Phase 2
- [ ] If duplicate → mark as read, log "duplicate", no notification
- [ ] REST endpoints unchanged for Gateway plugin compatibility

### US-4: Deterministic Post-Insert Actions (Priority: P2)

**As a** user who wants consistent behavior,
**I want** notify_user, learn_fact, and log_decision to run automatically after every insert,
**So that** no LLM forgetfulness can skip these steps.

**Acceptance Criteria:**
- [ ] After every insert: notify, learn × 3, log_decision run in fixed order
- [ ] LLM only provides `notify_message` text and `reasoning` for log_decision
- [ ] learn_fact calls use resolved fields: account type, payee mapping, category mapping

### US-5: Backward Compatibility (Priority: P2)

**As a** system with existing plugin tools,
**I want** the REST API endpoints to remain functional,
**So that** the Gateway plugin and any external callers continue to work.

**Acceptance Criteria:**
- [ ] All `/tools/*` endpoints remain registered and functional
- [ ] `insert_transaction`, `check_duplicate`, `resolve_merchant` endpoints still work
- [ ] `notify_user`, `learn_fact`, `log_decision`, `mark_email_read` endpoints remain
- [ ] Gateway plugin tools unchanged

---

## Non-Goals

- Changing the StatementProcessor (separate pipeline, spec 004)
- Changing the IMAP handler or dedup journal
- Changing the Gateway plugin tools
- Removing any existing REST endpoints
- Changing the classification flow (classify.js dispatchEmail)
- Changing the `resolve_merchant` internal pipeline (spec 015)

---

## Risks

| Risk | Mitigation |
|---|---|
| LLM returns malformed JSON | Validate schema; on failure, fall back to `notify_user` and leave unread |
| LLM hallucinates account_id not in fetch_accounts result | Validate account_id exists; if not, treat as `unsure` |
| `resolve_merchant` is called too often (memory/keyword misses) | The 3-step pipeline ensures it's last resort; auto-learning reduces future calls |
| Structured output increases token usage | The JSON output is smaller than multiple tool-call roundtrips; net savings expected |
| Breaking existing tests | Update orchestrator + prompts tests; Phase 1.5 logic has its own test suite |
| `search_memory` returns facts without payee mappings | Step 1 checks for regex match; non-matching facts are ignored, falls through to keyword step |
