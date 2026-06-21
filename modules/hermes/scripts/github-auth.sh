#!/bin/bash
# Generate short-lived GitHub App installation token and auth gh CLI.
# Requires: GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PRIVATE_KEY
#
# Idempotent — safe to run on every boot. Exits 0 on success, 1 on failure.
set -euo pipefail

log()  { echo "[github-auth] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# ---- pre-flight: check dependencies ----
for cmd in openssl curl python3 gh; do
    command -v "$cmd" >/dev/null || die "$cmd not found in PATH"
done

# ---- check required env vars ----
[ -z "${GH_APP_ID:-}" ]           && { log "GH_APP_ID not set — skipping"; exit 0; }
[ -z "${GH_APP_INSTALLATION_ID:-}" ] && { log "GH_APP_INSTALLATION_ID not set — skipping"; exit 0; }
[ -z "${GH_APP_PRIVATE_KEY:-}" ]    && { log "GH_APP_PRIVATE_KEY not set — skipping"; exit 0; }

# ---- decode private key (env vars escape \n as literal backslash-n) ----
PRIVATE_KEY=$(echo -e "$GH_APP_PRIVATE_KEY")
if ! echo "$PRIVATE_KEY" | grep -q "BEGIN.*PRIVATE KEY"; then
    die "private key does not contain BEGIN.*PRIVATE KEY header — check GH_APP_PRIVATE_KEY format"
fi

# ---- generate JWT ----
NOW=$(date +%s)
EXP=$((NOW + 600))
b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(echo -n "{\"iat\":$NOW,\"exp\":$EXP,\"iss\":\"$GH_APP_ID\"}" | b64url)
if ! SIGNATURE=$(echo -n "$HEADER.$PAYLOAD" | openssl dgst -sha256 -sign <(echo "$PRIVATE_KEY") -binary 2>&1 | b64url); then
    die "openssl signing failed — is the private key valid?"
fi
JWT="$HEADER.$PAYLOAD.$SIGNATURE"

# ---- call GitHub API to get installation token ----
RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/$GH_APP_INSTALLATION_ID/access_tokens")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP_CODE" != "201" ]; then
    ERR=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','unknown'))" 2>/dev/null || echo "unknown")
    die "GitHub API returned HTTP $HTTP_CODE: $ERR"
fi

TOKEN=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))") || die "failed to parse token from API response"
[ -z "$TOKEN" ] && die "API returned empty token"

# ---- store token ----
echo "$TOKEN" > /opt/data/.gh_token
chmod 644 /opt/data/.gh_token
export GITHUB_TOKEN="$TOKEN"
log "token stored (expires $(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expires_at','unknown'))"))"

# ---- auth gh CLI as hermes user (workers) ----
# gh auth login --with-token overwrites the existing entry for the same user.
# No logout needed — avoids multi-user ambiguity errors.
if [ "$(id -u)" = "$(id -u hermes 2>/dev/null || echo 0)" ]; then
    # Already running as hermes — auth directly
    if ! (unset GITHUB_TOKEN; echo "$TOKEN" | gh auth login --with-token); then
        die "gh auth login failed for hermes user"
    fi
else
    if ! echo "$TOKEN" | su -s /bin/sh hermes -c "gh auth login --with-token"; then
        die "gh auth login failed for hermes user"
    fi
fi

# ---- verify hermes auth ----
_gh_auth_check() {
    if [ "$(id -u)" = "$(id -u hermes 2>/dev/null || echo 0)" ]; then
        gh auth status
    else
        su -s /bin/sh hermes -c 'gh auth status'
    fi
}
if ! _gh_auth_check >/dev/null 2>&1; then
    die "gh auth verification failed for hermes user"
fi
log "hermes user authenticated as $(_gh_auth_check 2>&1 | grep -oP 'account \K[^ ]+')"

# ---- auth gh CLI as root (cron / memory-backup) ----
# Only try root auth if we are actually root; skip when running as hermes via cron.
if [ "$(id -u)" = "0" ]; then
    echo "$TOKEN" | gh auth login --with-token 2>/dev/null || log "warning: gh auth login failed for root (non-fatal)"
fi

log "done"
