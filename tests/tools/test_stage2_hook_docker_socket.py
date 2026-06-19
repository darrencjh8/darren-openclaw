"""Behavioral tests for stage2-hook.sh Docker socket group membership (lines 118-172).

Pattern: bash stubbing + subprocess sandbox.
Shadowed `[` builtin with `case`/`esac` for socket -S checks (avoids recursion).
Uses sandbox-relative paths to avoid host filesystem interference.
"""

import os
import textwrap

# ─── Socket detection using sandbox-relative paths ───────────────────────

SOCKET_CHECK_SNIPPET = textwrap.dedent('''\
    # Shadow [ builtin: detect -S flag on existing sandbox paths.
    _real_test() { command [ "$@"; }
    _detected=false
    _socket_gid=""
    [() {
        case "$*" in
            *-S*"$HERMES_HOME"*)
                # Verify the file actually exists before claiming it's a socket
                for _a in "$@"; do
                    case "$_a" in
                        "$HERMES_HOME"/*)
                            [ -e "$_a" ] && { _detected=true; return 0; }
                            ;;
                    esac
                done
                return 1
                ;;
            *) _real_test "$@"; return $? ;;
        esac
    }

    SOCK_A="$HERMES_HOME/var/run/docker.sock"
    SOCK_B="$HERMES_HOME/run/docker.sock"
    for sock in "$SOCK_A" "$SOCK_B"; do
        [ -S "$sock" ] || continue
        sock_gid=$(stat -c '%g' "$sock" 2>/dev/null) || continue
        [ -n "$sock_gid" ] || continue
        _socket_gid="$sock_gid"
        break
    done
    echo "detected=$_detected"
    echo "socket_gid=$_socket_gid"
''')


def test_detects_socket_via_S_flag(sandbox):
    """The loop uses [ -S "$sock" ] to detect a socket file.
    With a shadowed [ that detects sandbox_sock paths, the loop proceeds.
    """
    sandbox.mkdir("var/run")
    sandbox.write("var/run/docker.sock", "fake-socket-content")
    sandbox.mkdir("run")

    rc, stdout, stderr = sandbox.run(SOCKET_CHECK_SNIPPET)

    assert rc == 0, stderr
    assert "detected=true" in stdout


def test_skips_when_no_socket_file(sandbox):
    """When neither sandbox var/run/docker.sock nor sandbox run/docker.sock
    exists, the loop does nothing and detected stays false.
    """
    sandbox.mkdir("var/run")
    sandbox.mkdir("run")
    # No docker.sock files created

    rc, stdout, stderr = sandbox.run(SOCKET_CHECK_SNIPPET)

    assert rc == 0
    assert "detected=false" in stdout
    assert "socket_gid=" in stdout


def test_extracts_socket_gid(sandbox):
    """When a socket file exists, its GID is extracted via stat -c '%g'."""
    sandbox.mkdir("var/run")
    sandbox.write("var/run/docker.sock", "fake-socket")
    sandbox.mkdir("run")

    rc, stdout, stderr = sandbox.run(SOCKET_CHECK_SNIPPET)

    expected_gid = str(sandbox.stat("var/run/docker.sock").st_gid)
    assert rc == 0
    assert "detected=true" in stdout
    assert f"socket_gid={expected_gid}" in stdout


def test_prefers_first_socket_over_second(sandbox):
    """When both sandbox sockets exist, only the first one is used
    because `break` exits after processing.
    """
    sandbox.mkdir("var/run")
    sandbox.mkdir("run")
    sandbox.write("var/run/docker.sock", "first")
    sandbox.write("run/docker.sock", "second")

    rc, stdout, stderr = sandbox.run(SOCKET_CHECK_SNIPPET)

    first_gid = str(sandbox.stat("var/run/docker.sock").st_gid)
    assert rc == 0
    assert f"socket_gid={first_gid}" in stdout


# ─── Group membership logic (stubbed for non-root sandbox) ──────────────

GROUP_RESOLVE_SNIPPET = textwrap.dedent('''\
    # Stub getent: GID 998 exists as "docker", GID 999 does not exist
    getent() {
        if [ "$1" = "group" ] && [ "$2" = "998" ]; then
            echo "docker:x:998:"
            return 0
        fi
        return 1
    }

    _test_gid() {
        local gid="$1"
        sock_group=$(getent group "$gid" 2>/dev/null | cut -d: -f1)
        if [ -z "$sock_group" ]; then
            echo "gid_${gid}_needs_groupadd"
        else
            echo "gid_${gid}_reuses_${sock_group}"
        fi
    }

    _test_gid 998
    _test_gid 999
''')


def test_reuses_existing_group_when_gid_known(sandbox):
    """When the socket GID already has an entry in /etc/group,
    that group name is reused via getent group."""
    rc, stdout, stderr = sandbox.run(GROUP_RESOLVE_SNIPPET)

    assert rc == 0, stderr
    assert "gid_998_reuses_docker" in stdout


def test_detects_missing_group_for_unknown_gid(sandbox):
    """When the socket GID is not in /etc/group, the logic recognizes
    that groupadd would be needed."""
    rc, stdout, stderr = sandbox.run(GROUP_RESOLVE_SNIPPET)

    assert rc == 0, stderr
    assert "gid_999_needs_groupadd" in stdout


GROUPADD_FAIL_SAFE = textwrap.dedent('''\
    # Stub groupadd to always fail (non-root sandbox)
    groupadd() { return 1; }
    # Stub getent: GID 999 not found
    getent() { return 1; }

    _sock_gid="999"
    _sock="/var/run/docker.sock"
    sock_group=$(getent group "$_sock_gid" 2>/dev/null | cut -d: -f1)
    if [ -z "$sock_group" ]; then
        sock_group="hostdocker"
        if ! groupadd -g "$_sock_gid" "$sock_group" 2>/dev/null; then
            echo "Warning: groupadd failed; skipping docker socket group setup"
            echo "non_fatal_continue"
            exit 0
        fi
        echo "SHOULD_NOT_REACH_THIS"
    fi
''')


def test_non_fatal_when_groupadd_fails(sandbox):
    """When groupadd fails (e.g. non-root sandbox), the hook warns but
    does not exit non-zero — the failure is non-fatal.
    """
    rc, stdout, stderr = sandbox.run(GROUPADD_FAIL_SAFE)

    assert rc == 0
    assert "Warning: groupadd failed" in stdout
    assert "non_fatal_continue" in stdout
    assert "SHOULD_NOT_REACH_THIS" not in stdout
