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
if [ -n "$EXPENSE_DIR" ]; then
    mkdir -p "$CLONE_DIR/expense-tracker"
    cp "$EXPENSE_DIR/MEMORY.md" "$CLONE_DIR/expense-tracker/" 2>/dev/null || true
    cp "$EXPENSE_DIR/mappings.json" "$CLONE_DIR/expense-tracker/" 2>/dev/null || true
fi

# ---- Kanban backup (SQL dump — safe on live WAL DB) ----
if command -v sqlite3 >/dev/null 2>&1; then
    mkdir -p "$CLONE_DIR/kanban"

    # Default board
    if [ -f /opt/data/kanban.db ]; then
        sqlite3 /opt/data/kanban.db ".dump" > "$CLONE_DIR/kanban/kanban.sql" 2>/dev/null || true
    fi

    # Named boards
    for board_db in /opt/data/kanban/boards/*/kanban.db; do
        [ -f "$board_db" ] || continue
        slug=$(basename "$(dirname "$board_db")")
        sqlite3 "$board_db" ".dump" > "$CLONE_DIR/kanban/${slug}.sql" 2>/dev/null || true
    done
fi

# ---- Profile backup (identity metadata + per-profile memories) ----
mkdir -p "$CLONE_DIR/profiles"

# Sticky active profile
if [ -f /opt/data/active_profile ]; then
    cp /opt/data/active_profile "$CLONE_DIR/profiles/_active" 2>/dev/null || true
fi

# Named profiles
for profile_dir in /opt/data/profiles/*/; do
    [ -d "$profile_dir" ] || continue
    name=$(basename "$profile_dir")
    mkdir -p "$CLONE_DIR/profiles/$name"

    # Description metadata
    if [ -f "$profile_dir/profile.yaml" ]; then
        cp "$profile_dir/profile.yaml" "$CLONE_DIR/profiles/$name/" 2>/dev/null || true
    fi

    # Per-profile memories
    if [ -f "$profile_dir/memories/MEMORY.md" ]; then
        cp "$profile_dir/memories/MEMORY.md" "$CLONE_DIR/profiles/$name/" 2>/dev/null || true
    fi
    if [ -f "$profile_dir/memories/USER.md" ]; then
        cp "$profile_dir/memories/USER.md" "$CLONE_DIR/profiles/$name/" 2>/dev/null || true
    fi
done

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
