"""Synthetic token persistence checks; no browser, credentials or Gmail calls."""

from __future__ import annotations

import io
import json
import logging
import multiprocessing
import os
import stat
import time
from pathlib import Path

import httpx
import pytest

from jobctrl.infrastructure.gmail import auth


OLD_TOKEN = {"access_token": "synthetic-old", "refresh_token": "synthetic-refresh", "expires_at": 1}
NEW_TOKEN = {"access_token": "synthetic-new", "refresh_token": "synthetic-refresh", "expires_at": 9999999999}
PRIVATE_ERROR = "synthetic-private-provider-error"


def _seed(path: Path) -> bytes:
    contents = json.dumps(OLD_TOKEN, indent=2).encode()
    path.write_bytes(contents)
    path.chmod(0o600)
    return contents


class _FaultyFile:
    def __init__(self, wrapped, boundary: str) -> None:
        self.wrapped = wrapped
        self.boundary = boundary

    def __enter__(self):
        self.wrapped.__enter__()
        return self

    def __exit__(self, *args):
        return self.wrapped.__exit__(*args)

    def write(self, text: str):
        if self.boundary == "write":
            self.wrapped.write(text[:8])
            raise OSError(PRIVATE_ERROR)
        return self.wrapped.write(text)

    def flush(self):
        if self.boundary == "flush":
            raise OSError(PRIVATE_ERROR)
        return self.wrapped.flush()

    def fileno(self):
        return self.wrapped.fileno()


@pytest.mark.parametrize("boundary", ["create", "permissions", "open", "write", "flush", "fsync", "replace"])
@pytest.mark.parametrize("existing", [False, True])
def test_staging_failure_preserves_accepted_bytes_and_removes_temp(tmp_path, monkeypatch, caplog, boundary, existing):
    path = tmp_path / "token.json"
    accepted = _seed(path) if existing else None
    if boundary == "create":
        monkeypatch.setattr(auth, "_create_private_token_stage", lambda *_a: (_ for _ in ()).throw(OSError(PRIVATE_ERROR)))
    elif boundary == "permissions":
        monkeypatch.setattr(auth, "_prepare_private_token_stage", lambda *_a: (_ for _ in ()).throw(OSError(PRIVATE_ERROR)))
    elif boundary == "open":
        monkeypatch.setattr(auth.os, "fdopen", lambda *_a, **_kw: (_ for _ in ()).throw(OSError(PRIVATE_ERROR)))
    elif boundary in {"write", "flush"}:
        original = auth.os.fdopen
        monkeypatch.setattr(auth.os, "fdopen", lambda *a, **kw: _FaultyFile(original(*a, **kw), boundary))
    elif boundary == "fsync":
        monkeypatch.setattr(auth.os, "fsync", lambda *_a: (_ for _ in ()).throw(OSError(PRIVATE_ERROR)))
    else:
        monkeypatch.setattr(auth.os, "replace", lambda *_a: (_ for _ in ()).throw(OSError(PRIVATE_ERROR)))

    with caplog.at_level(logging.ERROR), pytest.raises(auth.GmailAuthError) as failure:
        try:
            auth.save_token(NEW_TOKEN, path)
        except auth.GmailAuthError:
            logging.getLogger("synthetic.gmail").exception("Gmail operation failed")
            raise
    assert path.read_bytes() == accepted if existing else not path.exists()
    assert list(tmp_path.glob(".token.json.*")) == []
    assert PRIVATE_ERROR not in str(failure.value)
    assert PRIVATE_ERROR not in caplog.text
    assert "synthetic-new" not in caplog.text and "synthetic-refresh" not in caplog.text


def test_replacement_is_private_before_publication_and_valid_after(tmp_path, monkeypatch):
    path = tmp_path / "token.json"
    accepted = _seed(path)
    original_replace = auth.os.replace
    original_open = auth.os.fdopen
    observed = []
    def inspect_open(descriptor, *args, **kwargs):
        metadata = os.fstat(descriptor)
        assert metadata.st_size == 0
        if os.name != "nt":
            assert stat.S_IMODE(metadata.st_mode) == 0o600
        return original_open(descriptor, *args, **kwargs)
    def inspect(staged, target):
        assert path.read_bytes() == accepted
        if os.name != "nt":
            assert stat.S_IMODE(Path(staged).stat().st_mode) == 0o600
        assert json.loads(Path(staged).read_text()) == NEW_TOKEN
        observed.append(True)
        original_replace(staged, target)
    monkeypatch.setattr(auth.os, "replace", inspect)
    monkeypatch.setattr(auth.os, "fdopen", inspect_open)
    auth.save_token(NEW_TOKEN, path)
    assert observed == [True]
    assert auth.load_token(path) == NEW_TOKEN
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert list(tmp_path.glob(".token.json.*")) == []


@pytest.mark.parametrize("token", [{}, {"access_token": ""}, {"access_token": 123},
    {"access_token": "synthetic-new", "other": float("nan")}, {"access_token": "synthetic-new", "other": object()}])
def test_invalid_token_does_not_replace_accepted_file(tmp_path, token):
    path = tmp_path / "token.json"
    accepted = _seed(path)
    with pytest.raises(auth.GmailAuthError, match="invalid"):
        auth.save_token(token, path)
    assert path.read_bytes() == accepted
    assert list(tmp_path.glob(".token.json.*")) == []


@pytest.mark.parametrize("boundary", ["permissions", "open"])
def test_stage_setup_failure_closes_descriptor(tmp_path, monkeypatch, boundary):
    path = tmp_path / "token.json"
    accepted = _seed(path)
    original = auth._create_private_token_stage
    descriptors = []
    def capture(destination):
        descriptor, name = original(destination)
        descriptors.append(descriptor)
        return descriptor, name
    monkeypatch.setattr(auth, "_create_private_token_stage", capture)
    if boundary == "permissions":
        monkeypatch.setattr(auth, "_prepare_private_token_stage", lambda *_a: (_ for _ in ()).throw(OSError(PRIVATE_ERROR)))
    else:
        monkeypatch.setattr(auth.os, "fdopen", lambda *_a, **_kw: (_ for _ in ()).throw(OSError(PRIVATE_ERROR)))
    with pytest.raises(auth.GmailAuthError):
        auth.save_token(NEW_TOKEN, path)
    assert path.read_bytes() == accepted
    assert len(descriptors) == 1
    with pytest.raises(OSError):
        os.fstat(descriptors[0])
    assert list(tmp_path.glob(".token.json.*")) == []


def test_interrupt_exception_cleans_private_stage(tmp_path, monkeypatch):
    path = tmp_path / "token.json"
    accepted = _seed(path)
    monkeypatch.setattr(auth.os, "replace", lambda *_a: (_ for _ in ()).throw(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        auth.save_token(NEW_TOKEN, path)
    assert path.read_bytes() == accepted
    assert list(tmp_path.glob(".token.json.*")) == []


def _pause_at_publication(path: str, ready, after_replace: bool) -> None:
    original = auth.os.replace
    def pause(staged, target):
        if after_replace:
            original(staged, target)
        ready.set()
        while True:
            time.sleep(1)
    auth.os.replace = pause
    auth.save_token(NEW_TOKEN, Path(path))


@pytest.mark.parametrize("after_replace", [False, True])
def test_process_interruption_leaves_old_or_complete_new_token(tmp_path, after_replace):
    path = tmp_path / "token.json"
    accepted = _seed(path)
    context = multiprocessing.get_context("spawn")
    ready = context.Event()
    process = context.Process(target=_pause_at_publication, args=(str(path), ready, after_replace))
    process.start()
    try:
        assert ready.wait(10), "synthetic writer did not reach publication"
        process.terminate()  # Only the exact child created by this test.
        process.join(10)
        assert not process.is_alive()
        if after_replace:
            assert auth.load_token(path) == NEW_TOKEN
            assert list(tmp_path.glob(".token.json.*")) == []
        else:
            assert path.read_bytes() == accepted
            abandoned = list(tmp_path.glob(".token.json.*"))
            assert len(abandoned) == 1
            if os.name != "nt":
                assert stat.S_IMODE(abandoned[0].stat().st_mode) == 0o600
    finally:
        if process.is_alive():
            process.terminate()
            process.join(10)


@pytest.mark.skipif(os.name == "nt", reason="symlink creation requires Windows privilege")
def test_configured_symlink_keeps_link_and_atomically_replaces_target(tmp_path):
    target = tmp_path / "accepted.json"
    _seed(target)
    link = tmp_path / "token.json"
    link.symlink_to(target)
    auth.save_token(NEW_TOKEN, link)
    assert link.is_symlink() and auth.load_token(link) == NEW_TOKEN
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


class _FakeHTTP:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status = status
        self.requests = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def post(self, url, *, data):
        self.requests.append((url, data))
        if isinstance(self.payload, bytes):
            return httpx.Response(self.status, content=self.payload, request=httpx.Request("POST", url))
        return httpx.Response(self.status, json=self.payload, request=httpx.Request("POST", url))


def _fake_oauth(monkeypatch, token_path, payload, status=200):
    client = auth.OAuthClient("synthetic-client", "synthetic-client-secret", "installed")
    http = _FakeHTTP(payload, status)
    monkeypatch.setattr(auth, "load_oauth_client", lambda: client)
    monkeypatch.setattr(auth.config, "get_gmail_mcp_credentials_path", lambda: token_path)
    monkeypatch.setattr(auth.httpx, "Client", lambda **_kwargs: http)
    return http


def _fake_callback(monkeypatch, *, error=None):
    monkeypatch.setattr(auth.secrets, "token_urlsafe", lambda _n: "synthetic-state")
    responses = []
    class Capture(io.BytesIO):
        def write(self, data):
            responses.append(data.decode("utf-8"))
            return super().write(data)
    class Server:
        def __init__(self, _address, handler):
            self.server_address = ("127.0.0.1", 9999)
            self.handler = handler

        def serve_forever(self):
            request = object.__new__(self.handler)
            request.path = (f"/oauth2callback?state=synthetic-state&error={error}" if error
                            else "/oauth2callback?state=synthetic-state&code=synthetic-code")
            request.wfile = Capture()
            request.send_response = lambda _code: None
            request.end_headers = lambda: None
            request.do_GET()

        def shutdown(self):
            pass

        def server_close(self):
            pass
    monkeypatch.setattr(auth, "ThreadingHTTPServer", Server)
    return responses


@pytest.mark.parametrize("mode", ["authenticate", "refresh"])
@pytest.mark.parametrize("fail", [False, True])
def test_auth_and_refresh_use_same_atomic_store(tmp_path, monkeypatch, capsys, caplog, mode, fail):
    path = tmp_path / "token.json"
    accepted = _seed(path)
    payload = {"access_token": "synthetic-new", "expires_in": 3600}
    if mode == "refresh":
        payload["refresh_token"] = "synthetic-provider-replacement"
    else:
        payload["refresh_token"] = "synthetic-new-refresh"
    http = _fake_oauth(monkeypatch, path, payload)
    if mode == "authenticate":
        _fake_callback(monkeypatch)
    if fail:
        monkeypatch.setattr(auth.os, "replace", lambda *_a: (_ for _ in ()).throw(OSError(PRIVATE_ERROR)))
    def perform():
        return auth.authenticate(open_browser=False) if mode == "authenticate" else auth.get_access_token()
    if fail:
        with pytest.raises(auth.GmailAuthError):
            perform()
        assert path.read_bytes() == accepted
    else:
        assert perform() == (path if mode == "authenticate" else "synthetic-new")
        saved = auth.load_token(path)
        assert saved["access_token"] == "synthetic-new"
        assert saved["expires_at"] > 1
        if mode == "refresh":
            assert saved["refresh_token"] == OLD_TOKEN["refresh_token"]
    assert len(http.requests) == 1
    assert list(tmp_path.glob(".token.json.*")) == []
    out = capsys.readouterr()
    assert PRIVATE_ERROR not in out.out + out.err + caplog.text
    assert "synthetic-new" not in out.out + out.err + caplog.text
    assert "synthetic-refresh" not in out.out + out.err + caplog.text


@pytest.mark.parametrize("payload,status", [({}, 200), ({"access_token": None}, 200),
    ({"access_token": ""}, 200), ({"access_token": "synthetic-new", "expires_in": "bad"}, 200),
    ({"access_token": "synthetic-new", "expires_in": False}, 200),
    (b'{"error":"synthetic-private-provider-error"', 200), ({"error": PRIVATE_ERROR}, 400)])
@pytest.mark.parametrize("mode", ["authenticate", "refresh"])
def test_invalid_provider_response_preserves_accepted_token(tmp_path, monkeypatch, capsys, caplog, payload, status, mode):
    path = tmp_path / "token.json"
    accepted = _seed(path)
    _fake_oauth(monkeypatch, path, payload, status)
    if mode == "authenticate":
        _fake_callback(monkeypatch)
    with pytest.raises(auth.GmailAuthError) as failure:
        if mode == "authenticate":
            auth.authenticate(open_browser=False)
        else:
            auth.get_access_token()
    assert path.read_bytes() == accepted
    assert PRIVATE_ERROR not in str(failure.value) + caplog.text + capsys.readouterr().err
    assert list(tmp_path.glob(".token.json.*")) == []


def test_unexpired_token_does_not_refresh(tmp_path, monkeypatch):
    path = tmp_path / "token.json"
    path.write_text(json.dumps(NEW_TOKEN), encoding="utf-8")
    http = _fake_oauth(monkeypatch, path, {"access_token": "unexpected"})
    assert auth.get_access_token() == NEW_TOKEN["access_token"]
    assert http.requests == []


@pytest.mark.parametrize("existing", [False, True])
@pytest.mark.parametrize("refresh", ["__missing__", None, "", "  ", False, 7, [], {}])
def test_auth_requires_its_own_usable_refresh_token(tmp_path, monkeypatch, existing, refresh, capsys, caplog):
    path = tmp_path / "token.json"
    accepted = _seed(path) if existing else None
    payload = {"access_token": "synthetic-new", "expires_in": 3600}
    if refresh != "__missing__":
        payload["refresh_token"] = refresh
    http = _fake_oauth(monkeypatch, path, payload)
    responses = _fake_callback(monkeypatch)
    with pytest.raises(auth.GmailAuthError, match="refresh token"):
        auth.authenticate(open_browser=False)
    assert path.read_bytes() == accepted if existing else not path.exists()
    assert len(http.requests) == 1
    assert responses == ["Gmail authorization received. Return to JobCtrl to finish."]
    assert list(tmp_path.glob(".token.json.*")) == []
    output = capsys.readouterr()
    assert "synthetic-new" not in output.out + output.err + caplog.text
    assert "synthetic-refresh" not in output.out + output.err + caplog.text


@pytest.mark.parametrize("existing", [False, True])
def test_auth_stores_new_refresh_token_without_inheriting_old_identity(tmp_path, monkeypatch, existing):
    path = tmp_path / "token.json"
    if existing:
        _seed(path)
    http = _fake_oauth(monkeypatch, path, {
        "access_token": "synthetic-new", "refresh_token": "synthetic-new-refresh", "expires_in": 3600,
    })
    _fake_callback(monkeypatch)
    assert auth.authenticate(open_browser=False) == path
    saved = auth.load_token(path)
    assert saved["access_token"] == "synthetic-new"
    assert saved["refresh_token"] == "synthetic-new-refresh"
    assert len(http.requests) == 1


def test_rejected_reauthorization_keeps_previous_token_refreshable(tmp_path, monkeypatch):
    path = tmp_path / "token.json"
    accepted = _seed(path)
    _fake_oauth(monkeypatch, path, {"access_token": "synthetic-new", "expires_in": 3600})
    _fake_callback(monkeypatch)
    with pytest.raises(auth.GmailAuthError, match="refresh token"):
        auth.authenticate(open_browser=False)
    assert path.read_bytes() == accepted
    refresh = _fake_oauth(monkeypatch, path, {"access_token": "synthetic-refreshed", "expires_in": 3600})
    assert auth.get_access_token() == "synthetic-refreshed"
    assert refresh.requests[0][1]["refresh_token"] == OLD_TOKEN["refresh_token"]
    assert auth.load_token(path)["refresh_token"] == OLD_TOKEN["refresh_token"]


def test_authorization_error_does_not_echo_provider_content(tmp_path, monkeypatch, capsys, caplog):
    path = tmp_path / "token.json"
    accepted = _seed(path)
    http = _fake_oauth(monkeypatch, path, {})
    _fake_callback(monkeypatch, error=PRIVATE_ERROR)
    with caplog.at_level(logging.ERROR), pytest.raises(auth.GmailAuthError) as failure:
        try:
            auth.authenticate(open_browser=False)
        except auth.GmailAuthError:
            logging.getLogger("synthetic.gmail").exception("Gmail operation failed")
            raise
    output = capsys.readouterr()
    assert PRIVATE_ERROR not in str(failure.value) + output.out + output.err + caplog.text
    assert path.read_bytes() == accepted
    assert http.requests == []
