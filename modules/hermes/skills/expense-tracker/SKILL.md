# Expense Tracker — Receipt Processing

Process bank transaction alerts into Actual Budget. Trigger: email from UOB, CIMB, Maybank, transaction alert, spent, charged, receipt, payment.

## Pipeline (4-phase memory-first design)

The expense-tracker orchestrator handles ALL phases internally. Hermes only routes emails — the orchestrator does field extraction, memory lookup, LLM audit with live data cross-referencing, web search fallback, and execution.

**Phase 1a — Field Extraction:** LLM extracts merchant, amount, date, currency from raw email. `reasoning=disabled`, no tools.

**Phase 1b — Deterministic Mapping:** Currency → budget_id. 3× search_memory for payee/account/category candidates.

**Phase 2 — LLM Audit:** Cross-references memory hints against live accounts/categories/payees via `fetch_context`. `reasoning=adaptive`. Leaves blank if unsure. V2 validation gate blanks invalid fields, retries ≤ 3×.

**Phase 3 — Web Search:** Runs `resolve_merchant` (memory → web search → classification) for missing payee/category. V3 gate validates, retries ≤ 2×. Only runs if payee/category blank after Phase 2.

**Phase 4 — Execute:** Insert with duplicate check, notify, learn facts. Skip for non-transactions. Notify on exhaustion.

## Key design principles

- **Leave blank > guess:** LLM leaves fields empty when unsure. Code handles blanks with web search or user notification.
- **Validation gates:** Every LLM-chosen field validated against live data. Invalid values blanked before retry. No hallucination amplification.
- **Memory-first:** Memory hints gathered before LLM audit. LLM cross-references hints against live data.
- **No keyword table:** Payee matching is memory + web search. No hardcoded keyword→payee mappings.

## Output style

When presenting expense data to the user, be concise and structured. Use bullet points or tables — never long paragraphs. Keep SOUL.md personality (warm, feminine, ~) but don't narrate data. State what happened, then list results.

Example format:
```
3 tx updated~

• Jun 18 RM30 → TNG eWallet
• Jun 15 RM30 → TNG eWallet  
• Jun 15 RM20 → TNG eWallet

Learned: RYT transfers = TNG top-up
```
