import pytest

try:
    from google.oauth2 import service_account  # noqa: F401
    from googleapiclient.discovery import build  # noqa: F401
    HAS_GOOGLE = True
except ImportError:
    HAS_GOOGLE = False


@pytest.mark.skipif(not HAS_GOOGLE, reason="google-api-python-client not installed")
def test_client_constructor_requires_valid_path():
    from src.google.sheets_client import GoogleSheetsClient
    with pytest.raises(FileNotFoundError):
        GoogleSheetsClient("/nonexistent/service_account.json")
