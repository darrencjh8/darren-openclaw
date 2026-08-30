# LiteLLM Account-Pool Fallback Rollout

## Goal

Route Hermes primary model calls through the Docker-hosted LiteLLM router while using ordered OpenAI subscription account pools. Use direct DeepSeek V4 Pro only after the relevant LiteLLM pool is exhausted or unavailable.

## Required routing

### Terra pool

```text
gpt-5.6-terra-3 -> gpt-5.6-terra-2 -> gpt-5.6-terra-1
```

Use for Hermes main chat, vision, approval, and the `code-reviewer` profile.

### Luna pool

```text
gpt-5.6-luna-3 -> gpt-5.6-luna-2 -> gpt-5.6-luna-1
```

Use for compression, delegation, triage specification, profile description, and the Project Manager profile.

### Sol

```text
gpt-5.6-sol-3
```

Use for the Architect profile. Its fallback is direct DeepSeek V4 Pro.

### Direct fallback

```text
deepseek-v4-pro
```

DeepSeek is the final direct fallback after the applicable LiteLLM route fails.

## Phase 1: codex-router

1. Inspect the router's generated LiteLLM configuration path.
2. Generate LiteLLM `router_settings.fallbacks` in descending account priority:
   - Terra-3 -> Terra-2 -> Terra-1
   - Luna-3 -> Luna-2 -> Luna-1
3. Keep account-specific models individually addressable.
4. Add regression tests for generated fallback configuration and ordering.
5. Validate generated configuration and test each pool through the router's OpenAI-compatible endpoint.

## Phase 2: darren-openclaw

1. Keep Hermes primary roles pointed at `http://codex-router:4100/v1`.
2. Keep exactly one direct DeepSeek V4 Pro fallback per primary/profile route; LiteLLM handles intra-pool fallback.
3. Configure each LiteLLM-backed auxiliary task's `fallback_chain` to direct DeepSeek V4 Pro after LiteLLM pool exhaustion, including compression.
4. Replace `static-analyst` with persistent `code-reviewer`; remove `qa-engineer` and `quality-assurance` from source and startup runtime state.
5. Keep `kanban.default_assignee` set to `code-reviewer`.
6. Keep generated `.codex/` metadata ignored.

## Verification

1. Router health endpoint succeeds.
2. Router model catalog includes all Terra/Luna account models.
3. Router tests prove ordered fallback configuration.
4. Hermes YAML and startup shell tests pass.
5. No direct production restart, rebuild, pull, Docker Compose command, or deployment is performed. Deployment occurs only through a reviewed PR and GitHub Actions.
