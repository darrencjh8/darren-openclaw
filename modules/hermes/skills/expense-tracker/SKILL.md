# Expense Tracker — Receipt Processing

Process bank transaction alerts into Actual Budget. Trigger: email from UOB, CIMB, Maybank, transaction alert, spent, charged, receipt, payment.

## Pipeline (3-phase design — see `src/orchestrator.js`)

The expense-tracker orchestrator handles ALL phases internally. Hermes only routes emails — the orchestrator does LLM analysis, code-driven resolution, and execution. (Spec 021 replaced the earlier 4-phase / V2-V3 gate design.)

**Phase 1 — LLM Analysis:** Single LLM call (`reasoning=adaptive`) with the `fetch_context` tool to read live accounts/categories/payees. Extracts merchant, amount, date, currency and proposes payee/category, leaving fields blank when unsure. 1 retry.

**Phase 2 — Resolution (code-driven, no LLM gates):** Deterministic fill-in of blanks:
- **payee:** memory → `resolve_merchant` (memory → web search → classification) → `"Misc"`
- **category:** memory → LLM category picker (`getCategoryPickerPrompt`) → `null`

**Phase 3 — Execute:** Insert with duplicate check, notify, `learn_fact` ×1. Skip for non-transactions. Notify on exhaustion.

## Key design principles

- **Leave blank > guess:** LLM leaves fields empty when unsure. Phase 2 code resolves blanks via memory/web search or falls back to `Misc`/`null`.
- **Memory-first:** Memory is consulted first in both payee and category resolution before any web/LLM step.
- **No keyword table:** Payee matching is memory + web search. No hardcoded keyword→payee mappings (no `src/keywords.js`).

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
