# Data Model: Todolist Reminder Engine (031)

**Source**: spec.md key entities. Storage: SQLite `data/reminder.db` (new file, same container as expense-tracker).

## TodoDefinition (config, file-backed JSON)

File: `config/reminders.json` (read by dispatcher; written by admin UI per sibling spec).

```json
{
  "id": "daily-exercise",
  "source": "fixed",
  "category": "daily",
  "title": "Morning exercise",
  "notes": "",
  "weekday": null,
  "day_of_month": null,
  "lead_days": null,
  "notion_source": null,
  "remind_hour": 7,
  "send_hour": 8,
  "auto_doneable": false,
  "enabled": true,
  "card_key": null
}
```

| Field | Type | Rules |
|---|---|---|
| id | string | unique, `^[a-z0-9-]+$`, required |
| source | enum | `fixed` \| `notion` \| `knowledge_base`, required |
| category | enum | `daily` \| `weekly` \| `monthly` \| `card_payment` \| `subscription_renewal` \| `reconcile_nudge`, required |
| title | string | required for fixed/KB; template for notion (e.g. `"Pay {label} by {date}"`) |
| weekday | int 0-6 | required iff category=weekly (0=Sunday) |
| day_of_month | int 1-31 | required iff category=monthly; overflow clamps to month end |
| lead_days | int >= 0 | card_payment default 3, subscription_renewal default 30; null otherwise |
| notion_source | string | required iff source=notion (data-source name, e.g. `Credit Cards`) |
| remind_hour | int 0-23 | Telegram nudge hour SGT; null = no nudge |
| send_hour | int 0-23 | Google Task creation hour SGT, required |
| auto_doneable | bool | default false; true = create then immediately complete |
| enabled | bool | default true |
| card_key | string \| null | stable key linking a card_payment definition to its reconcile_nudge definition(s) (e.g. `"dbs-visa"`); required iff category=reconcile_nudge (points at the parent card_payment); optional on card_payment itself (self-key so the D+1 rule can match). Also copied onto compiled DatedTodo rows (see below) |

Validation: duplicate ids refuse the whole run (spec edge case). `remind_hour`/`send_hour` out of range refuse the run. **Id immutability: `id` is immutable once created; rename = delete + create (two operations, never an in-place id change) — the validator rejects any PUT/set payload that reuses an existing row position with a different id as an update.** Hour ordering: when both hours are set and equal, deterministic order within that hourly run is nudge-first-then-create (`reminder_nudge` before `reminder_tasks_create`); when `remind_hour > send_hour` (inverted) the nudge fires after creation the same day — both are legal, no refusal. DatedTodo due_date derivation: routine (fixed/KB) defs → `due_date = run date`; compiled card/subscription items → `due_date = event date D` (the actual due/renewal date, NOT the lead/creation date) so the dedupe hash + yearly re-fire key on the event.

## dispatch_journal (SQLite)

```sql
CREATE TABLE dispatch_journal (
  dedupe_hash   TEXT PRIMARY KEY,  -- sha256(definition_id || '|' || due_date)
  definition_id TEXT NOT NULL,
  due_date      TEXT NOT NULL,     -- YYYY-MM-DD (SGT)
  card_key      TEXT,              -- nullable; copied from TodoDefinition/DatedTodo for D+1 parent matching
  created_at    TEXT NOT NULL,     -- ISO8601 SGT
  google_task_id TEXT,             -- null if only telegram nudge
  channel       TEXT NOT NULL      -- 'gtasks' | 'telegram' | 'both'
);
CREATE INDEX idx_journal_def_due ON dispatch_journal(definition_id, due_date);
CREATE INDEX idx_journal_card_due ON dispatch_journal(card_key, due_date);
```

Retention: rows older than 90 days may be pruned (dedup window only needs current cycle + late-catch-up).

## DatedTodo (compiler output, per run date)

`{definition_id, title, notes, due_date, card_key?}` — `card_key` copied from the parent TodoDefinition when set (card_payment + reconcile_nudge rows); routine rows omit it (null).

## State transitions

```
DatedTodo --(hash not in journal)--> create Google Task (+ optional notify_user)
          --(hash in journal)------> skip, log dedupe hit
Google Task (auto_doneable) -------> tasks.complete immediately, note += "(reminder only)"
Card due D passed + payment record exists --> reconcile_nudge DatedTodo for D+1
```

No other states. Journal is append-only; user deleting a Google Task does not delete the journal row (no recreate).
