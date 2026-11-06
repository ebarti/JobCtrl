#!/usr/bin/env python3
"""Exercise public Gmail OAuth and real token privacy with an owned HTTP provider.

This script imports no JobCtrl implementation or test fixtures. On Windows it
uses real file-sharing denial and native DACL inspection. Other platforms report
only their own file-mode proof; they never stand in for the Windows release gate.
"""

from __future__ import annotations

import argparse
import csv
import ctypes
from ctypes import wintypes
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def request(url):
    # These URLs are validated literal loopback before use; ignore all proxies.
    parsed = urlsplit(url)
    require(parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port, "Nonloopback QA HTTP URL refused.")
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(Request(url), timeout=10) as response:
            return response.status, dict(response.headers), response.read(8192)
    except HTTPError as error:
        return error.code, dict(error.headers), error.read(8192)


def windows_dacl(path):
    """Read the actual protected DACL and every ACE through Windows APIs."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    security.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    security.GetNamedSecurityInfoW.restype = wintypes.DWORD
    security.GetSecurityDescriptorControl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD)]
    security.GetSecurityDescriptorControl.restype = wintypes.BOOL
    security.GetAclInformation.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.c_int]
    security.GetAclInformation.restype = wintypes.BOOL
    security.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    security.GetAce.restype = wintypes.BOOL
    security.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    security.ConvertSidToStringSidW.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    acl, descriptor = ctypes.c_void_p(), ctypes.c_void_p()
    code = security.GetNamedSecurityInfoW(str(path), 1, 4, None, None, ctypes.byref(acl), None, ctypes.byref(descriptor))
    require(code == 0 and descriptor.value and acl.value, "Could not inspect the real token DACL.")
    try:
        control, revision = wintypes.WORD(), wintypes.DWORD()
        require(security.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)), "Could not inspect DACL control.")
        require(control.value & 0x1000, "The token DACL inherited its parent's access rules.")
        information = (wintypes.DWORD * 3)()
        require(security.GetAclInformation(acl, information, ctypes.sizeof(information), 2), "Could not enumerate token ACEs.")
        trustees = set()
        for index in range(information[0]):
            ace = ctypes.c_void_p()
            require(security.GetAce(acl, index, ctypes.byref(ace)), "Could not inspect a token ACE.")
            header = (ctypes.c_ubyte * 4).from_address(ace.value)
            mask = wintypes.DWORD.from_address(ace.value + 4).value
            require(header[0] == 0 and not header[1] & 0x10 and mask == 0x001F01FF, "Unexpected token ACE authority or inheritance.")
            sid = wintypes.LPWSTR()
            require(security.ConvertSidToStringSidW(ace.value + 8, ctypes.byref(sid)), "Could not inspect a token ACE SID.")
            try:
                trustees.add(sid.value)
            finally:
                kernel.LocalFree(ctypes.cast(sid, ctypes.c_void_p))
        output = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, check=True).stdout
        user = next(cell for row in csv.reader(output.splitlines()) for cell in row if cell.startswith("S-1-"))
        require(information[0] == 2 and trustees == {user, "S-1-5-18"}, "The token DACL grants another principal access.")
    finally:
        kernel.LocalFree(descriptor)


def private_file(path):
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "Token storage is not an owned regular file.")
    if os.name == "nt":
        windows_dacl(path)
    else:
        require(stat.S_IMODE(metadata.st_mode) == 0o600 and metadata.st_uid == os.getuid(), "Token file mode or owner is not private.")


class Denial:
    def __init__(self, path):
        self.path, self.handle, self.mode = path, None, None

    def __enter__(self):
        if os.name == "nt":
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                               wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
            self.kernel.CreateFileW.restype = wintypes.HANDLE
            self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            self.kernel.CloseHandle.restype = wintypes.BOOL
            # Hold the existing accepted token without delete/write sharing.
            self.handle = self.kernel.CreateFileW(str(self.path), 0x80000000, 1, None, 3, 0x80, None)
            require(self.handle != ctypes.c_void_p(-1).value, "Could not establish actual Windows replacement denial.")
        else:
            require(os.geteuid() != 0, "Real POSIX denial requires a non-root process.")
            self.mode = stat.S_IMODE(self.path.parent.stat().st_mode)
            self.path.parent.chmod(0o500)
        return self

    def __exit__(self, *_):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
        elif self.mode is not None:
            self.path.parent.chmod(self.mode)


class Proof:
    def __init__(self, root, python):
        self.root, self.python = root, python
        self.workspace = root / "workspace"
        self.workspace.mkdir(mode=0o700)
        self.gmail = self.workspace / "gmail"
        self.gmail.mkdir(mode=0o755)
        self.token = self.gmail / "token.json"
        self.capability = secrets.token_hex(32)
        self.canary = "private-oauth-qa-" + secrets.token_hex(16)
        self.workspace.joinpath(".jobctrl-e2e-owned.json").write_text(json.dumps({
            "version": 1, "workspace": str(self.workspace.resolve()), "token": self.capability}))
        self.gmail.joinpath("oauth-client.json").write_text(json.dumps({"installed": {
            "client_id": "synthetic-client", "client_secret": self.canary + "-client", "redirect_uris": ["http://127.0.0.1"]}}))
        if os.name == "nt":
            # A permissive owned parent makes accidental inheritance observable.
            subprocess.run(["icacls", str(self.gmail), "/grant", "*S-1-1-0:(OI)(CI)F"], capture_output=True, check=True)
        self.calls, self.children, self.mode, self.sequence = [], [], "success", 0
        self.received, self.release = threading.Event(), threading.Event()
        proof = self

        class External(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                parsed = urlsplit(self.path)
                values = parse_qs(parsed.query)
                require(parsed.path == "/oauth/authorize", "Unexpected external authorize path.")
                require(values["client_id"] == ["synthetic-client"] and values["scope"] == [SCOPES], "Unexpected OAuth authority.")
                callback = values["redirect_uri"][0]
                target = urlsplit(callback)
                require(target.scheme == "http" and target.hostname == "127.0.0.1" and target.port
                        and target.path == "/oauth2callback", "OAuth callback escaped owned loopback.")
                self.send_response(302)
                self.send_header("Location", callback + "?" + urlencode({"code": "synthetic-code", "state": values["state"][0]}))
                self.end_headers()

            def do_POST(self):
                require(self.path == "/oauth/token" and self.headers.get("Authorization") == "Bearer " + proof.capability,
                        "Unowned external token request.")
                values = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
                require(values["client_id"] == ["synthetic-client"] and values["client_secret"] == [proof.canary + "-client"]
                        and values["code"] == ["synthetic-code"] and values["grant_type"] == ["authorization_code"], "Unexpected token exchange.")
                mode, sequence = proof.mode, proof.sequence
                proof.calls.append(mode)
                proof.received.set()
                if mode == "held":
                    require(proof.release.wait(20), "Interrupted token control was not released.")
                token = {"access_token": proof.canary + "-access-" + str(sequence), "refresh_token": proof.canary + "-refresh",
                         "expires_in": 3600, "scope": SCOPES if mode != "scope-denied" else SCOPES.split()[0]}
                if mode == "staging":
                    token["qa_padding"] = "x" * 1400000
                encoded = json.dumps(token).encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), External)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.external = f"http://127.0.0.1:{self.server.server_address[1]}/oauth"
        repository = Path(__file__).resolve().parents[2]
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("JOBCTRL_", "GMAIL_MCP_"))}
        self.env.update(JOBCTRL_SYNTHETIC_BOUNDARIES="1", JOBCTRL_E2E_TOKEN=self.capability,
                        JOBCTRL_GMAIL_OAUTH_ROOT=self.external, JOBCTRL_DIR=str(self.workspace),
                        PYTHONPATH=str(repository / "workers" / "automation" / "src"), PYTHONUNBUFFERED="1", NO_COLOR="1")
        self.command = [python, "-u", "-m", "jobctrl", "--workspace", str(self.workspace), "gmail-auth", "--no-open", "--timeout", "30"]

    def stages(self):
        return list(self.gmail.glob(".token.json.*"))

    def run(self, mode="success", *, wrong_state=False):
        self.sequence += 1
        self.mode = mode
        self.received, self.release = threading.Event(), threading.Event()
        child = subprocess.Popen(self.command, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, encoding="utf-8", errors="replace", bufsize=1)
        self.children.append(child)
        lines, urls = [], queue.Queue()

        def output():
            for line in child.stdout:
                lines.append(line)
                if line.startswith(self.external + "/authorize?"):
                    urls.put(line.strip())

        reader = threading.Thread(target=output, daemon=True)
        reader.start()
        try:
            url = urls.get(timeout=15)
            values = parse_qs(urlsplit(url).query)
            if wrong_state:
                status, _, _ = request(values["redirect_uri"][0] + "?" + urlencode({"state": "wrong-state", "code": "not-authorized"}))
                require(status == 400 and not self.received.is_set(), "A foreign OAuth state reached the token exchange.")
            status, headers, _ = request(url)
            require(status == 302, "The controlled external OAuth authorization failed.")
            status, _, _ = request(headers["Location"])
            require(status == 200, "The real public OAuth callback failed.")
            require(self.received.wait(10), "The real public OAuth token exchange did not arrive.")
            captured = None
            if mode == "held":
                child.kill()
                child.wait(timeout=10)
                self.release.set()
            elif mode == "staging":
                deadline = time.monotonic() + 10
                while child.poll() is None and time.monotonic() < deadline:
                    stages = self.stages()
                    if stages:
                        captured = stages[0]
                        child.kill()
                        break
                    time.sleep(.0005)
                child.wait(timeout=10)
            else:
                child.wait(timeout=15)
            reader.join(timeout=3)
            require(not reader.is_alive(), "The public CLI output did not drain.")
            require(self.canary not in "".join(lines), "The public CLI disclosed private OAuth material.")
            return child.returncode, captured
        finally:
            self.release.set()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)
            reader.join(timeout=3)
            if not reader.is_alive():
                child.stdout.close()

    def refused(self, patch):
        before = len(self.calls)
        result = subprocess.run(self.command, env={**self.env, **patch}, capture_output=True, text=True, timeout=15)
        require(result.returncode != 0 and len(self.calls) == before, "An unowned OAuth selector was admitted.")
        require(self.canary not in result.stdout + result.stderr, "Refused OAuth disclosed private material.")
        require("synthetic_boundary_unowned" in result.stdout + result.stderr and "/authorize?" not in result.stdout,
                "An unowned OAuth selector reached credential loading or browser authorization.")

    def prove(self):
        code, _ = self.run(wrong_state=True)
        require(code == 0 and self.token.exists(), "Public Gmail OAuth failed to publish its first token.")
        private_file(self.token)
        accepted = self.token.read_bytes()
        self.refused({"JOBCTRL_GMAIL_OAUTH_ROOT": "http://192.0.2.1:9/oauth"})
        self.refused({"JOBCTRL_SYNTHETIC_BOUNDARIES": "0"})
        self.refused({"JOBCTRL_E2E_TOKEN": ("1" if self.capability[0] != "1" else "2") + self.capability[1:]})
        outsider = self.root / "outside-client.json"
        outside_bytes = json.dumps({"installed": {"client_id": "outside-synthetic-client", "client_secret": self.canary,
                                                  "redirect_uris": ["http://127.0.0.1"]}})
        outsider.write_text(outside_bytes)
        self.refused({"JOBCTRL_GMAIL_OAUTH_CLIENT_PATH": str(outsider)})
        require(outsider.read_text() == outside_bytes and self.token.read_bytes() == accepted, "A refused selector changed credentials.")
        code, _ = self.run("scope-denied")
        require(code != 0 and self.token.read_bytes() == accepted and not self.stages(), "Scope denial replaced or leaked a token.")
        with Denial(self.token):
            code, _ = self.run()
        require(code != 0 and self.token.read_bytes() == accepted and not self.stages(), "Native replacement denial lost the accepted token.")
        code, _ = self.run("held")
        require(code != 0 and self.token.read_bytes() == accepted and not self.stages(), "Interrupted exchange changed the accepted token.")
        interrupted, publication_races = None, 0
        for _ in range(5):
            before = self.token.read_bytes()
            code, stage = self.run("staging")
            if code != 0 and stage is not None and stage.exists() and self.token.read_bytes() == before:
                interrupted = stage
                break
            # A completed atomic replacement won the race. Verify that result
            # before another bounded attempt; never count it as interruption.
            require(not self.stages() and self.token.read_bytes() != before, "Unexpected staging interruption result.")
            private_file(self.token)
            value = json.loads(self.token.read_text())
            require(isinstance(value.get("access_token"), str) and value.get("qa_padding") == "x" * 1400000,
                    "An interrupted publication left an incomplete accepted token.")
            publication_races += 1
        require(interrupted is not None, "Could not observe interruption during real private staging within five attempts.")
        retained = {}
        for stage in self.stages():
            private_file(stage)
            retained[stage] = digest(stage)
        code, _ = self.run()
        require(code == 0, "Public OAuth did not recover after an interrupted private stage.")
        private_file(self.token)
        require(all(path.exists() and digest(path) == fingerprint for path, fingerprint in retained.items()),
                "Recovery modified a retained interrupted private stage.")
        return {"result": "PASS", "platform": sys.platform, "workspace": str(self.workspace),
                "windowsDacl": "passed" if os.name == "nt" else "not_executed_on_this_platform",
                "posixMode": "passed" if os.name != "nt" else "not_applicable",
                "publicOAuthExchanges": len(self.calls), "checks": ["actual_public_cli_oauth_callback_and_exchange",
                    "wrong_state_refused", "unowned_boundaries_refused", "outside_credentials_refused", "scope_denial_preserved_token",
                    "native_replacement_denial_preserved_token", "interrupted_exchange_preserved_token",
                    "real_staging_interruption_preserved_token", "interrupted_stage_private", "public_oauth_recovery",
                    "cli_did_not_disclose_tokens_or_client_secret"], "completedPublicationRaces": publication_races}

    def close(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=10)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace-root", type=Path, default=Path(tempfile.gettempdir()))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--require-windows", action="store_true")
    parser.add_argument("--keep-workspace", action="store_true")
    args = parser.parse_args()
    require(not args.require_windows or os.name == "nt", "The Windows privacy gate must execute on Windows.")
    args.workspace_root.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="jobctrl-gmail-token-e2e-", dir=args.workspace_root)).resolve()
    proof, result, failure = None, None, None
    try:
        proof = Proof(root, args.python)
        result = proof.prove()
    except Exception as error:
        failure = str(error) or type(error).__name__
    try:
        if proof is not None:
            proof.close()
            require(all(child.poll() is not None for child in proof.children) and proof.server.socket.fileno() == -1,
                    "Owned credential proof processes or listener did not stop.")
        if failure is None and not args.keep_workspace:
            shutil.rmtree(root)
    except Exception as error:
        failure = failure or str(error) or type(error).__name__
    if failure is not None:
        print(json.dumps({"result": "FAIL", "platform": sys.platform, "workspace": str(root), "reason": failure}))
        return 1
    result["ownedProcessesExited"] = True
    result["ownedListenerClosed"] = True
    result["workspaceRetained"] = args.keep_workspace
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
