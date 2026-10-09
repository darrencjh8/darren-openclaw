#!/bin/bash
# Mnemosyne + session vacuum report (no_agent script-only cron).
# Never deletes memories or sessions. SQLite VACUUM reclaims space after
# Mnemosyne TTL eviction/sleep and Hermes auto_prune have deleted rows.
# Session deletion stays owned by sessions.auto_prune/retention_days
# (currently 60); this script only counts sessions older than 30 days so an
# operator can decide whether to tighten retention. Exits 0 always.
set -u

HERMES_HOME="${HERMES_HOME:-/opt/data}"
MNEMOSYNE_DIR="${MNEMOSYNE_DATA_DIR:-$HERMES_HOME/mnemosyne/data}"
SESSION_MAX_AGE_DAYS="${SESSION_MAX_AGE_DAYS:-30}"

_size() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo "?"; }

echo "[vacuum] mnemosyne: $MNEMOSYNE_DIR/mnemosyne.db"
if [ -f "$MNEMOSYNE_DIR/mnemosyne.db" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        _check=$(sqlite3 "$MNEMOSYNE_DIR/mnemosyne.db" "PRAGMA integrity_check;" 2>/dev/null | head -n 1)
        echo "[vacuum] integrity: ${_check:-unknown}"
        _tables=$(sqlite3 "$MNEMOSYNE_DIR/mnemosyne.db" ".tables" 2>/dev/null)
        for _t in working_memory episodic_memory; do
            case " $_tables " in
                *" $_t "*) _n=$(sqlite3 "$MNEMOSYNE_DIR/mnemosyne.db" "SELECT COUNT(*) FROM $_t;" 2>/dev/null); echo "[vacuum] $_t: ${_n:-?}" ;;
            esac
        done
        echo "[vacuum] size_before: $(_size "$MNEMOSYNE_DIR/mnemosyne.db")"
        sqlite3 "$MNEMOSYNE_DIR/mnemosyne.db" "PRAGMA busy_timeout=5000; VACUUM;" 2>/dev/null || echo "[vacuum] VACUUM skipped (busy)"
        echo "[vacuum] size_after: $(_size "$MNEMOSYNE_DIR/mnemosyne.db")"
        unset _check _tables _t _n
    else
        echo "[vacuum] sqlite3 missing, size: $(_size "$MNEMOSYNE_DIR/mnemosyne.db")"
    fi
else
    echo "[vacuum] mnemosyne.db absent, nothing to do"
fi

echo "[vacuum] sessions older than ${SESSION_MAX_AGE_DAYS}d (report only, auto_prune owns deletion)"
for _db in "$HERMES_HOME/state.db" "$HERMES_HOME"/profiles/*/state.db; do
    [ -f "$_db" ] || continue
    if command -v sqlite3 >/dev/null 2>&1; then
        _tables=$(sqlite3 "$_db" ".tables" 2>/dev/null)
        _old="?"
        # Best-effort probe of known session-table shapes without assuming
        # schema; TEXT timestamps can compare lexically and misreport, so a
        # "?" means unknown, never a deletion trigger. Deletion stays owned
        # by sessions.auto_prune regardless of what prints here.
        for _q in \
            "SELECT COUNT(*) FROM sessions WHERE updated_at < strftime('%s','now','-${SESSION_MAX_AGE_DAYS} days');" \
            "SELECT COUNT(*) FROM sessions WHERE ended_at < strftime('%s','now','-${SESSION_MAX_AGE_DAYS} days');" \
            "SELECT COUNT(*) FROM sessions WHERE last_active < datetime('now','-${SESSION_MAX_AGE_DAYS} days');" \
        ; do
            _n=$(sqlite3 "$_db" "$_q" 2>/dev/null) && case "$_n" in ''|*[!0-9]*) ;; *) _old="$_n"; break ;; esac
        done
        echo "[vacuum] $_db older_than_${SESSION_MAX_AGE_DAYS}d: $_old size_before: $(_size "$_db")"
        sqlite3 "$_db" "PRAGMA busy_timeout=5000; VACUUM;" 2>/dev/null || echo "[vacuum] VACUUM skipped (busy): $_db"
        echo "[vacuum] $_db size_after: $(_size "$_db")"
        unset _tables _old _q _n
    else
        echo "[vacuum] $_db size: $(_size "$_db") (sqlite3 missing)"
    fi
    unset _db
done
