# Plan: Gateway Memory & Session Stability Fixes

## Architecture Overview

All fixes are **configuration-only** — no custom code, no forked plugins, no new services. Two files are modified:

| File | Role | Location |
|------|------|----------|
| `gateway/openclaw.json` | Gateway config (models, providers, agents, sessions, plugins) | Dev: `~/darren-openclaw/gateway/` → Container: `/app/openclaw.json` (ro) |
| `gateway/.env` | Secrets and environment variables | Dev + Production: `~/darren-openclaw/gateway/.env` |

## Fix #1: Memory Embedding Provider — Use Gemini Instead of OpenAI

### Current state
```
Error: No API key found for provider "openai"
Auth store: /app/.openclaw/agents/default/agent/auth-profiles.json
```

The `memory-core` plugin tries providers in this auto-selection order:
1. `local` — local ONNX model (requires model download, ~200MB)
2. `openai` — Fails: no `OPENAI_API_KEY` in `.env` ❌
3. `gemini` — Works: `GEMINI_API_KEY` already in `.env` ✅ (but never reached because OpenAI check fails first)
4. `voyage` / `mistral` — Not configured

In the current `openclaw.json`, only two providers are defined in `models.providers`:
- `deepseek` — chat-only, no embedding API
- `google` — chat + embedding (Gemini `text-embedding-004`)

DeepSeek does not offer an embeddings API and cannot be used for memory search.

### Fix

Set `agents.defaults.memorySearch.provider` to `"gemini"` so OpenClaw skips the auto-selection and goes directly to the Gemini embedding API using the existing `GEMINI_API_KEY`.

**Config to add to `openclaw.json`:**
```json
"agents": {
  "defaults": {
    "memorySearch": {
      "provider": "gemini"
    }
  }
}
```

OpenClaw resolves the Gemini key automatically from:
- `models.providers.google.apiKey` in `openclaw.json` (already set to `${GEMINI_API_KEY}`)
- or `GEMINI_API_KEY` environment variable (already in `.env`)

Gemini's `text-embedding-004` model produces 768-dimension embeddings and is free-tier friendly.

### Alternative

Use `"provider": "local"` for zero-dependency ONNX embeddings. This requires downloading a ~200MB model file on first run, uses more CPU but has no API cost.

## Fix #2: Session Size / Force-Reset Prevention

### Current state

Session `8a79e918` was force-reset at 06:03 because trajectory file reached ~5.1MB. After reset, a fresh session `bef8c2cc` started — all conversation history and context was lost.

The root cause: OpenClaw's default compaction settings are conservative. When the model's context window fills (DeepSeek V4 Flash: ~128K tokens), and compaction hasn't triggered in time, the gateway force-resets the session.

### Fix

Add `agents.defaults.compaction` config to trigger auto-compaction earlier, leaving more headroom:

```json
"agents": {
  "defaults": {
    "compaction": {
      "reserveTokens": 40000,
      "reserveTokensFloor": 20000,
      "memoryFlush": {
        "enabled": true,
        "softThresholdTokens": 4000
      }
    }
  }
}
```

| Parameter | Default | New Value | Effect |
|-----------|---------|-----------|--------|
| `reserveTokens` | ~16384 | 40000 | Leaves 40K tokens free for model responses, triggers compaction sooner |
| `reserveTokensFloor` | — | 20000 | Absolute floor — never eat into these 20K tokens |
| `memoryFlush.softThresholdTokens` | — | 4000 | When 4K tokens from threshold, ping model to write durable memory before compaction |

The `memoryFlush` setting is critical: it triggers a silent ("NO_REPLY") model turn to write important facts to `MEMORY.md` before context is compacted. Without this, bot forgets even within the same session after compaction.

### Session Maintenance

OpenClaw already has session maintenance controls with sensible defaults:
- `session.maintenance.rotateBytes`: 10MB (default)
- `session.maintenance.maxEntries`: 500 (default)
- `session.maintenance.pruneAfter`: 30d (default)

No change needed here — these are file-rotation controls for `sessions.json`, separate from the context-window issue.

## Fix #3: SKILL.md Mount Path (Verify)

### Current docker-compose.yml mount
```yaml
volumes:
  - ./workspace/SKILL.md:/app/.openclaw/workspace/SKILL.md:ro
```

The file exists on the host at `~/darren-openclaw/gateway/workspace/SKILL.md` (verified, ~2KB). The mount is in the compose file. The daily report error at 11:33 may be from an earlier container version or from within a sandboxed sub-agent that had a different workspace path.

### Action
Verify the mount works in the running container. If the error persists, check for path resolution differences between the `default` agent and any sub-agents.

## Fix #4: Sync .env Between Dev and Production

Per workspace rule: `.env` must be identical between dev and production before deploying. Both currently contain the same values (verified via SSH).

No changes needed unless secrets are modified.

## Deployment Strategy

1. Edit `gateway/openclaw.json` locally with the config changes
2. SSH to production, run `nohup docker compose build --no-cache openclaw` in background
3. After build completes, run `docker compose up -d openclaw`
4. Verify logs: no `sync failed` errors, memory search operational
5. Test: send a message to @AgentRhodeyBot, ask it to recall a known fact

## Rollback Plan

To revert, restore the previous `openclaw.json` (keep a `.bak` copy), rebuild, and redeploy. The memory search feature will simply disable itself (no crash), and sessions will use default compaction behavior.
