"""Conftest for session store tests.

Adds the repo root to sys.path so that ``hermes_cli.*`` imports resolve
from the in-repo source tree.
"""
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
