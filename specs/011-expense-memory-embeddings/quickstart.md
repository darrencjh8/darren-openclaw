# Quickstart: Expense Tracker Memory with Embeddings

**Feature**: 011-expense-memory-embeddings

## Prerequisites

- Python 3.12 with `.venv/` activated
- `uv pip install -r modules/expense-tracker/requirements.txt`
- Running `actual-api` container (or mock) for fetch tools
- IMAP test inbox configured (or `pytest` with mocks)

## Setup

```bash
# Set configurable memory path (optional)
export MEMORY_PATH=data/memory-test.md

# Default: data/MEMORY.md relative to working dir
cd modules/expense-tracker
```

## Verification Scenarios

### 1. Cold Start: Empty MEMORY.md

```bash
# Remove any existing memory file
rm -f data/MEMORY.md data/mappings.json

# Run unit test
uv run pytest tests/test_memory.py::test_empty_memory_returns_no_results -v
```

**Expected outcome:**
- `search_memory("anything")` returns `{"results": []}`
- No crash, no error
- `learn_fact("DBS Yuu is a debit card")` succeeds (first fact seeded)

### 2. Self-Learning with Dedup

```bash
uv run pytest tests/test_memory.py -v -k "learn_fact"
```

**Expected outcome:**
- `learn_fact("Grab → Transport")` → `added: true`
- `learn_fact("Grab → Transport")` again → `added: false, skipped: true` (dedup)
- MEMORY.md contains exactly one "Grab" line

### 3. Semantic Search Across Variations

```bash
uv run pytest tests/test_memory.py::test_semantic_search_variations -v
```

**Expected outcome:**
- Seed fact: "Card ending 4605 belongs to UOB Ladies credit card"
- Query "UOB card 4605" → returns the fact (score > 0.8)
- Query "what account is 4605" → returns the fact (score > 0.7)
- Query "DBS account" → empty (no match)

### 4. Notification Cooldown

```bash
uv run pytest tests/test_cooldown.py -v
```

**Expected outcome:**
- First `notify_user` for `msg_123` → allowed
- Second `notify_user` for `msg_123` within 1 hour → suppressed
- `update-fact(...)` called → cooldown cleared
- Third `notify_user` for `msg_123` after clear → allowed

### 5. Full Email Processing with Memory

```bash
# Requires live IMAP + Actual Budget or mocked
uv run pytest tests/test_agent_e2e.py::test_email_with_memory_lookup -v
```

**Expected outcome:**
1. Seed MEMORY.md with "DBS Yuu is a debit card" and "Toast Box → Food"
2. Send test email: "S$12.80 at Toast Box from DBS Yuu account ending 1234"
3. Agent calls `search_memory("DBS Yuu")` → gets fact
4. Agent calls `search_memory("Toast Box")` → gets fact
5. Transaction inserted with correct account + payee
6. `learn_fact` called × 3 (account, payee, category)
7. No duplicate entries in MEMORY.md after processing

### 6. User Correction via HTTP Tools

```bash
uv run pytest tests/test_tools.py::test_user_correction_flow -v
```

**Expected outcome:**
1. `list-facts` → returns all learned facts
2. `update-fact(old, new)` → replaces fact, returns `updated: true`
3. `search_memory(query)` → returns corrected fact
4. `delete-fact(match)` → removes fact, `search_memory` no longer returns it

### 7. System Prompt Validation

```bash
# Verify prompt structure
uv run python -c "
from src.agent.prompts import SYSTEM_PROMPT
assert 'RULES:' in SYSTEM_PROMPT
assert 'MATCHING' in SYSTEM_PROMPT
assert 'WORKFLOW' in SYSTEM_PROMPT
assert 'search_memory' in SYSTEM_PROMPT
assert 'learn_fact' in SYSTEM_PROMPT
assert 'learn_mapping' not in SYSTEM_PROMPT  # old tool removed
print('Prompt structure: OK')
"
```

**Expected outcome:** All assertions pass — prompt is restructured, old tools removed, new tools present.

### 8. Migration from mappings.json

```bash
rm -f data/MEMORY.md
echo '{"accounts":{"DBS Yuu":"debit card"},"payees":{"toast box":"Food"}}' > data/mappings.json
uv run python -c "
from src.agent.memory import MemoryStore
store = MemoryStore()
print(open(store.path).read())
"
```

**Expected outcome:** MEMORY.md created with:
```markdown
## Facts

- DBS Yuu is a debit card account
- toast box merchant maps to Food payee
```

## Integration Test (Docker)

```bash
cd gateway
docker compose build expense-tracker
docker compose up -d expense-tracker

# Test new endpoint
curl -X POST http://localhost:8080/tools/search-memory \
  -H "Content-Type: application/json" \
  -d '{"query": "DBS Yuu"}'

# Expected: {"results": []} on first run, populated after learning
```
