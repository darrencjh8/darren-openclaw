"""Integration tests for credential validation.

These tests connect to the actual Actual Budget server, DeepSeek API,
IMAP server, and SMTP server using credentials from the .env file.

Run with: pytest tests/test_credentials.py -v
Skip with: pytest tests/ -v -m "not integration"
"""

import os
import ssl
import json
import pytest
import urllib.request
import urllib.error


# Mark as integration tests
pytestmark = pytest.mark.integration


def _load_config():
    """Load config from .env, skip if .env is not configured."""
    from src.config import Config

    dotenv_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if not os.path.exists(dotenv_path):
        pytest.skip(".env file not found")

    try:
        return Config.from_env()
    except ValueError as e:
        pytest.skip(f"Config incomplete: {e}")


def _ssl_context():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class TestActualBudgetCredentials:
    """Verify Actual Budget server connectivity, authentication, and data access."""

    def test_actual_budget_server_is_reachable(self):
        """The Actual Budget server should respond to HTTP requests."""
        config = _load_config()

        try:
            req = urllib.request.Request(config.actual_budget_url)
            response = urllib.request.urlopen(req, timeout=10, context=_ssl_context())
            assert response.status == 200, f"Server returned {response.status}"
        except urllib.error.HTTPError as e:
            assert e.code in (401, 403, 404), f"Unexpected HTTP error: {e.code}"
        except Exception as e:
            pytest.fail(f"Cannot reach Actual Budget server at {config.actual_budget_url}: {e}")

    def test_actual_budget_authenticate_and_list_files(self):
        """Connect to Actual Budget with password, list available budget files."""
        from actual import Actual

        config = _load_config()

        with Actual(
            base_url=config.actual_budget_url,
            password=config.actual_budget_password,
            encryption_password=config.actual_budget_encryption_password,
        ) as actual:
            files = actual.list_user_files().data
            assert len(files) > 0, f"No budget files found. Actual Budget URL: {config.actual_budget_url}"
            file_names = [f.name for f in files]
            file_ids = [f.file_id for f in files]
            group_ids = [f.group_id for f in files if f.group_id]

            # Try matching by name, file_id, or group_id
            matched = (
                config.actual_budget_file in file_names
                or config.actual_budget_file in file_ids
                or config.actual_budget_file in group_ids
                or any(config.actual_budget_file in name for name in file_names)
            )
            assert matched, (
                f"Budget file '{config.actual_budget_file}' not found.\n"
                f"  Available files (names): {file_names}\n"
                f"  Available files (file_ids): {file_ids}\n"
                f"  Available files (group_ids): {group_ids}\n"
                f"  Tip: Update ACTUAL_BUDGET_FILE in .env to match one of the names above."
            )

    def test_actual_budget_download_and_list_accounts(self):
        """Download the budget file and list accounts."""
        from actual import Actual
        from actual.queries import get_accounts

        config = _load_config()

        budget_file = _resolve_budget_file(config)

        with Actual(
            base_url=config.actual_budget_url,
            password=config.actual_budget_password,
            encryption_password=config.actual_budget_encryption_password,
            file=budget_file,
        ) as actual:
            accounts = get_accounts(actual.session)
            assert len(accounts) > 0, "No accounts found in budget"
            account_names = [a.name for a in accounts if a.name]
            assert len(account_names) > 0, f"Found {len(accounts)} accounts but 0 have names"
            print(f"\n  Budget: {budget_file.name}")
            print(f"  Accounts ({len(account_names)}): {sorted(account_names)}")

    def test_actual_budget_list_categories(self):
        """Download the budget file and list categories."""
        from actual import Actual
        from actual.queries import get_categories

        config = _load_config()

        budget_file = _resolve_budget_file(config)

        with Actual(
            base_url=config.actual_budget_url,
            password=config.actual_budget_password,
            encryption_password=config.actual_budget_encryption_password,
            file=budget_file,
        ) as actual:
            categories = get_categories(actual.session)
            assert len(categories) > 0, "No categories found in budget"
            category_names = [c.name for c in categories if c.name]
            assert len(category_names) > 0, f"Found {len(categories)} categories but 0 have names"
            print(f"\n  Budget: {budget_file.name}")
            print(f"  Categories ({len(category_names)}): {sorted(category_names)}")


def _resolve_budget_file(config):
    """Resolve a budget file by trying name, file_id, or group_id match."""
    from actual import Actual

    with Actual(
        base_url=config.actual_budget_url,
        password=config.actual_budget_password,
        encryption_password=config.actual_budget_encryption_password,
    ) as actual:
        for f in actual.list_user_files().data:
            if config.actual_budget_file in (f.file_id, f.name, f.group_id):
                return f
            if f.name and config.actual_budget_file in f.name:
                return f
    raise ValueError(f"Could not find budget file '{config.actual_budget_file}'")


class TestDeepSeekCredentials:
    """Verify DeepSeek API key validity."""

    def test_deepseek_api_key_is_configured(self):
        """The DeepSeek API key should be set and properly formatted."""
        config = _load_config()
        assert config.deepseek_api_key, "DEEPSEEK_API_KEY is empty"
        assert config.deepseek_api_key.startswith("sk-"), "DEEPSEEK_API_KEY should start with 'sk-'"
        assert len(config.deepseek_api_key) > 20, "DEEPSEEK_API_KEY seems too short"

    def test_deepseek_api_chat_completion(self):
        """DeepSeek API should accept the key and return a valid chat completion."""
        config = _load_config()

        data = json.dumps({
            "model": "deepseek-chat",
            "messages": [{"role": "user", "content": "Say 'pong' and nothing else."}],
            "max_tokens": 10,
        }).encode()

        req = urllib.request.Request(
            "https://api.deepseek.com/v1/chat/completions",
            data=data,
            headers={
                "Authorization": f"Bearer {config.deepseek_api_key}",
                "Content-Type": "application/json",
            },
        )

        try:
            response = urllib.request.urlopen(req, timeout=30)
            assert response.status == 200, f"DeepSeek returned {response.status}"
            body = json.loads(response.read())
            assert "choices" in body, "Response missing 'choices'"
            assert len(body["choices"]) > 0, "No choices in response"
            content = body["choices"][0]["message"]["content"]
            assert "pong" in content.lower(), f"Expected 'pong', got: {content}"
        except Exception as e:
            pytest.fail(f"DeepSeek API call failed: {e}")


class TestIMAPCredentials:
    """Verify IMAP connectivity to Outlook."""

    def test_imap_host_format(self):
        """IMAP host should be set to a valid hostname."""
        config = _load_config()
        assert config.imap_host, "IMAP_HOST is empty"
        assert "." in config.imap_host, "IMAP_HOST doesn't look like a valid hostname"
        assert config.imap_port == 993, f"Expected port 993, got {config.imap_port}"

    def test_imap_login_to_outlook(self):
        """Log into Outlook IMAP and check inbox."""
        import imaplib
        import socket

        config = _load_config()

        try:
            conn = imaplib.IMAP4_SSL(config.imap_host, config.imap_port, timeout=15)
            conn.login(config.imap_username, config.imap_password)
            status, _ = conn.select("INBOX")
            assert status == "OK", f"Could not select INBOX: {status}"
            conn.logout()
        except imaplib.IMAP4.error as e:
            pytest.fail(
                f"IMAP login failed. Check IMAP_USERNAME and IMAP_PASSWORD. "
                f"For Outlook, use an app password (Microsoft Account → Security → App passwords). "
                f"Error: {e}"
            )
        except socket.timeout:
            pytest.fail(f"IMAP connection timed out to {config.imap_host}:{config.imap_port}")
        except Exception as e:
            pytest.fail(f"IMAP connection failed: {e}")


class TestSMTPCredentials:
    """Verify notification SMTP credentials."""

    def test_smtp_notification_configured(self):
        """SMTP notification credentials should be set."""
        config = _load_config()
        assert config.notification_smtp_host, "NOTIFICATION_SMTP_HOST is empty"
        assert config.notification_email, "NOTIFICATION_EMAIL is empty"
        assert "@" in config.notification_email, "NOTIFICATION_EMAIL doesn't look like an email"
        assert config.notification_email_password, "NOTIFICATION_EMAIL_PASSWORD is empty"