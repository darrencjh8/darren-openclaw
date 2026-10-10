# Implementation Plan: Todolist Reminder Engine (031)

**Branch**: `031-todolist-reminder-engine` | **Date**: 2026-10-10 | **Spec**: `spec.md` (same dir)

**Input**: Greenfield engine replacing Make.io. No in-repo code to migrate.

## Summary

Hourly Hermes dispatcher cron evaluates file-backed todo definitions, compiles Notion/KB dates into dated items, creates deduped Google Tasks, and sends Telegram nudges via `notify_user`. State in new SQLite `data/reminder.db`.

## Technical Context

**Language/Version**: Node.js 24 ESM (expense-tracker container, post spec-012 migration)
**Primary Dependencies**: `better-sqlite3`, built-in `fetch` (Google Tasks REST), existing `notify_user` HMAC path
**Storage**: `data/reminder.db` (new) + `config/reminders.json` (new)
**Testing**: `vitest` (`.test.js`, RED-GREEN-REFACTOR per constitution 2.3)
**Target Platform**: Ubuntu/Docker Compose (existing topology)
**Project Type**: container-internal scheduler + deterministic tools
**Performance Goals**: hourly run < 60s for < 200 definitions
**Constraints**: memory budget unchanged (~900MB total, no new container); secrets via env only
**Scale/Scope**: single user, tens of definitions, 6 categories

## Constitution Check

- 2.1 Configure-not-build: new work is skills + tools + one cron seed. No gateway fork. PASS.
- 2.2 Skills + deterministic tools: `reminder_*` tools in `tools.js` pattern, LLM decides order. PASS.
- 2.3 TDD: every implementation task below has a RED test task first. PASS (spec-only task: no code here).
- 2.4 Docker-first: no new container, no new port. PASS.
- 2.5 Memory: no new service. PASS.
- 2.6 Security: service-account JSON + tasklist ID via env, never committed. PASS.
- 2.7 Integrity: SHA-256 dedupe journal, idempotent re-runs, no silent failures (unparsable dates warn). PASS.
- 2.8 Tools-not-code: date math/hash/journal deterministic; classification ambiguous-row handling via LLM. PASS.
- 2.9 Observability: JSON-line logs with `reminder-<ts>` correlation ID. PASS.

## Project Structure

```text
specs/031-todolist-reminder-engine/
├── spec.md | plan.md (this file) | tasks.md
├── research.md | data-model.md | contracts.md | quickstart.md
└── checklists/requirements.md
modules/expense-tracker/
├── src/reminder/{compile.js,dispatch.js,tasks.js,journal.js}
├── config/reminders.json (seed: 2 fixed dailies, disabled Notion until secrets land)
└── tests/reminder/*.test.js
modules/hermes/50-seed-defaults (one hourly job block)
```

## Scheduling / rules engine

- One hourly cron tick; per-run: load config (refuse run on duplicate ids / bad hours) -> `reminder_compile(date)` -> for items whose `send_hour == now.hour`: dedupe-check -> create -> journal -> auto-complete if flagged -> `reminder_nudge(date, hour)` for `remind_hour` matches.
- Calendar matching: daily = every day; weekly = `weekday` match; monthly = `day_of_month` match with end-of-month clamp; card/subscription = `due_date - lead_days == today` (+ late-catch-up once); reconcile = D+1 iff payment record for D exists.
- All hours SGT.

## Make.io traceability (pre-implementation gate)

Each Make.io scenario (exported from console, outside repo) maps to one spec story:

| Make.io scenario | Engine story | Status |
|---|---|---|
| (to attach) daily push | US-1 | pending export |
| (to attach) weekly/monthly | US-2 | pending export |
| (to attach) card/subscription | US-3/US-4 | pending export |
| (to attach) reconcile follow-up | US-5 | pending export |

Implementation tasks must not close until this table is filled.

## Phases

1. Config + journal + validation (blocks everything).
2. Dispatcher + dedupe + Tasks create/complete (US-1, US-2, US-6).
3. Notion compiler + reconcile nudge (US-3, US-4, US-5).
4. Cron seed + staging soak (SC-001 7-day, SC-002 restart test).
