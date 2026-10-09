# Mnemosyne activation (seed-owned)

Mnemosyne is a memory provider plugin, not a context engine and not a
replacement for the `memory-triage` cron. Built-in `MEMORY.md`/`USER.md`
stay ON (additive). The seed owns the provider flip plus the version pin,
so reboots keep the working state instead of drifting.

## What Hermes reads

Only `MEMORY.md`/`USER.md` auto-inject every turn. `topics/*.md` load via
the core pointer plus keyword search. `state.db` loads via `session_search`.
`DREAMS.md` never loads. Mnemosyne loads via pre-turn prefetch plus its own
system-prompt header once `memory.provider: mnemosyne` is set.

## Install (seed-owned, verified live 2026-10-09)

The seed flips `memory.provider: mnemosyne` (only when the provider loads)
and pins the working pair into `/opt/data/lazy-packages`. Operator install
is a one-time bootstrap only:

```bash
hermes plugins install mnemosyne
```

Restart ships via the deploy pipeline, never by hand on prod.

Version pins: `mnemosyne-hermes==0.7.1` + `mnemosyne-memory[embeddings]
==3.15.1` is the working stable pair. Do NOT take 0.7.3/0.7.4: the P1b
home-binding guard makes `MnemosyneMemoryProvider.__init__` raise under any
turn scope (`self._beam = None` hits `_write_slot()` before `_bindings`
exists), so discovery logs "loaded but no provider instance found" and no
session ever gets tools. Avoid `0.7.2` (imports APIs its floor lacks).
Needs Hermes `>=0.21.4` (prod runs v0.21.5). Catalog versus wrapper share one path
`$HERMES_HOME/plugins/mnemosyne`; catalog install onto a wrapper refuses
with "already exists", uninstall first to switch.

RAM: core `~50MB` needs a remote embedding endpoint, `[embeddings]` `~800MB`
needs 2GB free, `[all]` `~1.5GB` wants 8GB. First use downloads
`BAAI/bge-small-en-v1.5` from Hugging Face; first uncached sleep downloads
`MiniCPM5-1B-Q4_K_M.gguf` `~656MB`. `MNEMOSYNE_LLM_ENABLED=false` skips it.

## Verify

```bash
hermes memory status
hermes tools list | grep mnemosyne_
hermes mnemosyne stats
hermes mnemosyne sleep
hermes doctor | grep -i memory
```

`memory status` shows registration only, not connectivity. Do not disable
built-in with `hermes tools disable memory`; that hides provider tools too
(`agent_init.py`). Disable via `memory_enabled: false` plus
`user_profile_enabled: false` only at cutover, never during pilot.

## Known limits

- Cron hardcodes `skip_memory=True`, so `mnemosyne_*` tools are unavailable
  in cron sessions. `memory-triage` keeps using
  `scripts/memory_triage.py apply` through `apply_memory_pending`.
- Hermes plugin defaults `auto_sleep` to `false`; set it `true` or
  cross-session consolidation never runs on fresh installs.
- `hermes journey` manages built-in nodes only. Mnemosyne rows use
  `forget`/`update`/`invalidate`/`get`, `doctor` plus gated `repair`.
- Backup is split: git markdown under `memories/` every 6h plus a single
  `mnemosyne/mnemosyne.db` file replaced in place at most once per 24h
  (`MNEMOSYNE_BACKUP_MAX_AGE_HOURS`, same filename, never dated copies).
  `memory-backup.sh` no-ops when the DB is absent.

## Vacuum (weekly, never deletes)

`mnemosyne-vacuum` cron runs Sundays `0 3 * * 0`, `no_agent`, `deliver: local`:
`scripts/mnemosyne-vacuum.sh` prints integrity, working/episodic counts,
size before/after plus `VACUUM`, then per `state.db` (main plus profiles)
counts sessions older than 30 days (`SESSION_MAX_AGE_DAYS`) plus `VACUUM`.
Report only. Session deletion stays owned by
`sessions.auto_prune`/`retention_days` (currently 60); tighten to 30 only by
explicit config change once the 30-day counts show a need.

## Cutover rule

Retire `memory-triage` only when recall is verified across sessions,
`mnemosyne stats` plus sleep are healthy, the SQLite backup restores, and
the approval path is tested. Keep `session_search` and `journey` either way.
