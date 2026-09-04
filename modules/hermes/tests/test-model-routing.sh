#!/bin/bash
# Contract test for durable Hermes model routing defaults.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../config.yaml"

python3 - "$CONFIG" <<'PY'
import sys
from pathlib import Path

import yaml

root = Path(sys.argv[1]).resolve().parents[2]
with open(sys.argv[1]) as f:
    config = yaml.safe_load(f)

router_provider = {
    "name": "Codex Router",
    "api": "http://codex-router:4100/v1",
    "api_key": "local",
    "transport": "chat_completions",
}
router_route = "custom:codex-router"
opencode_glm_fallback = {
    "provider": "opencode-go",
    "model": "glm-5.2",
}
deepseek_pro_fallback = {
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
}
mimo_fallback = {
    "provider": "opencode-zen",
    "model": "opencode/mimo-v2.5-free",
    "base_url": "https://opencode.ai/zen/v1"
}
deepseek_flash_fallback = {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
}
deepseek_vision_fallback = {
    "provider": "deepseek",
    "model": "deepseek-v4-flash-vision-exp",
}


def assert_provider(config, model, label):
    provider = config.get("providers", {}).get("codex-router", {})
    for key, value in router_provider.items():
        assert provider.get(key) == value, (
            f"{label}.providers.codex-router.{key}: expected {value!r}, got {provider.get(key)!r}"
        )
    assert provider.get("default_model") == model, (
        f"{label}.providers.codex-router.default_model: expected {model!r}, got {provider.get('default_model')!r}"
    )


def assert_route(route, model, label):
    assert route.get("provider") == router_route, (
        f"{label}.provider: expected {router_route!r}, got {route.get('provider')!r}"
    )
    assert route.get("model") == model, f"{label}.model: expected {model!r}, got {route.get('model')!r}"
    assert "base_url" not in route, f"{label} must use its named provider URL"
    assert "api_key" not in route, f"{label} must use its named provider API key"


assert_provider(config, "gpt-5.6-terra", "main")
assert config["model"].get("provider") == router_route
assert config["model"].get("default") == "gpt-5.6-terra"
assert "base_url" not in config["model"]
assert "api_key" not in config["model"]
assert config["agent"]["reasoning_effort"] == "medium"
assert config["fallback_providers"] == [opencode_glm_fallback, mimo_fallback, deepseek_flash_fallback], (
    "main fallback_providers must be opencode-go/glm-5.2, then opencode-zen/mimo-v2.5-free, then deepseek-v4-flash"
)
assert_route(config["delegation"], "gpt-5.6-luna", "delegation")

assert_route(config["auxiliary"]["vision"], "gpt-5.6-terra", "auxiliary.vision")
assert config["auxiliary"]["vision"].get("fallback_chain") == [opencode_glm_fallback, deepseek_vision_fallback], (
    "auxiliary.vision.fallback_chain must start with opencode-go/glm-5.2, then deepseek-v4-flash-vision-exp"
)

for task, model in {
    "web_extract": "gpt-5.6-luna",
    "compression": "gpt-5.6-luna",
    "approval": "gpt-5.6-terra",
    "triage_specifier": "gpt-5.6-luna",
    "profile_describer": "gpt-5.6-luna",
}.items():
    route = config["auxiliary"][task]
    assert_route(route, model, f"auxiliary.{task}")
    assert route.get("fallback_chain") == [opencode_glm_fallback, deepseek_flash_fallback], (
        f"auxiliary.{task}.fallback_chain must start with opencode-go/glm-5.2, then deepseek-v4-flash"
    )

assert config["kanban"]["default_assignee"] == "code-reviewer"
decomposer = config["auxiliary"]["kanban_decomposer"]
assert decomposer.get("provider") == "deepseek", (
    "auxiliary.kanban_decomposer.provider: expected 'deepseek' (direct API), got "
    f"{decomposer.get('provider')!r} — codex-router only exposes deepseek-v4-pro natively"
)
assert decomposer.get("model") == "deepseek-v4-flash", (
    f"auxiliary.kanban_decomposer.model: expected 'deepseek-v4-flash', got {decomposer.get('model')!r}"
)
assert "base_url" not in decomposer, "auxiliary.kanban_decomposer must use its named provider URL"
assert "api_key" not in decomposer, "auxiliary.kanban_decomposer must use its named provider API key"
assert "fallback_chain" not in decomposer, (
    "auxiliary.kanban_decomposer needs no fallback chain — decomposition retries on the next dispatch tick"
)

for profile, (model, fallback_model) in {
    "architect": ("gpt-5.6-sol", "deepseek-v4-pro"),
    "code-reviewer": ("glm-5.2", "deepseek-v4-pro"),
    "spec-auditor": ("gpt-5.6-terra", "deepseek-v4-pro"),
    "project-manager": ("gpt-5.6-luna", "deepseek-v4-flash"),
}.items():
    profile_config_path = root / "modules/hermes/profiles" / profile / "config.yaml"
    assert profile_config_path.is_file(), f"{profile} profile config is missing"
    with open(profile_config_path) as f:
        profile_config = yaml.safe_load(f)
    if profile != "code-reviewer":
        assert_provider(profile_config, model, profile)
    expected_provider = "opencode-go" if profile == "code-reviewer" else router_route
    assert profile_config["model"].get("provider") == expected_provider, (
        f"{profile}.model.provider: expected {expected_provider!r}, got {profile_config['model'].get('provider')!r}"
    )
    assert profile_config["model"].get("default") == model
    assert "base_url" not in profile_config["model"]
    assert "api_key" not in profile_config["model"]
    fallback = profile_config["fallback_providers"]
    if profile == "code-reviewer":
        assert len(fallback) >= 2, (
            f"{profile} fallback must have at least 2 entries (codex-router/terra + deepseek)"
        )
        assert fallback[0].get("provider") == "custom:codex-router", (
            f"{profile} first fallback must use custom:codex-router/terra"
        )
        assert fallback[0].get("model") == "gpt-5.6-terra", (
            f"{profile} first fallback model must be gpt-5.6-terra"
        )
        assert fallback[1].get("provider") == "deepseek"
        assert fallback[1].get("model") == fallback_model
    else:
        assert len(fallback) == 1
        assert fallback[0].get("provider") == "deepseek"
        assert fallback[0].get("model") == fallback_model, (
            f"{profile} fallback must use {fallback_model}, got {fallback[0].get('model')!r}"
        )
PY
