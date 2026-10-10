# Feature Specification: Reminder Admin UI (Configurable Todos)

**Feature Branch**: `032-reminder-admin-ui`

**Created**: 2026-10-10

**Status**: Draft

**Input**: SpecKit-compliant UI spec for managing reminder todo definitions. Parent findings
(t_f34e9722): zero Make.io / Google Tasks refs in-repo; only reminder surface is the weekly
wiki cron digest + event-driven `notify_user`; per-todo hour config and config UI are
greenfield. Sibling spec **031-todolist-reminder-engine** owns the engine, data model, and
config schema — this spec consumes them and never redefines them.

**Placement decision** (settles the "subtab or hamburger" question in the request): a
**"Reminders" subtab in the codex-router admin UI** (`router/manager.html`), collapsing to a
hamburger menu entry below 720px viewport width. Rationale: the router manager is already
the ops surface with `/admin/*` routes; the Hermes WebUI is upstream-owned chat-only code,
so building the config page there would mean fork drift on every upstream pull.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse, enable/disable, and delete todo definitions (Priority: P1)

User opens the router admin UI, clicks the Reminders subtab, and sees every todo definition
in a table: title, category, source, remind/send hours, auto-doneable, enabled state, and
computed next run. They can toggle enable/disable inline and delete a definition with
confirm.

**Why this priority**: Read + toggle is the minimum useful admin surface; every other story
builds on this shell.

**Independent Test**: Seed `config/reminders.json` with 3 definitions (1 disabled); load the
subtab; assert 3 rows render, next-run column is populated, toggling enable flips state and
persists on refetch, delete removes the row after confirm.

**Acceptance Scenarios**:

1. **Given** 3 definitions in config (1 disabled), **When** the Reminders subtab loads,
   **Then** all 3 rows render with correct columns and the disabled row is visually dimmed.
2. **Given** an enabled definition, **When** the user flips its toggle, **Then** the PUT
   succeeds, the row dims, and a refetch shows `enabled=false`.
3. **Given** a definition, **When** the user deletes and confirms, **Then** it disappears
   and a refetch confirms removal; cancelling leaves it untouched.

---

### User Story 2 - Create and edit definitions with category-aware form (Priority: P1)

User creates a new definition or edits an existing one in a form that shows only the fields
relevant to the chosen category (weekday iff weekly, day_of_month iff monthly, lead_days +
notion_source iff card/subscription, template title iff notion-sourced), plus the common
fields: title/notes, remind_hour, send_hour, auto_doneable toggle, enabled toggle.

**Why this priority**: CRUD is the core of "configurable todos"; without it the page is
read-only.

**Independent Test**: Create one definition per category through the form; assert each saves
and refetches correctly; submit an invalid form (bad id, missing weekday) and assert it is
rejected with field-level errors and nothing is written.

**Acceptance Scenarios**:

1. **Given** category=daily, **When** the form renders, **Then** weekday/day_of_month/
   lead_days/notion_source inputs are hidden and not submitted.
2. **Given** category=weekly without weekday, **When** the user saves, **Then** save is
   blocked with a field-level error and no PUT is issued.
3. **Given** a valid edit, **When** the user saves, **Then** the PUT succeeds, the table
   row updates, and a toast confirms.

---

### User Story 3 - Preview next runs before they dispatch (Priority: P2)

User opens the preview panel (default next 7 days, adjustable 1–30) and sees the dated
todos the engine *would* create: date, definition title, channel (gtasks/telegram/both),
and dedupe-skipped rows marked as such. Preview never writes to the dispatch journal.

**Why this priority**: Gives confidence that hour/category config is right; catches
misconfig before a week of wrong tasks.

**Independent Test**: Seed definitions covering daily + weekly + a disabled item; request
preview days=7; assert expected row count, disabled item absent, and journal row count
unchanged.

**Acceptance Scenarios**:

1. **Given** definitions including 1 disabled, **When** preview days=7 loads, **Then** rows
   cover 7 days, the disabled definition contributes zero rows.
2. **Given** a task already dispatched (journal hit), **When** preview renders that date,
   **Then** the row is marked "already dispatched — will skip".
3. **Given** any preview request, **When** it completes, **Then** the dispatch journal is
   byte-identical (preview is side-effect-free).

---

### User Story 4 - Validation errors block bad saves with clear messages (Priority: P2)

Every save runs full validation (client fast-path + server authoritative dry-run); failures
block the write and surface per-field messages. Duplicate ids, out-of-range hours, and
missing category-required fields are all caught.

**Why this priority**: A bad config can refuse an entire dispatcher run (031 edge case);
the UI must make bad saves impossible, not just unlikely.

**Independent Test**: Attempt saves with duplicate id, send_hour=25, weekly-without-weekday;
assert each is rejected with the offending field highlighted and config file unchanged.

**Acceptance Scenarios**:

1. **Given** two definitions sharing an id, **When** the user saves, **Then** the save is
   rejected naming both rows and the duplicate id.
2. **Given** send_hour=25, **When** the user saves, **Then** the hour field errors with the
   valid range and nothing is written.
3. **Given** the server rejects a save the client passed, **When** the response arrives,
   **Then** server messages render against the matching fields (fallback: form-level
   banner).

---

### Edge Cases

- Config file edited externally mid-session: save PUTs the full array; last-writer-wins,
  and the UI refetches after every save so drift is visible within one action. (No
  optimistic locking in v1 — single-operator assumption, documented.)
- Dispatcher running during a save: atomic temp-then-rename write means the dispatcher
  never reads a half-written file; it picks up the new config on its next hourly run.
- Notion source deleted/renamed: rows with dangling `notion_source` still render, flagged
  "source unreachable"; engine fails open per 031.
- 30+ definitions: table paginates client-side at 20 rows; preview caps at 500 rows with
  a "truncated" notice.
- Router admin unreachable from expense-tracker (proxy down): subtab shows a banner with
  the failing endpoint and retry; table shows last-known state only if previously loaded,
  never stale-without-label.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: UI MUST expose all six 031 categories and three sources; no category may be
  unrepresentable in the form.
- **FR-002**: Every TodoDefinition field in 031 data-model.md MUST be viewable; every
  mutable field MUST be editable except `id` after creation (id is immutable; rename =
  delete + create, stated in the form).
- **FR-003**: remind_hour MUST accept null (= no Telegram nudge); send_hour is required.
- **FR-004**: auto_doneable and enabled MUST be inline toggles on the table row.
- **FR-005**: Preview MUST be side-effect-free (no journal writes); enforced server-side
  by the engine's preview flag (`reminder_compile{preview:true}`, 031 contracts.md C2).
- **FR-006**: Saves MUST go through the validate dry-run before the real PUT when the
  client has any doubt (server always re-validates regardless).
- **FR-007**: All hours displayed and entered in `Asia/Singapore`, labeled "SGT" next to
  every hour input.
- **FR-008**: Config schema ownership stays with 031; this spec MUST NOT add, rename, or
  narrow any field — it may only hide inapplicable fields per category.

### Non-Functional Requirements

- **NFR-001**: No new auth surface — the subtab inherits the router admin's existing
  access control (localhost-only binding: codex-router `router/admin.py` runs
  uvicorn on `127.0.0.1:${CODEX_ROUTER_ADMIN_PORT:-4099}`; no tailnet reference
  exists in codex-router — any remote access is provided by the operator's own
  network layer outside this spec).
- **NFR-002**: Subtab initial render ≤ 1s on localhost (one GET for definitions, one GET
  for preview, fired in parallel).
- **NFR-003**: Zero fork drift on Hermes WebUI — no changes to upstream-owned WebUI code.
- **NFR-004**: Single writer: only the expense-tracker container writes
  `config/reminders.json`; the router admin proxies, never writes the file directly.

### Key Entities (references — normative definitions live in 031 data-model.md)

- **TodoDefinition**: id, source, category, title, notes, weekday?, day_of_month?,
  lead_days?, notion_source?, remind_hour (nullable), send_hour, auto_doneable, enabled.
- **PreviewRow**: date, definition_id, title, channel (gtasks | telegram | both),
  skipped (bool, dedupe hit).
- **ValidationError**: row index or definition id, field, message.

## Success Criteria *(mandatory)*

- **SC-001**: All 6 categories creatable/editable through the form with zero console
  errors; each round-trips through refetch byte-identical.
- **SC-002**: Every validation rule in 031 data-model.md is triggerable from the UI and
  blocks the save with a field-level message.
- **SC-003**: Preview for 7 days matches the engine's actual next-7-day dispatch
  (verified against staging journal) with zero phantom/missing rows.

## Non-Goals

- Editing Notion rows or KB facts from this UI (sources are managed where they live).
- Dispatch history / journal browser (engine logs cover it; a history tab is a future
  feature, not this one).
- Per-definition custom timezone (SGT-only per 031).
- Mobile-native app; responsive down to 360px is enough.

---

## Routes

All under the existing router admin server (`router/admin.py`). No new page route — the
subtab lives in the existing `manager.html` SPA.

| Method | Route | Purpose |
|---|---|---|
| GET | `/admin/reminders/api/definitions` | Array of TodoDefinition + computed `next_run` per item (derived client-side from preview — see below; no separate engine next-run tool) |
| PUT | `/admin/reminders/api/definitions` | Full-array replace (atomic server-side); 422 + per-index errors on validation failure |
| POST | `/admin/reminders/api/definitions/validate` | Dry-run validation only; same error shape, nothing written |
| GET | `/admin/reminders/api/preview?days=N` | PreviewRow[] for next N days (1–30, default 7); side-effect-free via engine `reminder_compile{preview:true}` (031 contracts.md C2; preview flag landed in 031 amendment `4e1d012`) |

**`next_run` derivation (no engine next-run tool):** the subtab computes `next_run`
per definition client-side from the already-fetched preview rows — earliest
preview row date for that definition id, or null when it contributes zero rows
in range. The per-row State column and `next_run` therefore always agree (same
source data). If 031 later adds a dedicated next-run tool, this derivation MAY
be replaced without changing the table contract.

Backend flow: router admin **proxies** to new expense-tracker tools-API endpoints
(`reminder_config_get` / `reminder_config_set` / `reminder_compile{preview:true}` — 031 contracts.md C2/C6, landed in 031 amendment `4e1d012`), which
are the sole writer of `config/reminders.json` (atomic temp-then-rename). The proxy exists
so the browser talks to one origin (the admin server it already uses).

## Wireframe (Reminders subtab)

```
+---------------------------------------------------------------+
| Router Manager  [Status] [Models] [Reminders]   <-- new subtab |
+---------------------------------------------------------------+
| Definitions (N)                        [+ New definition]     |
|---------------------------------------------------------------|
| Title | Category | Remind | Send | Auto-done | Next run | On |   |
|-------...                                              [⋯]  |  <- row: toggle, edit, delete
|---------------------------------------------------------------|
| Preview: next [7 v] days                        [Refresh]     |
| Date | Definition | Channel | State (pending/dispatched-skip) |
+---------------------------------------------------------------+
| Definition form (modal/drawer):                             |
|  id* (immutable after create)  title*  category* [select]    |
|  source* [fixed|notion|knowledge_base]                      |
|  [conditional block per category — see US-2]                 |
|  remind_hour (SGT, empty = no nudge)  send_hour* (SGT)       |
|  [x] auto-doneable (reminder only)   [x] enabled             |
|  [Validate] [Save] [Cancel]                                 |
+---------------------------------------------------------------+
```

Below 720px the subtab bar collapses into the existing hamburger menu with a "Reminders"
entry; layout stacks to one column.

## Component / State Spec

- **DefinitionsTable**: props `definitions[]`, `onToggle(id)`, `onEdit(id)`,
  `onDelete(id)`; dimmed style when `enabled=false`; badge when `notion_source`
  unreachable (from GET meta).
- **DefinitionForm**: local draft state initialized from the row (or blanks); category
  selector drives conditional block visibility AND the submitted field set (hidden fields
  are nulled, never sent stale); client fast-path validation mirrors 031 rules; Save =
  validate-POST then PUT; server 422 maps onto fields.
- **PreviewPanel**: props `days`, `rows[]`; Refresh refetches; "dispatched — will skip"
  rows styled muted; truncation notice past 500 rows.
- **Client state shape**: `{ definitions, preview: {days, rows}, saving, errors: {field:
  msg}, banner }`. No client persistence (no localStorage) — the server is the source of
  truth; refetch after every mutation.
- **Error contract**: 422 body `{errors: [{index?, id?, field, message}]}` shared by
  validate-POST and PUT, so the form renders both identically.

## Config Schema

Owned by 031 (`config/reminders.json`, array of TodoDefinition; validation rules in
`031 data-model.md` are normative for this UI). This spec adds no fields. UI-relevant
subset repeated here for form builders (on any conflict, 031 wins):

- `id` string `^[a-z0-9-]+$`, required, immutable after creation.
- `source` enum fixed|notion|knowledge_base, required.
- `category` enum daily|weekly|monthly|card_payment|subscription_renewal|reconcile_nudge.
- `title` required (fixed/KB) or template (notion, e.g. `"Pay {label} by {date}"`).
- `weekday` 0–6 required iff weekly; `day_of_month` 1–31 required iff monthly (overflow
  clamps); `lead_days` ≥ 0 (card default 3, subscription default 30); `notion_source`
  required iff source=notion.
- `remind_hour` 0–23 or null; `send_hour` 0–23 required; SGT.
- `auto_doneable` bool default false; `enabled` bool default true.
- Whole-file invariant: unique ids; duplicates refuse the run (engine) and the save (UI).

## Validation Rules (enforced client fast-path + server authoritative)

1. id matches `^[a-z0-9-]+$`, unique across the array.
2. source/category are in-enum; unknown values rejected naming the allowed set.
3. weekday present-and-0–6 iff category=weekly; must be null otherwise.
4. day_of_month present-and-1–31 iff category=monthly; must be null otherwise.
5. lead_days ≥ 0 int; defaults applied (3 / 30) when null on card/subscription rows.
6. notion_source non-empty iff source=notion; must be null otherwise.
7. remind_hour null or 0–23; send_hour required 0–23.
8. title non-empty; notion rows must contain at least one `{placeholder}` or warn
   (warn, not block — templates may be plain text).
9. Array-level: duplicate ids → whole save refused, both rows named.

## Dependencies on Reminder Engine Spec (031)

- **D1 (schema)**: 031 data-model.md + contracts.md C5 are normative; any 031 schema
  change requires a matching update to this spec's Config Schema section.
- **D2 (preview mode)**: engine's `reminder_compile` supports a side-effect-free
  preview flag (no journal writes); the PreviewPanel depends on it. LANDED in
  031 (contracts.md C2 `{date, preview?}`, amendment `4e1d012`).
- **D3 (config endpoints)**: engine exposes `reminder_config_get` /
  `reminder_config_set` (atomic write) for the admin proxy; validation logic shared, not
  duplicated. LANDED in 031 (contracts.md C6, amendment `4e1d012`).
- **D4 (unreachable-source signal)**: GET definitions includes per-row
  `source_ok` (`meta.source_ok` map) so the table can flag dangling `notion_source` values.
  LANDED in 031 (contracts.md C6, amendment `4e1d012`).

## References

- Parent findings: `docs/reminder/rca-2026-10-10.md` (feat/rca-reminder-map worktree;
  merged-separately).
- Sibling engine spec: `specs/031-todolist-reminder-engine/` (spec.md, data-model.md,
  contracts.md) — normative for schema, scheduling, and engine behavior.
- Router admin surface: codex-router `router/admin.py` (`/admin/*` routes),
  `router/manager.html` (SPA shell).
- Constitution: `.specify/memory/constitution.md` v4.0.0 (configure-don't-build,
  TDD for implementation stories, Docker-first).
