#!/bin/bash
# Pollinations image generation
# Usage: gen-pollinations.sh "PROMPT" OUTPUT [MODEL] [SIZE]
PROMPT="$1"
export IMG_OUTPUT="$2"
MODEL="${3:-flux}"
SIZE="${4:-1024x1024}"

if [ "$MODEL" = "flux" ]; then
  # Paid endpoint (requires POLLINATIONS_API_KEY)
  PAYLOAD=$(python3 -c "import json, sys; print(json.dumps({'model':sys.argv[1],'prompt':sys.argv[2],'n':1,'size':sys.argv[3]}))" "$MODEL" "$PROMPT" "$SIZE")
  curl -s -w "\nHTTP:%{http_code}" -X POST \
    "https://gen.pollinations.ai/v1/images/generations" \
    -H "Authorization: Bearer $POLLINATIONS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    | python3 -c "
import sys, os, base64, json
raw = sys.stdin.read()
for line in raw.split('\n'):
    if line.startswith('{'):
        data = json.loads(line)
        img = base64.b64decode(data['data'][0]['b64_json'])
        with open(os.environ['IMG_OUTPUT'], 'wb') as f:
            f.write(img)
        print('200')
        break
"
else
  # Free endpoint (sona)
  ENC=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$PROMPT")
  HTTP=$(curl -s -w "\nHTTP:%{http_code}" \
    "https://image.pollinations.ai/prompt/$ENC?width=${SIZE%%x*}&height=${SIZE##*x}&nologo=true" \
    -o "$IMG_OUTPUT")
  echo "$HTTP" | tail -1
fi
