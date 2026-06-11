"""Integration tests for credential validation.

These tests connect to the actual Actual Budget server, DeepSeek API,
IMAP server, and SMTP server using credentials from the .env file.

All live-connection tests are gated: if the target service is unreachable,
the test is skipped (not failed) with a clear reason. Failures only occur
when a service IS reachable but credentials or data are wrong.
"""

import json
import os
import socket
import ssl
import urllib.error
import urllib.request

import pytest

pytestmark = pytest.mark.integration


def _load_config():
    """Load config from .env, skip if .env is not present or incomplete."""
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


def _is_url_reachable(url, timeout=5):
    """Return True if a TCP connection can be established to the URL's host:port."""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False
    host, port = parsed.hostname, parsed.port
    if not host:
        return False
    port = port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (socket.timeout, OSError):
        return False


def _is_placeholder(value, placeholder_patterns=("your-", "example", "placeholder")):
    """Return True if the value looks like a placeholder/default, not a real credential."""
    if not value:
        return True
    v = value.lower()
    return any(p in v for p in placeholder_patterns)


# ====================================================================
# Actual Budget
# ====================================================================


@pytest.fixture(scope="class")
def ab_config():
    """Skip the entire class if Actual Budget server is unreachable."""
    config = _load_config()
    url = config.actual_budget_url

    if _is_placeholder(url):
        pytest.skip(f"ACTUAL_BUDGET_URL is a placeholder: {url}")

    if not _is_url_reachable(url, timeout=5):
        pytest.skip(f"Actual Budget server not reachable at {url}")

    return config


class TestActualBudgetCredentials:
    """Verify Actual Budget server connectivity, authentication, and data access."""

    def test_actual_budget_server_is_reachable(self, ab_config):
        """The Actual Budget server should respond to HTTP requests."""
        try:
            req = urllib.request.Request(ab_config.actual_budget_url)
            response = urllib.request.urlopen(req, timeout=10, context=_ssl_context())
            assert response.status == 200, f"Server returned {response.status}"
        except urllib.error.HTTPError as e:
            assert e.code in (401, 403, 404), f"Unexpected HTTP error: {e.code}"

    def test_actual_budget_authenticate_and_list_files(self, ab_config):
        """Connect to Actual Budget with password, list available budget files."""
        from actual import Actual

        with Actual(
            base_url=ab_config.actual_budget_url,
            password=ab_config.actual_budget_password,
            encryption_password=ab_config.actual_budget_encryption_password,
        ) as actual:
            files = actual.list_user_files().data
            assert len(files) > 0, (
                f"No budget files found. Actual Budget URL: {ab_config.actual_budget_url}"
            )
            file_names = [f.name for f in files]
            file_ids = [f.file_id for f in files]
            group_ids = [f.group_id for f in files if f.group_id]

            matched = (
                ab_config.actual_budget_file in file_names
                or ab_config.actual_budget_file in file_ids
                or ab_config.actual_budget_file in group_ids
                or any(ab_config.actual_budget_file in name for name in file_names)
            )
            assert matched, (
                f"Budget file '{ab_config.actual_budget_file}' not found.\n"
                f"  Available files (names): {file_names}\n"
                f"  Available files (file_ids): {file_ids}\n"
                f"  Available files (group_ids): {group_ids}\n"
                f"  Tip: Update ACTUAL_BUDGET_FILE in .env to match one of the names above."
            )

    def test_actual_budget_download_and_list_accounts(self, ab_config):
        """Download the budget file and list accounts."""
        from actual import Actual
        from actual.queries import get_accounts

        budget_file = _resolve_budget_file_from_config(ab_config)

        with Actual(
            base_url=ab_config.actual_budget_url,
            password=ab_config.actual_budget_password,
            encryption_password=ab_config.actual_budget_encryption_password,
            file=budget_file,
        ) as actual:
            accounts = get_accounts(actual.session)
            assert len(accounts) > 0, "No accounts found in budget"
            account_names = [a.name for a in accounts if a.name]
            assert len(account_names) > 0, f"Found {len(accounts)} accounts but 0 have names"
            print(f"\n  Budget: {budget_file.name}")
            print(f"  Accounts ({len(account_names)}): {sorted(account_names)}")

    def test_actual_budget_list_categories(self, ab_config):
        """Download the budget file and list categories."""
        from actual import Actual
        from actual.queries import get_categories

        budget_file = _resolve_budget_file_from_config(ab_config)

        with Actual(
            base_url=ab_config.actual_budget_url,
            password=ab_config.actual_budget_password,
            encryption_password=ab_config.actual_budget_encryption_password,
            file=budget_file,
        ) as actual:
            categories = get_categories(actual.session)
            assert len(categories) > 0, "No categories found in budget"
            category_names = [c.name for c in categories if c.name]
            assert len(category_names) > 0, f"Found {len(categories)} categories but 0 have names"
            print(f"\n  Budget: {budget_file.name}")
            print(f"  Categories ({len(category_names)}): {sorted(category_names)}")


def _resolve_budget_file_from_config(config):
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


# ====================================================================
# DeepSeek
# ====================================================================


@pytest.fixture(scope="class")
def ds_config():
    """Skip if DeepSeek API key is a placeholder or unreachable."""
    config = _load_config()
    if _is_placeholder(config.deepseek_api_key):
        pytest.skip(f"DEEPSEEK_API_KEY is a placeholder")
    if not _is_url_reachable("https://api.deepseek.com", timeout=5):
        pytest.skip("DeepSeek API not reachable from this network")
    return config


class TestDeepSeekCredentials:
    """Verify DeepSeek API key validity."""

    def test_deepseek_api_key_is_configured(self, ds_config):
        """The DeepSeek API key should be set and properly formatted."""
        assert ds_config.deepseek_api_key, "DEEPSEEK_API_KEY is empty"
        assert ds_config.deepseek_api_key.startswith("sk-"), (
            "DEEPSEEK_API_KEY should start with 'sk-'"
        )
        assert len(ds_config.deepseek_api_key) > 20, "DEEPSEEK_API_KEY seems too short"

    def test_deepseek_api_chat_completion(self, ds_config):
        """DeepSeek API should accept the key and return a valid chat completion."""
        data = json.dumps(
            {
                "model": "deepseek-chat",
                "messages": [{"role": "user", "content": "Say 'pong' and nothing else."}],
                "max_tokens": 10,
            }
        ).encode()

        req = urllib.request.Request(
            "https://api.deepseek.com/v1/chat/completions",
            data=data,
            headers={
                "Authorization": f"Bearer {ds_config.deepseek_api_key}",
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
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            pytest.fail(f"DeepSeek returned HTTP {e.code}: {body[:200]}")
        except urllib.error.URLError as e:
            pytest.skip(f"DeepSeek API unreachable: {e.reason}")


# ====================================================================
# IMAP
# ====================================================================


@pytest.fixture(scope="class")
def imap_config():
    """Skip if IMAP host is a placeholder or unreachable."""
    config = _load_config()
    if _is_placeholder(config.imap_host):
        pytest.skip(f"IMAP_HOST is a placeholder: {config.imap_host}")
    if _is_placeholder(config.imap_username):
        pytest.skip(f"IMAP_USERNAME is a placeholder: {config.imap_username}")
    if not _is_url_reachable(f"https://{config.imap_host}", timeout=5):
        pytest.skip(f"IMAP host not reachable: {config.imap_host}:{config.imap_port}")
    return config


class TestIMAPCredentials:
    """Verify IMAP connectivity."""

    def test_imap_host_format(self, imap_config):
        """IMAP host should be set to a valid hostname."""
        assert imap_config.imap_host, "IMAP_HOST is empty"
        assert "." in imap_config.imap_host, "IMAP_HOST doesn't look like a valid hostname"
        assert imap_config.imap_port == 993, f"Expected port 993, got {imap_config.imap_port}"

    def test_imap_login(self, imap_config):
        """Log into IMAP and check inbox."""
        import imaplib

        try:
            conn = imaplib.IMAP4_SSL(imap_config.imap_host, imap_config.imap_port, timeout=15)
            conn.login(imap_config.imap_username, imap_config.imap_password)
            status, _ = conn.select("INBOX")
            assert status == "OK", f"Could not select INBOX: {status}"
            conn.logout()
        except imaplib.IMAP4.error as e:
            pytest.fail(f"IMAP login failed. Check IMAP_USERNAME and IMAP_PASSWORD. Error: {e}")
        except socket.timeout:
            pytest.skip(
                f"IMAP connection timed out to {imap_config.imap_host}:{imap_config.imap_port}"
            )
        except OSError as e:
            pytest.skip(f"IMAP not reachable: {e}")


# ====================================================================
# Gateway
# ====================================================================


class TestGatewayCredentials:
    """Verify Gateway notification credentials."""

    def test_gateway_url_configured(self):
        """Gateway URL should be set."""
        config = _load_config()
        assert config.openclaw_gateway_url, "OPENCLAW_GATEWAY_URL is empty"
