"""Tests for OneDrive Graph API sync client."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


def make_client():
    from sync import OneDriveClient
    return OneDriveClient(
        tenant_id="test-tenant",
        client_id="test-client-id",
        client_secret="test-secret",
    )


def _make_async_response(json_data=None, read_data=None, status=200):
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.status = status
    resp.json = AsyncMock(return_value=json_data or {})
    resp.read = AsyncMock(return_value=read_data or b"")

    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=resp)
    ctx.__aexit__ = AsyncMock(return_value=None)
    return ctx


def _make_session(post_return=None, get_return=None):
    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=None)
    if post_return:
        session.post = MagicMock(return_value=post_return)
    if get_return:
        session.get = MagicMock(return_value=get_return)
    return session


class TestOneDriveClient:
    @pytest.mark.asyncio
    async def test_get_token_obtains_and_caches(self):
        client = make_client()
        post_resp = _make_async_response(json_data={"access_token": "token-abc"})
        mock_session = _make_session(post_return=post_resp)

        with patch("aiohttp.ClientSession", return_value=mock_session):
            token = await client._get_token()
            assert token == "token-abc"
            assert client._token == "token-abc"

    @pytest.mark.asyncio
    async def test_get_token_reuses_cached(self):
        client = make_client()
        client._token = "cached-token"
        token = await client._get_token()
        assert token == "cached-token"

    @pytest.mark.asyncio
    async def test_graph_get_returns_json(self):
        client = make_client()
        client._get_token = AsyncMock(return_value="token-abc")

        get_resp = _make_async_response(json_data={"value": [{"name": "test"}]})
        mock_session = _make_session(get_return=get_resp)

        with patch("aiohttp.ClientSession", return_value=mock_session):
            result = await client._graph_get("/me/drive/root/children")
            assert result == {"value": [{"name": "test"}]}

    @pytest.mark.asyncio
    async def test_graph_get_retries_on_401(self):
        client = make_client()
        token_call_count = 0

        async def fresh_token():
            nonlocal token_call_count
            token_call_count += 1
            return f"token-{token_call_count}"

        client._get_token = fresh_token

        resp_401 = _make_async_response(status=401)
        resp_200 = _make_async_response(json_data={"status": "ok"})
        mock_session = _make_session(get_return=resp_401)

        call_count = [0]

        def get_side_effect(url, headers=None):
            call_count[0] += 1
            if call_count[0] == 1:
                return resp_401
            return resp_200

        mock_session.get = MagicMock(side_effect=get_side_effect)

        with patch("aiohttp.ClientSession", return_value=mock_session):
            result = await client._graph_get("/test")
            assert result == {"status": "ok"}
            assert token_call_count == 2

    @pytest.mark.asyncio
    async def test_download_file_success(self, tmp_path):
        client = make_client()
        client._get_token = AsyncMock(return_value="token")

        client._graph_get = AsyncMock(return_value={
            "@microsoft.graph.downloadUrl": "https://download.example.com/file"
        })

        download_resp = _make_async_response(read_data=b"file contents")
        mock_session = _make_session(get_return=download_resp)

        local = str(tmp_path / "output" / "test.xml")
        with patch("aiohttp.ClientSession", return_value=mock_session):
            result = await client.download_file("/test/path.xml", local)
            assert result is True
            with open(local, "rb") as f:
                assert f.read() == b"file contents"

    @pytest.mark.asyncio
    async def test_download_file_no_download_url(self):
        client = make_client()
        client._get_token = AsyncMock(return_value="token")
        client._graph_get = AsyncMock(return_value={})

        result = await client.download_file("/test/path.xml", "/tmp/test.xml")
        assert result is False

    @pytest.mark.asyncio
    async def test_download_file_error_returns_false(self):
        client = make_client()
        client._get_token = AsyncMock(return_value="token")
        client._graph_get = AsyncMock(side_effect=Exception("Network error"))

        result = await client.download_file("/test/path.xml", "/tmp/test.xml")
        assert result is False

    @pytest.mark.asyncio
    async def test_download_folder_collects_files(self):
        client = make_client()
        client._get_token = AsyncMock(return_value="token")

        children = {
            "value": [
                {"name": "file1.xml", "file": {"mimeType": "text/xml"}},
                {"name": "file2.xml", "file": {"mimeType": "text/xml"}},
                {"name": "subfolder", "folder": {"childCount": 0}},
            ]
        }

        call_count = [0]

        async def graph_get(path):
            call_count[0] += 1
            if call_count[0] == 1:
                return children
            return {"value": []}

        client._graph_get = graph_get
        client.download_file = AsyncMock(return_value=True)

        count = await client.download_folder("/remote", "/local")
        assert client.download_file.call_count == 2
        assert count == 2
