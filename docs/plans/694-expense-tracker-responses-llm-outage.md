QUESTIONS
q: Does the live router still accept Chat Completions for auto-thinking? | a: No. A live probe returned 400 unsupported_endpoint_for_model; it is served on /v1/responses only (codex-router-opencode router/surfaces.py SHIM_SURFACES).
q: Does direct DeepSeek (final fallback) support Responses? | assumption: No; api.deepseek.com/v1 stays on chat.completions, so only non-deepseek routes move to Responses.
q: Is portfolio-tracker affected too? | a: Yes, modules/portfolio-tracker/src/orchestrator.js:37 uses chat.completions. Out of scope here; a follow-up issue is filed.
q: What about uid 1069 already in the 12h cooldown? | assumption: After the CI deploy, the operator deletes that single processed_uids row (or waits for the cooldown to end at about 09:32 UTC); no production edit is made by this change.
q: Should an LLM outage notify the user on every retry? | assumption: No. One notice per uid per process run; later retries log only.

# Plan: expense-tracker LLM client on Responses, retryable LLM outage (#694)

Tracking issue: #694. Kind: bug.

## Root causes
1. `LLMClient.chat` and `classify.js` call `chat.completions.create` against `auto-thinking`, which the router now serves on Responses only (400 on every call).
2. `_runPhase1` turns every provider error into `null`, reported as "Couldn't understand".
3. `imap.js` calls `recordProcessed(uid)` for every callback result, so an unread email enters the 12h `RETRY_COOLDOWN_MINUTES` (#592) after an outage and cannot recover.
4. The retired `gpt-5.6-terra` fallback is still the default (`config.js`, `docker-compose.yml`, `deploy.yml`), and `chat()` keeps only the last route's error.

## Change
- `src/llm-responses.js` (new, small): `toResponsesInput(messages)`, `toResponsesTools(tools, toolChoice)`, `fromResponses(response)` mapping to and from the chat-completion shape the orchestrator already consumes, so no caller changes.
- `orchestrator.js` `LLMClient.chat`: routes with `provider !== "deepseek"` call `client.responses.create` (`reasoning: { effort }`, no temperature); the DeepSeek route is unchanged. Failed routes are collected and thrown as one error naming each route and model. `classify.js` uses the same helpers.
- `_runPhase1` rethrows a provider failure as `LLMUnavailableError`; `_processEmailInternal` catches it, notifies once per uid per process, and returns `{ action: "llm_unavailable" }`. Validation failures still return `null`.
- `dedup.js` `recordProcessed(uid, retryAfterMinutes)` back-dates the row so the existing cooldown ends after `retryAfterMinutes`; `imap.js` passes 5 for `llm_unavailable` and never marks the message read or booked.
- Config: `LLM_FALLBACK_MODEL` defaults to empty (route skipped); drop `gpt-5.6-terra` from `docker-compose.yml` and `deploy.yml`.
- Docs: `README.md` diagram label and `docs/architecture.md` state the expense tracker uses Responses to the router; `modules/expense-tracker/docs/design.md` LLM section.

## Tests
`tests/llm-responses-outage-694.test.js` (already written, RED at base): Responses transport, tool mapping, DeepSeek fallback stays on chat, terra default removed, aggregated errors, `llm_unavailable` result, short retry cooldown, IMAP loop uses it. `tests/gpt56-router-contract.test.js` is updated to the Responses transport. Run in a throwaway `node:22-slim` container.

## Not in scope
portfolio-tracker (follow-up issue), router changes, any production edit.
