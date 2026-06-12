# Research: Migrate Python to Node.js

**Feature**: 012-migrate-to-nodejs  
**Date**: 2026-06-12

## 1. WASM Embeddings with @xenova/transformers

### Decision: `@xenova/transformers` with `Xenova/all-MiniLM-L6-v2`

**Source**: PoC confirmed 2026-06-12. Model load: 1.7s. 500-fact search: 1.5s. npm package v2.17.2, 386K weekly downloads, Apache-2.0.

**Rationale:**
- No PyTorch dependency → cold Docker build drops from 35 min to under 2 min
- ONNX WASM runtime (~50MB npm) vs PyTorch (~800MB pip)
- Semantic accuracy confirmed: "card 4605" matches "Card ending 4605 belongs to UOB Ladies" with 0.634 score
- Pre-download at build time via `RUN node -e "pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')"`

**Alternatives considered:**
- `node-onnxruntime` with pre-converted model: more complex setup, no pipeline API
- API-based embeddings (DeepSeek/Gemini): network-dependent, adds latency per search

## 2. DeepSeek Thinking Parameter via openai npm

### Decision: `openai` npm package with `body` option

**Source**: PoC confirmed 2026-06-12. The `openai` npm package's `client.chat.completions.create({...}, { body: { thinking: { type: "adaptive" } } })` correctly passes the extra parameter.

**Rationale:**
- Same SDK family (OpenAI-compatible) as Python
- `body` option merges extra JSON into the outbound request
- DeepSeek API confirmed to accept `adaptive` in `thinking.type`

**Alternatives considered:**
- `extra_body` (Python) → Node.js uses `body` option instead
- Direct `fetch` with raw JSON: works but loses SDK retry/error handling

## 3. OpenClaw Thinking Levels

### Decision: `adaptive` for orchestrator, `max` for thinker

**Source**: OpenClaw official docs (`docs/tools/thinking.md` — fetched 2026-06-12).

**Rationale:**
- `adaptive`: provider-managed — DeepSeek decides per-request whether reasoning helps. Saves tokens on simple emails.
- `max`: max reasoning effort — mapped to DeepSeek `reasoning_effort: "max"` for complex tasks.
- Current `medium` mapped to `reasoning_effort: "high"` (always-on), not adaptive.
- OpenClaw validates thinking levels against provider profiles; unsupported levels rejected at config time.

**Verification:**
- `adaptive` IS in OpenClaw's level list
- DeepSeek V4 models expose `/think xhigh|max` (docs: "both map to reasoning_effort: max")
- Lower non-off levels map to `high` (docs confirmed)

## 4. IMAP IDLE with imapflow

### Decision: `imapflow` npm package

**Rationale:**
- Full async IMAP with IDLE support, equivalent to `aioimaplib`
- Modern API, active maintenance, ~50K weekly downloads
- Same protocol — no behavioral difference expected

## 5. SQLite Dedup with better-sqlite3

### Decision: `better-sqlite3` npm package

**Rationale:**
- Synchronous API — fine for sub-ms dedup reads/writes
- Reads the same `data/dedup.db` file (SQLite is cross-language)
- Native addon (C++) — fast, no WASM overhead for SQL operations

**Note**: Requires `node-gyp` build tools in Dockerfile (`python3`, `make`, `gcc`).

## 6. Docker Base Image

### Decision: `node:22-slim`

**Rationale:**
- ~250MB base vs Python's `python:3.12-slim` ~150MB
- Net savings: removes PyTorch (~800MB), adds Node.js (~+100MB), net ~-700MB
- Same `slim` variant pattern as current Python Dockerfile
- ONNX WASM model pre-download adds ~30MB to image

## 7. Migration Strategy

### Decision: 1:1 file port, test-driven

Each `.py` file gets an equivalent `.js` file. The Python source serves as the specification — no redesign, no refactoring. Tests ported first (RED), then implementation (GREEN).

**Order:**
1. expense-tracker: memory.js → tools.js → orchestrator.js → prompts.js → index.js
2. portfolio-tracker: tools.js → orchestrator.js → index.js (Java bridge last)
3. Cleanup: delete all Python files
4. Config: fix thinking levels in openclaw.json
