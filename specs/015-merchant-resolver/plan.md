# Implementation Plan: Merchant Resolver

**Branch**: `feat/spec-015-merchant-resolver` | **Date**: 2026-06-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/015-merchant-resolver/spec.md`

## Summary

Add a `resolve_merchant` tool inside the expense-tracker that runs a deterministic 4-step pipeline: memory lookup → keyword heuristic → Brave web search → LLM classification → auto-learn. Add `update_transaction` with payee/category validation. Add `budget_resolve_merchant` and `budget_update_transaction` to the Gateway plugin.

## Technical Context

**Language/Version**: JavaScript (Node.js ESM, Node 22+)

**Primary Dependencies**: Existing `MemoryStore` (WASM embeddings), `DeepSeekClient` (reused for classification), `typebox` (bundled), `openclaw/plugin-sdk/plugin-entry`

**Storage**: MEMORY.md (facts), actual-api (transactions via `actual.updateTransaction`)

**Testing**: vitest (matches project convention). Mock `fetch` for Brave API, mock `DeepSeekClient.chat()` for classification.

**Target Platform**: Docker (Linux container, expense-tracker + gateway)

**Project Type**: Expense-tracker tool + Gateway plugin tool (same pattern as spec 014)

**Performance Goals**: Memory/keyword path <500ms, web search path <20s, PATCH endpoint <2s

**Constraints**: No new LLM model, no new external services beyond Brave Search, reuse existing DeepSeek client

**Scale/Scope**: 2 new tools in expense-tracker, 2 new plugin tools, 1 new actual-api endpoint, 1 new shared constant file

## Constitution Check

*GATE: Must pass before Phase 0 research.*

| Principle | Status | Evidence |
|---|---|---|
| §2.1 We Configure OpenClaw — We Don't Build It | ✅ PASS | Tools added to existing expense-tracker, plugin uses official SDK |
| §2.2 We Build Skills + Deterministic Tools | ✅ PASS | Pipeline is code-enforced (not prompt), tools are deterministic |
| §2.3 TDD | ✅ PASS | vitest tests with mocked fetch/DeepSeek client |
| §2.4 Docker-First | ✅ PASS | All changes in Docker containers, no host dependencies |
| §2.5 Memory Budget | ✅ PASS | Keyword table <1KB, no new state beyond MEMORY.md |
| §2.6 Security | ✅ PASS | Brave API key optional, internal Docker network only |
| §2.7 Data Integrity | ✅ PASS | Payee/category validation before insert/update |
| §2.8 LLM Agent Principles | ✅ PASS | One tool call, not prompt-guided multi-step |
| §2.9 Observability | ✅ PASS | `source` field on response, structured tool call logs |

**Gate Result**: ALL PASS.

## Project Structure

### Documentation

```text
specs/015-merchant-resolver/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
└── tasks.md (via /speckit.tasks)
```

### Source Code

```text
gateway/actual-api/
└── server.js                     # +PATCH /transactions/:id

modules/expense-tracker/src/
├── keywords.js                   # NEW: shared keyword table
├── tools.js                      # +resolve_merchant, +update_transaction handlers
├── index.js                      # +resolve_merchant, +update_transaction routes
├── prompts.js                    # Updated: use resolve_merchant
└── config.js                     # +braveSearchApiKey field

gateway/plugins/expense-tracker-tools/
├── index.js                      # +budget_resolve_merchant, +budget_update_transaction
└── openclaw.plugin.json          # +2 contracts

gateway/workspace/skills/expense-tracker/
└── SKILL.md                      # Updated: correction workflow
```

## Complexity Tracking

> No violations. All constitution gates pass.
