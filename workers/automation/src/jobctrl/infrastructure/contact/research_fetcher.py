"""Bounded, gateway-routed public-page fetcher for supervised contact research."""

from __future__ import annotations

import http.client
import logging
import math
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from concurrent.futures import CancelledError
from dataclasses import dataclass
from typing import Any

from bs4 import BeautifulSoup

from jobctrl.domain.contact.research import ResearchSourceOutcome
from jobctrl.domain.contact.source_policy import (
    ContactResearchSourcePolicy,
    ResearchSourceCategory,
    ResearchSourceDecision,
)
from jobctrl.domain.ports.contact import ResearchPageFetch
from jobctrl.infrastructure.network import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    RunBudgetCounter,
    parse_retry_after,
)
from jobctrl.infrastructure.network.fetch_failures import PublicFetchFailureKind, classify_public_fetch_failure
from jobctrl.infrastructure.network.public_http import (
    UnsafePublicDestinationError,
    build_public_http_opener,
)
from jobctrl.infrastructure.network.url_safety import Resolver, validate_public_http_url

log = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 20.0
_DEFAULT_MAX_BODY_BYTES = 2_000_000
_MAX_TEXT_CHARS = 40000
_MAX_REDIRECTS = 5
_READ_CHUNK_BYTES = 64 * 1024
_REDIRECT_STATUS_CODES = frozenset({301, 302, 303, 307, 308})
# A resolver or injected transport can ignore interruption. Bound those workers
# process-wide; timed-out workers cannot start a later socket after cancellation.
_ACQUISITION_SLOTS = threading.BoundedSemaphore(16)

TargetResolver = Callable[[str, int | None], tuple[str, ...]]


@dataclass(frozen=True)
class _Hop:
    result: ResearchPageFetch | None = None
    body: bytes = b""
    redirect: str | None = None
    status: int | None = None
    retry_after: str | None = None


class _ResolverTimeout(Exception):
    """Preserve a DNS timeout across public-destination OSError handling."""


class _Acquisition:
    """Owns one hop's sockets so a deadline can interrupt headers and body reads."""

    def __init__(self, deadline: float, cancel_event: threading.Event | None) -> None:
        self.deadline = deadline
        self.cancel_event = cancel_event
        self._lock = threading.Lock()
        self._aborted = False
        self._sockets: list[socket.socket] = []
        self._response: Any = None

    def check(self) -> None:
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise CancelledError()
        if self._aborted or time.monotonic() >= self.deadline:
            raise TimeoutError("Public-page acquisition deadline expired")

    def remaining(self) -> float:
        self.check()
        return max(0.001, self.deadline - time.monotonic())

    def socket_factory(self, family: int, socktype: int, proto: int) -> socket.socket:
        with self._lock:
            self.check()
            sock = socket.socket(family, socktype, proto)
            try:
                # HTTPS wraps/detaches the original socket. The duplicate can
                # still shut down the connection while headers/body trickle in.
                duplicate = sock.dup()
            except BaseException:
                sock.close()
                raise
            self._sockets.extend((sock, duplicate))
            return sock

    def set_response(self, response: Any) -> None:
        with self._lock:
            self.check()
            self._response = response

    def abort(self) -> None:
        with self._lock:
            self._aborted = True
            sockets = tuple(self._sockets)
            response = self._response
        # shutdown wakes a blocked socket read even after TLS wraps the socket.
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
        if response is not None:
            # Buffered response.close() may wait for a concurrent read lock.
            # Socket shutdown above makes real reads return; this also supports
            # close-interruptible test transports without blocking the caller.
            threading.Thread(target=_close_response, args=(response,), daemon=True).start()

    def close_sockets(self) -> None:
        with self._lock:
            sockets, self._sockets = self._sockets, []
        for sock in sockets:
            try:
                sock.close()
            except OSError:
                pass


def _close_response(response: Any) -> None:
    close = getattr(response, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - cleanup must not hide the outcome
            log.debug("Contact research response cleanup failed")


class GatewayContactResearchFetcher:
    """Fetch opted-in public pages with one byte limit and deadline per source."""

    def __init__(
        self,
        *,
        policy: ContactResearchSourcePolicy,
        session: PolitenessSession | None = None,
        recorder_conn=None,
        timeout: float = _DEFAULT_TIMEOUT,
        opener: urllib.request.OpenerDirector | None = None,
        target_resolver: TargetResolver | None = None,
        max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES,
        max_redirects: int = _MAX_REDIRECTS,
        cancel_event: threading.Event | None = None,
    ) -> None:
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("Contact research timeout must be finite and positive")
        if not isinstance(max_body_bytes, int) or isinstance(max_body_bytes, bool) or max_body_bytes <= 0:
            raise ValueError("Contact research byte limit must be a positive integer")
        if not isinstance(max_redirects, int) or max_redirects < 0:
            raise ValueError("Contact research redirect limit must be non-negative")
        self._policy = policy
        self._timeout = timeout
        self._max_body_bytes = max_body_bytes
        self._max_redirects = max_redirects
        self._cancel_event = cancel_event
        self._target_resolver = target_resolver or _resolve_target_addresses
        self._resolver = _resolver_from_target_resolver(self._target_resolver)
        self._opener = opener
        self._session = session or PolitenessSession(
            PolitenessGateway(),
            policy=policy.source_policy,
            budget=RunBudgetCounter(policy.source_policy.max_requests_per_run),
            context=PolitenessSourceContext(
                stage="contact_research", adapter="contact_research_fetcher"
            ),
            recorder_conn=recorder_conn,
        )

    def fetch(self, url: str) -> ResearchPageFetch:
        deadline = time.monotonic() + self._timeout
        redirects_remaining = self._max_redirects
        current = url
        while True:
            self._check_cancelled()
            if not self._source_allowed(current):
                return ResearchPageFetch(outcome=ResearchSourceOutcome.REJECTED.value, final_url=current)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return self._timeout_result(current)
            retry_after = None
            try:
                with self._session.guard(
                    current, timeout_seconds=remaining, cancel_event=self._cancel_event,
                ) as decision:
                    self._check_cancelled()
                    if not decision.allowed:
                        return ResearchPageFetch(outcome=decision.outcome.value, final_url=current)
                    hop = self._bounded_get(
                        current, {**decision.request_headers, "User-Agent": decision.user_agent}, deadline,
                    )
                    if hop.result is not None and hop.result.outcome == ResearchSourceOutcome.RATE_LIMITED.value:
                        retry_after = parse_retry_after(hop.retry_after)
                        if retry_after:
                            # Publish the host cooldown before another queued
                            # request can acquire this slot.
                            self._session.note_retry_after(current, retry_after)
            except TimeoutError:
                return self._timeout_result(current)
            # Release the host slot before a redirected hop requests its own slot.
            self._check_cancelled()
            if hop.result is not None:
                if hop.result.outcome == ResearchSourceOutcome.RATE_LIMITED.value:
                    self._session.record_server_rate_limit(current, retry_after)
                return hop.result
            if hop.redirect is None:
                return ResearchPageFetch(
                    outcome=ResearchSourceOutcome.ALLOWED.value,
                    text=_visible_text(hop.body), final_url=current, status=hop.status,
                )
            if redirects_remaining <= 0 or not hop.redirect:
                return ResearchPageFetch(
                    outcome=ResearchSourceOutcome.REDIRECT_FAILED.value, final_url=current, status=hop.status,
                )
            current = urllib.parse.urljoin(current, hop.redirect)
            redirects_remaining -= 1

    def _check_cancelled(self) -> None:
        if self._cancel_event is not None and self._cancel_event.is_set():
            raise CancelledError()

    @staticmethod
    def _timeout_result(url: str) -> ResearchPageFetch:
        return ResearchPageFetch(outcome=ResearchSourceOutcome.ACQUISITION_TIMEOUT.value, final_url=url)

    def _bounded_get(self, url: str, headers: Mapping[str, str], deadline: float) -> _Hop:
        operation = _Acquisition(deadline, self._cancel_event)
        while True:
            self._check_cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return _Hop(result=self._timeout_result(url))
            if _ACQUISITION_SLOTS.acquire(timeout=min(remaining, 0.05)):
                break
        done = threading.Event()
        values: list[_Hop | BaseException] = []

        def run() -> None:
            try:
                values.append(self._get(url, headers, operation))
            except BaseException as exc:  # propagate bugs/cancellation to the caller
                values.append(exc)
            finally:
                operation.close_sockets()
                _ACQUISITION_SLOTS.release()
                done.set()

        try:
            threading.Thread(target=run, name="contact-page-acquisition", daemon=True).start()
        except BaseException:
            _ACQUISITION_SLOTS.release()
            raise
        while True:
            remaining = deadline - time.monotonic()
            if done.wait(timeout=max(0, min(remaining, 0.05))):
                self._check_cancelled()
                if time.monotonic() >= deadline:
                    return _Hop(result=self._timeout_result(url))
                value = values[0]
                if isinstance(value, BaseException):
                    raise value
                return value
            if (self._cancel_event is not None and self._cancel_event.is_set()) or remaining <= 0:
                operation.abort()
                # Give an interrupted response a chance to close before releasing
                # the host slot; uninterruptible DNS remains bounded by the pool.
                done.wait(0.05)
                self._check_cancelled()
                return _Hop(result=self._timeout_result(url))

    def _get(self, url: str, headers: Mapping[str, str], operation: _Acquisition) -> _Hop:
        def resolver(*args: Any, **kwargs: Any):
            operation.check()
            try:
                result = self._resolver(*args, **kwargs)
            except OSError as exc:
                if classify_public_fetch_failure(exc) is PublicFetchFailureKind.TIMEOUT:
                    raise _ResolverTimeout() from exc
                raise
            operation.check()
            return result

        try:
            public_decision = validate_public_http_url(url, resolver=resolver)
            operation.check()
            if not public_decision.allowed:
                outcome = (ResearchSourceOutcome.TRANSPORT_FAILED if public_decision.failure_kind is PublicFetchFailureKind.DNS_FAILURE
                           else ResearchSourceOutcome.REJECTED)
                return _Hop(result=ResearchPageFetch(outcome=outcome.value, final_url=url))
            request = urllib.request.Request(url, method="GET")
            for key, value in headers.items():
                request.add_header(key, value)
            request.add_header("Accept", "text/html, */*;q=0.8")
            opener = self._opener or build_public_http_opener(
                resolver=resolver, socket_factory=operation.socket_factory, follow_redirects=False,
            )
            with opener.open(request, timeout=operation.remaining()) as response:
                operation.set_response(response)
                final_url = response.geturl()
                if final_url != url:
                    final = validate_public_http_url(final_url, resolver=resolver)
                    operation.check()
                    if not self._source_allowed(final_url) or not final.allowed:
                        return _Hop(result=ResearchPageFetch(
                            outcome=ResearchSourceOutcome.REJECTED.value, final_url=final_url,
                            status=getattr(response, "status", None),
                        ))
                status = getattr(response, "status", None)
                if status is not None and not 200 <= int(status) < 300:
                    return _Hop(result=ResearchPageFetch(
                        outcome=ResearchSourceOutcome.HTTP_ERROR.value, final_url=final_url, status=int(status),
                    ))
                response_headers = getattr(response, "headers", None)
                declared = response_headers.get("Content-Length") if response_headers else None
                if declared and declared.isascii() and declared.isdecimal():
                    try:
                        if int(declared) > self._max_body_bytes:
                            return _Hop(result=ResearchPageFetch(
                                outcome=ResearchSourceOutcome.RESPONSE_TOO_LARGE.value, final_url=final_url,
                            ))
                    except ValueError:
                        # Absurd decimal headers remain subject to the streamed limit.
                        return _Hop(result=ResearchPageFetch(
                            outcome=ResearchSourceOutcome.RESPONSE_TOO_LARGE.value, final_url=final_url,
                        ))
                chunks: list[bytes] = []
                received = 0
                read = getattr(response, "read1", None) or response.read
                while True:
                    operation.check()
                    chunk = read(min(_READ_CHUNK_BYTES, self._max_body_bytes + 1 - received))
                    operation.check()
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > self._max_body_bytes:
                        return _Hop(result=ResearchPageFetch(
                            outcome=ResearchSourceOutcome.RESPONSE_TOO_LARGE.value, final_url=final_url,
                        ))
                    chunks.append(chunk)
                if final_url != url:
                    # The normal opener never follows redirects; preserve a valid
                    # final URL from explicitly injected transports.
                    return _Hop(result=ResearchPageFetch(
                        outcome=ResearchSourceOutcome.ALLOWED.value, text=_visible_text(b"".join(chunks)),
                        final_url=final_url, status=int(status) if status is not None else None,
                    ))
                return _Hop(body=b"".join(chunks), status=int(status) if status is not None else None)
        except urllib.error.HTTPError as exc:
            try:
                if exc.code in _REDIRECT_STATUS_CODES:
                    location = exc.headers.get("Location") if exc.headers else None
                    return _Hop(redirect=location or "", status=exc.code)
                if exc.code in (429, 503):
                    return _Hop(
                        result=ResearchPageFetch(outcome=ResearchSourceOutcome.RATE_LIMITED.value, final_url=url),
                        retry_after=exc.headers.get("Retry-After") if exc.headers else None,
                    )
                return _Hop(result=ResearchPageFetch(
                    outcome=ResearchSourceOutcome.HTTP_ERROR.value, final_url=url, status=exc.code,
                ))
            finally:
                exc.close()
        except UnsafePublicDestinationError as exc:
            outcome = (ResearchSourceOutcome.TRANSPORT_FAILED if exc.failure_kind is PublicFetchFailureKind.DNS_FAILURE
                       else ResearchSourceOutcome.REJECTED)
            return _Hop(result=ResearchPageFetch(outcome=outcome.value, final_url=url))
        except _ResolverTimeout:
            return _Hop(result=self._timeout_result(url))
        except (OSError, urllib.error.URLError, ValueError, http.client.HTTPException) as exc:
            outcome = (ResearchSourceOutcome.ACQUISITION_TIMEOUT
                       if classify_public_fetch_failure(exc) is PublicFetchFailureKind.TIMEOUT
                       else ResearchSourceOutcome.TRANSPORT_FAILED)
            return _Hop(result=ResearchPageFetch(outcome=outcome.value, final_url=url))

    def _source_allowed(self, url: str) -> bool:
        return (
            self._policy.authorize(category=ResearchSourceCategory.PUBLIC_WEB_PAGE.value, url=url)
            is ResearchSourceDecision.ALLOWED
        )


def _visible_text(body: bytes) -> str:
    try:
        soup = BeautifulSoup(body, "html.parser")
    except Exception:  # noqa: BLE001 — a parse failure yields no text, an outcome not a crash
        return ""
    for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
        tag.decompose()
    return soup.get_text(separator="\n", strip=True)[:_MAX_TEXT_CHARS]


def _resolve_target_addresses(hostname: str, port: int | None) -> tuple[str, ...]:
    try:
        results = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return ()
    addresses: list[str] = []
    for result in results:
        sockaddr = result[4]
        if sockaddr:
            addresses.append(str(sockaddr[0]))
    return tuple(dict.fromkeys(addresses))


def _resolver_from_target_resolver(target_resolver: TargetResolver) -> Resolver:
    def _resolve(host: str, port: int | None, *_args: object, **_kwargs: object):
        resolved_port = int(port or 0)
        infos = []
        for address in target_resolver(host, port):
            family = socket.AF_INET6 if ":" in address else socket.AF_INET
            sockaddr = (
                (address, resolved_port, 0, 0)
                if family == socket.AF_INET6
                else (address, resolved_port)
            )
            infos.append((family, socket.SOCK_STREAM, 0, "", sockaddr))
        return infos

    return _resolve
