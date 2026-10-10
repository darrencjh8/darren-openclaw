# Contracts: Todolist Reminder Engine (031)

## C1. Dispatcher cron job (Hermes cron)

- Seeded in `modules/hermes/50-seed-defaults` alongside existing jobs.
- `schedule`: `{kind: interval, minutes: 60}` (hourly tick; per-todo hours evaluated inside).
- `deliver`: `local` (no user-facing output; user sees Tasks + nudges).
- Timezone: `Asia/Singapore` (hermes `config.yaml`, already set).
- Correlation ID per run: `reminder-<YYYYMMDD-HH-SGT>`.

## C2. Deterministic tools (expense-tracker container, Node.js ESM)

New `reminder_*` tools following the existing `tools.js` registration pattern:

| Tool | Input | Output |
|---|---|---|
| `reminder_compile` | `{date, preview?}` (SGT YYYY-MM-DD; `preview:true` = side-effect-free dry run, no journal writes, dedupe hits reported as `skipped:true`) | `DatedTodo[]` — routine (fixed/KB) + Notion-compiled items due for creation |
| `reminder_dispatch` | `{date, hour}` | per-item create/skip results; writes `dispatch_journal` |
| `reminder_nudge` | `{date, hour}` | Telegram nudges via existing `notify_user` for items whose `remind_hour == hour` |
| `reminder_tasks_create` | `DatedTodo` | `{google_task_id}` or `{deduped: true}` |
| `reminder_tasks_complete` | `{google_task_id}` | marks done (auto_doneable path only) |

LLM role (constitution 2.8): agent decides order and handles ambiguous Notion rows; date math, hashing, and journal writes are deterministic tools.

## C3. Google Tasks integration

- API: `tasks.googleapis.com/v1`, methods `tasks.insert`, `tasks.complete` (`tasks.patch status=completed`), `tasklists.list`.
- Auth: service-account JSON from env `GOOGLE_TASKS_SERVICE_ACCOUNT_JSON` (same pattern as `GOOGLE_SERVICE_ACCOUNT_JSON` for Sheets); tasklist ID from env `GOOGLE_TASKS_LIST_ID`.
- Create payload: `{title, notes, due (RFC3339 SGT date)}`.
- Auto-doneable: insert then immediate complete with notes suffix `" (reminder only)"`.
- Failure: log + fall back to Telegram nudge so the user is still informed; retry next hourly run.
- Secrets never committed (constitution 2.6; `.env`, excluded).

## C4. Notion date compilation

- Read path: existing `notion` MCP read tools (10 tools in hermes `config.yaml:170-188`); engine stays read-only like the wiki cron.
- Rows: `Accounts` / `Credit Cards` date fields (due/renewal/action dates); unparsable or missing dates skipped with `notify_user` warning.
- Notion unreachable: run fails open for routine todos (spec US-3 acceptance 3).

## C5. Config file contract (shared with sibling admin-UI spec)

- Path: `config/reminders.json` (array of TodoDefinition per data-model.md).
- Owner of schema: this spec. Sibling UI spec consumes it read/write; validation rules in data-model.md are normative for both.
- Atomic writes only (write-temp-then-rename); dispatcher re-reads per run so UI edits apply within the hour.
- Validation logic is shared: the same validator backs the dispatcher refusal path and `reminder_config_set`; never duplicated.

## C6. Config endpoints (engine-side, sole writer)

| Tool | Input | Output |
|---|---|---|
| `reminder_config_get` | `{}` | `{definitions: TodoDefinition[], meta: {source_ok: Record<definition_id, boolean>}}` — `source_ok=false` flags dangling `notion_source` values (unreachable source or unknown data-source name); file-backed sources always `true` |
| `reminder_config_set` | `{definitions: TodoDefinition[]}` | `{ok: true}` on success (atomic temp-then-rename); `{ok: false, errors: [{index?, id?, field, message}]}` (HTTP 422 at the proxy layer) on validation failure, nothing written |

Rules: `reminder_config_set` runs the full data-model.md validation (duplicate ids, hour ranges, weekly/monthly field presence, id format, immutability on rename handled as delete+create by callers). The router admin proxies to these endpoints and never writes the file directly (single-writer discipline, sibling spec NFR-004). Sibling preview panel derives `next_run` per definition client-side from `reminder_compile{preview:true}` over the requested day range (no separate next-run tool).

## C7. Knowledge-base source read contract

- Store/mechanism: `llm-wiki` skill knowledge-base facts (same KB the wiki cron digests); engine reads via the existing KB read path used by the wiki cron, read-only.
- Fact shape consumed: `{fact_id, label, schedule_hint?, date_hint?}` — `label` maps to TodoDefinition title template, date/schedule hints feed the same calendar-matching rules as fixed defs (daily/weekly/monthly).
- Fixture shape for tests (`tests/reminder/fixtures/kb-facts.json`): array of `{fact_id, label, cadence: daily|weekly|monthly, weekday?, day_of_month?}`.
- KB unreachable: run fails open for routine todos exactly like Notion-unreachable (spec US-3 acceptance 3 pattern): KB-sourced todos skipped with logged warning, fixed/Notion paths unaffected.
- Notion path (C4) unchanged: existing `notion` MCP read tools, read-only like the wiki cron.
