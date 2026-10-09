# Mnemosyne pilot (additive, no cutover)

Mnemosyne is a memory provider plugin, not a context engine and not a
replacement for the `memory-triage` cron. Pilot runs alongside built-in
memory. Built-in `MEMORY.md`/`USER.md` stay on until recall is verified.

## What Hermes reads

Only `MEMORY.md`/`USER.md` auto-inject every turn. `topics/*.md` load via
the core pointer plus keyword search. `state.db` loads via `session_search`.
`DREAMS.md` never loads. Mnemosyne loads via pre-turn prefetch plus its own
system-prompt header once `memory.provider: mnemosyne` is set.

## Install (operator, not seed)

The seed only creates `/opt/data/mnemosyne/data`. It never flips the
provider, never disables built-in memory, never changes triage.

```bash
hermes plugins install mnemosyne
hermes config set memory.provider mnemosyne
hermes config set memory.mnemosyne.auto_sleep true
hermes config set memory.mnemosyne.sleep_threshold 20
hermes gateway restart
```

Version pins: `mnemosyne-hermes 0.7.3` needs `mnemosyne-memory>=4.0.0b3`
beta, or stable pair `3.15.1` + `0.7.1`. Avoid `0.7.2`. Needs Hermes
`>=0.21.4`. Side venv Python minor must match the gateway or vector scores
return zero silently. Catalog versus wrapper share one path
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
- Backup is split: git markdown under `memories/` plus SQLite
  `mnemosyne.db` via `sqlite3 .backup` into `mnemosyne/` in the same repo.
  `memory-backup.sh` no-ops when the DB is absent.

## Cutover rule

Retire `memory-triage` only when recall is verified across sessions,
`mnemosyne stats` plus sleep are healthy, the SQLite backup restores, and
the approval path is tested. Keep `session_search` and `journey` either way.
