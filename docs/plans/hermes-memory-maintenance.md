QUESTIONS
q: Which Hermes memory and wiki cron problems does this change fix, and on what evidence? | a: Read-only prod inspection on 2026-10-10/11. `memory-compact` sends unpinned replace/remove ops, which Hermes' `apply_memory_pending` refuses (`/opt/hermes/tools/memory_tool.py:294`); `mnemosyne-vacuum.sh` calls the `sqlite3` CLI, which the image lacks (`command -v sqlite3` is empty), so it only prints sizes; `memory-triage` applied the previous day's plan on 10-10 and has re-held the same 5 records daily since 10-07; four seed blocks treat an unreadable `jobs.json` as empty and rewrite it; the MEMORY.md pointer seed re-adds a duplicate pointer (#765).
q: What schedule does the operator want for wiki maintenance, and in which timezone are cron expressions read? | a: 04:00 SGT on Mondays. `/opt/data/config.yaml` sets `timezone: Asia/Singapore` and live `next_run_at` values carry `+08:00`, so the expression is `0 4 * * 1`.
q: Why is a one-time migration needed for schedule changes? | a: The seed sets schedule fields only when it creates a job, so a dashboard choice is never reverted. Existing installs therefore need the same exact-legacy-value migration `memory-triage` already uses (`LEGACY_SCHEDULE = "0 9 * * *"`): only the exact old default is rewritten.
q: Is Python's sqlite3 module available where the vacuum script runs? | a: Yes. `/usr/bin/python3` and `/opt/hermes/.venv/bin/python3` both import sqlite3 (Python 3.13.5, SQLite 3.53.4). The operator chose it over installing the apt `sqlite3` package.
q: How is Mnemosyne consolidation run across sessions, and is it safe weekly? | a: `hermes mnemosyne sleep --all-sessions` (mnemosyne_hermes 0.7.1 CLI). A `--dry-run` on prod returned `no_op` (no working memory older than the 84 h eligibility cutoff yet). It consolidates and never deletes.
q: Where is `cross_session` read from? | a: `mnemosyne.core.config.resolve_beam_runtime()` reads `cross_session` from `/opt/data/mnemosyne/config.yaml` (config beats env). Hermes' `memory.mnemosyne.*` keys do not reach it, so the seed sets the key in that file. `true` removes session scoping for recall (the filter becomes `1=1`). Operator decision: `cross_session: true`, `default_scope` unchanged.
q: How are Telegram tables enabled, and does cron delivery use them? | a: The Telegram adapter's Bot API Rich Messages are opt-in via `platforms.telegram.extra.rich_messages` (`plugins/platforms/telegram/adapter.py:566`); the token still comes from `TELEGRAM_BOT_TOKEN` (env overrides merge via `setdefault`). Cron `_deliver_result` tries the live adapter first, and the adapter sends content containing a pipe table through `sendRichMessage`; without rich support, tables degrade to bullet groups.
q: What does MALLOC_ARENA_MAX change? | a: It caps glibc's per-thread malloc arenas (default 8 per core = 32 here; the WebUI runs 37 threads and holds 1.4 GB). `2` reduces fragmentation and unreturned memory at negligible cost under the GIL.
q: What does the wiki lint script check? | assumption: The structural rules already listed in the wiki job prompt step 6 and in the wiki's `SCHEMA.md`: frontmatter present, tags in the taxonomy, declared sources exist, raw SHA-256 verifies, every page indexed exactly once, index count, wikilinks resolve, inbound links, at least two outbound wikilinks. The script reports; it never edits.

# Hermes memory and wiki maintenance fixes

Tracked by issue #765 (the pointer fix); the other items were found in the same audit.

## Change

A. `modules/hermes/50-seed-defaults` PYPTR block: skip when the core already references `/opt/data/memories/topics` (committed). Test: `tests/test-memory-pointer.sh`.

B. Wiki maintenance default schedule `0 4 * * 1` ("every monday 4am") plus one-time migration from exact `0 9 * * 1`.

C. `scripts/memory_triage.py compact`: pin every replace/remove with Hermes' `_pin_matched_entries` (dry-run included) before any topic append; refuse on a pin failure. The test stub in `tests/test_memory_triage_compact.py` enforces the same pin rule.

D. `scripts/mnemosyne-vacuum.sh`: Python `sqlite3` for integrity, counts and VACUUM; `hermes mnemosyne sleep --all-sessions` before VACUUM. Output is a short Markdown table. The job's delivery stays `local` and the script exits non-zero only when integrity is not `ok` or sleep fails, which raises Hermes' cron error alert.

E. `memory-compact` default `30 7 * * 0`, migration from exact `30 8 * * 0`.

F. `self-wiki-reminders-daily` default `15 8 * * *`, migration from exact `0 8 * * *`.

G. Compact, triage, wiki and reminders seed blocks refuse an unreadable or malformed `jobs.json` and write it atomically, like the vacuum block.

H. Triage: `apply` refuses a plan file older than the queue listing (`/opt/data/tmp/triage-queue.json`); the digest gains a "Needs you" section for records held 7+ days, showing their text. Nothing is auto-discarded.

I. Seed sets `cross_session: true` in `/opt/data/mnemosyne/config.yaml` when the file exists.

J. New `scripts/wiki-lint.py`; the wiki prompt's step 0 reads only index, schema, log and pages flagged by the lint or diffs, and step 6 runs the script.

K. `config.yaml`: `platforms.telegram.extra.rich_messages: true`; triage and compact digests rewritten as short Markdown tables.

L. `modules/docker-compose.yml`: `MALLOC_ARENA_MAX=2` on the hermes service.

Each behaviour change gets a failing test first (seed shell tests, Python tests for triage/compact/lint, vacuum shell test).

## Risks

- `cross_session: true` makes every session's memories visible to every session, including delete visibility. Accepted by the operator.
- Rich messages are harder to copy as plain text in current Telegram clients (adapter comment). Accepted for readability.
- A schedule migration only fires on the exact legacy value, so a dashboard-chosen time is left alone.
