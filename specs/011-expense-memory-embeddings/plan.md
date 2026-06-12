# Implementation Plan: Expense Tracker Memory with Embeddings

**Branch**: `011-expense-memory-embeddings` | **Date**: 2026-06-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-expense-memory-embeddings/spec.md`

## Summary

Replace the hardcoded `data/mappings.json` (exact-match JSON dictionary injected into every system prompt) with a configurable `MEMORY.md` file backed by `all-MiniLM-L6-v2` embeddings for semantic search. New tools: `search_memory`, `learn_fact` (with cosine-similarity dedup), `list-facts`, `update-fact`, `delete-fact`. Restructure the agent system prompt into orthogonal RULES / MATCHING / WORKFLOW sections. Add notification cooldown for ambiguous emails. Set LLM thinking level to `medium`.

## Technical Context

**Language/Version**: Python 3.12 (existing)

**Primary Dependencies**: sentence-transformers (new), openai (existing), aiohttp (existing)

**Storage**: `MEMORY.md` (Markdown file on volume-mounted `data/`), in-memory embedding index (rebuilt on startup)

**Testing**: pytest + pytest-asyncio + pytest-mock (existing)

**Target Platform**: Linux server, Docker container (Ubuntu host), Docker Compose internal network

**Project Type**: Web service (aiohttp HTTP API) + embedded LLM agent

**Performance Goals**: <100ms memory search for up to 500 facts

**Constraints**: Container RAM budget (constitution: 150 MB for expense-tracker; ONNX quantized model adds ~55 MB → 205 MB total). Sequential email processing (no concurrent IMAP callbacks). Cooldown set in-memory only (lost on restart, acceptable).

**Scale/Scope**: ~20 accounts, ~200 payee mappings, ~50 category mappings. Single user. ~10-50 emails/day.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Design (Phase 0)

| Principle | Status | Notes |
|---|---|---|
| 2.1-2.4, 2.6-2.9 | ✅ PASS | No issues |
| 2.5 Memory Budget | ⚠️ REVIEW | 150 MB budget exceeded; resolved in Phase 0 research |

### Post-Design (Phase 1) — Re-check

| Principle | Status | Notes |
|---|---|---|
| 2.1 Configure OpenClaw | ✅ PASS | Gateway AGENTS.md change is config-only routing rule |
| 2.2 Skills + Deterministic Tools | ✅ PASS | 5 new HTTP endpoints, all deterministic; no LLM in the correction path |
| 2.3 TDD | ✅ PASS | test_memory.py + test_cooldown.py planned; all existing tests must still pass |
| 2.4 Docker-First | ✅ PASS | Only requirements.txt + Dockerfile change (pip install sentence-transformers optimum[onnxruntime]) |
| 2.5 Memory Budget | ⚠️ ACCEPTED | ONNX int8 quantization keeps increase to +55 MB (205 MB total vs 150 MB budget). Constitution 2.5 will be amended post-implementation to reflect 205 MB for expense-tracker. Total system: 861 MB. |
| 2.6 Security | ✅ PASS | No new ports, secrets, or network exposure |
| 2.7 Data Integrity | ✅ PASS | Atomic file writes, index rebuilt from MEMORY.md on startup (single source of truth) |
| 2.8 LLM Agent Principles | ✅ PASS | Tools not code; no hardcoded rules; learn_fact replaces learn_mapping; medium thinking adds reasoning audit trail |
| 2.9 Observability | ✅ PASS | Same JSON-line logging; new correlation_id context for cooldown events |

## Project Structure

### Documentation (this feature)

```text
specs/011-expense-memory-embeddings/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
modules/expense-tracker/
├── src/
│   ├── agent/
│   │   ├── memory.py          # NEW: MemoryStore class (embed, index, search, dedup)
│   │   ├── orchestrator.py    # MODIFY: add thinking="medium", import MemoryStore
│   │   ├── prompts.py         # MODIFY: restructure RULES/MATCHING/WORKFLOW, add search_memory/learn_fact
│   │   └── tools.py           # MODIFY: replace learn_mapping with learn_fact, add search_memory,
│   │                          #         list-facts, update-fact, delete-fact, cooldown logic
│   ├── main.py                # MODIFY: instantiate MemoryStore, pass to orchestrator
│   ├── config.py              # MODIFY: add memory_path from env
│   └── tools_api.py           # MODIFY: register new tool endpoints (2 new routes)
├── data/
│   └── MEMORY.md              # NEW: human-readable memory file (seed from mappings.json)
├── tests/
│   ├── test_memory.py         # NEW: MemoryStore unit tests
│   ├── test_cooldown.py       # NEW: notification cooldown tests
│   └── test_tools.py          # MODIFY: update for renamed/replaced tools
├── requirements.txt           # MODIFY: add sentence-transformers
└── docker/
    └── Dockerfile             # MODIFY: install sentence-transformers build deps if needed

gateway/
└── workspace/
    └── AGENTS.md              # MODIFY: add memory feedback routing rules
```

**Structure Decision**: Single-module changes within the existing `modules/expense-tracker/` structure. No new modules or containers. New `memory.py` encapsulates all embedding/logic. Gateway change is a config-only routing rule addition.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Memory budget: 270 MB vs 150 MB limit | Embeddings model requires ~120 MB RAM. Constitution 2.5 set 150 MB for expense-tracker before embeddings were designed. | Smaller model (all-MiniLM-L3-v2) would save ~90 MB but offer worse semantic matching for domain-specific terms. ONNX quantization could reduce to ~45 MB — evaluated in Phase 0 research. Pure keyword search (no embeddings) was rejected because it can't handle spelling variations ("TOASTBOX" vs "Toast Box") or partial matches ("card 4605" vs "UOB Card ending 4605"). |
