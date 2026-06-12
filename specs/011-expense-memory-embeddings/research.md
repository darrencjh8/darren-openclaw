# Research: Expense Tracker Memory with Embeddings

**Feature**: 011-expense-memory-embeddings  
**Date**: 2026-06-12

## 1. Embeddings Model Selection

### Decision: all-MiniLM-L6-v2 (ONNX quantized)

**Rationale:**
- Already agreed by user; domain-appropriate for short-fact similarity matching (5-20 word facts)
- ONNX int8 quantization reduces RAM footprint from ~120 MB to ~55 MB
- Keeps search latency at ~5ms (vs ~100ms+ for API calls)
- No network dependency — works offline, no rate limits, no API cost per search
- Total container RAM: ~150 MB (base) + ~55 MB (model) = ~205 MB

**Alternatives considered:**

| Option | RAM | Latency | Cost | Verdict |
|---|---|---|---|---|
| all-MiniLM-L6-v2 (full) | ~120 MB | ~5ms | Free | Simple but violates 150 MB budget |
| all-MiniLM-L6-v2 (ONNX int8) | ~55 MB | ~3ms | Free | **Selected**: best balance of size/perf |
| all-MiniLM-L3-v2 | ~50 MB | ~2ms | Free | Worse semantic matching for financial terms |
| DeepSeek embeddings API | 0 MB | ~100-200ms | ~$0.01/mo | Network-dependent, adds API failure mode |
| Gemini embeddings (like gateway) | 0 MB | ~100-200ms | Per-token | Already used by gateway for memory_search; adding a second API dependency |

**How to use ONNX:** `sentence-transformers` supports ONNX export natively. Add `optimum[onnxruntime]` to requirements. One-time export on first run: `model = SentenceTransformer('all-MiniLM-L6-v2'); model.save('data/model.onnx')`. Subsequent starts load ONNX directly.

## 2. Memory Budget Impact

### Updated constitution budget:

| Container | Before | After | Delta |
|---|---|---|---|
| expense-tracker | ~150 MB | ~205 MB | +55 MB (ONNX model) |
| openclaw | ~400 MB | ~400 MB | — |
| portfolio-tracker | ~256 MB | ~256 MB | — |
| **Total** | **~806 MB** | **~861 MB** | **+55 MB** |

**Decision:** Accept 205 MB for expense-tracker. ONNX quantization keeps the increase minimal (+55 MB, not +120 MB). Constitution 2.5 will be updated post-implementation to reflect the new budget.

## 3. MEMORY.md Format

### Decision: Follow gateway pattern (Markdown sections)

```markdown
# Long-Term Memory

## Facts

- Card ending 4605 belongs to UOB Ladies credit card
- Toast Box merchant maps to Food payee
- Grab merchant maps to Transport payee
- DBS Yuu is a debit card account
```

**Rationale:**
- Human-readable and manually editable (user can SSH and fix)
- Gateway already uses this format — consistency across the system
- Simple to parse: split by `## Facts`, extract bullet lines
- Each line = one fact → one embedding vector
- `learn_fact` appends new bullets; dedup prevents duplicates

**Alternatives considered:**
- JSON: rejected — not human-readable for manual editing
- SQLite: rejected — overkill for ~200 facts, can't be read by nano/vim

## 4. Deduplication Strategy

### Decision: Cosine similarity threshold 0.95 on learn, periodic rewrite every 50 facts

**How it works:**
1. `learn_fact(fact)` called
2. Embed new fact
3. Search existing index for top-1 match
4. If cosine similarity ≥ 0.95 → skip (already known)
5. Else → append to MEMORY.md + add to index
6. Counter increments; at 50 new facts, trigger background rewrite

**Periodic rewrite:**
- Re-read MEMORY.md, re-embed all facts
- Cross-deduplicate: for each fact, if any other fact has cosine ≥ 0.95, keep only one
- Rewrite file compactly
- Rebuild index from clean file

**Rationale:** The 0.95 threshold catches exact and near-exact duplicates ("Grab → Transport" vs "grab → Transport"). Periodic rewrite catches drift (facts that converged over time as wording evolved). 50 facts is a sweet spot — frequent enough to keep the file clean, infrequent enough to not impact performance.

## 5. Notification Cooldown

### Decision: In-memory dict `{msg_id: timestamp}`, cleared on update-fact/delete-fact

**How it works:**
1. Before `notify_user()` for ambiguous email, check `cooldown[msg_id]`
2. If exists and `now - timestamp < 3600` (1 hour) → suppress notification
3. If exists but expired → remove from dict, allow notification
4. If not exists → allow notification, add `cooldown[msg_id] = now`
5. When `update-fact` or `delete-fact` called → clear entire cooldown dict

**Rationale:** 
- Simple, no persistence needed (acceptable to lose on restart)
- Clearing on correction means user's answer triggers immediate re-processing
- 1-hour window prevents spam but allows re-asking if user is AFK
- No new dependencies

**Edge case:** Restart clears cooldown → existing unread emails re-trigger. Acceptable (restarts are rare).

## 6. LLM Thinking Level

### Decision: `medium`

**Rationale:**
- Current orchestrator doesn't set thinking at all (DeepSeek default behavior)
- `medium` gives LLM reasoning space to self-check against 14 rules before tool calls
- Prevents hallucination on edge cases (ambiguous currency, borderline promotional emails)
- Cost: ~200-400 extra tokens per email; negligible at ~50 emails/day
- Gateway already uses `medium` as default

## 7. System Prompt Restructure

### Decision: Three orthogonal sections

```
RULES:     WHAT NOT TO DO (14 numbered constraints)
MATCHING:  HOW TO MATCH (heuristics for accounts, payees, categories)
WORKFLOW:  WHAT TO DO (13-step checklist in exact order)
```

**Rationale:**
- Current prompt mixes constraints, heuristics, and procedures — LLM can miss rules embedded in prose
- Orthogonal sections: rules constrain, matching guides, workflow executes
- No redundancy — each concept appears in exactly one section
- Workflow as checklist: LLMs follow checklists better than scattered rules
- Total prompt length similar to current (~120 lines)
