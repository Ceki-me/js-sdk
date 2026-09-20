"""Tests for download event support (task 10135).

Verifies that Browser surfaces downloadWillBegin / downloadProgress /
downloadMeta / downloadChunk CDP events to consumers via on_download(),
and that the reassembly infrastructure from _webrtc.py is reused (not
duplicated).
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from ceki_sdk._browser import Browser
from ceki_sdk._models import Match


class _MockClient:
    """Minimal client stub — Browser only needs _active_browsers + _ws_send."""

    def __init__(self) -> None:
        self._active_browsers: dict[str, Browser] = {}
        self.sent: list[dict[str, Any]] = []

    async def _ws_send(self, msg: dict[str, Any]) -> None:
        self.sent.append(msg)


def _make_browser() -> tuple[Browser, _MockClient]:
    client = _MockClient()
    match = Match(session_id="test-session", schedule_id=0)
    browser = Browser(client, match)
    client._active_browsers[browser.session_id] = browser
    return browser, client


META = {
    "guid": "dl-guid-1",
    "url": "https://example.com/file.bin",
    "suggestedFilename": "file.bin",
    "totalBytes": 1000,
    "mimeType": "application/octet-stream",
}


class TestDownloadEventDispatch:
    """on_download receives the four download CDP methods."""

    @pytest.mark.asyncio
    async def test_download_will_begin_reaches_handler(self) -> None:
        browser, _ = _make_browser()
        received: list[tuple[str, dict[str, Any]]] = []
        browser.on_download(lambda method, params: received.append((method, params)))

        await browser._on_cdp_event(
            {"method": "Browser.downloadWillBegin", "params": META}
        )

        assert len(received) == 1
        assert received[0][0] == "Browser.downloadWillBegin"
        assert received[0][1]["guid"] == "dl-guid-1"
        assert received[0][1]["url"] == META["url"]
        assert received[0][1]["totalBytes"] == 1000

    @pytest.mark.asyncio
    async def test_download_progress_reaches_handler(self) -> None:
        browser, _ = _make_browser()
        received: list[tuple[str, dict[str, Any]]] = []
        browser.on_download(lambda method, params: received.append((method, params)))

        await browser._on_cdp_event(
            {
                "method": "Browser.downloadProgress",
                "params": {"guid": "dl-guid-1", "guidHint": "file.bin"},
            }
        )

        assert len(received) == 1
        assert received[0][0] == "Browser.downloadProgress"
        assert received[0][1]["guid"] == "dl-guid-1"

    @pytest.mark.asyncio
    async def test_download_meta_reaches_handler(self) -> None:
        browser, _ = _make_browser()
        received: list[tuple[str, dict[str, Any]]] = []
        browser.on_download(lambda method, params: received.append((method, params)))

        await browser._on_cdp_event(
            {"method": "Ceki.downloadMeta", "params": META}
        )

        assert len(received) == 1
        assert received[0][0] == "Ceki.downloadMeta"
        assert received[0][1]["suggestedFilename"] == "file.bin"

    @pytest.mark.asyncio
    async def test_download_chunk_reaches_handler(self) -> None:
        browser, _ = _make_browser()
        received: list[tuple[str, dict[str, Any]]] = []
        browser.on_download(lambda method, params: received.append((method, params)))

        await browser._on_cdp_event(
            {
                "method": "Ceki.downloadChunk",
                "params": {"guid": "dl-guid-1", "seq": 0, "total": 2, "payload": "AAAA"},
            }
        )

        assert len(received) == 1
        assert received[0][0] == "Ceki.downloadChunk"
        assert received[0][1]["seq"] == 0
        assert received[0][1]["total"] == 2
        assert received[0][1]["payload"] == "AAAA"


class TestDownloadEventFiltering:
    """Non-download CDP events must NOT reach on_download."""

    @pytest.mark.asyncio
    async def test_non_download_events_filtered(self) -> None:
        browser, _ = _make_browser()
        received: list[tuple[str, dict[str, Any]]] = []
        browser.on_download(lambda method, params: received.append((method, params)))

        await browser._on_cdp_event(
            {"method": "Page.frameNavigated", "params": {"url": "https://x"}}
        )
        await browser._on_cdp_event(
            {"method": "Network.requestWillBeSent", "params": {}}
        )
        await browser._on_cdp_event(
            {"method": "Page.screencastFrame", "params": {}}
        )

        assert len(received) == 0


class TestDownloadCallbackRegistration:
    """on_download appends callbacks to _download_callbacks."""

    def test_on_download_registers_callback(self) -> None:
        browser, _ = _make_browser()
        assert browser._download_callbacks == []

        cb = lambda method, params: None  # noqa: E731
        browser.on_download(cb)

        assert cb in browser._download_callbacks

    def test_multiple_callbacks_registered(self) -> None:
        browser, _ = _make_browser()
        cbs = [lambda m, p: None for _ in range(3)]  # noqa: E731
        for cb in cbs:
            browser.on_download(cb)

        assert len(browser._download_callbacks) == 3


class TestReassemblyReuse:
    """Reassembly infrastructure is reused from _webrtc.py — not duplicated."""

    def test_webrtc_has_reassembler(self) -> None:
        from ceki_sdk import _webrtc

        assert hasattr(_webrtc, "CaptureChunkReassembler")

    def test_browser_does_not_duplicate_reassembler(self) -> None:
        """Browser must not define its own reassembler class."""
        import inspect

        src = inspect.getsource(Browser)
        assert "class.*Reassembler" not in src


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
