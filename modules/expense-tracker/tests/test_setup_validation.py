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
        assert m["primary"] == "deepseek/deepseek-v4-pro"

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
            assert uid.isdigit(), f"Non-numeric user ID: {entry}"

    def test_no_placeholder_in_allowfrom(self):
        """No 'YOUR' or placeholder in allowFrom."""
        for entry in self.config["channels"]["telegram"]["allowFrom"]:
            assert "YOUR" not in entry.upper()

    def test_skills_extra_dirs(self):
        """skills.load.extraDirs includes /app/skills."""
        extra = self.config["skills"]["load"]["extraDirs"]
        assert "/app/skills" in extra

    def test_no_hardcoded_secrets(self):
        """Config uses env refs, no raw keys."""
        forbidden = ["sk-", "FkJY", "AAHe", "8883536925"]
        for s in forbidden:
            assert s not in self.text, f"Hardcoded secret: {s}"


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
            "DEEPSEEK_API_KEY", "ACTUAL_BUDGET_URL", "ACTUAL_BUDGET_PASSWORD",
            "ACTUAL_BUDGET_FILE", "IMAP_HOST", "IMAP_PORT", "IMAP_USERNAME",
            "IMAP_PASSWORD", "NOTIFICATION_SMTP_HOST", "NOTIFICATION_SMTP_PORT",
            "NOTIFICATION_EMAIL",
        ]
        for key in required:
            assert key in self.et_env, f"Missing key: {key}"

    def test_et_has_placeholder_values(self):
        """Template values are placeholders, not real credentials."""
        real_prefixes = ["sk-42046", "FkJY7", "b2e67f6d"]
        sensitive_keys = {k: v for k, v in self.et_env.items() if v}
        for key, val in sensitive_keys.items():
            for prefix in real_prefixes:
                assert not val.startswith(prefix), f"Real secret in {key}"

    def test_et_imap_is_zoho(self):
        """IMAP_HOST template is imap.zoho.com."""
        assert self.et_env["IMAP_HOST"] == "imap.zoho.com"

    def test_et_smtp_is_zoho(self):
        """SMTP template is smtp.zoho.com."""
        assert self.et_env["NOTIFICATION_SMTP_HOST"] == "smtp.zoho.com"

    def test_et_no_outlook_references(self):
        """No 'Outlook' anywhere in .env.example."""
        assert "Outlook" not in self.et_text, "Contains 'Outlook'"
        assert "outlook.office365.com" not in self.et_text, "Contains outlook"

    def test_et_no_openclaw_node_references(self):
        """No 'openclaw-node' references."""
        assert "openclaw-node" not in self.et_text

    def test_et_url_is_https(self):
        """ACTUAL_BUDGET_URL template uses HTTPS."""
        assert self.et_env["ACTUAL_BUDGET_URL"].startswith("https:")

    def test_et_imap_port_993(self):
        assert self.et_env["IMAP_PORT"] == "993"

    def test_et_smtp_port_587(self):
        assert self.et_env["NOTIFICATION_SMTP_PORT"] == "587"

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

    def test_openclaw_image(self):
        img = self.compose["services"]["openclaw"]["image"]
        assert "openclaw" in img.lower()

    def test_openclaw_env_vars(self):
        env = self.compose["services"]["openclaw"]["environment"]
        env_keys = [e.split("=")[0] for e in env]
        for k in ["OPENCLAW_CONFIG_PATH", "OPENCLAW_HOME", "OPENCLAW_GATEWAY_TOKEN",
                   "TELEGRAM_BOT_TOKEN", "DEEPSEEK_API_KEY"]:
            assert k in env_keys, f"Missing env: {k}"

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
        """SKILL.md and SKILL.js exist with correct format."""
        skill_dir = GATEWAY_DIR / "workspace" / "skills" / "expense-tracker"
        md = skill_dir / "SKILL.md"
        js = skill_dir / "SKILL.js"

        assert md.exists()
        md_content = md.read_text()
        assert md_content.startswith("---"), "SKILL.md missing YAML frontmatter"
        assert "name:" in md_content.split("---")[1], "SKILL.md missing 'name'"

        assert js.exists()
        js_content = js.read_text()
        assert "module.exports" in js_content or "export " in js_content

    def test_gitignore_covers_env(self):
        """gitignore blocks .env but allows .env.example."""
        gi = (PROJECT_ROOT / ".gitignore").read_text()
        assert ".env" in gi
        assert "!.env.example" in gi

    def test_env_example_has_no_secrets(self):
        """Quick sanity: .env.example files don't leak actual keys."""
        for path in [
            EXPENSE_TRACKER_DIR / ".env.example",
            GATEWAY_DIR / ".env.example",
        ]:
            text = path.read_text()
            for s in ["sk-42046", "FkJY7", "8883536925:", "3s636ZZb7q", "b2e67f6d"]:
                assert s not in text, f"Leaked secret in {path.name}: {s}"
