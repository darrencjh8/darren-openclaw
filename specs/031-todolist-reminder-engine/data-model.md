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
  "enabled": true
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

Validation: duplicate ids refuse the whole run (spec edge case). `remind_hour`/`send_hour` out of range refuse the run.

## dispatch_journal (SQLite)

```sql
CREATE TABLE dispatch_journal (
  dedupe_hash   TEXT PRIMARY KEY,  -- sha256(definition_id || '|' || due_date)
  definition_id TEXT NOT NULL,
  due_date      TEXT NOT NULL,     -- YYYY-MM-DD (SGT)
  created_at    TEXT NOT NULL,     -- ISO8601 SGT
  google_task_id TEXT,             -- null if only telegram nudge
  channel       TEXT NOT NULL      -- 'gtasks' | 'telegram' | 'both'
);
CREATE INDEX idx_journal_def_due ON dispatch_journal(definition_id, due_date);
```

Retention: rows older than 90 days may be pruned (dedup window only needs current cycle + late-catch-up).

## State transitions

```
DatedTodo --(hash not in journal)--> create Google Task (+ optional notify_user)
          --(hash in journal)------> skip, log dedupe hit
Google Task (auto_doneable) -------> tasks.complete immediately, note += "(reminder only)"
Card due D passed + payment record exists --> reconcile_nudge DatedTodo for D+1
```

No other states. Journal is append-only; user deleting a Google Task does not delete the journal row (no recreate).
