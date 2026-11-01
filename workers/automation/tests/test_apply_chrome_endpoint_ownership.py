"""Real synthetic browser processes bind their own endpoints before publication."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen

import pytest

from jobctrl.apply import chrome

_BROWSER = r'''
import json, os, sys, time
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
profile = Path(next(arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('--user-data-dir=')))
requested = int(next(arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('--remote-debugging-port=')))
mode = os.environ.get('SYNTHETIC_BROWSER_MODE', '')
token = 'browser-' + str(os.getpid())
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        token_value = token + '-mismatch' if mode == 'mismatch' else token
        body = json.dumps({'webSocketDebuggerUrl': f'ws://127.0.0.1:{self.server.server_port}/devtools/browser/{token_value}'}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args): pass
try:
    server = HTTPServer(('127.0.0.1', int(os.environ['SYNTHETIC_PEER_PORT']) if mode == 'bind-failure' else requested), Handler)
except OSError:
    (profile / 'bind-failed').write_text('peer preserved')
    while True: time.sleep(.01)
(profile / 'DevToolsActivePort').write_text(f'{server.server_port}\n/devtools/browser/{token}')
server.serve_forever()
'''


@pytest.fixture
def owned_browser(tmp_path, monkeypatch):
    browser = tmp_path / 'browser'
    browser.write_text(f'#!{sys.executable}\n' + _BROWSER)
    browser.chmod(0o700)
    monkeypatch.setattr(chrome.config, 'CHROME_WORKER_DIR', tmp_path / 'profiles')
    monkeypatch.setattr(chrome, 'require_system_browser_capability', lambda _: browser)
    for name in ('_chrome_procs', '_chrome_identities', '_chrome_endpoints'):
        monkeypatch.setattr(chrome, name, {})
    monkeypatch.setattr(chrome, '_CDP_READY_TIMEOUT_SECONDS', .5)
    guards = []

    def guard(port, *, worker_id, process, **_kwargs):
        owned_port, browser_ws = chrome.get_worker_endpoint(worker_id, process)
        assert port == owned_port
        guards.append((worker_id, port, browser_ws))

    monkeypatch.setattr(chrome, 'install_dry_run_cdp_guard', guard)
    monkeypatch.setattr(chrome, 'install_public_destination_cdp_guard', guard)
    yield guards
    chrome.cleanup_on_exit()


def launch(worker_id, port=0):
    return chrome.launch_chrome(worker_id, port=port, dry_run=True, approved_application_url='https://example.com/apply')


def test_simultaneous_browsers_have_distinct_owned_endpoints(owned_browser):
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(launch, 1)
        second = pool.submit(launch, 2)
        first, second = first.result(timeout=10), second.result(timeout=10)
    one = chrome.get_worker_endpoint(1, first)
    two = chrome.get_worker_endpoint(2, second)
    assert one[0] != two[0] and one[1] != two[1]
    assert len(owned_browser) == 2
    assert chrome._chrome_endpoints[1].profile_dir != chrome._chrome_endpoints[2].profile_dir
    for worker_id, process in ((1, first), (2, second)):
        endpoint = chrome._chrome_endpoints[worker_id]
        assert endpoint.profile_dir.stat().st_mode & 0o077 == 0
        assert str(process.pid) in endpoint.browser_ws
    chrome.cleanup_worker(1, first)
    assert second.poll() is None
    assert chrome.get_worker_endpoint(2, second) == two
    with pytest.raises(chrome.BrowserCapabilityError, match='ownership'):
        chrome.get_worker_endpoint(1, first)


def test_failed_bind_never_attaches_guard_to_peer(owned_browser, monkeypatch):
    first = launch(11)
    peer = chrome.get_worker_endpoint(11, first)
    monkeypatch.setenv('SYNTHETIC_BROWSER_MODE', 'bind-failure')
    monkeypatch.setenv('SYNTHETIC_PEER_PORT', str(peer[0]))
    with pytest.raises(chrome.BrowserCapabilityError, match='did not publish'):
        launch(12)
    assert len(owned_browser) == 1
    assert first.poll() is None
    assert chrome.get_worker_endpoint(11, first) == peer
    assert 12 not in chrome._chrome_procs and 12 not in chrome._chrome_endpoints


def test_endpoint_http_identity_mismatch_refuses_before_guard(owned_browser, monkeypatch):
    monkeypatch.setenv('SYNTHETIC_BROWSER_MODE', 'mismatch')
    with pytest.raises(chrome.BrowserCapabilityError, match='identity does not match'):
        launch(21)
    assert owned_browser == []
    assert chrome._chrome_procs == {}


@pytest.mark.parametrize('drift', ['contents', 'replacement', 'symlink', 'dead', 'handle', 'pid'])
def test_lookup_requires_original_file_and_exact_live_handle(owned_browser, drift):
    process = launch(31)
    endpoint = chrome._chrome_endpoints[31]
    path = endpoint.profile_dir / 'DevToolsActivePort'
    original_pid = process.pid
    try:
        if drift == 'contents':
            path.write_bytes(path.read_bytes() + b'\nchanged')
        elif drift == 'replacement':
            replacement = endpoint.profile_dir / 'replacement'
            replacement.write_bytes(path.read_bytes())
            replacement.replace(path)
        elif drift == 'symlink':
            saved = endpoint.profile_dir / 'saved'
            path.rename(saved)
            path.symlink_to(saved)
        elif drift == 'dead':
            process.kill()
            process.wait(timeout=5)
        elif drift == 'handle':
            class Other:
                pid = original_pid
                def poll(self): return None
            process = Other()
        elif drift == 'pid':
            process.pid += 1
        with pytest.raises(chrome.BrowserCapabilityError):
            chrome.get_worker_endpoint(31, process)
    finally:
        endpoint.process.pid = original_pid


def test_stale_endpoint_refused_before_spawn(owned_browser, tmp_path, monkeypatch):
    profile = tmp_path / 'stale'
    profile.mkdir(mode=0o700)
    (profile / 'DevToolsActivePort').write_text('12345\n/devtools/browser/stale')
    monkeypatch.setattr(chrome, 'setup_worker_profile', lambda _: profile)
    with pytest.raises(chrome.BrowserCapabilityError, match='already contains'):
        launch(41)
    assert chrome._chrome_procs == {}
    assert owned_browser == []


def test_endpoint_exit_during_readiness_refuses(owned_browser, monkeypatch):
    original = chrome._cdp_json
    def exit_on_probe(port, path):
        process = chrome._chrome_procs[51]
        process.kill()
        process.wait(timeout=5)
        return original(port, path)
    monkeypatch.setattr(chrome, '_cdp_json', exit_on_probe)
    with pytest.raises(chrome.BrowserCapabilityError):
        launch(51)
    assert owned_browser == []
    assert chrome._chrome_procs == {}


def test_separate_apply_processes_with_same_hint_and_worker_remain_isolated(tmp_path):
    """The reported allocation race crosses interpreters, not only threads."""
    browser = tmp_path / 'browser'
    browser.write_text(f'#!{sys.executable}\n' + _BROWSER)
    browser.chmod(0o700)
    helper = r'''
import json, os, time
from pathlib import Path
from jobctrl import config
from jobctrl.apply import chrome
root = Path(os.environ['SYNTHETIC_ROOT'])
role = os.environ['SYNTHETIC_ROLE']
config.CHROME_WORKER_DIR = root / 'profiles'
chrome.require_system_browser_capability = lambda _: root / 'browser'
guards = []
def guard(port, **kwargs):
    guards.append(chrome.get_worker_endpoint(kwargs['worker_id'], kwargs['process']))
chrome.install_dry_run_cdp_guard = guard
original_precheck = chrome._require_available_cdp_port
def precheck(port):
    original_precheck(port)
    (root / ('prechecked-' + role)).touch()
    deadline = time.monotonic() + 10
    while not (root / 'release-launch').exists():
        if time.monotonic() > deadline: raise TimeoutError('parent did not release launch')
        time.sleep(.01)
chrome._require_available_cdp_port = precheck
try:
    process = chrome.launch_chrome(7, port=int(os.environ['SYNTHETIC_HINT']), dry_run=True, approved_application_url='https://example.com/apply')
    (root / ('ready-' + role)).write_text(json.dumps({'endpoint': chrome.get_worker_endpoint(7, process), 'guards': guards, 'pid': process.pid}))
    deadline = time.monotonic() + 20
    while not (root / ('stop-' + role)).exists():
        if time.monotonic() > deadline: raise TimeoutError('parent did not release')
        time.sleep(.01)
finally:
    chrome.cleanup_on_exit()
'''
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        hint = reservation.getsockname()[1]
    children = []
    try:
        for role in ('A', 'B'):
            home = tmp_path / ('home-' + role)
            home.mkdir(mode=0o700)
            env = dict(os.environ, HOME=str(home), JOBCTRL_DIR=str(home / 'workspace'),
                       SYNTHETIC_ROOT=str(tmp_path), SYNTHETIC_ROLE=role, SYNTHETIC_HINT=str(hint))
            children.append(subprocess.Popen([sys.executable, '-c', helper], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
            deadline = time.monotonic() + 10
            while not (tmp_path / ('prechecked-' + role)).exists():
                assert children[-1].poll() is None, 'helper failed before precheck'
                assert time.monotonic() < deadline, 'precheck did not complete'
                time.sleep(.01)
        (tmp_path / 'release-launch').touch()
        deadline = time.monotonic() + 15
        while not all((tmp_path / ('ready-' + role)).exists() for role in ('A', 'B')):
            if any(child.poll() is not None for child in children):
                pytest.fail('synthetic helper exited: ' + repr([child.communicate(timeout=5) for child in children if child.poll() is not None]))
            assert time.monotonic() < deadline, 'owned browsers did not publish'
            time.sleep(.01)
        one, two = [json.loads((tmp_path / ('ready-' + role)).read_text()) for role in ('A', 'B')]
        assert one['endpoint'][0] != two['endpoint'][0]
        assert one['endpoint'][1] != two['endpoint'][1]
        assert one['guards'] == [one['endpoint']]
        assert two['guards'] == [two['endpoint']]
        for record in (one, two):
            with urlopen(f"http://127.0.0.1:{record['endpoint'][0]}/json/version", timeout=2) as response:
                assert json.load(response)['webSocketDebuggerUrl'] == record['endpoint'][1]
    finally:
        for role in ('A', 'B'):
            (tmp_path / ('stop-' + role)).touch()
        for child in children:
            try:
                stdout, stderr = child.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate(timeout=5)
                raise
            assert child.returncode == 0, (stdout, stderr)


@pytest.mark.skipif(os.name == "nt", reason="POSIX named pipe")
def test_fifo_endpoint_refuses_without_blocking(tmp_path):
    """A malformed producer cannot hang the reader before its type check."""
    profile = tmp_path / 'profile'
    profile.mkdir(mode=0o700)
    os.mkfifo(profile / 'DevToolsActivePort', 0o600)
    probe = """
import sys
from pathlib import Path
from jobctrl.apply.chrome import _read_private_endpoint, BrowserCapabilityError
try:
    _read_private_endpoint(Path(sys.argv[1]))
except BrowserCapabilityError:
    sys.exit(0)
sys.exit(1)
"""
    result = subprocess.run([sys.executable, '-c', probe, str(profile)], capture_output=True, text=True, timeout=3)
    assert result.returncode == 0, result.stderr



def test_guard_refuses_peer_endpoint_before_websocket_attachment(owned_browser, monkeypatch):
    import websocket

    first = launch(61)
    peer = launch(62)
    first_port, _ = chrome.get_worker_endpoint(61, first)
    peer_port, peer_ws = chrome.get_worker_endpoint(62, peer)
    original = chrome._cdp_json
    monkeypatch.setattr(chrome, '_cdp_json', lambda port, path: {'webSocketDebuggerUrl': peer_ws} if port == first_port else original(port, path))
    monkeypatch.setattr(websocket, 'create_connection', lambda *_args, **_kwargs: pytest.fail('peer must not receive a guard connection'))
    guard = chrome._DryRunCdpGuard(first_port, worker_id=61, process=first, approved_application_url='https://example.com/apply')
    with pytest.raises(chrome.BrowserCapabilityError, match='identity changed'):
        chrome._BrowserApplyGuardSession.connect(first_port, guard)
    assert first.poll() is None and peer.poll() is None
    assert chrome.get_worker_endpoint(62, peer) == (peer_port, peer_ws)
