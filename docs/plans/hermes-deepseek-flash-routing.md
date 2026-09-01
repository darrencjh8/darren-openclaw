# Hermes DeepSeek Flash Routing Update

## Goal

Build on #369 ("switch fallback LLM model to deepseek-v4-flash"): keep
`deepseek-v4-flash` for the light auxiliary fallbacks, kanban decomposition, and the
Project Manager profile, but restore `deepseek-v4-pro` for the main agent and the
`architect`, `code-reviewer`, and `spec-auditor` profiles — the routes that do the
hardest work when the primary pool is down and where fallback frequency is too low
for price to matter. Also fix the two routing bugs #369 introduced: the vision
fallback points at a text-only model, and the kanban decomposer routes
`deepseek-v4-flash` through Codex Router, which does not expose it.

## Background

- #369 blanket-swapped every DeepSeek fallback from `deepseek-v4-pro` to
  `deepseek-v4-flash`. That is right for the light tiers and wrong for the
  high-stakes routes, and it left two broken routes (below).
- `deepseek-v4-pro` and `deepseek-v4-flash` are text-only. A vision fallback on
  either model rejects image content — vision has no working fallback today. This
  is a bug; the fix is `deepseek-v4-flash-vision-exp`.
- `deepseek-v4-flash-vision-exp` (released 2026-08-21) is the only image-capable
  DeepSeek API model and is priced in the Flash token class.
- `deepseek-v4-flash` (0731 checkpoint) is ~79% SWE-bench Verified at roughly one
  third of V4 Pro's price — sufficient for compression, approval, triage,
  profile description, kanban decomposition, and the Project Manager profile.
- Codex Router only exposes `deepseek-v4-pro` natively. #369 set
  `auxiliary.kanban_decomposer` to `custom:codex-router` / `deepseek-v4-flash`,
  which the router cannot serve — the decomposer is broken. It moves to the
  direct `deepseek` provider; nothing DeepSeek flows through codex-router.
- Hermes resolves `DEEPSEEK_API_KEY` automatically for the named `deepseek`
  provider, matching the existing top-level fallback pattern in `config.yaml`.
- Web extract remains a live auxiliary slot (per the Configuring Models docs; only
  the legacy `AUXILIARY_WEB_EXTRACT_*` env vars are obsolete). It keeps
  `gpt-5.6-luna` with a `deepseek-v4-flash` fallback — unchanged from #369.
- Delegation has no documented fallback mechanism; it stays
  `custom:codex-router` / `gpt-5.6-luna` with intra-pool fallback handled by the
  router.

## Routing after this change

| Role | Primary | Fallback |
| --- | --- | --- |
| Main agent | codex-router / `gpt-5.6-terra` (medium) | direct / `deepseek-v4-pro` |
| Delegation | codex-router / `gpt-5.6-luna` | none (not supported) |
| Vision | codex-router / `gpt-5.6-terra` | direct / `deepseek-v4-flash-vision-exp` |
| Web extract | codex-router / `gpt-5.6-luna` | direct / `deepseek-v4-flash` (unchanged) |
| Compression | codex-router / `gpt-5.6-luna` | direct / `deepseek-v4-flash` (unchanged) |
| Approval | codex-router / `gpt-5.6-terra` | direct / `deepseek-v4-flash` (unchanged) |
| Kanban decomposer | direct / `deepseek-v4-flash` | none — retries next 60s tick |
| Triage specifier | codex-router / `gpt-5.6-luna` | direct / `deepseek-v4-flash` (unchanged) |
| Profile describer | codex-router / `gpt-5.6-luna` | direct / `deepseek-v4-flash` (unchanged) |
| architect profile | codex-router / `gpt-5.6-sol` | direct / `deepseek-v4-pro` |
| code-reviewer profile | codex-router / `gpt-5.6-terra` | direct / `deepseek-v4-pro` |
| spec-auditor profile | codex-router / `gpt-5.6-terra` | direct / `deepseek-v4-pro` |
| project-manager profile | codex-router / `gpt-5.6-luna` | direct / `deepseek-v4-flash` (unchanged) |

## Files changed

1. `modules/hermes/config.yaml`
   - Top-level `fallback_providers` (main): `deepseek-v4-flash` → `deepseek-v4-pro`
   - `auxiliary.vision.fallback_chain`: `deepseek-v4-flash` →
     `deepseek-v4-flash-vision-exp` (text-only models reject image content)
   - `auxiliary.kanban_decomposer`: `custom:codex-router` → direct `deepseek`
     provider (router does not expose flash; model stays `deepseek-v4-flash`)
   - All other auxiliary blocks and `delegation`: unchanged from #369
2. `modules/hermes/profiles/architect/config.yaml`,
   `modules/hermes/profiles/code-reviewer/config.yaml`,
   `modules/hermes/profiles/spec-auditor/config.yaml`
   - `fallback_providers[0].model`: `deepseek-v4-flash` → `deepseek-v4-pro`
   - `project-manager` profile: unchanged (flash fallback is correct for its tier)
3. `modules/hermes/tests/test-model-routing.sh`
   - Split the fallback expectation into pro (main, architect, code-reviewer,
     spec-auditor) and flash (web_extract, compression, approval,
     triage_specifier, profile_describer, project-manager) variants
   - Expect `deepseek-v4-flash-vision-exp` for vision
   - Replace the router-route assertion for `kanban_decomposer` with a direct
     `deepseek` / `deepseek-v4-flash` assertion

Note: `50-seed-defaults` force-copies `config.yaml` and force-migrates the managed
profile routing fields (`providers`, `model`, `fallback_providers`) on every boot, so
all changes must land in the repo defaults — runtime edits under `/opt/data` do not
persist.

## Implementation order (TDD)

1. Update `test-model-routing.sh` first — it fails against current config.
2. Apply the config and profile changes above.
3. `test-model-routing.sh` passes; run the remaining `modules/hermes/tests/` suite
   for regressions.

## Validation

1. `modules/hermes/tests/test-model-routing.sh` green.
2. Full hermes test suite green.
3. Spec audit against this plan, then one independent fresh-context code review per
   round, two consecutive clean rounds (per repo dev-loop policy) before merge.

## Deployment

Push a `fix/` branch, open a pull request, wait for required GitHub Actions checks,
squash-merge. CI/CD owns deployment after merge — no direct production restart,
rebuild, pull, or Docker Compose commands.
