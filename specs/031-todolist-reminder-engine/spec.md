# Feature Specification: Todolist Reminder Engine (Make.io Replacement)

**Feature Branch**: `031-todolist-reminder-engine`

**Created**: 2026-10-10

**Status**: Draft

**Input**: Replace Make.io todolist reminders with a Hermes-native engine. Parent findings (t_f34e9722): zero Make.io / Google Tasks refs in repo; only reminder surface is the weekly wiki cron digest line + event-driven `notify_user`. All 6 reminder categories are greenfield as scheduled per-item tasks.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Daily todos created once per day with dedupe (Priority: P1)

User defines a set of daily todos (from knowledge base / Notion / fixed set). Each morning at the configured send hour the engine creates one Google Task per todo, unless an identical task was already created today.

**Why this priority**: Core replacement for the Make.io daily push. Without it no reminders exist at all.

**Independent Test**: Define 2 fixed daily todos, run dispatcher at send hour twice; assert 2 Google Tasks created on first run, 0 on second run.

**Acceptance Scenarios**:

1. **Given** an enabled daily definition with send_hour=08, **When** dispatcher runs at 08:xx SGT and no task exists for today, **Then** one Google Task is created with title, notes, and due date = today.
2. **Given** a task already created today for the same definition, **When** dispatcher re-runs, **Then** no duplicate is created (dedupe hit logged).
3. **Given** a disabled daily definition, **When** dispatcher runs, **Then** it is skipped.

---

### User Story 2 - Weekly and monthly routines on calendar cadence (Priority: P1)

User defines weekly routines (weekday + hour) and monthly routines (day-of-month + hour). Engine creates Google Tasks on the matching day only.

**Why this priority**: Same engine path as daily; together they cover all routine categories.

**Independent Test**: Define weekly todo for Monday and monthly todo for day 1; simulate dispatcher on matching/non-matching dates; assert creation only on matches.

**Acceptance Scenarios**:

1. **Given** a weekly definition with weekday=1 (Monday), **When** dispatcher runs on a Monday at/after send hour, **Then** a task is created due that day.
2. **Given** the same definition, **When** dispatcher runs on a Tuesday, **Then** nothing is created.
3. **Given** a monthly definition with day=1, **When** dispatcher runs on the 1st, **Then** a task is created; on months where the day does not exist (e.g. day=30 in February) it fires on the last day of the month.

---

### User Story 3 - Card payment date reminders from Notion (Priority: P2)

Engine reads card payment due dates from the Notion `Credit Cards` / `Accounts` data sources, compiles them into dated todos with configurable lead days, and creates Google Tasks ahead of each due date.

**Why this priority**: Prevents late card payments; date compilation is the first Notion-driven path.

**Independent Test**: Seed fake Notion rows with a due date 3 days out and lead_days=3; run compiler; assert one dated todo + one Google Task created.

**Acceptance Scenarios**:

1. **Given** a card row with due date D and lead_days=3, **When** compiler runs on D-3, **Then** a dated todo for D is produced and a Google Task created.
2. **Given** the due date is missing or unparsable on a row, **When** compiler runs, **Then** the row is skipped and a `notify_user` warning is emitted (no silent failure).
3. **Given** Notion is unreachable, **When** compiler runs, **Then** the run fails open: routine todos still dispatch; card todos are skipped and the failure is logged.

---

### User Story 4 - Subscription renewal reminder 1 month before (Priority: P2)

Engine reads subscription renewal dates from Notion, subtracts a 30-day (configurable) lead, and creates a Google Task on the lead date so the user can cancel/renew in time.

**Why this priority**: Same compiler path as card dates with different lead math; high user value (avoids unwanted renewals).

**Independent Test**: Seed renewal date R; assert task created on R-30 with title naming the subscription and renewal date.

**Acceptance Scenarios**:

1. **Given** a subscription renewing on R with lead_days=30, **When** dispatcher runs on R-30, **Then** a Google Task "Subscription X renews on R" is created.
2. **Given** R-30 is in the past and no task was ever created, **When** dispatcher runs, **Then** the task is created immediately (late-catch-up, once only).

---

### User Story 5 - Card-payment reconcile nudge (Priority: P2)

After a card payment due date passes, the engine creates a "reconcile card X" todo so the user confirms the payment cleared and reconciles the statement.

**Why this priority**: Closes the loop between payment reminder and statement reconciliation (spec 004 pipeline stays arrival-driven; this is the timer-driven nudge on top).

**Independent Test**: Simulate due date D passed with payment reminder previously sent; assert reconcile nudge task created on D+1.

**Acceptance Scenarios**:

1. **Given** a card payment reminder was created for due date D, **When** dispatcher runs on D+1, **Then** a reconcile-nudge task is created (once per billing cycle). Matching rule: the nudge's `card_key` MUST equal the payment reminder's `card_key`, and the journal MUST contain a row with that `card_key` and `due_date = D` (lookup via `idx_journal_card_due`); definition_id matching alone is not sufficient.
2. **Given** no payment reminder was created for that cycle, **When** dispatcher runs, **Then** no nudge is created (no orphan nudges).

---

### User Story 6 - Per-todo remind hour, send hour, auto-doneable flag (Priority: P3)

Each todo definition carries `remind_hour` (Telegram nudge via `notify_user`), `send_hour` (Google Task creation), and `auto_doneable` (reminder-only tasks the engine may mark done without user action).

**Why this priority**: Per-item timing is the explicit gap called out in the RCA; auto-done keeps the task list clean for informational reminders.

**Independent Test**: Define reminder-only todo with auto_doneable=true; assert Telegram nudge at remind hour and completed Google Task at send hour.

**Acceptance Scenarios**:

1. **Given** a definition with remind_hour=07 and send_hour=08, **When** dispatcher runs at 07:xx, **Then** a Telegram nudge is sent and no Google Task is created yet.
2. **Given** the same definition, **When** dispatcher runs at 08:xx, **Then** the Google Task is created.
3. **Given** auto_doneable=true, **When** the Google Task is created, **Then** it is immediately marked completed with a "(reminder only)" note suffix.

---

### Edge Cases

- Dispatcher runs more than once in the same hour: second run is a no-op for already-created definitions (dedupe journal hit).
- Timezone: all hours evaluated in `Asia/Singapore`; DST does not exist in SGT.
- Monthly day overflow: day > days-in-month clamps to last day of month.
- Google Tasks API failure: task creation retried on next hourly run; failure logged with correlation ID; Telegram `notify_user` still sent so the user is not left uninformed.
- Notion unreachable: routine (fixed/KB) todos still dispatch; Notion-sourced todos skipped with logged warning.
- Duplicate definition IDs in config: dispatcher refuses to start the run and emits `notify_user` config-error alert.
- Task deleted by user in Google Tasks after creation: engine does NOT recreate (journal is source of truth for "already created").
- Clock skew / missed hour (container down at send hour): late-catch-up creates the task on the next run the same calendar day; next day starts a new cycle.
- Make.io parity: Make.io blueprints live outside the repo; before implementation closes, each Make.io scenario must be mapped to one engine story (traceability table in plan.md).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Engine MUST support three todo sources: knowledge-base facts, Notion data sources, fixed definition set.
- **FR-002**: Engine MUST support six categories: daily todos, weekly routines, monthly routines, card payment dates, subscription renewal (1-month lead), card-payment reconcile nudge.
- **FR-003**: Dispatcher MUST evaluate per-todo `remind_hour` and `send_hour` in `Asia/Singapore`.
- **FR-004**: Google Task creation MUST be deduped by SHA-256 over `(definition_id, due_date)`; duplicates skipped and logged.
- **FR-005**: Reminder-only definitions (`auto_doneable=true`) MUST be created then immediately marked completed.
- **FR-006**: Card/subscription dates MUST be compiled from Notion rows into dated todos with configurable lead days (defaults: card 3, subscription 30).
- **FR-007**: Reconcile nudge MUST fire D+1 after a card due date D, only if the payment reminder for that cycle was created — matched by `card_key` + journal lookup on `(card_key, due_date=D)`, not by definition_id alone.
- **FR-008**: Telegram nudges MUST reuse the existing `notify_user` primitive.
- **FR-009**: Config schema MUST be owned by this spec; the admin UI spec (sibling) consumes it.
- **FR-010**: Every run MUST emit JSON-line logs with correlation ID = run timestamp.

### Key Entities

- **TodoDefinition**: id (immutable; rename = delete + create), source (fixed | notion | knowledge_base), category (daily | weekly | monthly | card_payment | subscription_renewal | reconcile_nudge), schedule fields (weekday?, day_of_month?, lead_days?), remind_hour, send_hour (equal hours = nudge-first-then-create within the run; inverted hours legal), auto_doneable, enabled, card_key? (links reconcile_nudge to its parent card_payment).
- **DatedTodo**: definition_id, title, notes, due_date (routine = run date; compiled card/subscription = event date D), card_key? — output of the compiler for a given run date.
- **DispatchRecord**: dedupe_hash, definition_id, due_date, created_at, google_task_id, channel (gtasks | telegram | both).
- **NotionDateRow**: source row id, label (card/subscription name), due/renewal date, parsed status.

## Success Criteria *(mandatory)*

- **SC-001**: With Make.io disabled, all 6 categories produce Google Tasks / nudges on schedule for 7 consecutive days in staging with zero duplicates.
- **SC-002**: Killing and restarting the container mid-day causes no duplicate tasks and no missed same-day tasks (late-catch-up verified).
- **SC-003**: Every edge case in this spec has a corresponding test in the implementation tasks list.
