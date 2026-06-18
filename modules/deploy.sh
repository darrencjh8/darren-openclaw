#!/usr/bin/env bash
# =============================================================================
# Deploy Script — Hermes Agent + Services
# Validates all required environment variables, builds + deploys via Compose.
#
# Usage: ./modules/deploy.sh --component <name> [--component <name>...] [--non-interactive]
#   --component <name>  Required. One of: all, hermes, portfolio-tracker, expense-tracker, actual-api, image-gen, ktmb-booking
#   --non-interactive    Skip OneDrive auth prompt
# =============================================================================
set -euo pipefail

NON_INTERACTIVE=false
DOCKER_ARGS=()
COMPONENTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=true ;;
    --component) COMPONENTS+=("$2"); shift ;;
    *) DOCKER_ARGS+=("$1") ;;
  esac
  shift
done

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
  echo "  ktmb-booking         KTMB train booking"
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
  local name="$1" file="$2"
  local val
  val=$(env_get "$name" "$file")
  if [ -z "$val" ]; then
    echo -e "  ${RED}✗ MISSING: $name${NC}"
    missing=$((missing + 1))
  else
    echo -e "  ${GREEN}✓ $name${NC}"
  fi
}

check_var_optional() {
  local name="$1" file="$2"
  local val
  val=$(env_get "$name" "$file")
  if [ -z "$val" ]; then
    echo -e "  ${YELLOW}○ $name (not set)${NC}"
  else
    echo -e "  ${GREEN}✓ $name${NC}"
  fi
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
if check_file "$HERMES_ENV"; then
  # LLM
  echo "  [LLM Providers]"
  check_var "DEEPSEEK_API_KEY" "$HERMES_ENV"
  check_var "GEMINI_API_KEY" "$HERMES_ENV"

  # Telegram
  echo "  [Telegram]"
  check_var "TELEGRAM_BOT_TOKEN" "$HERMES_ENV"
  check_var "TELEGRAM_ALLOWED_USERS" "$HERMES_ENV"
  check_var "TELEGRAM_HOME_CHANNEL" "$HERMES_ENV"

  # Webhook
  echo "  [Webhook]"
  check_var "HERMES_WEBHOOK_SECRET" "$HERMES_ENV"

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
  check_var_optional "GITHUB_PAT" "$HERMES_ENV"
  check_var_optional "GITHUB_URL" "$HERMES_ENV"
  check_var_optional "FIRECRAWL_API_KEY" "$HERMES_ENV"
  check_var_optional "HERMES_DASHBOARD_BASIC_AUTH_USERNAME" "$HERMES_ENV"
  check_var_optional "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD" "$HERMES_ENV"
fi
fi

# ---- portfolio-tracker ----

if should_deploy "portfolio-tracker" || should_deploy "all"; then
echo ""
echo "--- Portfolio Tracker (.env) ---"
PT_ENV="$PT_DIR/.env"
if check_file "$PT_ENV"; then
  for v in DEEPSEEK_API_KEY ACTUAL_BUDGET_URL ACTUAL_BUDGET_PASSWORD \
           ACTUAL_PRIMARY_BUDGET_FILE ACTUAL_SECONDARY_BUDGET_FILE \
           ONEDRIVE_CLIENT_ID \
           IBKR_FLEX_TOKEN IBKR_FLEX_QUERY_ID \
           IBKR_PP_SGD_ACCOUNT IBKR_PP_USD_ACCOUNT \
           GOOGLE_SERVICE_ACCOUNT_JSON GOOGLE_SHEET_ID; do
    check_var "$v" "$PT_ENV"
  done
  # Validate service account JSON exists
  sa_json=$(env_get "GOOGLE_SERVICE_ACCOUNT_JSON" "$PT_ENV")
  if [ -n "$sa_json" ]; then
    sa_host_path="$ROOT/modules/portfolio-tracker/config/google-service-account.json"
    if [ -f "$sa_host_path" ]; then
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
if check_file "$ET_ENV"; then
  for v in DEEPSEEK_API_KEY ACTUAL_BUDGET_URL ACTUAL_BUDGET_PASSWORD \
           ACTUAL_PRIMARY_BUDGET_FILE ACTUAL_SECONDARY_BUDGET_FILE \
           ACTUAL_PRIMARY_CURRENCY ACTUAL_SECONDARY_CURRENCY \
           NOTIFY_URL HERMES_WEBHOOK_SECRET \
           IMAP_HOST IMAP_USERNAME IMAP_PASSWORD; do
    check_var "$v" "$ET_ENV"
  done
fi
fi

# ---- actual-api (uses portfolio-tracker .env for budget credentials) ----

if should_deploy "actual-api" || should_deploy "all"; then
echo ""
echo "--- actual-api (.env) ---"
PT_ENV="$PT_DIR/.env"
if check_file "$PT_ENV"; then
  for v in ACTUAL_BUDGET_PASSWORD ACTUAL_PRIMARY_BUDGET_FILE ACTUAL_BUDGET_URL; do
    check_var "$v" "$PT_ENV"
  done
else
  echo -e "  ${YELLOW}(portfolio-tracker/.env not found — cannot validate actual-api vars)${NC}"
fi
fi

# ---- pluggable modules (auto-discover from modules/*/module.env) ----

echo ""
echo "--- Pluggable Modules ---"
MODULE_COUNT=0
for mod_env in "$ROOT"/modules/*/module.env; do
  [ -f "$mod_env" ] || continue
  MODULE_COUNT=$((MODULE_COUNT + 1))
  source "$mod_env"
  mod_dir="$(dirname "$mod_env")"
  echo -e "  ${GREEN}✓ Found: ${MODULE_NAME:-unknown} ($mod_dir)${NC}"
  mod_env_file="${mod_dir}/${MODULE_ENV_FILE:-.env}"
  if [ -f "$mod_env_file" ]; then
    for v in "${MODULE_REQUIRED_VARS[@]}"; do
      check_var "$v" "$mod_env_file"
    done
  else
    echo -e "  ${RED}✗ Module .env not found at $mod_env_file${NC}"
    missing=$((missing + 1))
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
  echo "  Fill them in the corresponding .env files and re-run."
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

if [ "$NON_INTERACTIVE" = true ]; then
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
elif [ ! -f "$ONEDRIVE_TOKEN" ]; then
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

# ---- Portfolio Tracker: Java CLI ----
if should_deploy "portfolio-tracker"; then
echo ""
echo "--- Portfolio Tracker: Java CLI ---"
if command -v mvn &>/dev/null && [ -d "$PT_DIR/pp-cli" ]; then
  cd "$PT_DIR/pp-cli"
  echo "Building pp-cli.jar..."
  mvn package -q -DskipTests
  if [ -f target/pp-cli.jar ]; then
    echo -e "  ${GREEN}✓ pp-cli.jar built${NC}"
  else
    echo -e "  ${RED}✗ pp-cli.jar build failed${NC}"
    exit 1
  fi
  cd "$ROOT"
else
  echo -e "  ${YELLOW}! mvn not found or pp-cli not present — skipping (will use cached JAR if exists)${NC}"
fi
fi  # should_deploy portfolio-tracker

# ---- pull latest code ----

echo ""
echo "--- Git Pull ---"
cd "$ROOT"
git stash push -m "auto-deploy-stash-$(date +%s)" 2>/dev/null || true
git pull
git stash drop 2>/dev/null || true
echo -e "  ${GREEN}✓ code updated${NC}"

# ---- deploy ----

cd "$MODULES_DIR"

echo ""
echo "--- Building & Deploying ---"
export COMPOSE_DOCKER_CLI_BUILD=1 DOCKER_BUILDKIT=1
if [[ " ${COMPONENTS[*]} " =~ " all " ]] || [[ ${#COMPONENTS[@]} -eq 1 && "${COMPONENTS[0]}" == "all" ]]; then
  echo "  Building all services..."
  docker compose build
  docker compose up -d "${DOCKER_ARGS[@]}"
else
  echo "  Components: ${COMPONENTS[*]}"
  docker compose build "${COMPONENTS[@]}"
  docker compose up -d "${COMPONENTS[@]}"
fi

# ---- health checks ----

echo ""
echo "--- Health Checks ---"

health_ok() {
  local name="$1" url="$2"
  local code attempt=0 max_attempts=5
  while [ "$attempt" -lt "$max_attempts" ]; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then
      echo -e "  ${GREEN}✓ $name${NC}"
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt "$max_attempts" ] && sleep 3
  done
  echo -e "  ${RED}✗ $name (HTTP $code)${NC}"
  return 1
}

failed=0

# Hermes dashboard (always check if hermes being deployed)
if should_deploy "hermes" || should_deploy "all"; then
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

# Pluggable module health checks (auto-discovered)
for mod_env in "$ROOT"/modules/*/module.env; do
  [ -f "$mod_env" ] || continue
  source "$mod_env"
  for port in "${MODULE_HEALTH_PORTS[@]}"; do
    health_ok "${MODULE_NAME:-unknown}" "http://localhost:$port/health" || failed=$((failed + 1))
  done
done

echo ""
echo "========================================"
if [ "$failed" -gt 0 ]; then
  echo -e "  ${RED}$failed service(s) not healthy. Check: docker compose logs${NC}"
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

echo "========================================"
