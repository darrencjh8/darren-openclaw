#!/bin/bash
# Generate short-lived GitHub App installation token
# Requires: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
set -e

[ -z "${GITHUB_APP_ID}" ] && exit 0
[ -z "${GITHUB_APP_INSTALLATION_ID}" ] && exit 0
[ -z "${GITHUB_APP_PRIVATE_KEY}" ] && exit 0

# Decode \n escapes in private key (env vars can't hold real newlines)
PRIVATE_KEY=$(echo -e "$GITHUB_APP_PRIVATE_KEY")

# Generate JWT
NOW=$(date +%s)
EXP=$((NOW + 600))
HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | base64 -w0 | tr '+/' '-_' | tr -d '=')
PAYLOAD=$(echo -n "{\"iat\":$NOW,\"exp\":$EXP,\"iss\":\"$GITHUB_APP_ID\"}" | base64 -w0 | tr '+/' '-_' | tr -d '=')
SIGNATURE=$(echo -n "$HEADER.$PAYLOAD" | openssl dgst -sha256 -sign <(echo "$PRIVATE_KEY") -binary | base64 -w0 | tr '+/' '-_' | tr -d '=')
JWT="$HEADER.$PAYLOAD.$SIGNATURE"

# Get installation token
TOKEN=$(curl -s -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/$GITHUB_APP_INSTALLATION_ID/access_tokens" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -n "$TOKEN" ]; then
    echo "$TOKEN" > /opt/data/.gh_token
    chmod 600 /opt/data/.gh_token
    # Set for current shell and future processes
    export GITHUB_TOKEN="$TOKEN"
    # Also configure gh CLI
    echo "$TOKEN" | gh auth login --with-token 2>/dev/null || true
fi
