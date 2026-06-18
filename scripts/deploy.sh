#!/usr/bin/env bash
# =============================================================================
# OpenClaw Deployment Script
# Validates all required environment variables before starting Docker Compose.
#
# Usage: ./scripts/deploy.sh [--non-interactive]
#   --non-interactive  Skip OneDrive auth prompt, assume .env already configured
# =============================================================================
set -euo pipefail

NON_INTERACTIVE=false
DOCKER_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=true ;;
    *) DOCKER_ARGS+=("$arg") ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATEWAY_DIR="$ROOT/gateway"
PT_DIR="$ROOT/modules/portfolio-tracker"
ET_DIR="$ROOT/modules/expense-tracker"

echo "========================================"
echo " OpenClaw — Environment Validation"
echo "========================================"

missing=0

# Read a value from an env file (handles quotes and special characters)
env_get() {
  local key="$1" file="$2"
  grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | head -1 | sed "s/^[[:space:]]*${key}=//" | sed 's/^"//;s/"$//;s/^'"'"'//;s/'"'"'$//'
}

check_var() {
  local name="$1" file="$2"
  local val
  val=$(env_get "$name" "$file")
  if [ -z "$val" ]; then
    echo "  ✗ MISSING: $name"
    missing=$((missing + 1))
  else
    echo "  ✓ $name"
  fi
}

check_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo "  ✗ FILE NOT FOUND: $path"
    missing=$((missing + 1))
    return 1
  fi
  return 0
}

# ---- portfolio-tracker ----

echo ""
echo "--- Portfolio Tracker (.env) ---"
PT_ENV="$PT_DIR/.env"
if check_file "$PT_ENV"; then
  for v in DEEPSEEK_API_KEY ACTUAL_BUDGET_URL ACTUAL_BUDGET_PASSWORD \
           ACTUAL_BUDGET_FILE MYR_BUDGET_FILE \
           GOOGLE_SERVICE_ACCOUNT_JSON GOOGLE_SHEET_ID; do
    check_var "$v" "$PT_ENV"
  done
  # Validate service account JSON exists
  sa_json=$(env_get "GOOGLE_SERVICE_ACCOUNT_JSON" "$PT_ENV")
  if [ -n "$sa_json" ]; then
    sa_host_path="$ROOT/modules/portfolio-tracker/config/google-service-account.json"
    if [ -f "$sa_host_path" ]; then
      echo "  ✓ google-service-account.json"
    else
      echo "  ✗ google-service-account.json NOT FOUND at $sa_host_path"
      missing=$((missing + 1))
    fi
  fi
fi

# ---- expense-tracker ----

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

# ---- gateway (OpenClaw + actual-api) ----

echo ""
echo "--- Gateway (.env) ---"
GW_ENV="$GATEWAY_DIR/.env"
if check_file "$GW_ENV"; then
  for v in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID DEEPSEEK_API_KEY \
           ACTUAL_BUDGET_URL OPENCLAW_GATEWAY_TOKEN; do
    check_var "$v" "$GW_ENV"
  done
else
  echo "  (gateway/.env not found — cannot validate gateway vars)"
fi

# ---- actual-api (uses portfolio-tracker .env for budget credentials) ----

echo ""
echo "--- actual-api (.env) ---"
if check_file "$PT_ENV"; then
  for v in ACTUAL_BUDGET_PASSWORD ACTUAL_BUDGET_FILE ACTUAL_BUDGET_SERVER_URL; do
    check_var "$v" "$PT_ENV"
  done
else
  echo "  (portfolio-tracker/.env not found — cannot validate actual-api vars)"
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
  echo "  ✓ Found: ${MODULE_NAME:-unknown} ($mod_dir)"
  mod_env_file="${mod_dir}/${MODULE_ENV_FILE:-.env}"
  if [ -f "$mod_env_file" ]; then
    for v in "${MODULE_REQUIRED_VARS[@]}"; do
      check_var "$v" "$mod_env_file"
    done
  else
    echo "  ✗ Module .env not found at $mod_env_file"
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
  echo "  $missing variable(s) missing or empty."
  echo "  Fill them in the corresponding .env files and re-run."
  echo "========================================"
  exit 1
fi

echo "  All required variables present."
echo "========================================"
echo ""

# ---- onedrive ----

ONEDRIVE_CONF_DIR="$ROOT/modules/onedrive-sync/config/onedrive"
ONEDRIVE_TOKEN="$ONEDRIVE_CONF_DIR/refresh_token"

if [ "$NON_INTERACTIVE" = true ]; then
  if [ ! -f "$ONEDRIVE_TOKEN" ]; then
    echo ""
    echo "--- OneDrive ---"
    echo "  No refresh_token found. Run manually to sync:"
    echo ""
    echo "    cd ~/darren-openclaw && ./scripts/deploy.sh"
    echo ""
    echo "  (This will start the interactive OneDrive OAuth flow.)"
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
  export ONEDRIVE_CLIENT_ID=$(env_get ONEDRIVE_CLIENT_ID "$PT_ENV")
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
    cd "$GATEWAY_DIR"
  else
    # Feed the redirect URI to complete OAuth and sync
    echo "$REDIRECT_URI" | docker run --rm -i \
      -v "$ONEDRIVE_CONF_DIR:/onedrive/conf" \
      -v gateway_onedrive_data:/onedrive/data \
      driveone/onedrive:latest --sync --verbose --confdir /onedrive/conf --syncdir /onedrive/data 2>&1

    if [ -f "$ONEDRIVE_TOKEN" ]; then
      echo "✓ OneDrive authorized and synced. Token saved."
    else
      echo "✗ OneDrive authorization may have failed. Token not found."
      echo "  You can rerun deploy.sh to retry, or skip for now."
    fi
    cd "$GATEWAY_DIR"
  fi
  echo ""
fi

echo ""
echo "--- Portfolio Tracker: Java CLI ---"
if command -v mvn &>/dev/null && [ -d "$PT_DIR/pp-cli" ]; then
  cd "$PT_DIR/pp-cli"
  echo "Building pp-cli.jar..."
  mvn package -q -DskipTests
  if [ -f target/pp-cli.jar ]; then
    echo "  ✓ pp-cli.jar built"
  else
    echo "  ✗ pp-cli.jar build failed"
    missing=1
  fi
  cd "$ROOT"
else
  echo "  ! mvn not found or pp-cli not present — skipping (will use cached JAR if exists)"
fi

# ---- pull latest code ----

echo ""
echo "--- Git Pull ---"
cd "$ROOT"
git stash push -m "auto-deploy-stash-$(date +%s)" 2>/dev/null || true
git pull
git stash drop 2>/dev/null || true
echo "  ✓ code updated"

# ---- deploy ----

cd "$GATEWAY_DIR"
echo "Starting Cloudflare Warp (VPN for faster Docker pulls)..."
warp-cli --accept-tos connect 2>/dev/null || true
sleep 2
echo "Starting Docker Compose (cached build)..."
export COMPOSE_DOCKER_CLI_BUILD=1 DOCKER_BUILDKIT=1
docker compose build
docker compose up -d "${DOCKER_ARGS[@]}"

# ---- plugin registration (one-time, persists on named volume) ----

if [ -d "$GATEWAY_DIR/plugins/expense-tracker-tools" ]; then
  echo ""
  echo "--- Plugin Registration ---"
  docker exec gateway-openclaw-1 openclaw plugins install /home/node/plugins/expense-tracker-tools --force 2>/dev/null && \
    echo "  ✓ expense-tracker-tools plugin registered" || \
    echo "  ! plugin registration skipped (may already be installed)"
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
      echo "  ✓ $name ($url → $code)"
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -lt "$max_attempts" ]; then
      sleep 3
    fi
  done
  echo "  ✗ $name ($url → $code)"
  return 1
}

failed=0
health_ok "actual-api"       "http://localhost:3000/health" || failed=$((failed + 1))
health_ok "expense-tracker"   "http://localhost:8080/health" || failed=$((failed + 1))
health_ok "portfolio-tracker" "http://localhost:8081/health" || failed=$((failed + 1))

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
  echo "  $failed service(s) not healthy. Check: docker compose logs"
  echo "========================================"
  exit 1
fi

echo "  All services healthy."
echo "========================================"

# ---- Chrome Daemon (must run after containers) ----

if [ -d "$GATEWAY_DIR" ]; then
  echo ""
  echo "--- Chrome Daemon ---"

  # Prefer Google Chrome (production uses this).
  # Fall back to chromium if google-chrome not found.
  if [ -f /usr/bin/google-chrome ]; then
    CHROME_BIN="/usr/bin/google-chrome"
  elif command -v google-chrome-stable &>/dev/null; then
    CHROME_BIN="$(command -v google-chrome-stable)"
  elif command -v chromium &>/dev/null; then
    CHROME_BIN="$(command -v chromium)"
  else
    CHROME_BIN=""
    echo ""
    echo "  ✗ No Chrome/Chromium binary found."
    echo ""
    echo "  Install Google Chrome before running deploy.sh:"
    echo ""
    echo "    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | \\"
    echo "      sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg"
    echo "    echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main' | \\"
    echo "      sudo tee /etc/apt/sources.list.d/google-chrome.list"
    echo "    sudo apt-get update && sudo apt-get install -y google-chrome-stable"
    echo ""
    echo "  Then re-run: ./scripts/deploy.sh"
    exit 1
  fi

  echo "  ✓ Chrome binary: $CHROME_BIN"

  # Install socat
  if command -v socat &>/dev/null; then
    :
  elif sudo -n true 2>/dev/null; then
    sudo apt-get install -y -qq socat 2>/dev/null || true
  else
    echo "  ! socat not found and sudo unavailable — install manually"
  fi

  # Check if we can manage systemd services
  HAS_SUDO=false
  sudo -n true 2>/dev/null && HAS_SUDO=true

  # Create chrome-daemon service on first run
  CHROME_SVC="/etc/systemd/system/chrome-daemon.service"
  if [ ! -f "$CHROME_SVC" ] && [ -n "$CHROME_BIN" ] && [ -f "$CHROME_BIN" ]; then
    if $HAS_SUDO; then
      cat > "$CHROME_SVC" << UNIT
[Unit]
Description=Chrome Headless Daemon (CDP :9222)
After=network.target

[Service]
Type=simple
User=darren
Environment=DISPLAY=:99
Environment=HOME=/home/darren
ExecStartPre=/bin/sleep 2
ExecStart=$CHROME_BIN \\
  --disable-dev-shm-usage \\
  --remote-debugging-port=9222 \\
  --remote-debugging-address=0.0.0.0 \\
  --user-data-dir=/tmp/chrome-daemon \\
  --disable-gpu \\
  --disable-software-rasterizer \\
  --renderer-process-limit=1 \\
  --headless=new \\
  about:blank
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload 2>/dev/null || true
      systemctl enable chrome-daemon 2>/dev/null || true
      echo "  ✓ chrome-daemon.service created"
    else
      echo "  ! sudo unavailable — chrome-daemon.service not created"
    fi
  fi

  # Create cdp-forward service on first run
  CDP_SVC="/etc/systemd/system/cdp-forward.service"
  if [ ! -f "$CDP_SVC" ] && command -v socat &>/dev/null; then
    if $HAS_SUDO; then
      cat > "$CDP_SVC" << UNIT2
[Unit]
Description=CDP Forward (9223→9222)
After=chrome-daemon.service
Requires=chrome-daemon.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9222
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT2
      systemctl daemon-reload 2>/dev/null || true
      systemctl enable cdp-forward 2>/dev/null || true
      echo "  ✓ cdp-forward.service created"
    else
      echo "  ! sudo unavailable — cdp-forward.service not created"
    fi
  fi

  # Restart services (skip if sudo unavailable)
  if $HAS_SUDO; then
    systemctl restart chrome-daemon 2>/dev/null || true
    systemctl restart cdp-forward 2>/dev/null || true
    sleep 2
  else
    echo "  ! Skipping service restart (sudo unavailable)"
  fi
  ss -tlnp 2>/dev/null | grep -q 9222 && echo "  ✓ Chrome daemon :9222" || echo "  ! Chrome daemon not running"
  ss -tlnp 2>/dev/null | grep -q 9223 && echo "  ✓ CDP forward :9223"
fi

# Disconnect Warp after all network-dependent steps complete
echo "Disconnecting Warp..."
warp-cli --accept-tos disconnect 2>/dev/null || true
