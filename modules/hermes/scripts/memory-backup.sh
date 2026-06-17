#!/bin/bash
# Sync ~/.hermes/memories/ to private git repo
set -e

[ -z "${GITHUB_PAT}" ] && exit 0
[ -z "${GITHUB_URL}" ] && exit 0

REPO_URL=$(echo "${GITHUB_URL}" | sed "s|https://|https://${GITHUB_PAT}@|")
CLONE_DIR="/opt/data/memories-backup"
SRC_DIR="/opt/data/memories"
EXPENSE_DIR="${EXPENSE_TRACKER_DATA:-}"

if [ ! -d "$CLONE_DIR/.git" ]; then
    git clone "$REPO_URL" "$CLONE_DIR"
else
    git -C "$CLONE_DIR" pull origin main
fi

cp "$SRC_DIR/MEMORY.md" "$SRC_DIR/USER.md" "$CLONE_DIR/" 2>/dev/null || true
if [ -n "$EXPENSE_DIR" ] && [ -f "$EXPENSE_DIR/mappings.json" ]; then
    mkdir -p "$CLONE_DIR/expense-tracker"
    cp "$EXPENSE_DIR/mappings.json" "$CLONE_DIR/expense-tracker/"
fi

cd "$CLONE_DIR"
if ! git diff --quiet; then
    git add MEMORY.md USER.md
    git commit -m "$(date -Iseconds)"
    git push origin main
fi
