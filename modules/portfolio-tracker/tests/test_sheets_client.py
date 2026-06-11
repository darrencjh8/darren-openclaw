import pytest


def test_google_packages_not_shadowed_by_src_path():
    """Regression: src/google/ directory shadows the real google package when
    sys.path has src/ in it. This test verifies the real google.oauth2 is
    importable alongside the renamed src/gsheets/ package."""
    from google.oauth2 import service_account  # noqa: F401
    from googleapiclient.discovery import build  # noqa: F401


def test_gsheets_client_imports_without_import_error():
    """Verify GoogleSheetsClient can be imported without ImportError.
    Would have caught the src/google/ → src/gsheets/ namespace shadowing bug."""
    from src.gsheets.sheets_client import GoogleSheetsClient
    assert GoogleSheetsClient is not None
