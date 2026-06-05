import json
import os

try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    HAS_GOOGLE = True
except ImportError:
    HAS_GOOGLE = False


class GoogleSheetsClient:
    def __init__(self, service_account_json_path: str):
        if not HAS_GOOGLE:
            raise ImportError("google-api-python-client and google-auth required")
        if not os.path.exists(service_account_json_path):
            raise FileNotFoundError(f"Service account JSON not found: {service_account_json_path}")
        self._service_account_path = service_account_json_path
        self._service = None

    def _get_service(self):
        if self._service is None:
            with open(self._service_account_path) as f:
                creds_data = json.load(f)
            credentials = service_account.Credentials.from_service_account_info(
                creds_data,
                scopes=["https://www.googleapis.com/auth/spreadsheets"],
            )
            self._service = build("sheets", "v4", credentials=credentials)
        return self._service

    async def update_range(self, spreadsheet_id: str, range_str: str, values: list[list]) -> dict:
        service = self._get_service()
        body = {"values": values}
        result = service.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range=range_str,
            valueInputOption="USER_ENTERED",
            body=body,
        ).execute()
        return {"updated_cells": result.get("updatedCells", 0)}

    async def clear_range(self, spreadsheet_id: str, range_str: str) -> dict:
        service = self._get_service()
        result = service.spreadsheets().values().clear(
            spreadsheetId=spreadsheet_id,
            range=range_str,
        ).execute()
        return {"cleared_range": result.get("clearedRange", "")}
