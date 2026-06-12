# Feature Specification: Migrate Python to Node.js + Fix Thinking

**Feature Branch**: `012-migrate-to-nodejs`

**Created**: 2026-06-12

**Status**: Done

**Input**: User description: "Migrate expense-tracker and portfolio-tracker from Python to Node.js. Separate Docker containers, same HTTP hub architecture. Migrate all deterministic logic 1:1. Keep Java CLI for Portfolio Performance XML. Fix DeepSeek thinking levels: orchestrator → adaptive, thinker → max. Verified against official OpenClaw thinking docs and DeepSeek API docs."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Docker Build Completes in Under 2 Minutes (Priority: P1) 🎯 MVP

Today, a cold Docker build takes 35+ minutes because Python's `sentence-transformers` pulls in PyTorch (~800MB). After migration, a cold `npm install` completes in under 2 minutes, and incremental builds (source-only changes) complete in under 10 seconds. The embeddings model (`@xenova/transformers` with ONNX WASM) downloads ~30MB at build time and loads from cache at runtime.

**Why this priority**: This is the primary motivation — 35-minute deploys block iteration. Without this, nothing else matters.

**Independent Test**: `docker compose build expense-tracker --no-cache` completes in under 2 minutes on production hardware. `docker compose build expense-tracker` (cached) completes in under 10 seconds.

**Acceptance Scenarios**:

1. **Given** a clean Docker build cache, **When** `docker compose build expense-tracker --no-cache` runs, **Then** the build completes in under 2 minutes.
2. **Given** a cached build (npm dependencies unchanged), **When** source code changes and `docker compose build expense-tracker` runs, **Then** the build completes in under 10 seconds.
3. **Given** the new Dockerfile, **When** the image is built, **Then** the WASM embeddings model is pre-downloaded at build time and loads at runtime without network access.

---

### User Story 2 - Expense Tracker Tools Work Identically (Priority: P1)

All 15 HTTP tools exposed by the expense tracker (`search-memory`, `learn-fact`, `fetch-accounts`, `insert-transaction`, etc.) accept identical JSON requests and return identical JSON responses as the Python implementation. The gateway's `workspace/AGENTS.md` routing requires zero changes. The system prompt (`prompts.js`) is a 1:1 port of `prompts.py` with identical RULES/MATCHING/WORKFLOW sections.

**Why this priority**: The gateway must not break. Every tool contract is validated by existing integration tests.

**Independent Test**: Run the gateway's existing integration test suite against the migrated expense tracker. All tests that pass against Python must pass against Node.js.

**Acceptance Scenarios**:

1. **Given** the Node.js expense tracker running on port 8080, **When** `POST /tools/search-memory` is called with `{"query": "card ending 4605"}`, **Then** the response matches the Python implementation's contract exactly.
2. **Given** an email processed by the Node.js orchestrator, **When** the LLM calls `fetch-accounts`, `fetch-categories`, and `fetch-payees` in parallel, **Then** all three return correctly and the LLM proceeds to insert a transaction.
3. **Given** the system prompt loaded from `prompts.js`, **When** compared to `prompts.py`, **Then** all 14 rules, matching heuristics, and 13-step workflow are identical.

---

### User Story 3 - WASM Embeddings Match Python Accuracy (Priority: P2)

The `@xenova/transformers` WASM runtime with `Xenova/all-MiniLM-L6-v2` produces semantically equivalent results to Python's `sentence-transformers` with ONNX backend. The same query against the same facts returns the same top match with a score difference under 0.02.

**Why this priority**: Memory search is core to classification accuracy. A regression in embedding quality means misclassified transactions.

**Independent Test**: Seed identical MEMORY.md with 50 facts. Run 20 test queries through both Python and Node.js implementations. Compare top-1 match and score.

**Acceptance Scenarios**:

1. **Given** MEMORY.md containing "Card ending 4605 belongs to UOB Ladies credit card", **When** `search_memory("card 4605")` runs in Node.js WASM, **Then** the top result is the UOB Ladies fact with score ≥ 0.60.
2. **Given** 20 test queries run against both Python and Node.js implementations, **When** top-1 matches are compared, **Then** at least 19 of 20 match (95% parity).
3. **Given** a 500-fact MEMORY.md, **When** `search_memory()` runs, **Then** the search completes in under 100ms (matching SC-003 from spec 011).

---

### User Story 4 - Portfolio Tracker Migrated (Priority: P2)

The portfolio tracker's Python logic (LLM orchestration, Google Sheets API, Actual Budget API, IBKR parsing, PDF extraction, OneDrive sync) is ported 1:1 to Node.js. The Java CLI bridge (`pp-client/java_bridge.js`) invokes `java -jar pp-cli.jar` via `child_process` — identical to Python's `subprocess`. All 30+ existing tests are ported.

**Why this priority**: Unifies the stack (zero Python in the entire repo). The Java CLI is the bottleneck in both languages — migration adds no new complexity.

**Independent Test**: Run the portfolio tracker's test suite after migration. All 30+ tests pass with identical behavior.

**Acceptance Scenarios**:

1. **Given** the Node.js portfolio tracker, **When** the gateway calls `/tools/sync-portfolio`, **Then** the Java CLI is invoked correctly and Portfolio Performance XML is updated.
2. **Given** an IBKR flex query email, **When** the Node.js orchestrator processes it, **Then** the IBKR parser extracts all trade data correctly.
3. **Given** Google Sheets API calls, **When** the `sheets_client.js` writes taxonomy data, **Then** the spreadsheet is updated identically to the Python version.

---

### User Story 5 - Thinking Levels Fixed Per OpenClaw Docs (Priority: P3)

The expense tracker and gateway thinking levels are updated to valid values per the official OpenClaw documentation (`docs/tools/thinking.md`):
- **Orchestrator agent** (openclaw.json): `thinkingDefault: "adaptive"` — lets DeepSeek decide whether reasoning helps per request
- **Thinker agent** (openclaw.json): `thinkingDefault: "max"` — maximum reasoning effort (already set)
- **Expense tracker orchestrator** (internal DeepSeekClient): `thinking: { type: "adaptive" }` — matches orchestrator behavior

The current value `"medium"` for the orchestrator was incorrect — per OpenClaw docs, `medium` maps to `reasoning_effort: "high"` which is always-on reasoning, not adaptive.

**Why this priority**: Fixes incorrect configuration. Adaptive reasoning saves tokens on simple emails while adding reasoning on complex ones (ambiguity, multi-step matching).

**Independent Test**: Verify openclaw.json validates against the OpenClaw configuration schema. Verify the expense tracker's internal LLM calls use `thinking.type: "adaptive"`.

**Acceptance Scenarios**:

1. **Given** `openclaw.json` with `thinkingDefault: "adaptive"`, **When** OpenClaw validates the config, **Then** no errors are raised.
2. **Given** a simple email ("S$12.80 at Toast Box from DBS Yuu"), **When** the expense tracker processes it with adaptive thinking, **Then** the LLM responds without unnecessary reasoning tokens.
3. **Given** a complex email (ambiguous card number, unknown merchant), **When** the expense tracker processes it with adaptive thinking, **Then** the LLM uses reasoning to resolve the ambiguity before making tool calls.

---

### Edge Cases

- What happens when `@xenova/transformers` model download fails at build time? → Docker build fails with a clear error. The model is baked into the image; no runtime download.
- What happens if the WASM model file is corrupted? → `pipeline()` throws a clear error. Fallback: `memory.js` drops to substring search (same as Python fallback).
- What happens when `child_process('java', ['-jar', 'pp-cli.jar'])` fails? → Same error handling as Python: log the stderr, return error to gateway, let LLM decide retry/notify.
- How does `openai` npm package pass `thinking.type: "adaptive"` to DeepSeek? → Via the `body` option on `client.chat.completions.create({...}, { body: { thinking: { type: "adaptive" } } })` — verified working in PoC.
- What happens to existing `data/MEMORY.md`? → No migration needed. Same Markdown file, same format, same volume mount. The new `memory.js` reads it identically.
- What happens to existing `data/dedup.db`? → Same SQLite file. `better-sqlite3` reads the same schema.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All expense tracker Python source files (26 files) MUST be ported 1:1 to Node.js with identical logic.
- **FR-002**: All expense tracker Python test files (26 files) MUST be ported 1:1 to Node.js tests (vitest or jest).
- **FR-003**: All portfolio tracker Python source files (18 files) MUST be ported 1:1 to Node.js with identical logic.
- **FR-004**: All portfolio tracker Python test files (31 files) MUST be ported 1:1 to Node.js tests.
- **FR-005**: The Java CLI bridge (`pp-client/java_bridge.js`) MUST invoke `java -jar pp-cli.jar` via `child_process.execFile`, identical to Python's `subprocess.run`.
- **FR-006**: The Dockerfile MUST use `node:22-slim` base image and pre-download the WASM embeddings model at build time.
- **FR-007**: The `@xenova/transformers` package MUST be used for embeddings, replacing `sentence-transformers`.
- **FR-008**: The `openai` npm package MUST be used for DeepSeek API calls, passing `thinking: { type: "adaptive" }` via the `body` option.
- **FR-009**: The `better-sqlite3` package MUST be used for the dedup journal, reading the same `data/dedup.db` schema.
- **FR-010**: The `imapflow` package MUST be used for IMAP IDLE, replacing `aioimaplib`.
- **FR-011**: The `cheerio` package MUST be used for HTML email extraction, replacing `beautifulsoup4`.
- **FR-012**: The `pino` package MUST be used for structured JSON logging, replacing Python's `logging` module.
- **FR-013**: The OpenClaw gateway `openclaw.json` orchestrator agent MUST use `thinkingDefault: "adaptive"` (was `"medium"` per OpenClaw docs).
- **FR-014**: The OpenClaw gateway `openclaw.json` thinker agent MUST keep `thinkingDefault: "max"` (unchanged).
- **FR-015**: The expense tracker's internal DeepSeekClient MUST pass `thinking: { type: "adaptive" }` to the DeepSeek API.
- **FR-016**: All 105 Python files in the repository MUST be removed after migration is complete and verified.
- **FR-017**: Docker Compose configuration MUST remain unchanged — same service names, ports, and volume mounts.
- **FR-018**: The gateway's `workspace/AGENTS.md` routing rules MUST require zero changes.

### Key Entities

- **Expense Tracker Container**: Node.js HTTP server (Express/Fastify) on port 8080. Exposes 15 tools via POST endpoints. Communicates with gateway via HTTP. Replaces the Python `aiohttp` container.
- **Portfolio Tracker Container**: Node.js HTTP server on port 8081. Exposes portfolio tools via POST endpoints. Calls Java CLI for PP XML manipulation. Replaces the Python container.
- **MemoryStore (Node.js)**: 1:1 port of `memory.py`. Manages ONNX WASM embeddings, cosine similarity search, semantic dedup, periodic rewrite, and MEMORY.md file I/O.
- **Java CLI Bridge**: `child_process.execFile('java', ['-jar', 'pp-cli.jar', ...])` — identical semantics to Python's `subprocess.run`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Cold Docker build (`--no-cache`) completes in under 2 minutes on production hardware (vs. current 35+ minutes).
- **SC-002**: Cached Docker build (source change only) completes in under 10 seconds.
- **SC-003**: All 211 existing tests that pass against Python also pass against the Node.js implementation.
- **SC-004**: WASM embeddings search returns top-1 match identical to Python ONNX for at least 95% of test queries.
- **SC-005**: Container RAM usage drops from 205 MB to under 150 MB.
- **SC-006**: Docker image size drops from ~900MB to under 400MB.
- **SC-007**: Gateway integration tests pass without any changes to `workspace/AGENTS.md` or `docker-compose.yml`.
- **SC-008**: Zero Python files remain in the repository after migration verification.

## Assumptions

- `@xenova/transformers` v2.17.2 (386K weekly downloads, Apache-2.0, per npmjs.com) is production-ready for server-side Node.js embeddings.
- The `openai` npm package's `body` option correctly passes DeepSeek's `thinking.type: "adaptive"` parameter (verified in PoC).
- `imapflow` supports IMAP IDLE equivalent to `aioimaplib` (both use standard IMAP protocol).
- The Java CLI binary and its dependencies (`openjdk-21-jre-headless`) remain in the Docker image — no change to the Java toolchain.
- DeepSeek API accepts `thinking.type: "adaptive"` as confirmed by the PoC API response (`expected one of 'adaptive', 'enabled', 'disabled'`).
- OpenClaw `thinkingDefault` values are validated per the official docs at `docs/tools/thinking.md` — `adaptive` and `max` are documented valid levels.
