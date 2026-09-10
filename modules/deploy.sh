#!/usr/bin/env bash
# =============================================================================
# Deploy Script — Hermes Agent + Services
# Validates all required environment variables, builds + deploys via Compose.
#
# On GitHub Actions (GITHUB_ACTIONS=true): reads secrets from environment.
# Locally: reads .env files.
#
# Usage: ./modules/deploy.sh --component <name> [--component <name>...] [--non-interactive]
#   --component <name>  Required. One of: all, hermes, portfolio-tracker, expense-tracker, actual-api, image-gen
#   --non-interactive    Skip OneDrive auth prompt
# =============================================================================
set -euo pipefail

NON_INTERACTIVE=false
SKIP_BUILD=false
DOCKER_ARGS=()
COMPONENTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --component) COMPONENTS+=("$2"); shift ;;
    *) DOCKER_ARGS+=("$1") ;;
  esac
  shift
done

# ktmb-booking is retired: refuse an explicit request instead of failing the
# health gate after deploying a module that cannot start.
if [[ " ${COMPONENTS[*]} " =~ " ktmb-booking " ]]; then
  echo "ktmb-booking is retired and no longer deployable" >&2
  exit 1
fi

if [[ ${#COMPONENTS[@]} -eq 0 ]]; then
  echo "Usage: ./modules/deploy.sh --component <name> [--component <name>...] [--non-interactive]"
  echo ""
  echo "Available components:"
  echo "  all                  Deploy all components"
  echo "  hermes               Hermes agent (MCP, cron, Telegram)"
  echo "  portfolio-tracker    Portfolio tracker + IBKR flex"
  echo "  expense-tracker      Expense tracker"
  echo "  actual-api           Actual Budget API"
  echo "  image-gen            Image generation"
  echo "  codex-router         LiteLLM proxy (ChatGPT/DeepSeek router)"
  echo ""
  echo "Example:"
  echo "  ./modules/deploy.sh --component portfolio-tracker --component hermes --non-interactive"
  echo "  ./modules/deploy.sh --component all"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULES_DIR="$ROOT/modules"
PT_DIR="$ROOT/modules/portfolio-tracker"
ET_DIR="$ROOT/modules/expense-tracker"
HERMES_DIR="$ROOT/modules/hermes"
HERMES_ENV="$HERMES_DIR/.env"

# Auto-detect: GitHub Actions uses secrets via environment;
# local dev reads .env files.
GITHUB_MODE=false
[[ "${GITHUB_ACTIONS:-}" == "true" ]] && GITHUB_MODE=true

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

missing=0

env_get() {
  local key="$1" file="$2"
  grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | head -1 | sed "s/^[[:space:]]*${key}=//" | sed 's/^"//;s/"$//;s/^'"'"'//;s/'"'"'$//'
}

check_var() {
  local name="$1"
  local val
  if $GITHUB_MODE; then
    val="${!name:-}"
  else
    local file="$2"
    val=$(env_get "$name" "$file")
    # Fall back to shell environment
    if [ -z "$val" ]; then
      val="${!name:-}"
    fi
  fi
  if [ -z "$val" ]; then
    echo -e "  ${RED}✗ MISSING: $name${NC}"
    missing=$((missing + 1))
  else
    echo -e "  ${GREEN}✓ $name${NC}"
  fi
}

check_var_optional() {
  local name="$1"
  local val
  if $GITHUB_MODE; then
    val="${!name:-}"
  else
    local file="$2"
    val=$(env_get "$name" "$file")
    # Fall back to shell environment (e.g. exported from secrets manager)
    if [ -z "$val" ]; then
      val="${!name:-}"
    fi
  fi
  if [ -z "$val" ]; then
    echo -e "  ${YELLOW}○ $name (not set)${NC}"
  else
    echo -e "  ${GREEN}✓ $name${NC}"
  fi
}

# True when platforms.slack.enabled is truthy in the seeded Hermes config.
# A missing, unreadable, or unparseable config counts as ENABLED: a required
# token must never be silently skipped because detection failed.
slack_platform_enabled() {
  local config="$HERMES_DIR/config.yaml"
  [ -f "$config" ] && [ -r "$config" ] || return 0

  # A missing interpreter must not read as "Slack disabled".
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  local rc=0
  python3 - "$config" <<'PY' || rc=$?
"""Read only platforms.slack.enabled, using the standard library.

The deploy host is not guaranteed to have PyYAML. Importing it and falling back
to "enabled" when the import fails aborts production deployment, so the single
boolean this gate needs is read directly instead of pulling in a YAML package.

Fail-closed contract: only a value that is DEFINITELY false may disable the
gate. Missing, unreadable, non-UTF8, malformed, empty, unrecognised, or
ambiguous input always resolves to enabled, because the caller treats "enabled"
as "require the tokens". Every exception is caught for the same reason.
"""
import re
import sys

# Key lines only; deliberately does not match "- item" or continuation text.
KEY_RE = re.compile(r"^([ \t]*)([A-Za-z0-9_.-]+):[ \t]*(.*)$")
# Like KEY_RE but also accepts a quoted key, so a block scalar under `"prompt":`
# is recognised and its body masked out.
MASK_KEY_RE = re.compile(
    r"""^([ \t]*)(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+):[ \t]*(.*)$"""
)
QUOTES = "\"'"
FALSEY = ("false", "no", "off", "0")


class Quoted(str):
    """A scalar written in quotes: always a string, never a YAML boolean."""


# Typed tokens, so stripped quotes can never be confused with YAML null.
MISSING = object()  # no usable scalar (empty / comment / nested block)
NULL = object()  # YAML null: null, Null, NULL, ~

# Result codes for the line walk.
FOUND = "found"
ABSENT = "absent"  # no definite answer yet; keep scanning
AMBIGUOUS = "ambiguous"


def scalar(raw):
    """Return MISSING, NULL, a Quoted string, or a bare token.

    Quote handling precedes comment stripping: `"false # x"` is the truthy
    string `false # x`, not the value `false` plus a comment.
    """
    raw = raw.strip()
    if not raw:
        return MISSING
    if raw[0] in QUOTES:
        end = raw.find(raw[0], 1)
        return Quoted(raw[1:] if end < 0 else raw[1:end])
    raw = raw.split(" #", 1)[0].split("\t#", 1)[0].strip()
    if not raw or raw.startswith("#"):
        return MISSING
    if raw.lower() in ("null", "~"):
        return NULL
    return raw


def normalized(value):
    """Map a parsed value to True (enabled/require) or False (disabled)."""
    if value is MISSING or value is NULL:
        return True
    if isinstance(value, Quoted):
        return str(value).strip().lower() not in FALSEY
    if isinstance(value, str):
        return str(value).strip().lower() not in FALSEY
    return bool(value)


def value_end(text, start):
    """Index just past the value beginning at `start` (flow-aware)."""
    i = start
    level = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char in QUOTES:
            i += 1
            while i < n and text[i] != char:
                i += 1
            i += 1
            continue
        if char in "[{":
            level += 1
        elif char in "]}":
            if level == 0:
                break
            level -= 1
        elif char == "," and level == 0:
            break
        i += 1
    return i


def flow_value(text, key, depth):
    """Value text of `key` at `depth` in a flow mapping, or None.

    Only a sibling at `depth` matches, so a `slack` key nested deeper (for
    example `platforms.webhook.routes.slack`) is ignored.
    """
    i = 0
    level = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char in "[{":
            level += 1
            i += 1
            continue
        if char in "]}":
            level -= 1
            i += 1
            continue
        if char in QUOTES:
            i += 1
            while i < n and text[i] != char:
                i += 1
            i += 1
            continue
        if level == depth:
            match = re.match(r"([A-Za-z0-9_.-]+)\s*:", text[i:])
            if match:
                if match.group(1) != key:
                    # Skip this entry's value and continue with the next key.
                    i = value_end(text, i + match.end()) + 1
                    continue
                start = i + match.end()
                return text[start:value_end(text, start)].strip()
        i += 1
    return None


def flow_key_seen(text, key, depth):
    """Count occurrences of `key` at `depth` in a flow mapping."""
    count = 0
    i = 0
    level = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char in "[{":
            level += 1
            i += 1
            continue
        if char in "]}":
            level -= 1
            i += 1
            continue
        if char in QUOTES:
            i += 1
            while i < n and text[i] != char:
                i += 1
            i += 1
            continue
        if level == depth:
            match = re.match(r"([A-Za-z0-9_.-]+)\s*:", text[i:])
            if match:
                if match.group(1) == key:
                    count += 1
                i = value_end(text, i + match.end()) + 1
                continue
        i += 1
    return count


def flow_enabled(raw):
    """Handle `platforms: {slack: {enabled: true}}` on one line."""
    inner = raw.strip()
    if inner.startswith("{") and inner.endswith("}"):
        inner = inner[1:-1]
    # Duplicate keys in a flow mapping are as ambiguous as in block style.
    if flow_key_seen(inner, "slack", 0) > 1:
        return True
    slack_value = flow_value(inner, "slack", 0)
    if slack_value is None or not slack_value.startswith("{"):
        return True
    slack_inner = slack_value[1:-1]
    if flow_key_seen(slack_inner, "enabled", 0) > 1:
        return True
    enabled_value = flow_value(slack_inner, "enabled", 0)
    if enabled_value is None:
        return True
    return normalized(scalar(enabled_value))


def quote_closes(line, quote):
    """True when `line` contains the quote character that ends an open scalar.

    Backslash escapes count only in double-quoted scalars, and a doubled single
    quote is an escaped apostrophe rather than a terminator.
    """
    i = 0
    n = len(line)
    while i < n:
        char = line[i]
        if quote == '"' and char == "\\":
            i += 2
            continue
        if char == quote:
            if quote == "'" and i + 1 < n and line[i + 1] == "'":
                i += 2
                continue
            return True
        i += 1
    return False


def mask_opaque(text):
    """Blank out region types whose body text is not configuration.

    Removes comments, literal/folded block scalars (the webhook route prompt is
    one, and deliberately precedes the `slack` block), and multi-line quoted
    scalars, so their contents can never be mistaken for keys. Non-UTF8 bytes
    are replaced rather than rejected, so surrounding keys are still read.
    """
    out = []
    block_indent = None
    quote = None
    for line in text.splitlines():
        stripped = line.lstrip()
        if block_indent is not None:
            if line.strip() and len(line) - len(stripped) > block_indent:
                out.append("")
                continue
            block_indent = None
        if quote is not None:
            if quote_closes(line, quote):
                quote = None
            out.append("")
            continue
        if not stripped or stripped.startswith("#"):
            out.append("")
            continue

        # The scalar value is everything after the first key colon. A
        # multi-line quote can only open there, so an apostrophe or a `" #"`
        # inside a plain or double-quoted value cannot start one.
        key_match = MASK_KEY_RE.match(line)
        value = "" if key_match is None else key_match.group(2).strip()
        for ch in QUOTES:
            if value.startswith(ch) and value.count(ch) % 2 == 1:
                quote = ch
                break
        if key_match is not None and value[:1] in ("|", ">"):
            block_indent = len(key_match.group(1))
        out.append(line)
    return "\n".join(out)


def duplicate_top_level_key(text, name):
    """True when `name` occurs more than once as a top-level mapping key.

    Duplicate keys are invalid YAML and parsers disagree on which one wins, so
    the gate must not pick either. Called on masked text, so prompt bodies
    cannot contribute a phantom key.
    """
    seen = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        match = KEY_RE.match(line)
        if not match:
            continue
        indent, key = match.group(1), match.group(2)
        if "\t" in indent or len(indent) != 0:
            continue
        if key == name:
            seen += 1
            if seen > 1:
                return True
    return False


def scan_lines(text):
    """Walk the masked text once and return (state, value).

    Nothing is decided until the whole document has been read, because a
    duplicate `slack` or `enabled` key appearing later makes an earlier one
    untrustworthy.
    """
    count_platforms = 0
    count_slack = 0
    count_enabled = 0
    enabled = MISSING
    platforms_indent = None
    platforms_child_indent = None
    slack_indent = None
    child_indent = None

    for line in text.splitlines():
        match = KEY_RE.match(line)
        if not match:
            continue
        indent, key, raw = match.group(1), match.group(2), match.group(3)

        # Only space indentation can start a YAML block mapping.
        if "\t" in indent:
            continue
        width = len(indent)
        value = raw.strip()

        # A top-level key ends whatever block was open beneath it.
        if width == 0:
            if key == "platforms":
                count_platforms += 1
                platforms_indent = width
                platforms_child_indent = None
                slack_indent = None
                if value.startswith("{"):
                    enabled = flow_enabled(value)
                    count_enabled += 1
                continue
            platforms_indent = None
            slack_indent = None
            continue

        if platforms_indent is None:
            continue

        # Leaving the slack block must still allow a second `slack` sibling to
        # be seen (a duplicate key), so this does not `continue`.
        if slack_indent is not None and width <= slack_indent:
            slack_indent = None

        if width <= platforms_indent:
            continue

        # `slack` is the platform only as a direct child of `platforms`.
        if slack_indent is None:
            if platforms_child_indent is None:
                platforms_child_indent = width
            if width == platforms_child_indent and key == "slack":
                count_slack += 1
                slack_indent = width
                child_indent = None
                if value.startswith("{"):
                    enabled = flow_enabled(value)
                    count_enabled += 1
            continue

        # `enabled` is the flag only as a direct child of `slack`.
        if child_indent is None:
            child_indent = width
        if width == child_indent and key == "enabled":
            count_enabled += 1
            enabled = normalized(scalar(raw))

    # Any duplicate along the path makes the document ambiguous.
    if count_platforms > 1 or count_slack > 1 or count_enabled > 1:
        return AMBIGUOUS, None
    if count_enabled == 0:
        return ABSENT, None
    return FOUND, enabled


def main(path):
    # errors="replace" so a stray non-UTF8 byte cannot abort the gate.
    with open(path, encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    masked = mask_opaque(text)
    # Ambiguous documents are never trusted to disable the gate.
    if duplicate_top_level_key(masked, "platforms"):
        return True
    state, value = scan_lines(masked)
    if state == FOUND:
        return bool(value)
    # ABSENT (no flag) and AMBIGUOUS (duplicate keys) both mean "enabled".
    return True


try:
    result = main(sys.argv[1])
except Exception:
    # Any unexpected failure must fail CLOSED (require tokens), never open.
    result = True

sys.exit(0 if result else 1)
PY

  # The probe only ever exits 0 (enabled/require) or 1 (disabled/skip). Any
  # other code means the interpreter failed, which must fail closed.
  if [ "$rc" -eq 1 ]; then
    return 1
  fi
  return 0
}

check_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo -e "  ${RED}✗ FILE NOT FOUND: $path${NC}"
    missing=$((missing + 1))
    return 1
  fi
  return 0
}

# Check if a component should be deployed
should_deploy() {
  for c in "${COMPONENTS[@]}"; do
    [[ "$c" == "all" || "$c" == "$1" ]] && return 0
  done
  return 1
}

echo "========================================"
echo " Environment Validation"
echo "========================================"

# ---- Hermes ----

if should_deploy "hermes" || should_deploy "all"; then
echo ""
echo "--- Hermes (.env) ---"
if $GITHUB_MODE || check_file "$HERMES_ENV"; then
  # LLM
  echo "  [LLM Providers]"
  check_var "DEEPSEEK_API_KEY" "$HERMES_ENV"
  check_var "GEMINI_API_KEY" "$HERMES_ENV"

  # Telegram
  echo "  [Telegram]"
  check_var "TELEGRAM_BOT_TOKEN" "$HERMES_ENV"
  check_var "TELEGRAM_ALLOWED_USERS" "$HERMES_ENV"
  check_var "TELEGRAM_HOME_CHANNEL" "$HERMES_ENV"

  # Slack (Socket Mode). Validated only while platforms.slack.enabled is true,
  # so the wiring could merge before the Slack app existed. The allowlist is a
  # hard requirement: free response makes it the only authorization gate, and an
  # empty one yields a bot that connects but answers nobody.
  if slack_platform_enabled; then
    echo "  [Slack]"
    check_var "SLACK_BOT_TOKEN" "$HERMES_ENV"
    check_var "SLACK_APP_TOKEN" "$HERMES_ENV"
    check_var "SLACK_ALLOWED_USERS" "$HERMES_ENV"
    check_var_optional "SLACK_HOME_CHANNEL" "$HERMES_ENV"
    check_var_optional "SLACK_HOME_CHANNEL_NAME" "$HERMES_ENV"
  else
    echo "  [Slack] disabled in config.yaml — skipping token validation"
  fi

  # Webhook
  echo "  [Webhook]"
  check_var "HERMES_WEBHOOK_SECRET" "$HERMES_ENV"

  # GitHub App
  echo "  [GitHub App]"
  check_var "MEMORY_REPO_URL" "$HERMES_ENV"
  check_var "GH_APP_ID" "$HERMES_ENV"
  check_var "GH_APP_INSTALLATION_ID" "$HERMES_ENV"
  check_var "GH_APP_PRIVATE_KEY" "$HERMES_ENV"

  # Dashboard Auth
  echo "  [Dashboard Auth]"
  check_var "HERMES_DASHBOARD_BASIC_AUTH_USERNAME" "$HERMES_ENV"
  check_var "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD" "$HERMES_ENV"

  # Persona
  echo "  [Persona]"
  check_var "IDENTITY_NAME" "$HERMES_ENV"
  check_var "IDENTITY_EMOJI" "$HERMES_ENV"
  check_var "IDENTITY_VIBE" "$HERMES_ENV"
  check_var "SOUL_VOICE_TONE" "$HERMES_ENV"
  check_var "SOUL_VOICE_STYLE" "$HERMES_ENV"
  check_var "SOUL_VOICE_RULES" "$HERMES_ENV"
  check_var "SOUL_DELEGATION" "$HERMES_ENV"

  # Optional
  echo "  [Optional]"
  check_var_optional "FRIDAY_PAT" "$HERMES_ENV"
  check_var_optional "BRAVE_SEARCH_API_KEY" "$HERMES_ENV"
  check_var_optional "FIRECRAWL_API_KEY" "$HERMES_ENV"
  check_var_optional "NOTION_API_KEY" "$HERMES_ENV"
fi
fi

# ---- portfolio-tracker ----

if should_deploy "portfolio-tracker" || should_deploy "all"; then
echo ""
echo "--- Portfolio Tracker (.env) ---"
PT_ENV="$PT_DIR/.env"
if $GITHUB_MODE || check_file "$PT_ENV"; then
  for v in DEEPSEEK_API_KEY ACTUAL_BUDGET_URL ACTUAL_BUDGET_PASSWORD \
           ACTUAL_PRIMARY_BUDGET_FILE ACTUAL_SECONDARY_BUDGET_FILE \
           ONEDRIVE_CLIENT_ID \
           IBKR_FLEX_TOKEN IBKR_FLEX_QUERY_ID \
           IBKR_PP_SGD_ACCOUNT IBKR_PP_USD_ACCOUNT \
           GOOGLE_SERVICE_ACCOUNT_JSON GOOGLE_SHEET_ID \
           TAXONOMY_SHEET_MAPPING TAXONOMY_NAMES PP_OFFSET_MAP; do
    check_var "$v" "$PT_ENV"
  done
  # Validate service account JSON exists
  if $GITHUB_MODE; then
    sa_json="${GOOGLE_SERVICE_ACCOUNT_JSON:-}"
  else
    sa_json=$(env_get "GOOGLE_SERVICE_ACCOUNT_JSON" "$PT_ENV")
  fi
  if [ -n "$sa_json" ]; then
    sa_host_path="/home/runner/data/portfolio-tracker/google-service-account.json"
    # In GitHub mode, write the secret to the file so Docker can mount it
    if $GITHUB_MODE; then
      mkdir -p "$(dirname "$sa_host_path")"
      echo "$sa_json" > "$sa_host_path"
      chmod 600 "$sa_host_path"
      echo -e "  ${GREEN}✓ google-service-account.json (from secret)${NC}"
    elif [ -f "$sa_host_path" ]; then
      echo -e "  ${GREEN}✓ google-service-account.json${NC}"
    else
      echo -e "  ${RED}✗ google-service-account.json NOT FOUND at $sa_host_path${NC}"
      missing=$((missing + 1))
    fi
  fi
fi
fi

# ---- expense-tracker ----

if should_deploy "expense-tracker" || should_deploy "all"; then
echo ""
echo "--- Expense Tracker (.env) ---"
ET_ENV="$ET_DIR/.env"
if $GITHUB_MODE || check_file "$ET_ENV"; then
  # DEEPSEEK_API_KEY is only required for the final fallback when LiteLLM is primary.
  if $GITHUB_MODE; then
    et_llm_provider="${LLM_PROVIDER:-litellm}"
  else
    et_llm_provider=$(env_get "LLM_PROVIDER" "$ET_ENV")
    [ -z "$et_llm_provider" ] && et_llm_provider="litellm"
  fi
  if [ "$et_llm_provider" = "deepseek" ]; then
    check_var "DEEPSEEK_API_KEY" "$ET_ENV"
  else
    check_var_optional "DEEPSEEK_API_KEY" "$ET_ENV"
  fi
  for v in ACTUAL_BUDGET_URL ACTUAL_BUDGET_PASSWORD \
           ACTUAL_PRIMARY_BUDGET_FILE ACTUAL_SECONDARY_BUDGET_FILE \
           ACTUAL_PRIMARY_CURRENCY ACTUAL_SECONDARY_CURRENCY \
           NOTIFY_URL HERMES_WEBHOOK_SECRET \
           IMAP_HOST IMAP_USERNAME IMAP_PASSWORD; do
    check_var "$v" "$ET_ENV"
  done
  echo "  [Optional]"
  check_var_optional "BRAVE_SEARCH_API_KEY" "$ET_ENV"
  check_var_optional "LLM_PROVIDER" "$ET_ENV"
  check_var_optional "LLM_BASE_URL" "$ET_ENV"
  check_var_optional "LLM_MODEL" "$ET_ENV"
  check_var_optional "LLM_API_KEY" "$ET_ENV"
  check_var_optional "LLM_REASONING_EFFORT" "$ET_ENV"
  check_var_optional "LLM_FALLBACK_MODEL" "$ET_ENV"
  check_var_optional "LLM_FINAL_FALLBACK_PROVIDER" "$ET_ENV"
  check_var_optional "LLM_FINAL_FALLBACK_MODEL" "$ET_ENV"
fi
fi

# ---- actual-api (uses portfolio-tracker .env for budget credentials) ----

if should_deploy "actual-api" || should_deploy "all"; then
echo ""
echo "--- actual-api (.env) ---"
PT_ENV="$PT_DIR/.env"
if $GITHUB_MODE || check_file "$PT_ENV"; then
  for v in ACTUAL_BUDGET_PASSWORD ACTUAL_PRIMARY_BUDGET_FILE ACTUAL_BUDGET_URL; do
    check_var "$v" "$PT_ENV"
  done
elif ! $GITHUB_MODE; then
  echo -e "  ${YELLOW}(portfolio-tracker/.env not found — cannot validate actual-api vars)${NC}"
fi
fi

# ---- codex-router ----

if should_deploy "codex-router" || should_deploy "all"; then
echo ""
echo "--- Codex Router ---"
  check_var "CODEX_ROUTER_AUTH_PASSWORD" ""
  check_var_optional "OPENCODE_ZEN_API_KEY" ""
  echo "  [LLM Provider]"
  check_var_optional "LLM_PROVIDER" ""
  check_var_optional "LLM_BASE_URL" ""
  check_var_optional "LLM_MODEL" ""
  check_var_optional "LLM_API_KEY" ""
  check_var_optional "LLM_REASONING_EFFORT" ""
  check_var_optional "LLM_FALLBACK_MODEL" ""
  check_var_optional "LLM_FINAL_FALLBACK_PROVIDER" ""
  check_var_optional "LLM_FINAL_FALLBACK_MODEL" ""
fi

# ---- pluggable modules (auto-discover from modules/*/module.env) ----

echo ""
echo "--- Pluggable Modules ---"
MODULE_COUNT=0
for mod_env in "$ROOT"/modules/*/module.env; do
  [ -f "$mod_env" ] || continue
  source "$mod_env"
  # ktmb-booking is retired (the module targets mcp 1.x and is unused).
  if [ "${MODULE_NAME:-}" = "ktmb-booking" ]; then continue; fi
  MODULE_COUNT=$((MODULE_COUNT + 1))
  mod_dir="$(dirname "$mod_env")"
  echo -e "  ${GREEN}✓ Found: ${MODULE_NAME:-unknown} ($mod_dir)${NC}"
  if $GITHUB_MODE; then
    for v in "${MODULE_REQUIRED_VARS[@]}"; do
      check_var "$v" ""
    done
  else
    mod_env_file="${mod_dir}/${MODULE_ENV_FILE:-.env}"
    if [ -f "$mod_env_file" ]; then
      for v in "${MODULE_REQUIRED_VARS[@]}"; do
        check_var "$v" "$mod_env_file"
      done
    else
      echo -e "  ${RED}✗ Module .env not found at $mod_env_file${NC}"
      missing=$((missing + 1))
    fi
  fi
done
if [ "$MODULE_COUNT" -eq 0 ]; then
  echo "  (none — no modules/*/module.env found)"
fi

# ---- result ----

echo ""
echo "========================================"
if [ "$missing" -gt 0 ]; then
  echo -e "  ${RED}$missing variable(s) missing or empty.${NC}"
  if $GITHUB_MODE; then
    echo "  Ensure all required secrets are set in GitHub → Settings → Secrets."
  else
    echo "  Fill them in the corresponding .env files and re-run."
  fi
  echo "========================================"
  exit 1
fi

echo -e "  ${GREEN}All required variables present.${NC}"
echo "========================================"
echo ""

# ---- onedrive ----

if should_deploy "portfolio-tracker"; then

ONEDRIVE_CONF_DIR="$ROOT/modules/onedrive-sync/config/onedrive"
ONEDRIVE_TOKEN="$ONEDRIVE_CONF_DIR/refresh_token"

if [ "$NON_INTERACTIVE" != true ] && [ ! -f "$ONEDRIVE_TOKEN" ]; then
  echo ""
  echo "----------------------------------------"
  echo " OneDrive Auth Setup"
  echo "----------------------------------------"
  echo ""
  echo "OneDrive authorization is required to sync the Portfolio file."
  echo ""

  cd "$ROOT/modules/onedrive-sync"
  mkdir -p "$ONEDRIVE_CONF_DIR"

  # Construct the Microsoft OAuth URL
  ONEDRIVE_CLIENT_ID=$(env_get ONEDRIVE_CLIENT_ID "$PT_ENV")
  AUTH_URL="https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${ONEDRIVE_CLIENT_ID}&scope=Files.ReadWrite%20Files.ReadWrite.All%20Sites.ReadWrite.All%20offline_access&response_type=code&prompt=login&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient"

  echo "Open this URL in your browser, log in, and after the redirect to a blank"
  echo "page, paste the ENTIRE URL from the address bar back here:"
  echo ""
  echo "$AUTH_URL"
  echo ""
  echo -n "Paste redirect URI: "
  read -r REDIRECT_URI

  if [ -z "$REDIRECT_URI" ]; then
    echo "✗ No redirect URI provided. Skipping OneDrive setup."
  else
    # Feed the redirect URI to complete OAuth and sync
    echo "$REDIRECT_URI" | docker run --rm -i \
      -v "$ONEDRIVE_CONF_DIR:/onedrive/conf" \
      -v gateway_onedrive_data:/onedrive/data \
      driveone/onedrive:latest --sync --verbose --confdir /onedrive/conf --syncdir /onedrive/data 2>&1

    if [ -f "$ONEDRIVE_TOKEN" ]; then
      echo -e "  ${GREEN}✓ OneDrive authorized and synced. Token saved.${NC}"
    else
      echo -e "  ${RED}✗ OneDrive authorization may have failed. Token not found.${NC}"
      echo "  You can rerun deploy.sh to retry, or skip for now."
    fi
  fi
  echo ""
fi
fi  # should_deploy portfolio-tracker

# ---- hermes workspace ----

if should_deploy "hermes" || should_deploy "all"; then
  # Hermes workspace: use HERMES_WORKSPACE env var if set (GitHub mode),
  # otherwise default to $HOME/workspace/hermes (local dev).
  if [ -n "${HERMES_WORKSPACE:-}" ]; then
    HERMES_WS="$HERMES_WORKSPACE"
  else
    HERMES_WS="$HOME/workspace/hermes"
  fi
  mkdir -p "$HERMES_WS"
  if [ "$(stat -c '%u' "$HERMES_WS" 2>/dev/null)" != "10000" ]; then
    echo ""
    echo "--- Hermes Workspace ---"
    echo "  Setting ownership of $HERMES_WS to UID 10000 (hermes user)..."
    sudo chown 10000:10000 "$HERMES_WS"
    echo -e "  ${GREEN}✓ hermes workspace ready${NC}"
  fi
fi

# ---- pull latest code ----

if ! $SKIP_BUILD; then

echo ""
echo "--- Git Pull ---"
cd "$ROOT"
git stash push -m "auto-deploy-stash-$(date +%s)" 2>/dev/null || true

# Configure private repository access
if [ -n "${SUBMODULE_PAT:-}" ]; then
  git config --local url."https://x-access-token:${SUBMODULE_PAT}@github.com/".insteadOf "https://github.com/"
fi

if git pull; then
  echo -e "  ${GREEN}✓ code updated${NC}"
else
  echo -e "  ${RED}✗ git pull failed${NC}"
fi
git stash drop 2>/dev/null || true
fi  # SKIP_BUILD

# ---- deploy ----

cd "$MODULES_DIR"

echo ""
echo "--- Building & Deploying ---"

# Ensure shared network exists (idempotent — needed for signal-cli)
docker network create hermes_shared --driver bridge 2>/dev/null || true

export COMPOSE_DOCKER_CLI_BUILD=1 DOCKER_BUILDKIT=1
COMPOSE="docker-compose --project-name modules"
if [[ " ${COMPONENTS[*]} " =~ " all " ]] || [[ ${#COMPONENTS[@]} -eq 1 && "${COMPONENTS[0]}" == "all" ]]; then
  # Always resolve the full service list — never leave TARGETS empty.
  # An empty TARGETS causes docker compose to silently ignore --force-recreate
  # and only touch services with changed images/configs.
  TARGETS=$($COMPOSE config --services | tr '\n' ' ')
  # ktmb-booking is retired: the module targets mcp 1.x and is unused.
  TARGETS=$(echo "$TARGETS" | tr ' ' '\n' | grep -vx ktmb-booking | tr '\n' ' ')
else
  TARGETS="${COMPONENTS[*]}"
fi

# Build (skip if --skip-build)
if ! $SKIP_BUILD; then
  echo "  Building $TARGETS..."
  $COMPOSE build $TARGETS
fi

# Deploy
if [[ " ${COMPONENTS[*]} " =~ " all " ]]; then
  docker ps -q --filter name=gateway | xargs -r docker stop 2>/dev/null; true
  docker stop hermes modules-portfolio-tracker-1 modules-expense-tracker-1 modules-actual-api-1 kokoro-tts 2>/dev/null; true
  # Retired ktmb-booking: signal any in-flight seat-watcher worker, then give the
  # stop the same 11-minute grace the old drain provided.
  docker exec modules-ktmb-booking-1 sh -c 'rm -f /etc/cron.d/ktmb-worker; pkill cron 2>/dev/null; touch /tmp/ktmb_worker.stop' 2>/dev/null || true
  docker stop -t 660 modules-ktmb-booking-1 2>/dev/null; true
fi

if [ "${FORCE_ALL:-false}" = "true" ]; then
    $COMPOSE up -d --force-recreate $TARGETS
else
    $COMPOSE up -d $TARGETS
fi

# ---- health checks ----

echo ""
echo "--- Health Checks ---"

health_ok() {
  local name="$1" url="$2" max_attempts="${3:-10}"
  local code attempt=0
  # Give the container a moment to bind the port
  sleep 2
  while [ "$attempt" -lt "$max_attempts" ]; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null)
    [ -z "$code" ] && code="000"
    if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
      echo -e "  ${GREEN}✓ $name${NC}"
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt "$max_attempts" ] && sleep 6
  done
  echo -e "  ${RED}✗ $name (HTTP $code)${NC}"
  return 1
}

failed=0

# Hermes dashboard (always check if hermes being deployed)
# Needs extra wait: config migration + profile seeding runs before port binds
if should_deploy "hermes" || should_deploy "all"; then
  sleep 30
  health_ok "hermes" "http://localhost:9119/" || failed=$((failed + 1))
fi

if should_deploy "actual-api" || should_deploy "all"; then
  health_ok "actual-api" "http://localhost:3000/health" || failed=$((failed + 1))
fi

if should_deploy "expense-tracker" || should_deploy "all"; then
  health_ok "expense-tracker" "http://localhost:8080/health" || failed=$((failed + 1))
fi

if should_deploy "portfolio-tracker" || should_deploy "all"; then
  health_ok "portfolio-tracker" "http://localhost:8081/health" || failed=$((failed + 1))
fi

if should_deploy "codex-router" || should_deploy "all"; then
  health_ok "codex-router" "http://localhost:4100/health/liveliness" 30 || failed=$((failed + 1))
fi

# Pluggable module health checks (auto-discovered)
for mod_env in "$ROOT"/modules/*/module.env; do
  [ -f "$mod_env" ] || continue
  source "$mod_env"
  should_deploy "${MODULE_NAME:-}" || continue
  # Only health-check what was deployed; a retired module cannot answer.
  [[ " $TARGETS " == *" ${MODULE_NAME} "* ]] || continue
  for port in "${MODULE_HEALTH_PORTS[@]}"; do
    health_ok "${MODULE_NAME:-unknown}" "http://localhost:$port/health" || failed=$((failed + 1))
  done
done

echo ""
echo "========================================"
if [ "$failed" -gt 0 ]; then
  echo -e "  ${RED}$failed service(s) not healthy. Check: docker-compose logs${NC}"
  echo "========================================"
  exit 1
fi

echo -e "  ${GREEN}All services healthy.${NC}"

# ---- MCP reconnect ----
echo ""
echo "--- MCP Reconnect ---"
sleep 5

for mcp_name in expense-tracker portfolio-tracker; do
  if should_deploy "$mcp_name" || should_deploy "all"; then
    echo -n "  $mcp_name ... "
    if docker exec hermes hermes mcp test "$mcp_name" > /dev/null 2>&1; then
      echo -e "${GREEN}connected${NC}"
    else
      echo -e "${YELLOW}failed (retry later)${NC}"
    fi
  fi
done

# ---- onedrive reminder (non-interactive only) ----
if [ "$NON_INTERACTIVE" = true ] && should_deploy "portfolio-tracker"; then
  ONEDRIVE_TOKEN="$ROOT/modules/onedrive-sync/config/onedrive/refresh_token"
  if [ ! -f "$ONEDRIVE_TOKEN" ]; then
    echo ""
    echo "--- OneDrive ---"
    echo -e "  ${YELLOW}⚠ No refresh_token found. OneDrive is not initialized.${NC}"
    echo ""
    echo "  Initialize via MCP (no shell needed):"
    echo "    1. In Telegram: /onedrive setup"
    echo "    2. Hermes will give you a URL to open in your browser"
    echo "    3. After authorizing, paste the redirect URL back in Telegram"
    echo ""
    echo "  Or run deploy.sh interactively:"
    echo "    cd ~/darren-openclaw && ./modules/deploy.sh --component portfolio-tracker"
    echo ""
  fi
fi

echo "========================================"

echo ""
