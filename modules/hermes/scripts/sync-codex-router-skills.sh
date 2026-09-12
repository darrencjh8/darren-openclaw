#!/bin/sh
# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.
#
# Reconcile codex-router's canonical skills into every skill root the Hermes
# container reads. `darrencjh8/codex-router` `codex/skills` is the single source
# of truth for the skills it owns; this script replaces whatever copy is in the
# runtime roots and leaves openclaw-owned skills and unrelated siblings alone.
#
# Contract:
#   * Managed roots: /opt/data/skills, /opt/data/.agents/skills and
#     /opt/data/home/.agents/skills.
#   * A stale canonical copy under ~/.config/opencode/skills would shadow the
#     reconciled copy, so each managed skill is also removed from those shadow
#     roots. Unrelated user skills there are left alone.
#   * A skill removed from the canonical source is removed from every root, so
#     a retired skill cannot linger.
#   * The manifest installer records a directory hash of what it installed and
#     refuses a later run on drift. The refreshed bytes are canonical, so any
#     ledger entry that points at a managed root is updated to match instead of
#     being left to claim drift.
#   * Writers serialize on a lock directory. The container's boot hook and a
#     deploy both run this script, and they must not swap the same staging and
#     destination paths concurrently.
#
# Usage: sync-codex-router-skills.sh [SOURCE] [STAGE_NEW]
#   SOURCE defaults to /opt/data/.codex-router-skills, staged by the deploy.
#   STAGE_NEW, when given, is moved onto SOURCE under the lock before the
#   reconcile, so the deploy's staged swap cannot race the boot hook.
#
# shellcheck shell=sh
# shellcheck disable=SC2086  # TARGETS, SHADOWS and STATE_DIRS are intentional space-split lists

set -eu

SOURCE=${1:-/opt/data/.codex-router-skills}
# Optional second argument: a freshly staged tree to move onto SOURCE under the
# lock before reconciling. The deploy stages there, so the swap happens inside
# the same critical section as every other writer.
STAGE_NEW=${2:-}
PRIMARY_HOME=${HERMES_SKILL_PRIMARY_HOME:-/opt/data}
SECONDARY_HOME=${HERMES_SKILL_SECONDARY_HOME:-/opt/data/home}
MANAGED_FILE=${HERMES_SKILL_MANAGED_FILE:-$PRIMARY_HOME/.codex-router-managed-skills}
LOCK_WAIT_SECONDS=${HERMES_SKILL_LOCK_WAIT_SECONDS:-120}
# Ledger roots to refresh. `install-agents.sh` records under the secondary home;
# `install-hermes.sh` takes `CODEX_ROUTER_SKILL_STATE_DIR`. Refresh whichever
# exist so no ledger is left pointing at pre-reconcile bytes.
STATE_DIRS=${HERMES_MANIFEST_STATE_DIRS:-${CODEX_ROUTER_SKILL_STATE_DIR:-} $SECONDARY_HOME/.local/state/codex-router $PRIMARY_HOME/.local/state/codex-router}

if [ ! -d "$SOURCE" ] && [ -z "$STAGE_NEW" ]; then
    echo "sync-codex-router-skills: no source at $SOURCE; skipping" >&2
    exit 0
fi

# A skill name is a single path segment. The managed-name file and the source
# tree are both on a user-writable volume, and every name is used to build an
# `rm -rf` path, so anything else is refused instead of sanitized.
valid_name() {
    case "$1" in
        ''|.|..|*[!A-Za-z0-9._-]*)
            echo "sync-codex-router-skills: refusing unsafe skill name: $1" >&2
            return 1
            ;;
    esac
    return 0
}

TARGETS="$PRIMARY_HOME/skills $PRIMARY_HOME/.agents/skills $SECONDARY_HOME/.agents/skills"
SHADOWS="$PRIMARY_HOME/.config/opencode/skills $SECONDARY_HOME/.config/opencode/skills"

mkdir -p "$PRIMARY_HOME" "$SECONDARY_HOME"

# `flock` is the primary primitive: the kernel releases it when the holder dies,
# including across a container recreate where a stored pid could be recycled to
# an unrelated live process. `HERMES_SKILL_LOCK_MODE=mkdir` forces the fallback
# (used by tests); the fallback only ever reclaims a lock whose process is gone
# and refuses to remove a lock it no longer owns.
LOCK_MODE=${HERMES_SKILL_LOCK_MODE:-auto}
LOCK_BASE=${HERMES_SKILL_LOCK_BASE:-$PRIMARY_HOME/.codex-router-skills.lock}
MKDIR_LOCK="$LOCK_BASE.d"
USE_FLOCK=false
if [ "$LOCK_MODE" != mkdir ] && command -v flock >/dev/null 2>&1; then
    USE_FLOCK=true
fi

LOCK_OWNED=false
CURRENT=""
MODES_TMP=""
cleanup() {
    if [ -n "$CURRENT" ]; then
        rm -f "$CURRENT"
    fi
    if [ -n "$MODES_TMP" ]; then
        rm -f "$MODES_TMP.src" "$MODES_TMP.dst"
    fi
    if [ "$LOCK_OWNED" = true ] && [ "$USE_FLOCK" = false ]; then
        # Only the current owner may release the mkdir lock. After a fallback
        # reclaim, an older holder's trap must not delete its successor's lock.
        if [ "$(cat "$MKDIR_LOCK/pid" 2>/dev/null)" = "$$" ]; then
            rm -f "$MKDIR_LOCK/pid"
            rmdir "$MKDIR_LOCK" 2>/dev/null || true
        fi
    fi
}
trap cleanup EXIT

if [ "$USE_FLOCK" = true ]; then
    exec 9>"$LOCK_BASE"
fi

attempts=0
while [ "$attempts" -lt "$LOCK_WAIT_SECONDS" ]; do
    if [ "$USE_FLOCK" = true ]; then
        if flock -n 9; then
            LOCK_OWNED=true
            break
        fi
    else
        if mkdir "$MKDIR_LOCK" 2>/dev/null; then
            echo $$ > "$MKDIR_LOCK/pid"
            LOCK_OWNED=true
            break
        fi
        if [ -f "$MKDIR_LOCK/pid" ]; then
            # Reclaim only when the holder is provably gone. `kill -0` reports
            # both ESRCH (no such process) and EPERM (process alive, owned by
            # someone else) as a bare failure, so reclaiming on that failure
            # would steal a live lock. /proc distinguishes them: an existing
            # /proc/<pid> that cannot be read is EPERM, and one that is absent
            # is ESRCH. Anything else waits, and the bounded loop fails closed.
            # ponytail: Linux-only (this runs in the container); the mkdir
            # fallback is test-only, and flock is the production primitive.
            holder=$(cat "$MKDIR_LOCK/pid" 2>/dev/null) || holder=""
            case $holder in
                ''|*[!0-9]*)
                    # A truncated or corrupt pid file names no process. Reclaim
                    # it; otherwise `/proc//stat` resolves to `/proc/stat`, which
                    # is always readable, and the lock is stuck forever.
                    rm -rf "$MKDIR_LOCK" 2>/dev/null || true
                    ;;
                *)
                    if kill -0 "$holder" 2>/dev/null; then
                        :
                    elif [ ! -r "/proc/$holder/stat" ]; then
                        rm -rf "$MKDIR_LOCK" 2>/dev/null || true
                    fi
                    ;;
            esac
        fi
    fi
    attempts=$((attempts + 1))
    sleep 1
done
if [ "$LOCK_OWNED" != true ]; then
    # Fail closed: a caller that treats a skip as success would report a green
    # deploy while every skill root keeps stale bytes.
    echo "sync-codex-router-skills: could not acquire the reconcile lock within ${LOCK_WAIT_SECONDS}s" >&2
    exit 1
fi

if [ -n "$STAGE_NEW" ]; then
    if [ ! -d "$STAGE_NEW" ]; then
        echo "sync-codex-router-skills: no staged tree at $STAGE_NEW" >&2
        exit 1
    fi
    rm -rf "${SOURCE:?}"
    mv "${STAGE_NEW:?}" "${SOURCE:?}"
fi
if [ ! -d "$SOURCE" ]; then
    echo "sync-codex-router-skills: no source at $SOURCE; skipping" >&2
    exit 0
fi

# A run killed between creating $CURRENT and its EXIT trap leaves that staging
# file behind. It is litter the next run would otherwise carry forever, so sweep
# the family before creating the current one. A matched directory or a permission
# failure makes rm return non-zero, which must not abort the reconcile, so the
# sweep stays non-fatal. (`rm -f` already tolerates an unmatched glob.)
rm -f "$PRIMARY_HOME"/.codex-router-managed-skills.new.* 2>/dev/null || true
CURRENT="$PRIMARY_HOME/.codex-router-managed-skills.new.$$"
: > "$CURRENT"
MODES_TMP="$PRIMARY_HOME/.codex-router-modes.$$"

# Compare the permission bits of a canonical tree with an installed copy.
# `diff -r` compares contents only, so without this a canonical permission
# change would be skipped as identical and never reach the runtime root. Only
# directories and regular files are compared, the two types `cp -a` restores.
# ponytail: symlink modes are not compared — Linux cannot set them, and a
# symlink that survives `cp -a` keeps the canonical target string anyway.
same_modes() {
    src=$1
    dst=$2
    srclist="$MODES_TMP.src"
    dstlist="$MODES_TMP.dst"
    printf '%s\n' "$(stat -c '%a' "$src")" > "$srclist"
    find "$src" \( -type d -o -type f \) -printf '%P %m\n' >> "$srclist"
    printf '%s\n' "$(stat -c '%a' "$dst")" > "$dstlist"
    find "$dst" \( -type d -o -type f \) -printf '%P %m\n' >> "$dstlist"
    diff "$srclist" "$dstlist" >/dev/null 2>&1
}

# The canonical set for this run: only directories that carry SKILL.md. A stray
# file or a non-skill directory in the source is never copied.
for source_dir in "$SOURCE"/*/; do
    [ -d "$source_dir" ] || continue
    name=$(basename "$source_dir")
    [ -f "$source_dir/SKILL.md" ] || continue
    valid_name "$name" || continue
    echo "$name" >> "$CURRENT"
done

# Prune a skill the canonical source no longer publishes. The managed-name list
# is kept outside the staged source, which the deploy replaces wholesale.
if [ -f "$MANAGED_FILE" ]; then
    # A *fully empty* staged source must never be read as "every skill was
    # retired": that would delete every managed skill and still exit 0. A
    # partial source (some managed skills present, others absent) would still
    # retire the absent names, because the managed set is names, not a content
    # manifest. That gap is accepted: today's deploy stages the whole canonical
    # checkout in one `docker cp`, so a partial source is unreachable. Compare
    # against the recorded managed set only if a future producer can stage a
    # subset.
    if [ ! -s "$CURRENT" ] && [ -s "$MANAGED_FILE" ]; then
        echo "sync-codex-router-skills: source $SOURCE has no skills while $(wc -l < "$MANAGED_FILE") are managed; refusing to prune" >&2
        exit 1
    fi
    while IFS= read -r previous || [ -n "$previous" ]; do
        [ -n "$previous" ] || continue
        valid_name "$previous" || continue
        if grep -qxF -- "$previous" "$CURRENT"; then
            continue
        fi
        for target in $TARGETS; do
            rm -rf "${target:?}/${previous:?}"
            rm -rf "${target:?}/${previous:?}.codex-router.bak"
        done
        for shadow in $SHADOWS; do
            rm -rf "${shadow:?}/${previous:?}"
        done
    done < "$MANAGED_FILE"
fi

for target in $TARGETS; do
    mkdir -p "$target"
    for source_dir in "$SOURCE"/*/; do
        [ -d "$source_dir" ] || continue
        name=$(basename "$source_dir")
        [ -f "$source_dir/SKILL.md" ] || continue
        valid_name "$name" || continue
        dest="$target/$name"
        # `diff -r` is the content comparison and `same_modes` the permission
        # comparison: a tree is skipped only when both match, so a canonical
        # permission change still propagates. The modes are only checked once
        # the contents match, to keep the listing off the common drift path.
        if [ -d "$dest" ] && diff -r "$source_dir" "$dest" >/dev/null 2>&1 \
            && same_modes "$source_dir" "$dest"; then
            continue
        fi
        staging="$target/.$name.staging.$$"
        rm -rf "${staging:?}"
        cp -a "$source_dir" "$staging"
        rm -rf "${dest:?}"
        mv "$staging" "$dest"
    done
    # Compatibility backups left by a previous installer run are stale
    # duplicates of a skill this script now owns. The merged installer writes
    # them as a directory (`copytree`), older ones as a single file, so the
    # removal must handle both shapes. Only a backup of a managed skill is
    # touched; an unrelated entry that happens to carry the suffix is kept.
    while IFS= read -r name || [ -n "$name" ]; do
        [ -n "$name" ] || continue
        bak="$target/$name.codex-router.bak"
        if [ -e "$bak" ]; then
            rm -rf "${bak:?}"
        fi
    done < "$CURRENT"
done

while IFS= read -r name || [ -n "$name" ]; do
    [ -n "$name" ] || continue
    valid_name "$name" || continue
    for shadow in $SHADOWS; do
        rm -rf "${shadow:?}/${name:?}"
    done
done < "$CURRENT"

# Ownership is what makes the refreshed tree readable by the hermes daemon, so a
# failure must not be swallowed like the lock bookkeeping above: report it and
# let the boot hook's redirect keep the breadcrumb.
chown_error=$(chown -R hermes:hermes \
    "$PRIMARY_HOME/skills" "$PRIMARY_HOME/.agents/skills" "$SECONDARY_HOME/.agents/skills" \
    2>&1) || {
    rc=$?
    echo "sync-codex-router-skills: chown failed (exit $rc) on the skill roots: $chown_error" >&2
}

for state in $STATE_DIRS; do
    [ -d "$state/manifests" ] || continue
    python3 - "$state" "$SOURCE" $TARGETS <<'PY'
import hashlib
import json
import pathlib
import sys

state, source = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
targets = [pathlib.Path(arg) for arg in sys.argv[3:]]


def directory_hash(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    for file_path in sorted(p for p in path.rglob("*") if p.is_file()):
        digest.update(file_path.relative_to(path).as_posix().encode() + b"\0")
        digest.update(file_path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


# Rewriting the ledger erases the installer's drift signal for the copy that
# was just overwritten, so every refreshed record is named in the log.
for manifest_file in sorted(state.glob("manifests/*/*.json")):
    try:
        manifest = json.loads(manifest_file.read_text())
    except (OSError, ValueError):
        continue
    installed = pathlib.Path(manifest.get("installed_path", ""))
    if not installed.is_dir() or installed.parent not in targets:
        continue
    canonical = source / installed.name
    if not (canonical / "SKILL.md").is_file():
        continue
    previous = manifest.get("installed_hash")
    manifest["installed_hash"] = directory_hash(installed)
    manifest["canonical_hash"] = directory_hash(canonical)
    manifest["canonical_source"] = str(canonical)
    manifest_file.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(
        f"sync-codex-router-skills: refreshed {manifest_file} "
        f"({str(previous)[:12]} -> {manifest['installed_hash'][:12]})"
    )
PY
done

mv "$CURRENT" "$MANAGED_FILE"
echo "sync-codex-router-skills: reconciled $(basename "$SOURCE") into the Hermes skill roots"
