#!/bin/bash
# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

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
deepseek_pro_fallback = {
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
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
assert config["fallback_providers"] == [deepseek_pro_fallback], (
    "main fallback_providers must use deepseek-v4-pro — fallbacks fire rarely, "
    "so the main agent wants the strongest available net"
)
assert_route(config["delegation"], "gpt-5.6-luna", "delegation")

assert_route(config["auxiliary"]["vision"], "gpt-5.6-terra", "auxiliary.vision")
assert config["auxiliary"]["vision"].get("fallback_chain") == [deepseek_vision_fallback], (
    "auxiliary.vision.fallback_chain must use deepseek-v4-flash-vision-exp — "
    "deepseek-v4-pro and deepseek-v4-flash are text-only and reject image content"
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
    assert route.get("fallback_chain") == [deepseek_flash_fallback], (
        f"auxiliary.{task}.fallback_chain must directly use deepseek-v4-flash after LiteLLM exhaustion"
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
    "code-reviewer": ("gpt-5.6-terra", "deepseek-v4-pro"),
    "spec-auditor": ("gpt-5.6-terra", "deepseek-v4-pro"),
    "project-manager": ("gpt-5.6-luna", "deepseek-v4-flash"),
}.items():
    profile_config_path = root / "modules/hermes/profiles" / profile / "config.yaml"
    assert profile_config_path.is_file(), f"{profile} profile config is missing"
    with open(profile_config_path) as f:
        profile_config = yaml.safe_load(f)
    assert_provider(profile_config, model, profile)
    assert profile_config["model"].get("provider") == router_route
    assert profile_config["model"].get("default") == model
    assert "base_url" not in profile_config["model"]
    assert "api_key" not in profile_config["model"]
    fallback = profile_config["fallback_providers"]
    assert len(fallback) == 1
    assert fallback[0].get("provider") == "deepseek"
    assert fallback[0].get("model") == fallback_model, (
        f"{profile} fallback must use {fallback_model}, got {fallback[0].get('model')!r}"
    )
PY
