# Implementation Plan: Migrate Python to Node.js + Fix Thinking

**Branch**: `012-migrate-to-nodejs` | **Date**: 2026-06-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-migrate-to-nodejs/spec.md`

## Summary

Migrate expense-tracker (26 source + 26 test files) and portfolio-tracker (18 source + 31 test files) from Python to Node.js. Separate Docker containers, identical HTTP hub architecture. All deterministic logic ported 1:1. Java CLI kept for Portfolio Performance XML. DeepSeek thinking levels fixed: orchestrator → `adaptive`, expense-tracker internal → `adaptive`, thinker → `max`. Verifications: OpenClaw thinking docs, DeepSeek API docs, `@xenova/transformers` npm, PoC confirmed `openai` npm `body` option passes `thinking.type: "adaptive"`.

## Technical Context

**Language/Version**: Node.js 22 (LTS) — replacing Python 3.12

**Primary Dependencies**: `@xenova/transformers` (embeddings, WASM), `openai` (DeepSeek LLM), `better-sqlite3` (dedup), `imapflow` (IMAP IDLE), `cheerio` (HTML parsing), `pino` (logging), `express` (HTTP server), `vitest` (testing)

**Storage**: `MEMORY.md` (unchanged), `data/dedup.db` (unchanged SQLite schema), `data/mappings.json` (removed)

**Testing**: vitest + Node.js built-in test runner

**Target Platform**: Linux server, Docker container (Ubuntu host), `node:22-slim` base image

**Project Type**: Web service (Express HTTP API) + embedded LLM agent

**Performance Goals**: <100ms memory search (WASM), <2min cold Docker build, <10s incremental build

**Constraints**: Container RAM <150 MB (vs. 205 MB Python). Docker image <400 MB (vs. ~900 MB). Zero Python runtime after migration.

**Scale/Scope**: ~20 accounts, ~200 payee mappings, ~50 category mappings. Single user. ~10-50 emails/day.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| 2.1 Configure OpenClaw | ✅ PASS | No gateway changes. HTTP hub endpoints unchanged. AGENTS.md routing unchanged. |
| 2.2 Skills + Deterministic Tools | ✅ PASS | Same tool contracts, different runtime. All 15 tools ported 1:1. |
| 2.3 TDD | ✅ PASS | 57 existing tests ported 1:1 to vitest. RED-GREEN-REFACTOR per ported file. |
| 2.4 Docker-First | ✅ PASS | Same docker-compose.yml, same ports, same volumes. `node:22-slim` base image. |
| 2.5 Memory Budget | ✅ IMPROVED | 205 MB → <150 MB (no Python runtime, no PyTorch, WASM lighter). Total system: 861 → ~800 MB. |
| 2.6 Security | ✅ PASS | No new ports, no new secrets, same internal Docker network |
| 2.7 Data Integrity | ✅ PASS | Same SQLite schema, same MEMORY.md format, same atomic writes |
| 2.8 LLM Agent Principles | ✅ PASS | Tools not code — all classification delegated to LLM. No hardcoded business rules. |
| 2.9 Observability | ✅ PASS | `pino` structured JSON logging replaces `logging` module. Same correlation_id pattern. |

## Project Structure

### Documentation (this feature)

```text
specs/012-migrate-to-nodejs/
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
│   ├── index.js              # Entry: Express server + IDLE loop
│   ├── memory.js             # MemoryStore (1:1 from memory.py)
│   ├── prompts.js            # System prompt (1:1 from prompts.py)
│   ├── tools.js              # ToolRegistry (1:1 from tools.py)
│   ├── orchestrator.js       # AgentOrchestrator (1:1 from orchestrator.py)
│   ├── extractors.js         # Email/PDF extractors (1:1)
│   ├── imap.js               # IMAP IDLE handler (1:1 from idle_handler.py)
│   ├── dedup.js              # Dedup journal (1:1 from dedup.py)
│   ├── config.js             # Config from env (1:1 from config.py)
│   └── statement/            # Statement processing (1:1)
├── docker/
│   └── Dockerfile            # node:22-slim, npm ci, pre-download WASM model
├── tests/                    # All 26 tests ported to vitest
├── package.json
└── data/
    └── MEMORY.md             # Unchanged, shared format

modules/portfolio-tracker/
├── src/
│   ├── index.js              # Entry: Express server + scheduler
│   ├── orchestrator.js       # AgentOrchestrator (1:1)
│   ├── prompts.js            # System prompt (1:1)
│   ├── tools.js              # ToolRegistry (1:1)
│   ├── config.js             # Config from env (1:1)
│   ├── channels/email_handler.js  # Email processing (1:1)
│   ├── extractors/           # IBKR parser, PDF extractor (1:1)
│   ├── gsheets/sheets_client.js   # Google Sheets API (1:1)
│   ├── client/actual_client.js    # Actual Budget API (1:1)
│   ├── pp_client/java_bridge.js   # Java CLI bridge (1:1)
│   └── utils/                # Dedup, logging, memory (1:1)
├── docker/
│   └── Dockerfile            # node:22-slim + openjdk-21-jre-headless
├── tests/                    # All 31 tests ported to vitest
├── package.json
└── data/

gateway/
├── openclaw.json             # MODIFY: orchestrator thinkingDefault: "adaptive" (was "medium")
└── workspace/
    └── AGENTS.md             # UNCHANGED — same routing rules
```

**Structure Decision**: Two separate Node.js containers (same as today's Python containers). No new modules. Gateway change is a one-line config fix. After migration, delete all 105 `.py` files and Python dependencies.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| (none) | | |
