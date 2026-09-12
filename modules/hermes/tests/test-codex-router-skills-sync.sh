#!/bin/bash
# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

# Tests for modules/hermes/scripts/sync-codex-router-skills.sh — the single
# writer for codex-router-owned skills in the Hermes container.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC="$SCRIPT_DIR/../scripts/sync-codex-router-skills.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# run <source>  (isolated homes so nothing touches the real container)
run() {
    HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIR="$STATE" \
    sh "$SYNC" "$1"
}

fresh_fixture() {
    ROOT=$(mktemp -d "$TMPDIR/case.XXXXXX")
    SOURCE="$ROOT/source"
    PRIMARY="$ROOT/primary"
    SECONDARY="$ROOT/secondary"
    STATE="$ROOT/state"
    mkdir -p "$SOURCE/dev-loop/scripts" "$SOURCE/code-reviewer" "$SOURCE/not-a-skill"
    printf 'canonical dev-loop\n' > "$SOURCE/dev-loop/SKILL.md"
    printf 'loop v1\n' > "$SOURCE/dev-loop/scripts/loop.py"
    printf 'canonical code-reviewer\n' > "$SOURCE/code-reviewer/SKILL.md"
    printf 'ignore me\n' > "$SOURCE/not-a-skill/README.md"
    TARGETS=("$PRIMARY/skills" "$PRIMARY/.agents/skills" "$SECONDARY/.agents/skills")
}

echo "=== fresh sync reaches every root ==="
fresh_fixture
run "$SOURCE" >/dev/null
for target in "${TARGETS[@]}"; do
    if [[ -f "$target/dev-loop/scripts/loop.py" && -f "$target/code-reviewer/SKILL.md" ]]; then
        ok "synced canonical skills into $target"
    else
        nope "synced canonical skills into $target" "$(find "$target" -maxdepth 3 2>/dev/null | head)"
    fi
done

echo "=== non-skill directories are skipped ==="
if [[ ! -e "$PRIMARY/skills/not-a-skill" ]]; then
    ok "skipped a source directory without SKILL.md"
else
    nope "skipped a source directory without SKILL.md" "not-a-skill was copied"
fi

echo "=== idempotent rerun leaves no staging dirs ==="
run "$SOURCE" >/dev/null
if [[ -z "$(find "$PRIMARY" "$SECONDARY" -name '.*.staging.*' 2>/dev/null)" ]]; then
    ok "rerun left no staging directories"
else
    nope "rerun left no staging directories" "$(find "$PRIMARY" "$SECONDARY" -name '.*.staging.*')"
fi

echo "=== drift is replaced with the canonical bytes ==="
printf 'locally edited\n' > "$PRIMARY/skills/dev-loop/SKILL.md"
run "$SOURCE" >/dev/null
if [[ "$(cat "$PRIMARY/skills/dev-loop/SKILL.md")" == "canonical dev-loop" ]]; then
    ok "overwrote a drifted copy"
else
    nope "overwrote a drifted copy" "$(cat "$PRIMARY/skills/dev-loop/SKILL.md")"
fi

echo "=== files dropped upstream are removed ==="
rm "$SOURCE/dev-loop/scripts/loop.py"
run "$SOURCE" >/dev/null
if [[ ! -e "$PRIMARY/skills/dev-loop/scripts/loop.py" ]]; then
    ok "removed a file the source dropped"
else
    nope "removed a file the source dropped" "loop.py still present"
fi

echo "=== siblings the sync does not own are preserved ==="
mkdir -p "$PRIMARY/skills/hermes-troubleshooting"
printf 'openclaw-owned\n' > "$PRIMARY/skills/hermes-troubleshooting/SKILL.md"
run "$SOURCE" >/dev/null
if [[ "$(cat "$PRIMARY/skills/hermes-troubleshooting/SKILL.md")" == "openclaw-owned" ]]; then
    ok "preserved an openclaw-owned sibling skill"
else
    nope "preserved an openclaw-owned sibling skill" "sibling was modified"
fi

echo "=== stale shadow and legacy backups are removed ==="
mkdir -p "$PRIMARY/.config/opencode/skills/dev-loop" \
         "$SECONDARY/.config/opencode/skills/code-reviewer" \
         "$PRIMARY/.config/opencode/skills/user-skill"
printf 'stale shadow\n' > "$PRIMARY/.config/opencode/skills/dev-loop/SKILL.md"
printf 'stale shadow\n' > "$SECONDARY/.config/opencode/skills/code-reviewer/SKILL.md"
printf 'user-owned\n' > "$PRIMARY/.config/opencode/skills/user-skill/SKILL.md"
printf 'stale\n' > "$PRIMARY/skills/dev-loop.codex-router.bak"
printf 'stale\n' > "$SECONDARY/.agents/skills/code-reviewer.codex-router.bak"
run "$SOURCE" >/dev/null
if [[ ! -e "$PRIMARY/.config/opencode/skills/dev-loop" \
      && ! -e "$SECONDARY/.config/opencode/skills/code-reviewer" \
      && -f "$PRIMARY/.config/opencode/skills/user-skill/SKILL.md" ]]; then
    ok "removed stale canonical copies from the shadow roots, kept user skills"
else
    nope "removed stale canonical copies from the shadow roots, kept user skills" \
        "$(find "$PRIMARY/.config/opencode/skills" "$SECONDARY/.config/opencode/skills" 2>/dev/null)"
fi
if [[ -z "$(find "$PRIMARY/skills" "$SECONDARY/.agents/skills" -name '*.codex-router.bak' 2>/dev/null)" ]]; then
    ok "removed legacy compatibility backups"
else
    nope "removed legacy compatibility backups" "a .bak survived"
fi

echo "=== manifest ledger is refreshed, not left claiming drift ==="
IDENTITY=$(python3 - "$PRIMARY/.agents/skills" <<'PY'
import hashlib, sys
print(hashlib.sha256(str(__import__("pathlib").Path(sys.argv[1]).resolve()).encode()).hexdigest()[:16])
PY
)
mkdir -p "$STATE/manifests/$IDENTITY"
cat > "$STATE/manifests/$IDENTITY/dev-loop.json" <<JSON
{
  "skill_name": "dev-loop",
  "canonical_source": "/old/source/dev-loop",
  "canonical_hash": "stale",
  "installed_path": "$PRIMARY/.agents/skills/dev-loop",
  "installed_hash": "stale",
  "managed_by": "codex-router"
}
JSON
run "$SOURCE" >/dev/null
if python3 - "$STATE/manifests/$IDENTITY/dev-loop.json" "$PRIMARY/.agents/skills/dev-loop" <<'PY'
import hashlib, json, pathlib, sys

record = json.loads(pathlib.Path(sys.argv[1]).read_text())
target = pathlib.Path(sys.argv[2])


def directory_hash(path):
    digest = hashlib.sha256()
    for file_path in sorted(p for p in path.rglob("*") if p.is_file()):
        digest.update(file_path.relative_to(path).as_posix().encode() + b"\0")
        digest.update(file_path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


sys.exit(0 if record["installed_hash"] == directory_hash(target) else 1)
PY
then
    ok "refreshed the manifest installed_hash"
else
    nope "refreshed the manifest installed_hash" "ledger still records drift"
fi

echo "=== absent source is a no-op ==="
if run "$TMPDIR/does-not-exist" >/dev/null 2>&1; then
    ok "absent source exits 0"
else
    nope "absent source exits 0" "non-zero exit"
fi

echo ""
echo "================================"
echo "  skills sync: $pass passed, $fail failed"
echo "================================"
[[ "$fail" -eq 0 ]]
