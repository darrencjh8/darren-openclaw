#!/bin/sh
# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.
#
# Reconcile codex-router's canonical skills into every skill root the Hermes
# container reads. `darrencjh8/codex-router` `codex/skills` is the single source
# of truth for the skills it owns; this script replaces whatever copy is in the
# runtime roots and leaves openclaw-owned skills and unrelated siblings alone.
#
# Usage: sync-codex-router-skills.sh [SOURCE]
#   SOURCE defaults to /opt/data/.codex-router-skills, staged by the deploy.
#
# shellcheck shell=sh
# shellcheck disable=SC2086  # TARGETS and SHADOWS are intentional space-split lists

set -eu

SOURCE=${1:-/opt/data/.codex-router-skills}
PRIMARY_HOME=${HERMES_SKILL_PRIMARY_HOME:-/opt/data}
SECONDARY_HOME=${HERMES_SKILL_SECONDARY_HOME:-/opt/data/home}
MANIFEST_STATE=${HERMES_MANIFEST_STATE_DIR:-$SECONDARY_HOME/.local/state/codex-router}

if [ ! -d "$SOURCE" ]; then
    echo "sync-codex-router-skills: no source at $SOURCE; skipping" >&2
    exit 0
fi

TARGETS="$PRIMARY_HOME/skills $PRIMARY_HOME/.agents/skills $SECONDARY_HOME/.agents/skills"
# opencode also reads skills from ~/.config/opencode/skills. A stale canonical
# copy there shadows the reconciled one, so each canonical skill is removed from
# the shadow roots while any other user-owned skill there is left alone.
SHADOWS="$PRIMARY_HOME/.config/opencode/skills $SECONDARY_HOME/.config/opencode/skills"

for target in $TARGETS; do
    mkdir -p "$target"
    for source_dir in "$SOURCE"/*/; do
        [ -d "$source_dir" ] || continue
        name=$(basename "$source_dir")
        # Only canonical skill directories are managed; a stray file or a
        # non-skill directory in the source is never copied.
        [ -f "$source_dir/SKILL.md" ] || continue
        dest="$target/$name"
        if [ -d "$dest" ] && diff -r "$source_dir" "$dest" >/dev/null 2>&1; then
            continue
        fi
        staging="$target/.$name.staging.$$"
        rm -rf "${staging:?}"
        cp -a "$source_dir" "$staging"
        rm -rf "${dest:?}"
        mv "$staging" "$dest"
    done
    # The pre-reconcile installer left single-file compatibility backups in the
    # skills root; they are stale duplicates of a skill we now own.
    for bak in "$target"/*.codex-router.bak; do
        if [ -e "$bak" ]; then
            rm -f "$bak"
        fi
    done
done

for shadow in $SHADOWS; do
    for source_dir in "$SOURCE"/*/; do
        [ -d "$source_dir" ] || continue
        name=$(basename "$source_dir")
        [ -f "$source_dir/SKILL.md" ] || continue
        if [ -d "${shadow:?}/${name:?}" ]; then
            rm -rf "${shadow:?}/${name:?}"
        fi
    done
done

chown -R hermes:hermes \
    "$PRIMARY_HOME/skills" "$PRIMARY_HOME/.agents/skills" "$SECONDARY_HOME/.agents/skills" \
    2>/dev/null || true

# The manifest installer records a directory hash of what it installed and
# refuses a later run on drift. The synced bytes are now canonical, so refresh
# the recorded hashes for the skills this run replaced instead of leaving a
# ledger that claims drift.
if [ -d "$MANIFEST_STATE/manifests" ]; then
    # shellcheck disable=SC2086  # TARGETS is an intentional word-split list
    python3 - "$MANIFEST_STATE" "$SOURCE" $TARGETS <<'PY'
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


refreshed = 0
for manifest_file in state.glob("manifests/*/*.json"):
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
    manifest["installed_hash"] = directory_hash(installed)
    manifest["canonical_hash"] = directory_hash(canonical)
    manifest["canonical_source"] = str(canonical)
    manifest_file.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    refreshed += 1
print(f"sync-codex-router-skills: refreshed {refreshed} manifest record(s)")
PY
fi

echo "sync-codex-router-skills: reconciled $(basename "$SOURCE") into the Hermes skill roots"
