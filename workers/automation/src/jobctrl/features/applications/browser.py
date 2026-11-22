"""Owned empty-browser rehearsal; the only admitted navigation is one exact GET."""

from __future__ import annotations

import os
import asyncio
import socket
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from httpx import URL
import httpx

from jobctrl.app.synthetic import synthetic_boundary
from jobctrl.network.public_http import build_public_http_opener
from jobctrl.network.url_safety import validate_public_http_url

from .domain import ApplicationFailure

_FETCH_SLOTS = threading.BoundedSemaphore(2)


class _DocumentOperation:
    """Own actual sockets so cancellation cannot leave a slow read running."""

    def __init__(self):
        self.deadline = time.monotonic() + 20
        self.lock = threading.Lock()
        self.aborted = False
        self.sockets = []

    def check(self):
        if self.aborted or time.monotonic() >= self.deadline:
            raise ApplicationFailure("application_rehearsal_document_timeout")

    def resolver(self, *args, **kwargs):
        self.check()
        result = socket.getaddrinfo(*args, **kwargs)
        self.check()
        return result

    def socket_factory(self, family, socktype, proto):
        with self.lock:
            self.check()
            sock = socket.socket(family, socktype, proto)
            try:
                duplicate = sock.dup()
            except BaseException:
                sock.close()
                raise
            # A duplicate still owns the connection if TLS detaches the first
            # socket, and shutdown interrupts reads across that ownership.
            self.sockets.extend((sock, duplicate))
            return sock

    def close(self, *, abort=False):
        with self.lock:
            self.aborted = self.aborted or abort
            sockets, self.sockets = self.sockets, []
        for sock in sockets:
            if abort:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            try:
                sock.close()
            except OSError:
                pass


class BrowserRehearsal:
    def __init__(self, runtime):
        self.runtime = runtime
        self.documents = RehearsalDocuments(runtime)

    async def inspect(self, application_url):
        parts = urlsplit(application_url)
        if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
            raise ApplicationFailure("application_browser_destination_invalid")
        target = str(URL(application_url))
        from playwright.async_api import async_playwright
        admitted, blocked, document_failure = False, 0, None
        browser = None
        try:
            async with async_playwright() as playwright:
                launch = {"headless": True}
                executable = os.environ.get("JOBCTRL_CHROMIUM_EXECUTABLE")
                if executable:
                    launch["executable_path"] = executable
                browser = await playwright.chromium.launch(**launch)
                context = await browser.new_context(java_script_enabled=False, accept_downloads=False,
                                                    service_workers="block")
                page = await context.new_page()

                async def guard(route):
                    nonlocal admitted, blocked, document_failure
                    request = route.request
                    if (not admitted and request.method == "GET" and request.is_navigation_request()
                            and request.frame == page.main_frame and request.url == target):
                        admitted = True
                        try:
                            document = await self.documents.fetch_async(target)
                        except ApplicationFailure as error:
                            document_failure = error.code
                            await route.abort("blockedbyclient")
                            return
                        await route.fulfill(status=document["status"], headers=document["headers"], body=document["body"])
                    else:
                        blocked += 1
                        await route.abort("blockedbyclient")

                await context.route("**/*", guard)
                try:
                    response = await page.goto(target, wait_until="domcontentloaded", timeout=30000)
                except Exception:
                    if document_failure:
                        raise ApplicationFailure(document_failure) from None
                    raise
                if response is None or response.status >= 400 or page.url != target:
                    raise ApplicationFailure("application_rehearsal_navigation_blocked")
                text = await page.locator("body").inner_text(timeout=10000)
                links = await page.locator("a[href]").evaluate_all(
                    "elements => elements.slice(0,200).map(element => ({text:element.innerText.slice(0,500),href:element.getAttribute('href').slice(0,4000)}))")
                observations = {"url": page.url, "title": (await page.title())[:2000],
                                "text": text[:64000], "textTruncated": len(text) > 64000, "links": links}
                # No typing, uploads, credentials, scripts, redirects or final
                # submit are available. Multi-page/dynamic coverage is unknown.
                await browser.close()
                browser = None
                return {"coverage": "partial", "blockedMutationCount": blocked,
                        "observations": observations,
                        "checks": ["one_exact_get", "pinned_public_destination", "proxies_disabled", "empty_browser_profile", "scripts_disabled", "mutations_blocked", "manual_final_submission"]}
        except ApplicationFailure:
            raise
        except Exception:
            raise ApplicationFailure("application_browser_rehearsal_unavailable") from None
        finally:
            if browser is not None:
                try:
                    await browser.close()
                except Exception:
                    pass


class RehearsalDocuments:
    """Only this I/O adapter fetches the document; Chromium never resolves it."""

    MAX_BYTES = 2 * 1024 * 1024

    def __init__(self, runtime):
        self.workspace = runtime.workspace
        self.endpoint = os.environ.get("JOBCTRL_E2E_ATS_URL")
        self.synthetic = synthetic_boundary(self.workspace, self.endpoint) if self.endpoint else None
        if self.endpoint and self.synthetic is None:
            raise ApplicationFailure("application_ats_boundary_unowned")

    @staticmethod
    def _headers(headers):
        # Renderer input needs document type only; cookies, redirects, refresh
        # navigation and provider headers do not become browser authority.
        return {"Content-Type": headers.get("Content-Type", "text/html; charset=utf-8"),
                "Content-Security-Policy": "default-src 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; base-uri 'none'"}

    def fetch(self, target):
        operation = _DocumentOperation()
        try:
            return self._fetch(target, operation)
        finally:
            operation.close()

    async def fetch_async(self, target):
        if not _FETCH_SLOTS.acquire(blocking=False):
            raise ApplicationFailure("application_rehearsal_network_busy")
        operation, done, values = _DocumentOperation(), threading.Event(), []
        def run():
            try:
                values.append(self._fetch(target, operation))
            except BaseException as error:
                values.append(error)
            finally:
                operation.close()
                _FETCH_SLOTS.release()
                done.set()
        try:
            threading.Thread(target=run, name="application-document-read", daemon=True).start()
        except BaseException:
            _FETCH_SLOTS.release()
            raise
        try:
            while not done.is_set():
                operation.check()
                await asyncio.sleep(.02)
            operation.check()
            if isinstance(values[0], BaseException):
                raise values[0]
            return values[0]
        except BaseException:
            operation.close(abort=True)
            # Uninterruptible OS DNS remains bounded by two daemon slots. Its
            # eventual return cannot open a socket after the aborted fence.
            raise

    def _fetch(self, target, operation):
        operation.check()
        if self.synthetic:
            return self._synthetic_fetch(target, operation)
        request = urllib.request.Request(target, method="GET", headers={
            "User-Agent": "JobCtrl read-only application inspection", "Accept": "text/html,application/xhtml+xml",
            "Accept-Encoding": "identity",
        })
        # The neutral opener validates every DNS answer at connection time and
        # connects directly to its chosen validated numeric address. Disable
        # inherited proxy routing and every redirect before opening a socket.
        opener = build_public_http_opener(urllib.request.ProxyHandler({}), resolver=operation.resolver,
                                          socket_factory=operation.socket_factory, follow_redirects=False)
        try:
            with opener.open(request, timeout=20) as response:
                status = int(response.status)
                content = bytearray()
                while len(content) <= self.MAX_BYTES:
                    operation.check()
                    chunk = response.read1(min(64 * 1024, self.MAX_BYTES + 1 - len(content)))
                    if not chunk:
                        break
                    content.extend(chunk)
                body = bytes(content)
                if not 200 <= status < 300 or len(body) > self.MAX_BYTES:
                    raise ApplicationFailure("application_rehearsal_document_refused")
                return {"status": status, "headers": self._headers(response.headers), "body": body}
        except ApplicationFailure:
            raise
        except (OSError, ValueError, urllib.error.URLError):
            raise ApplicationFailure("application_rehearsal_destination_refused") from None

    def _synthetic_fetch(self, target, operation):
        synthetic_boundary(self.workspace, self.endpoint)
        # The owned external boundary represents ATS HTTP and DNS, following
        # the same public-address decision before returning any page to Chrome.
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=20) as client:
            with client.stream("GET", self.endpoint, headers={"Authorization": "Bearer " + self.synthetic["token"],
                               "X-JobCtrl-Source-URL": target}) as response:
                addresses = response.headers.get("X-JobCtrl-Resolved-Addresses", "93.184.216.34").split(",")
                def resolver(_host, port, **_kwargs):
                    return [(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, 6, "",
                             (address.strip(), port)) for address in addresses]
                if not validate_public_http_url(target, resolver=resolver).allowed:
                    raise ApplicationFailure("application_rehearsal_destination_refused")
                if not 200 <= response.status_code < 300:
                    raise ApplicationFailure("application_rehearsal_document_refused")
                content = bytearray()
                for chunk in response.iter_bytes():
                    operation.check()
                    content.extend(chunk)
                    if len(content) > self.MAX_BYTES:
                        raise ApplicationFailure("application_rehearsal_document_refused")
                return {"status": response.status_code, "headers": self._headers(response.headers), "body": bytes(content)}
