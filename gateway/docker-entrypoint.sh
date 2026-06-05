#!/bin/sh
# Generate AGENTS.md from template with env var substitution, then start OpenClaw
node -e "
const fs = require('fs');
let t = fs.readFileSync('/app/AGENTS.md.template', 'utf8');
const vars = Object.keys(process.env).filter(k => !k.includes('PATH') && !k.includes('HOME') && !k.includes('SHLVL') && !k.includes('PWD'));
vars.sort((a, b) => b.length - a.length);
for (const k of vars) {
  const re = new RegExp('\\\\\\$' + k + '(?![a-zA-Z0-9_])', 'g');
  t = t.replace(re, process.env[k] || '');
}
fs.writeFileSync('/app/AGENTS.md', t);
console.log('AGENTS.md generated');
"
exec tini -s -- node openclaw.mjs gateway
