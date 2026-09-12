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
#
# Usage: sync-codex-router-skills.sh [SOURCE]
#   SOURCE defaults to /opt/data/.codex-router-skills, staged by the deploy.
#
# shellcheck shell=sh
# shellcheck disable=SC2086  # TARGETS, SHADOWS and STATE_DIRS are intentional space-split lists

set -eu

SOURCE=${1:-/opt/data/.codex-router-skills}
PRIMARY_HOME=${HERMES_SKILL_PRIMARY_HOME:-/opt/data}
SECONDARY_HOME=${HERMES_SKILL_SECONDARY_HOME:-/opt/data/home}
MANAGED_FILE=${HERMES_SKILL_MANAGED_FILE:-$PRIMARY_HOME/.codex-router-managed-skills}
# Ledger roots to refresh. `install-agents.sh` records under the secondary home;
# `install-hermes.sh` takes `CODEX_ROUTER_SKILL_STATE_DIR`. Refresh whichever
# exist so no ledger is left pointing at pre-reconcile bytes.
STATE_DIRS=${HERMES_MANIFEST_STATE_DIRS:-${CODEX_ROUTER_SKILL_STATE_DIR:-} $SECONDARY_HOME/.local/state/codex-router $PRIMARY_HOME/.local/state/codex-router}

if [ ! -d "$SOURCE" ]; then
    echo "sync-codex-router-skills: no source at $SOURCE; skipping" >&2
    exit 0
fi

TARGETS="$PRIMARY_HOME/skills $PRIMARY_HOME/.agents/skills $SECONDARY_HOME/.agents/skills"
SHADOWS="$PRIMARY_HOME/.config/opencode/skills $SECONDARY_HOME/.config/opencode/skills"

mkdir -p "$PRIMARY_HOME" "$SECONDARY_HOME"
CURRENT="$PRIMARY_HOME/.codex-router-managed-skills.new.$$"
trap 'rm -f "$CURRENT"' EXIT
: > "$CURRENT"

# The canonical set for this run: only directories that carry SKILL.md. A stray
# file or a non-skill directory in the source is never copied.
for source_dir in "$SOURCE"/*/; do
    [ -d "$source_dir" ] || continue
    name=$(basename "$source_dir")
    [ -f "$source_dir/SKILL.md" ] || continue
    echo "$name" >> "$CURRENT"
done

# Prune a skill the canonical source no longer publishes. The managed-name list
# is kept outside the staged source, which the deploy replaces wholesale.
if [ -f "$MANAGED_FILE" ]; then
    while IFS= read -r previous; do
        [ -n "$previous" ] || continue
        if grep -qxF -- "$previous" "$CURRENT"; then
            continue
        fi
        for target in $TARGETS; do
            rm -rf "${target:?}/${previous:?}"
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
        dest="$target/$name"
        # `diff -r` is the content comparison: identical trees are skipped so a
        # rerun is a no-op.
        if [ -d "$dest" ] && diff -r "$source_dir" "$dest" >/dev/null 2>&1; then
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
    # removal must handle both shapes.
    for bak in "$target"/*.codex-router.bak; do
        if [ -e "$bak" ]; then
            rm -rf "${bak:?}"
        fi
    done
done

while IFS= read -r name; do
    [ -n "$name" ] || continue
    for shadow in $SHADOWS; do
        rm -rf "${shadow:?}/${name:?}"
    done
done < "$CURRENT"

chown -R hermes:hermes \
    "$PRIMARY_HOME/skills" "$PRIMARY_HOME/.agents/skills" "$SECONDARY_HOME/.agents/skills" \
    2>/dev/null || true

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
print(f"sync-codex-router-skills: refreshed {refreshed} manifest record(s) in {state}")
PY
done

mv "$CURRENT" "$MANAGED_FILE"
echo "sync-codex-router-skills: reconciled $(basename "$SOURCE") into the Hermes skill roots"
