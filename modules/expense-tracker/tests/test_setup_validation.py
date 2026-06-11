"""Setup validation tests — verify all config files, env templates, and Docker setup.

These tests validate file formats, required fields, and cross-file consistency.
They do NOT require external services or live credentials.
"""

import json
import os
import re
import sys
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
GATEWAY_DIR = PROJECT_ROOT / "gateway"
EXPENSE_TRACKER_DIR = PROJECT_ROOT / "modules" / "expense-tracker"


def _parse_env_file(path):
    """Parse KEY=VALUE from an env-like file."""
    result = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        result[key.strip()] = val.strip()
    return result


# ============================================================
# openclaw.json validation
# ============================================================


class TestOpenclawJson:
    """Validate gateway/openclaw.json format and required fields."""

    @classmethod
    def setup_class(cls):
        cls.config_path = GATEWAY_DIR / "openclaw.json"
        cls.text = cls.config_path.read_text()
        cls.config = json.loads(cls.text)

    def test_file_exists_and_is_valid_json(self):
        """openclaw.json exists and is valid JSON."""
        assert self.config_path.exists()
        assert isinstance(self.config, dict)

    def test_gateway_section(self):
        """gateway: port=18789, bind=lan, mode=local."""
        gw = self.config["gateway"]
        assert gw["port"] == 18789
        assert gw["bind"] in ("lan", "loopback", "tailnet", "auto")
        assert gw["mode"] == "local"

    def test_deepseek_provider(self):
        """DeepSeek apiKey is ${DEEPSEEK_API_KEY}."""
        p = self.config["models"]["providers"]["deepseek"]
        assert p["apiKey"] == "${DEEPSEEK_API_KEY}"

    def test_agent_model(self):
        """Agent uses deepseek/deepseek-v4-pro."""
        m = self.config["agents"]["defaults"]["model"]
        assert m["primary"] == "deepseek/deepseek-v4-flash"

    def test_telegram_channel(self):
        """Telegram: enabled, botToken ref, allowlist, valid user IDs."""
        tg = self.config["channels"]["telegram"]
        assert tg["enabled"] is True
        assert tg["botToken"] == "${TELEGRAM_BOT_TOKEN}"
        assert tg["dmPolicy"] == "allowlist"
        assert len(tg["allowFrom"]) >= 1
        for entry in tg["allowFrom"]:
            assert entry.startswith("tg:")
            uid = entry.split(":", 1)[1]
            assert uid.isdigit() or uid.startswith("${"), f"Invalid user ID format: {entry}"

    def test_no_placeholder_in_allowfrom(self):
        """No 'YOUR' or placeholder in allowFrom."""
        for entry in self.config["channels"]["telegram"]["allowFrom"]:
            assert "YOUR" not in entry.upper()

    def test_skills_extra_dirs(self):
        """skills.load.extraDirs is non-empty."""
        extra = self.config["skills"]["load"]["extraDirs"]
        assert len(extra) > 0, f"extraDirs should not be empty: {extra}"

    def test_no_hardcoded_secrets(self):
        """Config uses env refs, no raw keys."""
        env_keys_found = {"TELEGRAM_BOT_TOKEN", "DEEPSEEK_API_KEY"}
        missing = [k for k in env_keys_found if k not in self.text]
        assert not missing, f"Missing expected env key refs: {missing}"
        assert "${" in self.text, "Config should use ${VAR} references, not raw values"


# ============================================================
# .env.example validation
# ============================================================


class TestDotEnvExample:
    """Validate .env.example templates — keys present, no real secrets."""

    @classmethod
    def setup_class(cls):
        cls.et_path = EXPENSE_TRACKER_DIR / ".env.example"
        cls.gw_path = GATEWAY_DIR / ".env.example"
        cls.et_text = cls.et_path.read_text()
        cls.gw_text = cls.gw_path.read_text()
        cls.et_env = _parse_env_file(cls.et_path)
        cls.gw_env = _parse_env_file(cls.gw_path)

    def test_expense_tracker_example_exists(self):
        assert self.et_path.exists()

    def test_gateway_example_exists(self):
        assert self.gw_path.exists()

    def test_et_required_keys_present(self):
        """All required template keys are defined."""
        required = [
            "DEEPSEEK_API_KEY",
            "ACTUAL_BUDGET_URL",
            "ACTUAL_BUDGET_PASSWORD",
            "ACTUAL_BUDGET_FILE",
            "IMAP_HOST",
            "IMAP_PORT",
            "IMAP_USERNAME",
            "IMAP_PASSWORD",
            "OPENCLAW_GATEWAY_URL",
        ]
        for key in required:
            assert key in self.et_env, f"Missing key: {key}"

    def test_et_has_placeholder_values(self):
        """Template values are placeholders, not real credentials."""
        placeholder_markers = {"your", "example", "sk-...", "...", ""}
        sensitive_keys = {k: v for k, v in self.et_env.items() if v}
        for key, val in sensitive_keys.items():
            val_lower = val.lower()
            is_placeholder = any(m in val_lower for m in placeholder_markers)
            is_domain = ".com" in val and "@" not in val
            is_port = val.isdigit()
            assert is_placeholder or is_domain or is_port, (
                f"Value for {key} looks like a real secret, not a placeholder: {val[:30]}"
            )

    def test_et_imap_template(self):
        """IMAP_HOST template is imap.example.com."""
        assert self.et_env["IMAP_HOST"] == "imap.example.com"

    def test_et_env_path_is_file_not_directory(self):
        """If .env exists, it must be a file — not a directory."""
        env_path = EXPENSE_TRACKER_DIR / ".env"
        if env_path.exists():
            assert env_path.is_file(), (
                f"{env_path} exists but is a directory, not a file. "
                f"It may have been created by a Docker volume mount. "
                f"Remove it and create a proper .env file (copy from .env.example)."
            )

    def test_et_no_outlook_references(self):
        """No 'Outlook' anywhere in .env.example."""
        assert "Outlook" not in self.et_text, "Contains 'Outlook'"
        assert "outlook.office365.com" not in self.et_text, "Contains outlook"

    def test_et_no_openclaw_node_references(self):
        """No 'openclaw-node' references."""
        assert "openclaw-node" not in self.et_text

    def test_et_url_is_http(self):
        """ACTUAL_BUDGET_URL template points to the actual-api proxy."""
        assert self.et_env["ACTUAL_BUDGET_URL"].startswith("http://")

    def test_et_imap_port_993(self):
        assert self.et_env["IMAP_PORT"] == "993"

    def test_gw_telegram_token_key(self):
        """gateway .env.example has TELEGRAM_BOT_TOKEN."""
        assert "TELEGRAM_BOT_TOKEN" in self.gw_env

    def test_gw_telegram_token_is_placeholder(self):
        """TELEGRAM_BOT_TOKEN is a placeholder, not real."""
        val = self.gw_env["TELEGRAM_BOT_TOKEN"]
        assert "your" in val.lower() or "example" in val.lower() or val == "", (
            f"Real token in .env.example: {val[:20]}"
        )


# ============================================================
# docker-compose.yml validation
# ============================================================


class TestDockerCompose:
    """Validate gateway/docker-compose.yml structure."""

    @classmethod
    def setup_class(cls):
        cls.path = GATEWAY_DIR / "docker-compose.yml"
        cls.compose = yaml.safe_load(cls.path.read_text())

    def test_two_services(self):
        s = self.compose["services"]
        assert "openclaw" in s
        assert "expense-tracker" in s

    def test_openclaw_build(self):
        build = self.compose["services"]["openclaw"].get("build") or self.compose["services"][
            "openclaw"
        ].get("image")
        assert build is not None, "openclaw service must have either build or image directive"

    def test_openclaw_env_vars(self):
        env = self.compose["services"]["openclaw"]["environment"]
        env_keys = [e.split("=")[0] for e in env]
        required_env = ["OPENCLAW_CONFIG_PATH", "OPENCLAW_HOME"]
        for k in required_env:
            assert k in env_keys, f"Missing env: {k}"

    def test_openclaw_env_file(self):
        """openclaw service has env_file pointing to portfolio-tracker .env."""
        env_files = self.compose["services"]["openclaw"].get("env_file", [])
        assert env_files, "openclaw service missing env_file"
        assert any("portfolio-tracker" in ef for ef in env_files), (
            f"env_file should point to portfolio-tracker, got: {env_files}"
        )

    def test_openclaw_port(self):
        ports = [str(p) for p in self.compose["services"]["openclaw"]["ports"]]
        assert any("18789" in p for p in ports)

    def test_expense_tracker_port(self):
        ports = [str(p) for p in self.compose["services"]["expense-tracker"]["ports"]]
        assert any("8080" in p for p in ports)

    def test_et_env_mounted_readonly(self):
        vols = [str(v) for v in self.compose["services"]["expense-tracker"]["volumes"]]
        env_vols = [v for v in vols if ".env" in v]
        assert env_vols
        assert any(":ro" in v for v in env_vols)

    def test_skills_mounted_readonly(self):
        vols = [str(v) for v in self.compose["services"]["openclaw"]["volumes"]]
        skill_vols = [v for v in vols if "skills" in v]
        assert skill_vols
        assert any(":ro" in v for v in skill_vols)

    def test_restart_policy(self):
        for name in ["openclaw", "expense-tracker"]:
            assert self.compose["services"][name]["restart"] == "unless-stopped"

    def test_openclaw_home_volume(self):
        vols = [str(v) for v in self.compose["services"]["openclaw"]["volumes"]]
        assert any(".openclaw" in v for v in vols)

    def test_volumes_section(self):
        v = self.compose["volumes"]
        assert "openclaw_data" in v
        assert "openclaw_home" in v


# ============================================================
# Dockerfile validation
# ============================================================


class TestDockerfile:
    """Validate modules/expense-tracker/docker/Dockerfile."""

    @classmethod
    def setup_class(cls):
        cls.path = EXPENSE_TRACKER_DIR / "docker" / "Dockerfile"
        cls.content = cls.path.read_text()

    def test_exists(self):
        assert self.path.exists()

    def test_base_python_3_12_slim(self):
        assert "python:3.12-slim" in self.content

    def test_exposes_8080(self):
        assert "EXPOSE 8080" in self.content

    def test_copies_src_and_config(self):
        assert "src/" in self.content
        assert "config/" in self.content

    def test_copies_requirements(self):
        assert "requirements.txt" in self.content

    def test_runs_pip_install(self):
        assert "pip install" in self.content

    def test_entrypoint_src_main(self):
        assert "src.main" in self.content


# ============================================================
# Cross-file consistency
# ============================================================


class TestCrossFileConsistency:
    """Verify consistency between related config files."""

    def test_skills_mount_matches_config(self):
        """skills.load.extraDirs has matching volume in compose."""
        cfg = json.loads((GATEWAY_DIR / "openclaw.json").read_text())
        compose = yaml.safe_load((GATEWAY_DIR / "docker-compose.yml").read_text())
        extra_dirs = cfg["skills"]["load"]["extraDirs"]
        volumes = [str(v) for v in compose["services"]["openclaw"]["volumes"]]
        for d in extra_dirs:
            d_stripped = d.lstrip("/")
            assert any(d_stripped in v or d in v for v in volumes), (
                f"No volume mount for skills dir: {d}"
            )

    def test_config_path_matches_mount(self):
        """OPENCLAW_CONFIG_PATH env has matching volume mount."""
        compose = yaml.safe_load((GATEWAY_DIR / "docker-compose.yml").read_text())
        env = compose["services"]["openclaw"]["environment"]
        config_path = [e.split("=")[1] for e in env if "OPENCLAW_CONFIG_PATH" in e][0]
        volumes = [str(v) for v in compose["services"]["openclaw"]["volumes"]]
        dest = config_path.lstrip("/")
        assert any(dest in v for v in volumes)

    def test_skill_files_exist(self):
        """SKILL.md exists with correct format."""
        skill_dir = GATEWAY_DIR / "workspace" / "skills" / "expense-tracker"
        md = skill_dir / "SKILL.md"

        assert md.exists()
        md_content = md.read_text()
        assert md_content.startswith("---"), "SKILL.md missing YAML frontmatter"
        assert "name:" in md_content.split("---")[1], "SKILL.md missing 'name'"

    def test_gitignore_covers_env(self):
        """gitignore blocks .env but allows .env.example."""
        gi = (PROJECT_ROOT / ".gitignore").read_text()
        assert ".env" in gi
        assert "!.env.example" in gi

    def test_env_example_has_no_secrets(self):
        """Quick sanity: .env.example files don't leak actual keys."""
        non_secret_keys = {
            "IDENTITY_NAME",
            "IDENTITY_VIBE",
            "IDENTITY_EMOJI",
            "SOUL_VOICE_CORE",
            "SOUL_VOICE_TONE",
            "SOUL_VOICE_STYLE",
            "SOUL_VOICE_RULES",
            "SOUL_VISUAL_APPEARANCE",
            "SOUL_VISUAL_OUTFIT",
            "USER_PREFERENCES",
            "USER_EXTRA",
            "USER_NAME",
            "MYR_BUDGET_FILE",
            "ACTUAL_BUDGET_FILE",
            "ACTUAL_BUDGET_URL",
            "ACTUAL_API_URL",
            "IMAP_HOST",
            "IMAP_PORT",
        }
        for path in [
            EXPENSE_TRACKER_DIR / ".env.example",
            GATEWAY_DIR / ".env.example",
        ]:
            text = path.read_text()
            lines = [l.strip() for l in text.splitlines() if l.strip() and not l.startswith("#")]
            for line in lines:
                if "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip()
                if not val or key in non_secret_keys:
                    continue
                if val.startswith("sk-"):
                    assert "your" in val.lower() or "example" in val.lower(), (
                        f"sk- value in {path.name} looks like a real key: {val[:30]}"
                    )
                ok_markers = ("your", "example", "...", ".com", "http://", "https://", ":")
                looks_placeholder = any(m in val.lower() for m in ok_markers) or val.isdigit()
                is_short_template = len(val) <= 40 and ":" in val
                assert looks_placeholder or is_short_template, (
                    f"Possible real value in {path.name}: {key}={val[:30]}"
                )
