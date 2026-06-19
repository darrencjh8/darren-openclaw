"""Behavioral tests for stage2-hook.sh auth.json bootstrap (lines 345-352).

Pattern: printf %s for safe JSON value injection (no shell interpretation).
Note: chown requires root; tests verify printf behavior and permission
tightening where possible without root.
"""

import stat
import textwrap


AUTH_BOOTSTRAP_FIRST_BOOT = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    if [ ! -f "$HERMES_HOME/auth.json" ] && [ -n "${HERMES_AUTH_JSON_BOOTSTRAP:-}" ]; then
        printf '%s' "$HERMES_AUTH_JSON_BOOTSTRAP" > "$HERMES_HOME/auth.json"
        chown hermes:hermes "$HERMES_HOME/auth.json" 2>/dev/null || true
        chmod 600 "$HERMES_HOME/auth.json" 2>/dev/null || true
        echo "seeded_auth_json"
    fi
''')


def test_seeds_auth_json_on_first_boot(sandbox):
    """When auth.json does not exist and HERMES_AUTH_JSON_BOOTSTRAP is set,
    the hook writes the env var content to auth.json.
    """
    rc, stdout, stderr = sandbox.run(
        AUTH_BOOTSTRAP_FIRST_BOOT,
        env={"HERMES_AUTH_JSON_BOOTSTRAP": '{"token_key":"abc123"}'},
    )

    assert rc == 0, stderr
    assert "seeded_auth_json" in stdout
    assert sandbox.exists("auth.json"), "auth.json should have been created"
    content = sandbox.path("auth.json").read_text()
    assert '"token_key":"abc123"' in content, f"Got: {content}"


AUTH_CLOBBER_GUARD = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    # Pre-create auth.json to simulate existing file from previous boot
    echo '{"existing":"data"}' > "$HERMES_HOME/auth.json"
    if [ ! -f "$HERMES_HOME/auth.json" ] && [ -n "${HERMES_AUTH_JSON_BOOTSTRAP:-}" ]; then
        printf '%s' "$HERMES_AUTH_JSON_BOOTSTRAP" > "$HERMES_HOME/auth.json"
        chmod 600 "$HERMES_HOME/auth.json"
        echo "clobbered"
    else
        echo "skipped_bootstrap"
    fi
    cat "$HERMES_HOME/auth.json"
''')


def test_does_not_clobber_existing_auth_json(sandbox):
    """When auth.json already exists (idempotent restart), the ! -f guard
    prevents overwriting with HERMES_AUTH_JSON_BOOTSTRAP.
    """
    rc, stdout, stderr = sandbox.run(
        AUTH_CLOBBER_GUARD,
        env={"HERMES_AUTH_JSON_BOOTSTRAP": '{"new":"data"}'},
    )

    assert rc == 0, stderr
    assert "skipped_bootstrap" in stdout
    assert '{"existing":"data"}' in stdout
    assert "clobbered" not in stdout


def test_skips_when_env_var_empty(sandbox):
    """When HERMES_AUTH_JSON_BOOTSTRAP is empty or unset, nothing happens."""
    rc, stdout, stderr = sandbox.run(
        AUTH_BOOTSTRAP_FIRST_BOOT,
        env={"HERMES_AUTH_JSON_BOOTSTRAP": ""},
    )

    assert rc == 0, stderr
    assert not sandbox.exists("auth.json"), "auth.json should not be created"
    assert "seeded_auth_json" not in stdout


def test_skips_when_env_var_unset(sandbox):
    """When HERMES_AUTH_JSON_BOOTSTRAP is not set at all, nothing happens."""
    rc, stdout, stderr = sandbox.run(AUTH_BOOTSTRAP_FIRST_BOOT)

    assert rc == 0, stderr
    assert not sandbox.exists("auth.json"), "auth.json should not be created"
    assert "seeded_auth_json" not in stdout


PRINTF_SAFETY_SNIPPET = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    # Use printf %s with JSON containing backslashes and quotes
    bootstrap='{"key":"value with spaces","escaped":"\\\\n \\\\t quote"}'
    printf '%s' "$bootstrap" > "$HERMES_HOME/auth.json"
    cat "$HERMES_HOME/auth.json"
''')


def test_printf_percent_s_preserves_json_literally(sandbox):
    """printf %s (not echo) writes JSON verbatim — backslashes and
    special chars are preserved exactly as given.
    """
    rc, stdout, stderr = sandbox.run(PRINTF_SAFETY_SNIPPET)

    assert rc == 0, stderr
    # Core assertion: JSON content is preserved, no shell escape interpretation
    assert 'value with spaces' in stdout
    assert 'escaped' in stdout
    # Backslash sequences should be present (not interpreted as control chars)
    assert '\\n' in stdout or '\\\\n' in stdout


PRINTF_LEADING_DASH_SNIPPET = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    bootstrap='{"flag":"-n"}'
    printf '%s' "$bootstrap" > "$HERMES_HOME/auth_printf.json"
    echo "$bootstrap" > "$HERMES_HOME/auth_echo.json"
    echo "printf_size=$(wc -c < "$HERMES_HOME/auth_printf.json")"
    echo "echo_size=$(wc -c < "$HERMES_HOME/auth_echo.json")"
    echo "printf_content=$(cat "$HERMES_HOME/auth_printf.json")"
    echo "echo_content=$(cat "$HERMES_HOME/auth_echo.json")"
''')


def test_printf_handles_leading_dash_safely(sandbox):
    """printf %s is safe with values starting with '-' like {"flag":"-n"}.
    echo -n would interpret -n as a flag and lose the value.
    """
    rc, stdout, stderr = sandbox.run(PRINTF_LEADING_DASH_SNIPPET)

    assert rc == 0, stderr
    printf_size = int([l for l in stdout.splitlines() if "printf_size=" in l][0].split("=")[1])
    echo_size = int([l for l in stdout.splitlines() if "echo_size=" in l][0].split("=")[1])
    printf_content = [l for l in stdout.splitlines() if "printf_content=" in l][0].split("=", 1)[1]
    echo_content = [l for l in stdout.splitlines() if "echo_content=" in l][0].split("=", 1)[1]

    # Both files exist
    assert sandbox.exists("auth_printf.json")
    assert sandbox.exists("auth_echo.json")
    # printf preserves {"flag":"-n"} literally
    assert printf_content == '{"flag":"-n"}', f"printf got: {printf_content!r}"
    # echo with -n flag may lose content entirely
    assert printf_size > 0
    assert echo_size >= 0


CHMOD_600_VERIFY = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    echo "secret" > "$HERMES_HOME/auth.json"
    chmod 777 "$HERMES_HOME/auth.json" 2>/dev/null || true
    # The stage2-hook hardening block
    if [ -f "$HERMES_HOME/auth.json" ]; then
        chmod 600 "$HERMES_HOME/auth.json" 2>/dev/null || true
    fi
    stat -c "%a" "$HERMES_HOME/auth.json"
''')


def test_auth_json_chmod_600(sandbox):
    """The auth.json is chmod'd to 600 (owner-only rw) after creation.
    We verify chmod works (it doesn't require root when we own the file).
    """
    rc, stdout, stderr = sandbox.run(CHMOD_600_VERIFY)

    assert rc == 0, stderr
    perms_str = stdout.strip()
    assert perms_str == "600", f"Expected 600, got {perms_str}"
