#!/bin/sh
# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.
#
# Move a staged codex-router skill tree into its persistent location and run the
# reconciler. Runs inside the Hermes container as root, invoked by deploy.sh;
# the skills-sync test executes it directly with sandbox paths.
#
# Usage: apply-codex-router-skills.sh [STAGED] [FINAL]
#
# shellcheck shell=sh

set -eu

STAGED=${1:-/opt/data/.codex-router-skills.new}
FINAL=${2:-/opt/data/.codex-router-skills}
SYNC=${HERMES_SKILL_SYNC_SCRIPT:-/opt/hermes-defaults/scripts/sync-codex-router-skills.sh}
TMP_SYNC=${HERMES_SKILL_TMP_SYNC:-/tmp/sync-codex-router-skills.sh}

if [ ! -d "$STAGED" ]; then
    echo "apply-codex-router-skills: no staged tree at $STAGED" >&2
    exit 1
fi

# The deploy copies the checkout's reconciler here so a router-only deploy works
# before the image carries it; prefer that copy when present.
if [ -f "$TMP_SYNC" ]; then
    SYNC=$TMP_SYNC
fi
if [ ! -f "$SYNC" ]; then
    echo "apply-codex-router-skills: reconciler not found at $SYNC" >&2
    exit 1
fi

rm -rf "${FINAL:?}"
mv "${STAGED:?}" "${FINAL:?}"
chown -R hermes:hermes "$FINAL" 2>/dev/null || true
sh "$SYNC" "$FINAL"
