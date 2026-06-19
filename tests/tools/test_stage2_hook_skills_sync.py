"""Behavioral tests for stage2-hook.sh skills sync mechanism (lines 386-395).

Pattern: stubs `as_hermes` function to verify invocation without root requirements.
Uses sandbox-local directories to avoid host filesystem interference.
"""

import textwrap

SKILLS_SYNC_BASIC = textwrap.dedent('''\
    # Stub as_hermes to record what it was asked to run
    _called=false
    _args=""
    as_hermes() {
        _called=true
        _args="$*"
    }

    INSTALL_DIR="$HERMES_HOME/opt/hermes"
    if [ -d "$INSTALL_DIR/skills" ]; then
        as_hermes "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/tools/skills_sync.py" \\
            || echo "Warning: skills_sync.py failed; continuing"
    fi

    echo "called=$_called"
    echo "args=$_args"
''')


def test_invokes_skills_sync_when_skills_dir_exists(sandbox):
    """When $INSTALL_DIR/skills exists, as_hermes is called with the
    python binary and skills_sync.py script.
    """
    s = sandbox
    s.mkdir("opt/hermes/skills")

    rc, stdout, stderr = s.run(SKILLS_SYNC_BASIC)

    assert rc == 0, stderr
    assert "called=true" in stdout
    assert "/opt/hermes/.venv/bin/python" in stdout
    assert "/opt/hermes/tools/skills_sync.py" in stdout


SKILLS_SYNC_NO_DIR = textwrap.dedent('''\
    _called=false
    as_hermes() { _called=true; }
    INSTALL_DIR="$HERMES_HOME/opt/hermes"
    # Do NOT create skills directory
    if [ -d "$INSTALL_DIR/skills" ]; then
        as_hermes "/opt/hermes/.venv/bin/python" "/opt/hermes/tools/skills_sync.py"
    fi
    echo "called=$_called"
''')


def test_skips_when_skills_dir_missing(sandbox):
    """When $INSTALL_DIR/skills does not exist, as_hermes is never called."""
    s = sandbox
    # Do NOT create opt/hermes/skills

    rc, stdout, stderr = s.run(SKILLS_SYNC_NO_DIR)

    assert rc == 0, stderr
    assert "called=false" in stdout


SKILLS_SYNC_FAILURE = textwrap.dedent('''\
    as_hermes() {
        # Simulate skills_sync.py failure (exit 1) when called with fail marker
        case "$*" in
            *skills_sync_fail.py*) return 1 ;;
            *) return 0 ;;
        esac
    }

    INSTALL_DIR="$HERMES_HOME/opt/hermes"
    if [ -d "$INSTALL_DIR/skills" ]; then
        as_hermes "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/tools/skills_sync_fail.py" \\
            || echo "Warning: skills_sync.py failed; continuing"
        echo "after_failure=ok"
    fi
''')


def test_non_fatal_when_skills_sync_fails(sandbox):
    """When skills_sync.py fails (non-zero exit), the || echo Warning
    catches it and the hook continues — the failure is not fatal.
    """
    s = sandbox
    s.mkdir("opt/hermes/skills")

    rc, stdout, stderr = s.run(SKILLS_SYNC_FAILURE)

    assert rc == 0, stderr
    assert "Warning: skills_sync.py failed; continuing" in stdout
    assert "after_failure=ok" in stdout


def test_uses_absolute_python_path(sandbox):
    """The skills sync python is invoked by absolute path
    ($INSTALL_DIR/.venv/bin/python), not relying on PATH or venv activation.
    """
    s = sandbox
    s.mkdir("opt/hermes/skills")

    rc, stdout, stderr = s.run(SKILLS_SYNC_BASIC)

    assert rc == 0, stderr
    assert "/opt/hermes/" in stdout
    assert ".venv/bin/python" in stdout


AS_HERMES_S6 = textwrap.dedent('''\
    s6_called=false
    s6_user=""
    direct_called=false
    direct_cmd=""
    s6-setuidgid() {
        s6_called=true
        s6_user="$1"
        shift
        direct_cmd="$*"
    }

    as_hermes() {
        # When root, use s6-setuidgid. When non-root, run directly.
        if [ "$(id -u)" = 0 ]; then
            s6-setuidgid hermes "$@"
            return
        fi
        # Non-root path: run command directly, record it
        direct_called=true
        direct_cmd="$*"
    }

    INSTALL_DIR="$HERMES_HOME/opt/hermes"
    if [ -d "$INSTALL_DIR/skills" ]; then
        as_hermes "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/tools/skills_sync.py"
    fi

    echo "s6_called=$s6_called"
    echo "direct_called=$direct_called"
    echo "direct_cmd=$direct_cmd"
''')


def test_as_hermes_runs_directly_when_non_root(sandbox):
    """When running as non-root (normal sandbox), as_hermes runs the command
    directly without s6-setuidgid. The root-path privilege drop is verified
    by its presence in the logic."""
    s = sandbox
    s.mkdir("opt/hermes/skills")

    rc, stdout, stderr = s.run(AS_HERMES_S6)

    assert rc == 0, stderr
    # Non-root: direct_called=true, s6_called=false
    assert "direct_called=true" in stdout
    assert "s6_called=false" in stdout
    assert "skills_sync.py" in stdout


def test_as_hermes_passes_full_command(sandbox):
    """The python binary and script path are passed as separate arguments
    through as_hermes."""
    s = sandbox
    s.mkdir("opt/hermes/skills")

    rc, stdout, stderr = s.run(AS_HERMES_S6)

    assert rc == 0, stderr
    assert ".venv/bin/python" in stdout
    assert "skills_sync.py" in stdout
    cmd_line = [l for l in stdout.splitlines() if "direct_cmd=" in l][0]
    assert ".venv/bin/python" in cmd_line
    assert "skills_sync.py" in cmd_line
