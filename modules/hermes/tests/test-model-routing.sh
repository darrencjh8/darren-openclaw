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
deepseek_fallback = {
    "provider": "deepseek",
    "model": "deepseek-flash",
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


assert_provider(config, "auto-thinking", "main")
assert config["model"].get("provider") == router_route
assert config["model"].get("default") == "auto-thinking"
assert "base_url" not in config["model"]
assert "api_key" not in config["model"]
assert config["agent"]["reasoning_effort"] == "low"
assert config["compression"]["threshold_tokens"] == 300000, (
    f"compression.threshold_tokens: expected 300000, got {config['compression'].get('threshold_tokens')!r}"
)
assert config["compression"]["threshold"] == 0.50, (
    f"compression.threshold: expected 0.50, got {config['compression'].get('threshold')!r}"
)
assert config["compression"]["enabled"] is True, (
    f"compression.enabled: expected True, got {config['compression'].get('enabled')!r}"
)
assert config["fallback_providers"] == [deepseek_fallback], (
    "main fallback_providers must be deepseek-flash"
)
assert_route(config["delegation"], "auto-thinking", "delegation")

vision = config["auxiliary"]["vision"]
assert vision.get("provider") == "deepseek", (
    "auxiliary.vision.provider: expected 'deepseek' (direct API), got "
    f"{vision.get('provider')!r}"
)
assert vision.get("model") == "deepseek-flash", (
    f"auxiliary.vision.model: expected 'deepseek-flash', got {vision.get('model')!r}"
)
assert "fallback_chain" not in vision, (
    "auxiliary.vision needs no fallback chain — deepseek-flash is natively multimodal"
)
assert "base_url" not in vision, "auxiliary.vision must use its named provider URL"
assert "api_key" not in vision, "auxiliary.vision must use its named provider API key"

for task, model in {
    "web_extract": "gpt-5.6-luna",
    "compression": "gpt-5.6-luna",
    "approval": "gpt-5.6-terra",
    "triage_specifier": "gpt-5.6-luna",
    "profile_describer": "gpt-5.6-luna",
}.items():
    route = config["auxiliary"][task]
    assert_route(route, model, f"auxiliary.{task}")
    assert route.get("fallback_chain") == [deepseek_fallback], (
        f"auxiliary.{task}.fallback_chain must use deepseek-flash"
    )

assert config["kanban"]["default_assignee"] == "code-reviewer"
decomposer = config["auxiliary"]["kanban_decomposer"]
assert decomposer.get("provider") == "deepseek", (
    "auxiliary.kanban_decomposer.provider: expected 'deepseek' (direct API), got "
    f"{decomposer.get('provider')!r}"
)
assert decomposer.get("model") == "deepseek-flash", (
    f"auxiliary.kanban_decomposer.model: expected 'deepseek-flash', got {decomposer.get('model')!r}"
)
assert "base_url" not in decomposer, "auxiliary.kanban_decomposer must use its named provider URL"
assert "api_key" not in decomposer, "auxiliary.kanban_decomposer must use its named provider API key"
assert "fallback_chain" not in decomposer, (
    "auxiliary.kanban_decomposer needs no fallback chain — decomposition retries on the next dispatch tick"
)

for profile, (model, fallback_model) in {
    "architect": ("gpt-5.6-sol", "deepseek-flash"),
    "code-reviewer": ("auto-thinking", None),
    "spec-auditor": ("gpt-5.6-terra", "deepseek-flash"),
    "project-manager": ("gpt-5.6-luna", "deepseek-flash"),
}.items():
    profile_config_path = root / "modules/hermes/profiles" / profile / "config.yaml"
    assert profile_config_path.is_file(), f"{profile} profile config is missing"
    with open(profile_config_path) as f:
        profile_config = yaml.safe_load(f)
    assert_provider(profile_config, model, profile)
    expected_provider = router_route
    assert profile_config["model"].get("provider") == expected_provider, (
        f"{profile}.model.provider: expected {expected_provider!r}, got {profile_config['model'].get('provider')!r}"
    )
    assert profile_config["model"].get("default") == model
    assert "base_url" not in profile_config["model"]
    assert "api_key" not in profile_config["model"]
    fallback = profile_config["fallback_providers"]
    if profile == "code-reviewer":
        assert fallback == [], "code-reviewer must fail closed instead of switching review tiers"
        assert profile_config["memory"]["memory_enabled"] is False, (
            "code-reviewer memory must be disabled so every review has a fresh context"
        )
    else:
        assert len(fallback) == 1
        assert fallback[0].get("provider") == "deepseek"
        assert fallback[0].get("model") == fallback_model, (
            f"{profile} fallback must use {fallback_model}, got {fallback[0].get('model')!r}"
        )
PY
