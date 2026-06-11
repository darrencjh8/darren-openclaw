# Spec: Gateway Memory & Session Stability Fixes

**Feature:** `gateway-memory-fixes`
**Date:** 2026-06-09
**Trigger:** Daily report from gateway-openclaw-1 observed 6 production issues

## Problem Summary

The gateway-openclaw-1 Telegram bot (@AgentRhodeyBot) suffers from three cascading problems:

1. **No long-term memory** — `memory-core` plugin defaults to OpenAI for embeddings, but no `OPENAI_API_KEY` exists. Memory sync fails silently on every attempt. The bot has zero recall across sessions.
2. **Session force-resets** — Trajectory files grow until they hit context-window limits (~5.1MB), at which point OpenClaw force-resets the session, destroying all conversation history.
3. **Bot repeats itself** — Consequence of #1 + #2. The bot asked "Is UOB ending 4605 Ladies or One?" three separate times because it can't remember earlier exchanges.

Three additional low-impact issues also surfaced:
4. Empty edit request (model hallucination — hard to fix)
5. Missing SKILL.md mount (possible stale error)
6. WebSocket session errors (transient, low priority)

## User Stories

### US-1: Memory recall works across sessions
**As** a Telegram user talking to @AgentRhodeyBot
**I want** the bot to remember my preferences, past decisions, and facts (like which UOB card is which)
**So that** I don't have to repeat myself across sessions.

**Acceptance criteria:**
- `memory_search` tool returns results from `MEMORY.md` and `memory/*.md`
- Memory sync completes without `No API key found for provider "openai"` errors
- After a session restart, the bot recalls user preferences from prior sessions
- No new API keys required — uses existing `GEMINI_API_KEY` or local ONNX embeddings

### US-2: Sessions don't force-reset mid-conversation
**As** a Telegram user having a long conversation
**I want** the bot to compact conversation context instead of resetting and losing everything
**So that** I don't have to re-explain context that was established earlier.

**Acceptance criteria:**
- Session trajectories don't force-reset; they auto-compact instead
- After compaction, the bot retains a summary of prior conversation context
- `openclaw.json` has `agents.defaults.compaction` configuration

### US-3: User doesn't see the same question repeated
**As** a Telegram user
**I want** the bot to know what it asked me before
**So that** I don't get frustrated by the bot asking me the same thing three times.

**Acceptance criteria:**
- Satisfied by US-1 + US-2 working correctly
- No duplicate questions within the same session or across sessions

## Non-Functional Requirements

- No new API key or external service dependency
- Config-only changes — no custom code or forked plugins
- Must survive `docker compose down && docker compose up` cycles
- `.env` must stay in sync between dev and production

## Out of Scope

- Fixing model hallucination bugs (empty edit requests)
- WebSocket connection robustness
- Adding OpenAI support
