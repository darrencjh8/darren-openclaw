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

router = {
    "provider": "custom",
    "base_url": "http://codex-router:4100/v1",
    "api_key": "local",
}
deepseek_fallback = {
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
}


def assert_route(route, model, label):
    for key, value in router.items():
        assert route.get(key) == value, f"{label}.{key}: expected {value!r}, got {route.get(key)!r}"
    assert route.get("model") == model, f"{label}.model: expected {model!r}, got {route.get('model')!r}"


for key, value in router.items():
    assert config["model"].get(key) == value, f"model.{key}: expected {value!r}, got {config['model'].get(key)!r}"
assert config["model"].get("default") == "gpt-5.6-terra-3"
assert config["agent"]["reasoning_effort"] == "medium"
assert config["fallback_providers"] == [deepseek_fallback]
assert_route(config["delegation"], "gpt-5.6-luna-3", "delegation")

for task, model in {
    "vision": "gpt-5.6-terra-3",
    "web_extract": "gpt-5.6-luna-3",
    "compression": "gpt-5.6-luna-3",
    "approval": "gpt-5.6-terra-3",
    "triage_specifier": "gpt-5.6-luna-3",
    "profile_describer": "gpt-5.6-luna-3",
}.items():
    route = config["auxiliary"][task]
    assert_route(route, model, f"auxiliary.{task}")
    assert route.get("fallback_chain") == [deepseek_fallback], (
        f"auxiliary.{task}.fallback_chain must directly use deepseek-v4-pro after LiteLLM exhaustion"
    )

assert config["kanban"]["default_assignee"] == "code-reviewer"

for profile, model in {
    "architect": "gpt-5.6-sol-3",
    "code-reviewer": "gpt-5.6-terra-3",
    "project-manager": "gpt-5.6-luna-3",
}.items():
    with open(root / "modules/hermes/profiles" / profile / "config.yaml") as f:
        profile_config = yaml.safe_load(f)
    for key, value in router.items():
        assert profile_config["model"].get(key) == value, (
            f"{profile}.model.{key}: expected {value!r}, got {profile_config['model'].get(key)!r}"
        )
    assert profile_config["model"].get("default") == model
    fallback = profile_config["fallback_providers"]
    assert len(fallback) == 1
    assert fallback[0].get("provider") == "deepseek"
    assert fallback[0].get("model") == "deepseek-v4-pro"
PY
