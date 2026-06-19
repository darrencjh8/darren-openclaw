"""Shared fixtures for stage2-hook behavioral tests.

Pattern: bash stubbing + subprocess sandbox. Each test constructs a
minimal filesystem in a tmpdir, writes a bash snippet that exercises one
behavioral unit from stage2-hook.sh, runs it via subprocess, and asserts
output / exit code / filesystem side-effects.
"""

import os
import stat
import subprocess
import tempfile
import textwrap
from pathlib import Path

import pytest


@pytest.fixture
def sandbox():
    """Temporary directory that acts as a minimal container filesystem.

    Provides:
      sandbox.root      — Path to the temp root
      sandbox.write()   — Write a file under the root
      sandbox.run()     — Run a bash snippet with root as working dir
      sandbox.stat()    — stat a path under the root
      sandbox.exists()  — check if a path exists
    """
    class Sandbox:
        def __init__(self, root):
            self.root = Path(root)

        def path(self, *parts):
            return self.root.joinpath(*parts)

        def write(self, relpath, content, mode=0o644):
            full = self.path(relpath)
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(content)
            full.chmod(mode)

        def mkdir(self, relpath):
            self.path(relpath).mkdir(parents=True, exist_ok=True)

        def exists(self, relpath):
            return self.path(relpath).exists()

        def stat(self, relpath):
            return self.path(relpath).stat()

        def run(self, script, env=None, expect_ok=True):
            """Run a bash script and return (exit_code, stdout, stderr).

            Script is automatically dedented. HERMES_HOME is pinned to the
            sandbox root so scripts operate on sandbox files, not real host
            paths.
            """
            merged_env = {
                k: v for k, v in os.environ.items()
                if not k.startswith("HERMES_HOME")
            }
            merged_env["HERMES_HOME"] = str(self.root)
            if env:
                merged_env.update(env)
            proc = subprocess.run(
                ["bash", "-c", textwrap.dedent(script)],
                capture_output=True,
                text=True,
                cwd=str(self.root),
                env=merged_env,
                timeout=10,
            )
            if expect_ok and proc.returncode != 0:
                raise AssertionError(
                    f"Expected exit 0, got {proc.returncode}\n"
                    f"STDERR:\n{proc.stderr}\nSTDOUT:\n{proc.stdout}"
                )
            return proc.returncode, proc.stdout, proc.stderr

        def run_script_file(self, script_path, env=None):
            """Run a script file by path (relative to sandbox root)."""
            merged_env = os.environ.copy()
            if env:
                merged_env.update(env)
            proc = subprocess.run(
                ["bash", str(self.path(script_path))],
                capture_output=True,
                text=True,
                cwd=str(self.root),
                env=merged_env,
                timeout=10,
            )
            return proc.returncode, proc.stdout, proc.stderr

    with tempfile.TemporaryDirectory(prefix="stage2test_") as td:
        yield Sandbox(td)

    # cleanup happens automatically


@pytest.fixture
def sandbox_with_etc(sandbox):
    """Sandbox with basic /etc/group and /etc/passwd stubs for user/group ops."""
    sandbox.mkdir("etc")
    # Minimal /etc/group with a 'hermes' group at GID 10000
    sandbox.write("etc/group", textwrap.dedent("""\
        root:x:0:
        hermes:x:10000:hermes
        docker:x:998:
    """))
    # Minimal /etc/passwd with a 'hermes' user at UID 10000
    sandbox.write("etc/passwd", textwrap.dedent("""\
        root:x:0:0:root:/root:/bin/bash
        hermes:x:10000:10000:Hermes:/opt/data:/bin/bash
    """))
    return sandbox


@pytest.fixture
def sandbox_as_root(sandbox_with_etc):
    """Sandbox where the 'hermes' user is already remapped to running uid (root)."""
    # We run as root within the test, so mark hermes at UID 0 for tests
    # that need the as_hermes() function to detect root and use s6-setuidgid.
    sandbox_with_etc.write("etc/passwd", textwrap.dedent("""\
        root:x:0:0:root:/root:/bin/bash
        hermes:x:0:10000:Hermes:/opt/data:/bin/bash
    """))
    return sandbox_with_etc
