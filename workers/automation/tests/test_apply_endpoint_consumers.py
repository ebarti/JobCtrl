"""Exact browser identity survives port reuse; Python sockets only, no Chromium."""
from __future__ import annotations

import base64
from hashlib import sha1
import json
import socket
import threading

import pytest

from jobctrl.domain.apply.services import _default_mcp_config
from jobctrl.infrastructure.apply_tools.mcp_server import _first_page_ws_url


class _BrowserSocket:
    """Tiny owned CDP WebSocket seam, with a browser-specific upgrade path."""
    def __init__(self, browser_id, *, port=0):
        self.browser_id = browser_id
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", port))
        self.port = self.listener.getsockname()[1]
        self.listener.listen()
        self.listener.settimeout(.1)
        self.stopped = threading.Event()
        self.requests = []
        self.commands = []
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"ws://127.0.0.1:{self.port}/devtools/browser/{self.browser_id}"

    def _serve(self):
        while not self.stopped.is_set():
            try:
                connection, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                connection.settimeout(5)
                header = b""
                while b"\r\n\r\n" not in header:
                    block = connection.recv(4096)
                    if not block:
                        break
                    header += block
                lines = header.decode().split("\r\n")
                path = lines[0].split(" ")[1]
                self.requests.append(path)
                if path != f"/devtools/browser/{self.browser_id}":
                    connection.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                    continue
                fields = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
                accept = base64.b64encode(sha1((fields["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
                connection.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
                frame = connection.recv(2)
                length = frame[1] & 127
                mask = connection.recv(4)
                data = connection.recv(length)
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
                command = json.loads(payload)
                self.commands.append(command)
                response = json.dumps({"id": command["id"], "result": {"targetInfos": [
                    {"type": "page", "targetId": "page-" + self.browser_id}]}}).encode()
                size = bytes([len(response)]) if len(response) < 126 else b"\x7e" + len(response).to_bytes(2, "big")
                connection.sendall(b"\x81" + size + response)

    def close(self):
        self.stopped.set()
        self.listener.close()
        self.thread.join(timeout=5)
        assert not self.thread.is_alive()


def test_old_browser_socket_never_rediscovers_peer_after_same_port_reuse(monkeypatch):
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "source")
    first = _BrowserSocket("old-owned-browser")
    old_url, port = first.url, first.port
    try:
        assert _first_page_ws_url(old_url) == f"ws://127.0.0.1:{port}/devtools/page/page-old-owned-browser"
        mcp = _default_mcp_config(port, browser_ws_url=old_url)
        assert f"--cdp-endpoint={old_url}" in mcp["mcpServers"]["playwright"]["args"]
        assert mcp["mcpServers"]["apply_tools"]["env"]["JOBCTRL_APPLY_CDP_ENDPOINT"] == old_url
    finally:
        first.close()
    peer = _BrowserSocket("new-peer-browser", port=port)
    try:
        # The exact endpoint path is stale even though another healthy browser
        # serves the same numeric origin. No HTTP/json/list fallback is allowed.
        with pytest.raises(Exception, match="404"):
            _first_page_ws_url(old_url)
        assert peer.requests == ["/devtools/browser/old-owned-browser"]
        assert peer.commands == []
        assert _first_page_ws_url(peer.url) == f"ws://127.0.0.1:{port}/devtools/page/page-new-peer-browser"
        assert peer.commands[0]["method"] == "Target.getTargets"
    finally:
        peer.close()


@pytest.mark.parametrize("endpoint", ["http://127.0.0.1:9222", "http://localhost:9222", "ws://localhost:9222/devtools/browser/id"])
def test_unbound_http_or_alias_is_not_browser_identity(endpoint):
    with pytest.raises(ValueError, match="exact verified"):
        _first_page_ws_url(endpoint)
