"""Configuration stubs — resolve at runtime from the installed hermes package.

In the deployment repo, these are thin wrappers that delegate to the
hermes-agent distribution's config module. The test suite mocks them.
"""
import os


def get_hermes_home() -> str:
    """Return HERMES_HOME from environment or default."""
    return os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
