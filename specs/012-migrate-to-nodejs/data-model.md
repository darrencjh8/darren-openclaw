# Data Model: Migrate Python to Node.js

**Feature**: 012-migrate-to-nodejs

## Entities (Unchanged from Python)

No data model changes. All existing entities are preserved:

- **Memory Fact** — identical to spec 011. Stored in `MEMORY.md`, indexed by WASM embeddings.
- **Memory Index** — identical to spec 011. In-memory ONNX WASM embeddings matrix.
- **Notification Cooldown** — identical to spec 011. `{msg_id: timestamp}` suppression map.
- **Dedup Journal** — identical SQLite schema. Same `data/dedup.db` file.
- **Statement Journal** — identical SQLite schema. Same file.
- **Portfolio PP XML** — unchanged Java CLI output.

## Runtime Entities (New)

| Entity | Python | Node.js | Notes |
|---|---|---|---|
| MemoryStore | `memory.py` class | `memory.js` class | Same API: `search()`, `add()`, `remove()`, `update()`, `list_facts()` |
| ToolRegistry | `tools.py` class | `tools.js` class | Same 15 tools, same schemas |
| AgentOrchestrator | `orchestrator.py` | `orchestrator.js` | Same LLM loop, same tool iteration |
| IMAP Handler | `aioimaplib` async | `imapflow` async | Same IDLE + fetch_unread + mark_read |
| Dedup Journal | `sqlite3` (stdlib) | `better-sqlite3` (npm) | Same SQL queries |
| HTTP Server | `aiohttp` | `express` | Same routes, same ports |
| LLM Client | `openai` (py) | `openai` (npm) | Same API, `body: {thinking: {type: "adaptive"}}` |

## File Mapping (Expense Tracker)

| Python | Node.js |
|---|---|
| `src/agent/memory.py` | `memory.js` |
| `src/agent/prompts.py` | `prompts.js` |
| `src/agent/tools.py` | `tools.js` |
| `src/agent/orchestrator.py` | `orchestrator.js` |
| `src/extractors/html_extractor.py` | `extractors.js` |
| `src/extractors/pdf_extractor.py` | (in extractors.js) |
| `src/imap/idle_handler.py` | `imap.js` |
| `src/utils/dedup.py` | `dedup.js` |
| `src/utils/logging.py` | `logging.js` (pino wrapper) |
| `src/config.py` | `config.js` |
| `src/tools_api.py` | (routes in index.js) |
| `src/main.py` | `index.js` |

## File Mapping (Portfolio Tracker)

| Python | Node.js |
|---|---|
| `src/agent/orchestrator.py` | `orchestrator.js` |
| `src/agent/prompts.py` | `prompts.js` |
| `src/agent/tools.py` | `tools.js` |
| `src/tools_api.py` | (routes in index.js) |
| `src/main.py` | `index.js` |
| `src/config.py` | `config.js` |
| `src/channels/email_handler.py` | `email_handler.js` |
| `src/extractors/ibkr_parser.py` | `ibkr_parser.js` |
| `src/extractors/pdf_extractor.py` | `pdf_extractor.js` |
| `src/extractors/email_extractor.py` | `email_extractor.js` |
| `src/gsheets/sheets_client.py` | `sheets_client.js` |
| `src/client/actual_client.py` | `actual_client.js` |
| `src/pp_client/java_bridge.py` | `java_bridge.js` |
| `src/onedrive_download.py` | `onedrive_download.js` |
| `src/onedrive_upload.py` | `onedrive_upload.js` |
| `src/utils/dedup.py` | `dedup.js` |
| `src/utils/logging.py` | `logging.js` |
| `src/utils/memory.py` | `memory_utils.js` |
