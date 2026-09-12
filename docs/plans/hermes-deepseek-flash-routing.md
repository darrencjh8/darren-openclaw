# Hermes DeepSeek Flash Routing

## Status: superseded

This plan proposed splitting DeepSeek fallbacks across tiered model names (a pro tier
for the hard routes, a flash tier for the light ones, and a separate vision model).
That split is retired. Every DeepSeek route in Hermes now uses the single canonical
model id `deepseek-flash`, and the separate vision pin is gone because the current
model is natively multimodal. See darrencjh8/darren-openclaw#428.

## Routing today

| Role | Primary | Fallback |
| --- | --- | --- |
| Main agent | codex-router / `auto-thinking` (reasoning low) | direct / `deepseek-flash` |
| Delegation | codex-router / `auto-thinking` | none (not supported) |
| Vision | direct / `deepseek-flash` | none — terminal direct route; the model is natively multimodal |
| Web extract | codex-router / `gpt-5.6-luna` | direct / `deepseek-flash` |
| Compression | codex-router / `gpt-5.6-luna` | direct / `deepseek-flash` |
| Approval | codex-router / `gpt-5.6-terra` | direct / `deepseek-flash` |
| Kanban decomposer | direct / `deepseek-flash` | none — retries next 60s tick |
| Triage specifier | codex-router / `gpt-5.6-luna` | direct / `deepseek-flash` |
| Profile describer | codex-router / `gpt-5.6-luna` | direct / `deepseek-flash` |
| architect profile | codex-router / `gpt-5.6-sol` | direct / `deepseek-flash` |
| code-reviewer profile | codex-router / `auto-thinking` | none — fails closed |
| spec-auditor profile | codex-router / `gpt-5.6-terra` | direct / `deepseek-flash` |
| project-manager profile | codex-router / `gpt-5.6-luna` | direct / `deepseek-flash` |

Hermes resolves `DEEPSEEK_API_KEY` automatically for the named `deepseek` provider,
which serves the direct routes (`vision` and `kanban_decomposer`). No Hermes DeepSeek
*fallback* traffic flows through codex-router; codex-router still hops to DeepSeek
itself inside the `auto-thinking` pool.

## Notes

- Codex Router exposes `deepseek-flash` as its only native DeepSeek route, and the
  `auto-thinking` pool uses the same id for its DeepSeek hop. That route is reachable
  only over the Responses transport, so `deepseek-flash` is deliberately absent from
  the OpenCode Chat Completions catalog in `modules/hermes/opencode/opencode.json`.
- `50-seed-defaults` reseeds every config key the baked `config.yaml` defines and
  force-migrates the managed profile routing fields (`providers`, `model`,
  `fallback_providers`) on every boot, so all routing changes must land in the repo
  defaults — runtime edits to those keys under `/opt/data` do not persist. A top-level
  key the baked config does not define (for example the codex-router `hooks:`) is
  preserved across the reseed.
- Deployment is a reviewed pull request followed by GitHub Actions. CI/CD owns the
  rollout; never restart, rebuild, pull, or run Docker Compose on production.
