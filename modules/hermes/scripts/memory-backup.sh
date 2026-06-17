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
    cd "$CLONE_DIR"
    git config user.email "hermes@darren.dev"
    git config user.name "Friday (Hermes Memory)"
    # Handle empty repo (no commits yet)
    if ! git rev-parse --verify main >/dev/null 2>&1; then
        git checkout -b main
        HAS_REMOTE=false
    else
        HAS_REMOTE=true
    fi
else
    cd "$CLONE_DIR"
    git pull origin main 2>/dev/null || true
    HAS_REMOTE=true
fi

cp "$SRC_DIR/MEMORY.md" "$SRC_DIR/USER.md" "$CLONE_DIR/" 2>/dev/null || true
if [ -n "$EXPENSE_DIR" ] && [ -f "$EXPENSE_DIR/mappings.json" ]; then
    mkdir -p "$CLONE_DIR/expense-tracker"
    cp "$EXPENSE_DIR/mappings.json" "$CLONE_DIR/expense-tracker/"
fi

cd "$CLONE_DIR"
# Check if there are changes (handles empty repo with no HEAD)
if ! git rev-parse HEAD >/dev/null 2>&1; then
    HAS_CHANGES=true
elif ! git diff --quiet; then
    HAS_CHANGES=true
elif [ -n "$(git ls-files --others --exclude-standard)" ]; then
    HAS_CHANGES=true
else
    HAS_CHANGES=false
fi

if [ "$HAS_CHANGES" = true ]; then
    git add -A
    git commit -m "$(date -Iseconds)"
    if [ "$HAS_REMOTE" = true ]; then
        git push origin main
    else
        git push -u origin main
        HAS_REMOTE=true
    fi
fi
