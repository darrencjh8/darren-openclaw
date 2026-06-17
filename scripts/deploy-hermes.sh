#!/usr/bin/env bash
# =============================================================================
# Hermes Agent — Deploy Script
# Validates all required environment variables, builds + deploys hermes,
# expense-tracker, and actual-api via Compose.
#
# Usage: ./scripts/deploy-hermes.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_DIR="$ROOT/modules/hermes"
HERMES_ENV="$HERMES_DIR/.env"
GATEWAY_DIR="$ROOT/gateway"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

missing=0

env_get() {
  local key="$1" file="$2"
  grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | head -1 | sed "s/^[[:space:]]*${key}=//" | sed 's/^"//;s/"$//;s/^'"'"'//;s/'"'"'$//'
}

check_required() {
  local name="$1"
  local val
  val=$(env_get "$name" "$HERMES_ENV")
  if [ -z "$val" ]; then
    echo -e "  ${RED}✗ MISSING: $name${NC}"
    missing=$((missing + 1))
  else
    echo -e "  ${GREEN}✓ $name${NC}"
  fi
}

check_optional() {
  local name="$1"
  local val
  val=$(env_get "$name" "$HERMES_ENV")
  if [ -z "$val" ]; then
    echo -e "  ${YELLOW}○ $name (not set — feature disabled)${NC}"
  else
    echo -e "  ${GREEN}✓ $name${NC}"
  fi
}

echo "========================================"
echo " Hermes Agent — Environment Validation"
echo "========================================"

# ---- LLM Providers ----
echo ""
echo "--- LLM Providers ---"
check_required "DEEPSEEK_API_KEY"
check_required "GEMINI_API_KEY"

# ---- Telegram Gateway ----
echo ""
echo "--- Telegram Gateway ---"
check_required "TELEGRAM_BOT_TOKEN"
check_required "TELEGRAM_ALLOWED_USERS"
check_required "TELEGRAM_HOME_CHANNEL"

# ---- Webhook ----
echo ""
echo "--- Webhook ---"
check_required "HERMES_WEBHOOK_SECRET"

# ---- Dashboard Auth ----
echo ""
echo "--- Dashboard Auth ---"
check_required "HERMES_DASHBOARD_BASIC_AUTH_USERNAME"
check_required "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"

# ---- SOUL / Persona ----
echo ""
echo "--- Persona ---"
check_required "IDENTITY_NAME"
check_required "IDENTITY_EMOJI"
check_required "IDENTITY_VIBE"
check_required "SOUL_VOICE_TONE"
check_required "SOUL_VOICE_STYLE"
check_required "SOUL_VOICE_RULES"
check_required "SOUL_DELEGATION"

# ---- Optional ----
echo ""
echo "--- Memory Backup ---"
check_optional "GITHUB_PAT"
check_optional "GITHUB_URL"

echo ""
echo "--- Expense Tracker Memory ---"
check_optional "EXPENSE_TRACKER_DATA"

echo ""
echo "--- Optional Tools ---"
check_optional "FIRECRAWL_API_KEY"

# ---- Result ----
echo ""
echo "========================================"
if [ "$missing" -gt 0 ]; then
  echo -e "  ${RED}$missing required variable(s) missing.${NC}"
  echo "  Fill them in modules/hermes/.env and re-run."
  echo "========================================"
  exit 1
fi

echo -e "  ${GREEN}All required variables present.${NC}"
echo "========================================"
echo ""

# ---- Deploy via Compose ----
mkdir -p "$HOME/.hermes"

cd "$GATEWAY_DIR"
echo "--- Building services ---"
docker compose build hermes expense-tracker actual-api
echo ""
echo "--- Deploying ---"
docker compose up -d hermes expense-tracker actual-api

# ---- Health check ----
echo ""
echo "--- Health Check ---"
attempt=0 max_attempts=10
while [ "$attempt" -lt "$max_attempts" ]; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:9119/ 2>/dev/null || echo "000")
  if [ "$code" = "302" ] || [ "$code" = "200" ]; then
    echo -e "  ${GREEN}✓ Hermes dashboard responding (HTTP $code)${NC}"
    break
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -lt "$max_attempts" ] && sleep 3
done
if [ "$attempt" -ge "$max_attempts" ]; then
  echo -e "  ${RED}✗ Hermes dashboard not responding (HTTP $code)${NC}"
  echo "  Check: docker compose logs hermes"
  exit 1
fi

echo ""
echo "========================================"
echo -e "  ${GREEN}Hermes Agent deployed.${NC}"
echo "========================================"
