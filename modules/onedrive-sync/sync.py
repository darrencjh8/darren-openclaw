"""
OneDrive Graph API client — downloads files from OneDrive using client credentials.
Configure via environment variables, no browser OAuth needed.
"""
import asyncio
import json
import logging
import os
import shutil
from pathlib import Path

import aiohttp

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
TOKEN_URL = "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"


class OneDriveClient:
    def __init__(self, tenant_id: str, client_id: str, client_secret: str):
        self._tenant_id = tenant_id
        self._client_id = client_id
        self._client_secret = client_secret
        self._token: str | None = None

    async def _get_token(self) -> str:
        if self._token:
            return self._token
        async with aiohttp.ClientSession() as session:
            data = {
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "grant_type": "client_credentials",
                "scope": "https://graph.microsoft.com/.default",
            }
            async with session.post(TOKEN_URL.format(tenant_id=self._tenant_id), data=data) as resp:
                resp.raise_for_status()
                result = await resp.json()
                self._token = result["access_token"]
                return self._token

    async def _graph_get(self, path: str) -> dict:
        token = await self._get_token()
        headers = {"Authorization": f"Bearer {token}"}
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{GRAPH_BASE}{path}", headers=headers) as resp:
                if resp.status == 401:
                    self._token = None
                    return await self._graph_get(path)
                resp.raise_for_status()
                return await resp.json()

    async def download_file(self, remote_path: str, local_path: str) -> bool:
        encoded = remote_path.lstrip("/").replace("/", "%2F").replace("'", "%27")
        try:
            metadata = await self._graph_get(f"/me/drive/root:/{remote_path}")
            download_url = metadata.get("@microsoft.graph.downloadUrl")
            if not download_url:
                logger.error("No download URL for %s", remote_path)
                return False

            async with aiohttp.ClientSession() as session:
                async with session.get(download_url) as resp:
                    resp.raise_for_status()
                    content = await resp.read()

            Path(local_path).parent.mkdir(parents=True, exist_ok=True)
            Path(local_path).write_bytes(content)
            logger.info("Downloaded %s -> %s (%d bytes)", remote_path, local_path, len(content))
            return True

        except Exception as e:
            logger.error("Failed to download %s: %s", remote_path, e)
            return False

    async def download_folder(self, remote_folder: str, local_folder: str) -> int:
        count = 0
        try:
            encoded = remote_folder.rstrip("/")
            children = await self._graph_get(f"/me/drive/root:/{encoded}:/children")
            for item in children.get("value", []):
                name = item["name"]
                remote_path = f"{remote_folder}/{name}"
                local_path = os.path.join(local_folder, name)
                if item.get("folder"):
                    count += await self.download_folder(remote_path, local_path)
                elif item.get("file"):
                    success = await self.download_file(remote_path, local_path)
                    if success:
                        count += 1
        except Exception as e:
            logger.error("Failed to list folder %s: %s", remote_folder, e)
        return count


async def sync_loop(client: OneDriveClient, remote_path: str, local_path: str, interval: int = 300):
    import time
    while True:
        try:
            if remote_path.endswith(".xml") or not remote_path.endswith("/"):
                await client.download_file(remote_path, local_path)
            else:
                await client.download_folder(remote_path, local_path)
            logger.info("Sync complete: %s -> %s", remote_path, local_path)
        except Exception as e:
            logger.error("Sync failed: %s", e)
        await asyncio.sleep(interval)


async def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

    tenant_id = os.environ["ONEDRIVE_TENANT_ID"]
    client_id = os.environ["ONEDRIVE_CLIENT_ID"]
    client_secret = os.environ["ONEDRIVE_CLIENT_SECRET"]
    remote_path = os.environ.get("ONEDRIVE_REMOTE_PATH", "PortfolioPerformance/portfolio.xml")
    local_path = os.environ.get("ONEDRIVE_LOCAL_PATH", "/data/portfolio.xml")
    interval = int(os.environ.get("ONEDRIVE_SYNC_INTERVAL", "300"))

    client = OneDriveClient(tenant_id, client_id, client_secret)
    await sync_loop(client, remote_path, local_path, interval)


if __name__ == "__main__":
    asyncio.run(main())
