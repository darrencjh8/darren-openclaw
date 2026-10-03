#!/bin/bash
# Generate short-lived GitHub App installation token and auth gh CLI as hermes.
# Requires: GH_APP_ID, GH_APP_INSTALLATION_ID, GH_APP_PRIVATE_KEY
#
# Exit contract: exit 0 skip (log, no alert) when App configuration is incomplete;
# return non-zero only on attempted-but-failed mint/auth/parse.
# Idempotent — safe to run on every boot and every cron tick.
set -euo pipefail

# Installation credentials must win over any ambient PAT-style override.
unset GH_TOKEN GITHUB_TOKEN

log()  { echo "[github-auth] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# ---- check required env vars (skip, not fail, when incomplete) ----
[ -z "${GH_APP_ID:-}" ]               && { log "GH_APP_ID not set — skipping"; exit 0; }
[ -z "${GH_APP_INSTALLATION_ID:-}" ] && { log "GH_APP_INSTALLATION_ID not set — skipping"; exit 0; }
[ -z "${GH_APP_PRIVATE_KEY:-}" ]      && { log "GH_APP_PRIVATE_KEY not set — skipping"; exit 0; }

# ---- pre-flight: check dependencies only for an attempted refresh ----
for cmd in openssl curl python3 gh; do
    command -v "$cmd" >/dev/null || die "$cmd not found in PATH"
done

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
# The minted JWT goes on the wire; only log output is redacted, never the request.
AUTHZ="Authorization: Bearer $JWT"
APP_SLUG=$(curl -s \
  -H "$AUTHZ" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('slug',''))")
[ -n "$APP_SLUG" ] || die "GitHub API did not return the App slug"
case "$APP_SLUG" in
    *[!a-zA-Z0-9_-]*) die "GitHub API returned an invalid App slug" ;;
esac
APP_LOGIN="${APP_SLUG}[bot]"
export GH_APP_LOGIN="$APP_LOGIN"
RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -H "$AUTHZ" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/$GH_APP_INSTALLATION_ID/access_tokens")
unset AUTHZ JWT
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP_CODE" != "201" ]; then
    ERR=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','unknown'))" 2>/dev/null || echo "unknown")
    die "GitHub API returned HTTP $HTTP_CODE: $ERR"
fi

TOKEN=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))") || die "failed to parse token from API response"
[ -z "$TOKEN" ] && die "API returned empty token"
EXPIRES_AT=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expires_at','unknown'))")

# ---- store token (atomic temp-file-plus-rename, hermes-owned 0600) ----
# Flat files only: hosts.yml is gh-managed and is written solely via gh auth login.
# The path is overridable so tests never touch the live credential.
TOKEN_FILE="${GH_APP_TOKEN_FILE:-/opt/data/.gh_token}"
TOK_TMP=$(mktemp "${TOKEN_FILE}.XXXXXX")
trap 'rm -f "$TOK_TMP"' EXIT
printf '%s' "$TOKEN" > "$TOK_TMP"
chown hermes:hermes "$TOK_TMP" 2>/dev/null || true
chmod 600 "$TOK_TMP"
mv -f "$TOK_TMP" "$TOKEN_FILE"
trap - EXIT
log "token stored (expires $EXPIRES_AT)"

# ---- auth gh CLI as the hermes runtime user ----
# The boot hook and the cron scheduler both run as hermes. Pin HOME because the
# root boot hook invokes this through su -m, which otherwise preserves /root.
# HERMES_HOME is the mounted data root; gh's config lives in its home subdirectory.
export HOME="${GH_HOME:-/opt/data/home}"
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh}"

if [ "$(id -u)" = "0" ]; then
    INIT_TMP=$(mktemp /tmp/.gh-app-token-init.XXXXXX)
    trap 'rm -f "$INIT_TMP"' EXIT
    printf '%s' "$TOKEN" > "$INIT_TMP"
    chmod 600 "$INIT_TMP"
    su -s /bin/sh hermes -c "HOME=$HOME gh auth login --with-token < $INIT_TMP && HOME=$HOME gh auth switch --hostname github.com --user '${GH_APP_LOGIN:-friday-coder-bot[bot]}'" 2>/dev/null \
        || die "gh auth login or switch failed for hermes"
    rm -f "$INIT_TMP"
else
    INIT_TMP=$(mktemp "${TMPDIR:-/tmp}/.gh-app-token-init.XXXXXX")
    trap 'rm -f "$INIT_TMP"' EXIT
    printf '%s' "$TOKEN" > "$INIT_TMP"
    chmod 600 "$INIT_TMP"
    HOME=$HOME gh auth login --with-token < "$INIT_TMP" 2>/dev/null \
        || die "gh auth login failed for $(id -un)"
    gh auth switch --hostname github.com --user "${GH_APP_LOGIN:-friday-coder-bot[bot]}" 2>/dev/null \
        || die "gh auth switch failed for $(id -un)"
    rm -f "$INIT_TMP"
fi
trap - EXIT

log "done"
exit 0