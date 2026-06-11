#!/bin/sh
# Generate prompt files from templates with env var substitution, then start OpenClaw
WS=/app/.openclaw/workspace
mkdir -p "$WS"

node -e "
const fs = require('fs');
const files = ['AGENTS', 'SOUL', 'USER', 'IDENTITY'];
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

rm -rf /app/.openclaw/sandboxes

# Start notify webhook sidecar for portfolio-tracker notifications
nohup python3 /app/notify-webhook.py > /dev/null 2>&1 &

exec tini -s -- node openclaw.mjs gateway
