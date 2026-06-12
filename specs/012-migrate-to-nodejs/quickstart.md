# Quickstart: Migrate Python to Node.js

**Feature**: 012-migrate-to-nodejs

## Prerequisites

- Node.js 22+
- npm 10+
- Docker and Docker Compose
- Access to production `.env` files (gateway, expense-tracker, portfolio-tracker)

## Setup

```bash
cd modules/expense-tracker
npm install
cd ../portfolio-tracker
npm install
```

## Verification Scenarios

### 1. WASM Embeddings

```bash
cd modules/expense-tracker
node -e "
import('@xenova/transformers').then(async ({ pipeline }) => {
  const e = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  console.log('Model loaded:', e.model.config.model_type);
});
"
```

**Expected**: Loads once (downloads ~30MB model), prints model type. Subsequent runs use cache.

### 2. Memory Search

```bash
cd modules/expense-tracker
node -e "
import('./src/memory.js').then(async ({ MemoryStore }) => {
  const store = new MemoryStore('data/test-memory.md');
  await store.ready;
  const results = store.search('card 4605');
  console.log('Results:', results.length);
});
"
```

**Expected**: Returns 0 results if empty MEMORY.md, or matched facts if seeded.

### 3. DeepSeek Thinking (Adaptive)

```bash
cd modules/expense-tracker
node -e "
import('openai').then(async ({ default: OpenAI }) => {
  const c = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' });
  const r = await c.chat.completions.create({
    model: 'deepseek-chat', messages: [{ role: 'user', content: 'Say hello in one word.' }], max_tokens: 10
  }, { body: { thinking: { type: 'adaptive' } } });
  console.log('Response:', r.choices[0].message.content);
});
"
```

**Expected**: Returns "Hello" (or similar). No API error about unknown thinking type.

### 4. Docker Build (Cold)

```bash
cd gateway
docker compose build --no-cache expense-tracker
time docker compose build --no-cache expense-tracker
```

**Expected**: Under 2 minutes wall-clock time.

### 5. Docker Build (Cached)

```bash
cd gateway
docker compose build expense-tracker
time docker compose build expense-tracker
```

**Expected**: Under 10 seconds.

### 6. HTTP Endpoint Smoke Test

```bash
docker compose up -d expense-tracker
curl -X POST http://localhost:8080/tools/search-memory \
  -H "Content-Type: application/json" \
  -d '{"query": "DBS Yuu"}'
```

**Expected**: `{"results": []}` on cold start, or learned facts if MEMORY.md is seeded.

### 7. Portfolio Tracker Java Bridge

```bash
cd modules/portfolio-tracker
node -e "
const { execFile } = require('child_process');
execFile('java', ['-version'], (err, stdout, stderr) => {
  console.log('Java available:', !!stdout || !!stderr);
});
"
```

**Expected**: Prints Java version info.

### 8. All Tests Pass

```bash
cd modules/expense-tracker && npm test
cd ../portfolio-tracker && npm test
```

**Expected**: All ported tests pass (matching Python test count).

### 9. Zero Python Remaining

```bash
find . -name "*.py" -not -path "./.venv/*" -not -path "./node_modules/*" | wc -l
```

**Expected**: `0` (after migration cleanup).

### 10. OpenClaw Config Validation

```bash
cd gateway
# Verify thinkingDefault: "adaptive" is in openclaw.json
grep -A2 '"id": "orchestrator"' openclaw.json | grep thinkingDefault
```

**Expected**: `"thinkingDefault": "adaptive"`
