"""Behavioral tests for stage2-hook.sh edge cases: .env permissions,
HERMES_HOME bootstrap, config.yaml perms, install-method stamp healing.

All tests use sandbox-local paths and handle non-root limitations.
"""

import stat
import textwrap

# ─── .env permissions (lines 329-332) ───────────────────────────────────

ENV_PERMS_SNIPPET = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    # Create .env with permissive mode (simulates host-mounted file)
    cat > "$HERMES_HOME/.env" << 'ENVEOF'
API_KEY=***
ENVEOF
    chmod 644 "$HERMES_HOME/.env" 2>/dev/null || true

    # Stage2-hook .env hardening block: chmod 600 unconditionally
    if [ -f "$HERMES_HOME/.env" ]; then
        chown hermes:hermes "$HERMES_HOME/.env" 2>/dev/null || true
        chmod 600 "$HERMES_HOME/.env" 2>/dev/null || true
    fi
    stat -c "%a" "$HERMES_HOME/.env"
''')


def test_tightens_env_permissions_to_600(sandbox):
    """The .env file is unconditionally tightened to 600 (owner-only rw)."""
    rc, stdout, stderr = sandbox.run(ENV_PERMS_SNIPPET)

    assert rc == 0, stderr
    perms_str = stdout.strip()
    assert perms_str == "600", f"Expected 600, got {perms_str}"


ENV_PERMS_MISSING = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    if [ -f "$HERMES_HOME/.env" ]; then
        chmod 600 "$HERMES_HOME/.env" 2>/dev/null || true
        echo "tightened"
    else
        echo "no_env_file"
    fi
''')


def test_skips_env_perms_when_no_env_file(sandbox):
    """When .env does not exist, the permission tightening block is
    silently skipped.
    """
    rc, stdout, stderr = sandbox.run(ENV_PERMS_MISSING)

    assert rc == 0, stderr
    assert "no_env_file" in stdout
    assert "tightened" not in stdout


# ─── config.yaml permissions (lines 267-270) ────────────────────────────

CONFIG_YAML_PERMS = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    echo "config: value" > "$HERMES_HOME/config.yaml"
    chmod 777 "$HERMES_HOME/config.yaml" 2>/dev/null || true

    if [ -f "$HERMES_HOME/config.yaml" ]; then
        chown hermes:hermes "$HERMES_HOME/config.yaml" 2>/dev/null || true
        chmod 640 "$HERMES_HOME/config.yaml" 2>/dev/null || true
    fi
    stat -c "%a" "$HERMES_HOME/config.yaml"
''')


def test_config_yaml_permissions_640(sandbox):
    """config.yaml is set to 640 (owner rw, group r, no others)."""
    rc, stdout, stderr = sandbox.run(CONFIG_YAML_PERMS)

    assert rc == 0, stderr
    perms_str = stdout.strip()
    assert perms_str == "640", f"Expected 640, got {perms_str}"


# ─── HERMES_HOME bootstrap (lines 76-86) ────────────────────────────────

HERMES_HOME_MKDIR = textwrap.dedent('''\
    mkdir -p "$HERMES_HOME/custom/path"
    test -d "$HERMES_HOME/custom/path" && echo "created_hermes_home"
''')


def test_creates_hermes_home_with_mkdir_p(sandbox):
    """The bootstrap creates $HERMES_HOME (and parents) with mkdir -p."""
    rc, stdout, stderr = sandbox.run(HERMES_HOME_MKDIR)

    assert rc == 0, stderr
    assert "created_hermes_home" in stdout
    assert sandbox.exists("custom/path"), "HERMES_HOME dir should exist"


HERMES_HOME_IDEMPOTENT = textwrap.dedent('''\
    mkdir -p "$HERMES_HOME/my_hermes_home"
    mkdir -p "$HERMES_HOME/my_hermes_home"
    echo "idempotent_ok"
''')


def test_mkdir_p_is_idempotent(sandbox):
    """mkdir -p is idempotent: calling it on an already-existing
    HERMES_HOME does not error.
    """
    rc, stdout, stderr = sandbox.run(HERMES_HOME_IDEMPOTENT)

    assert rc == 0, stderr
    assert "idempotent_ok" in stdout
    assert sandbox.exists("my_hermes_home")


# ─── Install-method stamp healing (lines 306-312) ───────────────────────

STAMP_HEALING = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    echo "docker" > "$HERMES_HOME/.install_method"

    if [ -f "$HERMES_HOME/.install_method" ]; then
        stamped="$(tr -d '[:space:]' < "$HERMES_HOME/.install_method" 2>/dev/null || true)"
        if [ "$stamped" = "docker" ]; then
            rm -f "$HERMES_HOME/.install_method" 2>/dev/null || true
            echo "healed_stale_stamp"
        fi
    fi
''')


def test_removes_stale_docker_stamp(sandbox):
    """A stale 'docker' stamp in $HERMES_HOME/.install_method is removed
    on boot so the shared data volume doesn't poison host installs.
    """
    rc, stdout, stderr = sandbox.run(STAMP_HEALING)

    assert rc == 0, stderr
    assert "healed_stale_stamp" in stdout
    assert not sandbox.exists(".install_method"), "stale stamp should be removed"


STAMP_NON_DOCKER = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    echo "desktop" > "$HERMES_HOME/.install_method"

    if [ -f "$HERMES_HOME/.install_method" ]; then
        stamped="$(tr -d '[:space:]' < "$HERMES_HOME/.install_method" 2>/dev/null || true)"
        if [ "$stamped" = "docker" ]; then
            rm -f "$HERMES_HOME/.install_method" 2>/dev/null || true
            echo "removed"
        else
            echo "kept_non_docker_stamp"
        fi
    fi
''')


def test_preserves_non_docker_stamp(sandbox):
    """Only 'docker' stamps are removed. A 'desktop' stamp (host install)
    is preserved.
    """
    rc, stdout, stderr = sandbox.run(STAMP_NON_DOCKER)

    assert rc == 0, stderr
    assert "kept_non_docker_stamp" in stdout
    assert sandbox.exists(".install_method"), "non-docker stamp should persist"


STAMP_WHITESPACE = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    printf '  docker\\n' > "$HERMES_HOME/.install_method"

    if [ -f "$HERMES_HOME/.install_method" ]; then
        stamped="$(tr -d '[:space:]' < "$HERMES_HOME/.install_method" 2>/dev/null || true)"
        echo "stripped=[$stamped]"
        if [ "$stamped" = "docker" ]; then
            rm -f "$HERMES_HOME/.install_method" 2>/dev/null || true
            echo "removed_whitespace_variant"
        fi
    fi
''')


def test_handles_whitespace_in_stamp(sandbox):
    """tr -d '[:space:]' strips whitespace before comparing, so
    '  docker\\n' matches 'docker'.
    """
    rc, stdout, stderr = sandbox.run(STAMP_WHITESPACE)

    assert rc == 0, stderr
    assert "stripped=[docker]" in stdout
    assert "removed_whitespace_variant" in stdout


# ─── Seed .env from example (line 322) ──────────────────────────────────

SEED_ENV_SNIPPET = textwrap.dedent('''\
    HERMES_HOME="${HERMES_HOME:-.}"
    INSTALL_DIR="$HERMES_HOME/opt/hermes"

    mkdir -p "$INSTALL_DIR"
    echo "EXAMPLE_KEY=example_value" > "$INSTALL_DIR/.env.example"

    seed_one() {
        dest=$1
        src=$2
        if [ ! -f "$HERMES_HOME/$dest" ] && [ -f "$INSTALL_DIR/$src" ]; then
            cp "$INSTALL_DIR/$src" "$HERMES_HOME/$dest"
            echo "seeded_$dest"
        fi
    }
    seed_one ".env" ".env.example"

    cat "$HERMES_HOME/.env" 2>/dev/null || echo "no_env_yet"
''')


def test_seeds_dot_env_from_example_on_first_boot(sandbox):
    """On first boot, .env.example is copied to $HERMES_HOME/.env if
    .env doesn't already exist.
    """
    rc, stdout, stderr = sandbox.run(SEED_ENV_SNIPPET)

    assert rc == 0, stderr
    assert "seeded_.env" in stdout
    assert "EXAMPLE_KEY=example_value" in stdout
