# Quickstart: Todolist Reminder Engine (031)

Staging verification for SC-001 / SC-002. No production commands (per AGENTS.md).

1. Seed config: copy `config/reminders.json` example (2 fixed dailies, 1 weekly), all Notion-sourced `enabled: false` until secrets land.
2. Set env: `GOOGLE_TASKS_SERVICE_ACCOUNT_JSON`, `GOOGLE_TASKS_LIST_ID` (staging tasklist).
3. Trigger dispatcher manually for today 08 SGT; assert Tasks created once.
4. Re-run same hour; assert zero new tasks (dedupe).
5. Restart container; re-run; assert zero duplicates + same-day catch-up intact.
6. Enable one Notion card row fixture; assert D-3 task appears.
7. Soak 7 days; log evidence per SC-001.
