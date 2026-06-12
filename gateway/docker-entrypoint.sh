#!/bin/sh
# Generate prompt files from templates with env var substitution, then start OpenClaw
WS=/app/.openclaw/workspace
mkdir -p "$WS" /app/.openclaw/compile-cache

# Copy config from bind-mount to writable volume (default path: OPENCLAW_HOME/.openclaw/openclaw.json)
cp /app/openclaw.json.bk /app/.openclaw/openclaw.json

node -e "
const fs = require('fs');
const files = ['AGENTS', 'SOUL', 'USER', 'IDENTITY', 'MEMORY'];
const vars = Object.keys(process.env).filter(k => !k.includes('PATH') && !k.includes('HOME') && !k.includes('SHLVL') && !k.includes('PWD'));
vars.sort((a, b) => b.length - a.length);
for (const name of files) {
  try {
    let t = fs.readFileSync('/app/' + name + '.md.template', 'utf8');
    for (const k of vars) {
      const re = new RegExp('\\\\\\$' + k + '(?![a-zA-Z0-9_])', 'g');
      t = t.replace(re, process.env[k] || '');
    }
    fs.writeFileSync('$WS/' + name + '.md', t);
    console.log(name + '.md generated');
  } catch(e) {
    console.log(name + '.md skipped: ' + e.message);
  }
}
try { fs.unlinkSync('$WS/BOOTSTRAP.md'); console.log('BOOTSTRAP.md removed'); } catch(e) {}
// Generate thinker workspace
const thinkerWs = '/app/.openclaw/workspace-thinker';
fs.mkdirSync(thinkerWs, { recursive: true });
try {
  let tt = fs.readFileSync('/app/AGENTS.thinker.md.template', 'utf8');
  for (const k of vars) {
    const re = new RegExp('\\\\\\$' + k + '(?![a-zA-Z0-9_])', 'g');
    tt = tt.replace(re, process.env[k] || '');
  }
  fs.writeFileSync(thinkerWs + '/AGENTS.md', tt);
  console.log('thinker AGENTS.md generated');
} catch(e) {
  console.log('thinker AGENTS.md skipped: ' + e.message);
}
"

# Start Xvfb and dbus for headless browser support (Perchance, etc.)
rm -f /tmp/.X99-lock 2>/dev/null
dbus-daemon --session --fork --address="unix:path=/tmp/dbus-session" 2>/dev/null
export DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/dbus-session"
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Resolve Docker host gateway for CDP URL (zero hardcoded IPs)
HOST_GATEWAY=$(getent hosts host.docker.internal | awk '{print $1; exit}')
[ -n "$HOST_GATEWAY" ] && export CDP_URL="http://${HOST_GATEWAY}:9223"

# Wait for host Chrome CDP to be reachable (5 attempts, 3s apart)
echo "Checking Chrome CDP at ${CDP_URL}..."
for i in 1 2 3 4 5; do
  if curl -s "${HOST_GATEWAY}:9223/json/version" > /dev/null 2>&1; then
    echo "Chrome CDP reachable (attempt $i)"
    break
  fi
  echo "Chrome CDP not ready, retrying ($i/5)..."
  sleep 3
done

rm -rf /app/.openclaw/sandboxes

# Remove source extensions to silence duplicate-plugin warnings
rm -rf /app/extensions

# Remove empty default .openclaw dir to avoid split-state warnings
rm -rf /home/node/.openclaw

# Seed exec-approvals.json if not present (production manages this via bind-mount)
if [ ! -f /app/.openclaw/exec-approvals.json ]; then
  cat > /app/.openclaw/exec-approvals.json << 'APPROVALS'
{
  "version": 1,
  "socket": {
    "path": "/app/.openclaw/exec-approvals.sock"
  },
  "defaults": {
    "security": "allowlist",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "orchestrator": {
      "allowlist": [
        { "pattern": "curl" },
        { "pattern": "qpdf" },
        { "pattern": "pdftotext" },
        { "pattern": "echo" }
      ]
    },
    "thinker": {
      "allowlist": [
        { "pattern": "curl" },
        { "pattern": "qpdf" },
        { "pattern": "pdftotext" },
        { "pattern": "echo" }
      ]
    }
  }
}
APPROVALS
fi

exec tini -s -- node openclaw.mjs gateway
