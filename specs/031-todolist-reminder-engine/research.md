# Research: Todolist Reminder Engine (031)

**Date**: 2026-10-10
**Input**: Parent task t_f34e9722 handoff (RCA report `docs/reminder/rca-2026-10-10.md`, worktree `feat/rca-reminder-map`).

## Current-system findings (verified from RCA)

- Make.io: 0 references in repo. Scenario logic (if any) lives outside the repo. Nothing to migrate in-repo.
- Google Tasks: 0 references. No creation path, no auth, no tasklist wiring. Greenfield.
- Only scheduled reminder surface: cron `self-wiki-maintenance-and-reminders` (`modules/hermes/50-seed-defaults:1057`, expr `0 9 * * 1`, Monday 9am) emitting a 30-day account-date Telegram digest line. Not per-item tasks.
- Card/subscription dates live in Notion `Accounts` / `Credit Cards` data sources, read weekly, read-only (`50-seed-defaults:1028,1030`). Never compiled to dated tasks.
- Delivery primitive exists: `notify_user` (`modules/expense-tracker/src/tools.js:682-690`, `:1856-1896`) — fire-and-forget webhook POST with cooldown. No scheduling, no state.
- Scheduler: Hermes cron, jobs in `/opt/data/cron/jobs.json` seeded by `50-seed-defaults`, per-job `schedule` + `deliver`, timezone `Asia/Singapore` (`modules/hermes/config.yaml:153`).
- Reconcile tooling exists (`reconcile_transaction`, `fetch_unreconciled_transactions`) but is statement-arrival-driven, not timer-driven.
- WebUI is chat-only; no per-todo config surface (sibling task t_33344451 owns the admin UI spec).

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Single hourly dispatcher cron job, not one cron job per todo | `jobs.json` explosion avoided; per-todo hours evaluated against `Asia/Singapore` clock inside the dispatcher |
| D2 | Deterministic tools live in the expense-tracker container (`reminder_*` tools) | No new container; stays inside constitution memory budget (~900MB); reuses `notify_user` HMAC path and JSON-line logging |
| D3 | State journal is SQLite (`data/reminder.db`), separate file from `dedup.db` / `statement.db` | Follows statement-pipeline precedent; no direct DB sharing across modules |
| D4 | Dedupe = SHA-256 over `(definition_id, due_date)` checked before every Google Tasks insert | Same pattern as constitution 2.7 duplicate prevention |
| D5 | Google Tasks auth = service-account JSON via env, same as portfolio-tracker Sheets usage | Consistent with existing `GOOGLE_SERVICE_ACCOUNT_JSON` precedent; never committed |
| D6 | LLM classifies/matches; Python..Node layer never hardcodes business rules | Constitution 2.8: tools, not code. Date compilation rules (lead days, clamping) are deterministic date math, allowed as tools |
| D7 | `notify_user` stays the Telegram delivery primitive; task-state layer sits above it | RCA finding: keep primitive, add state |
| D8 | Config schema defined here; admin UI (sibling spec) consumes it read/write | Avoids two cards deciding one schema (orchestrator-owned boundary) |

## Open inputs (not blockers for spec)

- Make.io scenario blueprints must be exported from the Make.io console (outside repo) and attached to the implementation task for source-parity checking.
- Target Google tasklist ID and service-account provisioning are deploy-time secrets, resolved at implementation.
