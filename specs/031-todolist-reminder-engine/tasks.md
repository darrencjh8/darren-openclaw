# Tasks: Todolist Reminder Engine (031)

**Input**: spec.md, plan.md, data-model.md, contracts.md (same dir)
**TDD**: every implementation task has a RED test task first (constitution 2.3). `[P]` = parallelizable (different files, no deps).

## Phase 1: Config + journal (foundation, blocks all stories)

- [ ] T001 [P] RED: config validation tests (`tests/reminder/config.test.js`) — duplicate ids, bad hours, missing weekly/monthly fields.
- [ ] T002 Config loader + validator (`src/reminder/config.js`) — TodoDefinition schema per data-model.md. Deps: T001.
- [ ] T003 [P] RED: journal tests (`tests/reminder/journal.test.js`) — insert, dedupe-hash primary key, def+due lookup, 90-day prune.
- [ ] T004 Journal class (`src/reminder/journal.js`, `data/reminder.db`). Deps: T003.
- [ ] T005 Seed `config/reminders.json` (2 fixed dailies + 1 weekly example, Notion-sourced disabled). Deps: T002.

## Phase 2: Dispatcher + Google Tasks (US-1, US-2, US-6) MVP

- [ ] T006 [P] RED: calendar-matching tests (`tests/reminder/compile.test.js`) — daily/weekly/monthly match + month-end clamp.
- [ ] T007 `reminder_compile` for fixed + KB sources (`src/reminder/compile.js`). Deps: T002, T006.
- [ ] T008 [P] RED: dispatch/dedupe tests (`tests/reminder/dispatch.test.js`) — double-run no-op, disabled skip, auto_doneable completes.
- [ ] T009 Google Tasks client (`src/reminder/tasks.js`: insert/complete via `tasks.googleapis.com`, env auth). Deps: T008.
- [ ] T010 `reminder_dispatch` + `reminder_nudge` wiring `notify_user` (`src/reminder/dispatch.js`). Deps: T004, T007, T009. Label: feat-031-dispatch.
- [ ] T011 Hourly cron seed block in `modules/hermes/50-seed-defaults` + seed test update. Deps: T010. [P] with T012.
- [ ] T012 [P] Quickstart soak runbook (`quickstart.md` staging steps for SC-001/SC-002). No code.

## Phase 3: Notion compiler + reconcile nudge (US-3, US-4, US-5)

- [ ] T013 [P] RED: Notion compiler tests (`tests/reminder/notion-compile.test.js`) — lead math, unparsable-date skip+warn, unreachable fails open.
- [ ] T014 Notion date compiler extension to `compile.js` (card lead 3, subscription lead 30, late-catch-up). Deps: T007, T013. Label: feat-031-notion-compile.
- [ ] T015 [P] RED: reconcile-nudge tests (`tests/reminder/reconcile.test.js`) — D+1 only with payment record, no orphans.
- [ ] T016 Reconcile nudge step in dispatcher. Deps: T010, T015. Label: feat-031-reconcile-nudge.

## Phase 4: Parity + staging

- [ ] T017 Fill Make.io traceability table (plan.md) from console exports; attach exports to task. Blocks close.
- [ ] T018 Staging soak: 7-day SC-001 + restart SC-002, evidence logged. Deps: T011, T014, T016, T017.

## Dependency graph

```
T001 -> T002 -> T005,T007
T003 -> T004 --\
T006 -> T007 -> T010 -> T011 -> T018
T008 -> T009 -> T010 -> T016 -> T018
T013 -> T014 -> T018
T015 -> T016
T012 (docs, parallel)   T017 (gate, parallel)
```
