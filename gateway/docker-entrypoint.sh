#!/bin/sh
# Generate AGENTS.md from template with env var substitution, then start OpenClaw
node -e "
const fs = require('fs');
let t = fs.readFileSync('/app/AGENTS.md.template', 'utf8');
for (const [k, v] of Object.entries(process.env)) {
  t = t.replaceAll('\$' + k, v || '');
}
fs.writeFileSync('/app/AGENTS.md', t);
console.log('AGENTS.md generated');
"
exec tini -s -- node openclaw.mjs gateway
