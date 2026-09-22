"""Execution-bound Discovery with preferred live Chrome and guarded provider HTTP.

The live Chrome client talks only to the loopback JobCtrl API broker; its paired
extension owns those remote page/API requests. When the extension is unavailable
at setup, the JobStreaming registry uses anonymous provider HTTP with public
destination checks and pinned connections. Neither path copies a browser profile.
Temporal remains the durability authority and broker request/result envelopes
stay in process memory. Downstream extraction can persist posting text and send
captured content to configured LLM providers.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import requests
from urllib3 import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.connection import HTTPConnection, HTTPSConnection

from jobctrl import config
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.errors import ConfigurationError, JobCtrlError, TransientNetworkError
from jobctrl.infrastructure.network.fetch_failures import PublicFetchFailureKind
from jobctrl.infrastructure.network.public_http import UnsafePublicDestinationError, create_public_connection
from jobctrl.infrastructure.network.url_safety import validate_public_http_url


DiscoveryBrowserSourceFamily = Literal[
    "jobspy",
    "ats_api",
    "workday",
    "smartextract",
    "enrichment",
]
ApiTransport = Callable[[str, str, bytes | None, Mapping[str, str], float], tuple[int, bytes]]

_TOKEN_FILENAME = "extension-capability-token"
_FORBIDDEN_BROWSER_HEADERS = frozenset(
    {
        "connection",
        "content-length",
        "cookie",
        "host",
        "origin",
        "referer",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "user-agent",
    }
)


@dataclass(frozen=True, slots=True)
class LiveBrowserResult:
    final_url: str
    status_code: int | None
    content_type: str
    title: str
    body_text: str
    body_html: str | None = None
    browser_user_agent: str = ""


class LiveBrowserHttpError(RuntimeError):
    """HTTP status failure returned by a remote site through Chrome."""

    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        super().__init__(message)


class LiveBrowserTaskError(JobCtrlError):
    """One remote acquisition failed; other targets may still make progress."""

    def __init__(self, message: str, *, code: str, retryable: bool) -> None:
        self.code = code
        self.retryable = retryable
        super().__init__(message)


class _DiscoveryCapacityBusy(TransientNetworkError):
    """The bounded extension executor pool is full; retry admission locally."""


class LiveChromeDiscoveryClient:
    """Submit bounded acquisition tasks to the extension installed in Chrome."""

    def __init__(
        self,
        execution: DiscoveryExecutionRef,
        *,
        source_family: DiscoveryBrowserSourceFamily,
        source_id: str | None = None,
        cancel_event: threading.Event | None = None,
        app_dir: Path | None = None,
        api_base_url: str | None = None,
        transport: ApiTransport | None = None,
        poll_interval_seconds: float = 0.2,
    ) -> None:
        self.execution = execution
        self.source_family = source_family
        self.source_id = str(source_id or "").strip()[:200] or None
        self.cancel_event = cancel_event
        self.app_dir = Path(app_dir or config.APP_DIR)
        self.api_base_url = (api_base_url or _default_api_base_url()).rstrip("/")
        self._transport = transport or _urllib_transport
        self._poll_interval_seconds = max(0.01, poll_interval_seconds)
        self._token: str | None = None

    def ensure_available(self) -> None:
        status = self._api_json(
            "GET", "/v1/discovery/browser-extension/status", authenticated=False, timeout_seconds=1.0
        )
        if status.get("connected") is not True:
            raise ConfigurationError(
                "The paired JobCtrl extension is not connected in the user's Chrome profile."
            )

    def request(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Mapping[str, object] | None = None,
        body: str | None = None,
        timeout_seconds: float = 60.0,
    ) -> LiveBrowserResult:
        normalized_method = method.upper()
        if normalized_method not in {"GET", "POST"}:
            raise ValueError("live Chrome Discovery supports only GET and POST")
        if normalized_method == "GET" and body is not None:
            raise ValueError("GET live Chrome Discovery requests cannot include a body")
        request_payload: dict[str, Any] = {
            "mode": "http_request",
            "url": str(url),
            "method": normalized_method,
            "headers": _safe_headers(headers or {}),
        }
        if body is not None:
            request_payload["body"] = body
        return self._execute(request_payload, timeout_seconds=timeout_seconds)

    def rendered_page(self, url: str, *, timeout_seconds: float = 60.0) -> LiveBrowserResult:
        return self._execute(
            {"mode": "rendered_page", "url": str(url)},
            timeout_seconds=timeout_seconds,
        )

    def fetch_json(
        self,
        url: str,
        *,
        method: str = "GET",
        json_body: dict[str, Any] | None = None,
        timeout: float | None = None,
        headers: Mapping[str, object] | None = None,
    ) -> Any:
        merged_headers = dict(headers or {})
        merged_headers.setdefault("Accept", "application/json")
        body = None
        if json_body is not None:
            merged_headers.setdefault("Content-Type", "application/json")
            body = json.dumps(json_body, separators=(",", ":"), ensure_ascii=False)
        response = self.request(
            url,
            method=method,
            headers=merged_headers,
            body=body,
            timeout_seconds=timeout or 60.0,
        )
        if response.status_code is not None and not 200 <= response.status_code < 400:
            raise LiveBrowserHttpError(response.status_code, f"Discovery source returned HTTP {response.status_code}")
        try:
            return json.loads(response.body_text)
        except json.JSONDecodeError as exc:
            raise LiveBrowserTaskError(
                "Discovery source returned invalid JSON through Chrome", code="invalid_json", retryable=True
            ) from exc

    def _execute(self, request_payload: dict[str, Any], *, timeout_seconds: float) -> LiveBrowserResult:
        timeout_ms = min(120_000, max(1_000, int(timeout_seconds * 1_000)))
        task_input: dict[str, Any] = {
            "workflowId": self.execution.workflow_id,
            "temporalRunId": self.execution.temporal_run_id,
            "sourceFamily": self.source_family,
            "request": request_payload,
            "timeoutMs": timeout_ms,
        }
        if self.source_id is not None:
            task_input["sourceId"] = self.source_id
        task_input["taskId"] = _task_id(task_input)
        task_id = str(task_input["taskId"])
        self._check_canceled(task_id=None)
        admission_deadline = time.monotonic() + 30.0
        while True:
            self._check_canceled(task_id=None)
            try:
                accepted = self._api_json(
                    "POST",
                    "/v1/extension/discovery/tasks",
                    payload=task_input,
                    authenticated=True,
                )
                break
            except _DiscoveryCapacityBusy as exc:
                if time.monotonic() >= admission_deadline:
                    raise TransientNetworkError(
                        "Timed out waiting for capacity in the user's Chrome extension"
                    ) from exc
                time.sleep(self._poll_interval_seconds)
        if accepted.get("taskId") != task_id:
            raise TransientNetworkError("JobCtrl returned a mismatched Discovery browser task")

        queue_deadline = time.monotonic() + 30.0
        execution_deadline: float | None = None
        try:
            while True:
                self._check_canceled(task_id=task_id)
                status = self._api_json(
                    "GET",
                    f"/v1/extension/discovery/tasks/{urllib.parse.quote(task_id, safe='')}",
                    authenticated=True,
                )
                state = status.get("status")
                now = time.monotonic()
                if state == "pending":
                    if now >= queue_deadline:
                        raise TransientNetworkError(
                            "Timed out waiting for capacity in the user's Chrome extension"
                        )
                    time.sleep(self._poll_interval_seconds)
                    continue
                if state == "leased":
                    if execution_deadline is None:
                        execution_deadline = now + (timeout_ms / 1_000) + 20.0
                    if now >= execution_deadline:
                        raise TransientNetworkError(
                            "Timed out waiting for the user's Chrome extension to complete Discovery"
                        )
                    time.sleep(self._poll_interval_seconds)
                    continue
                result = status.get("result")
                if not isinstance(result, dict):
                    raise TransientNetworkError("JobCtrl returned an invalid Discovery browser result")
                if state == "failed" or result.get("status") == "failed":
                    message = str(result.get("message") or "Chrome could not complete the Discovery request")
                    raise LiveBrowserTaskError(
                        message,
                        code=str(result.get("errorCode") or "request_failed"),
                        retryable=bool(result.get("retryable")),
                    )
                if state != "succeeded" or result.get("status") != "succeeded":
                    raise TransientNetworkError("JobCtrl returned an unknown Discovery browser task state")
                return LiveBrowserResult(
                    final_url=str(result.get("finalUrl") or ""),
                    status_code=(int(result["statusCode"]) if result.get("statusCode") is not None else None),
                    content_type=str(result.get("contentType") or ""),
                    title=str(result.get("title") or ""),
                    body_text=str(result.get("bodyText") or ""),
                    body_html=(str(result["bodyHtml"]) if result.get("bodyHtml") is not None else None),
                    browser_user_agent=str(result.get("browserUserAgent") or ""),
                )
        finally:
            try:
                self._api_json(
                    "DELETE",
                    f"/v1/extension/discovery/tasks/{urllib.parse.quote(task_id, safe='')}",
                    authenticated=True,
                    allow_empty=True,
                )
            except (ConfigurationError, TransientNetworkError, LiveBrowserTaskError):
                pass

    def _check_canceled(self, *, task_id: str | None) -> None:
        if self.cancel_event is None or not self.cancel_event.is_set():
            return
        if task_id is not None:
            try:
                self._api_json(
                    "DELETE",
                    f"/v1/extension/discovery/tasks/{urllib.parse.quote(task_id, safe='')}",
                    authenticated=True,
                    allow_empty=True,
                )
            except (ConfigurationError, TransientNetworkError, LiveBrowserTaskError):
                pass
        raise TransientNetworkError("Discovery browser request canceled")

    def _api_json(
        self,
        method: str,
        path: str,
        *,
        payload: Mapping[str, Any] | None = None,
        authenticated: bool,
        allow_empty: bool = False,
        timeout_seconds: float = 5.0,
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = f"Bearer {self._capability_token()}"
        data = None
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            status_code, raw = self._transport(
                method,
                f"{self.api_base_url}{path}",
                data,
                headers,
                timeout_seconds,
            )
        except (OSError, urllib.error.URLError) as exc:
            raise TransientNetworkError("The local JobCtrl API is unavailable for Discovery browser work") from exc
        if not raw and allow_empty and status_code in {200, 202, 204}:
            return {}
        try:
            response = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TransientNetworkError("The local JobCtrl API returned an invalid Discovery response") from exc
        if not isinstance(response, dict):
            raise TransientNetworkError("The local JobCtrl API returned an invalid Discovery response")
        if status_code >= 400:
            error_code = str(response.get("error") or "")
            message = str(response.get("message") or "Discovery browser bridge request failed")
            if status_code == 429 and error_code == "discovery_browser_capacity":
                raise _DiscoveryCapacityBusy(message)
            if status_code in {401, 403} or error_code == "discovery_extension_unavailable":
                raise ConfigurationError(message)
            if status_code == 400 and method == "POST" and path == "/v1/extension/discovery/tasks":
                raise LiveBrowserTaskError(message, code=error_code or "request_rejected", retryable=False)
            raise TransientNetworkError(message)
        return response

    def _capability_token(self) -> str:
        if self._token is None:
            token_path = self.app_dir / _TOKEN_FILENAME
            try:
                token = token_path.read_text(encoding="utf-8").strip()
            except OSError as exc:
                raise ConfigurationError("JobCtrl extension pairing token is missing; pair the extension in Settings") from exc
            if not token:
                raise ConfigurationError("JobCtrl extension pairing token is empty; pair the extension in Settings")
            self._token = token
        return self._token


class LiveChromeResponse:
    """Small requests/tls-client-compatible response used by JobStreaming."""

    def __init__(self, result: LiveBrowserResult) -> None:
        self.status_code = result.status_code or 200
        self.text = result.body_text
        self.content = result.body_text.encode("utf-8")
        self.url = result.final_url
        self.headers = {"Content-Type": result.content_type}
        self.ok = 200 <= self.status_code < 400

    def json(self) -> Any:
        return json.loads(self.text)

    def raise_for_status(self) -> None:
        if not self.ok:
            raise LiveBrowserHttpError(self.status_code, f"Discovery source returned HTTP {self.status_code}")


class LiveChromeSession:
    """requests/tls-client-shaped session whose only transport is the extension."""

    def __init__(self, client: LiveChromeDiscoveryClient) -> None:
        self.client = client
        self.headers: dict[str, str] = {}

    def get(self, url: str, **kwargs: Any) -> LiveChromeResponse:
        return self._request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> LiveChromeResponse:
        return self._request("POST", url, **kwargs)

    def close(self) -> None:
        return None

    def _request(self, method: str, url: str, **kwargs: Any) -> LiveChromeResponse:
        params = kwargs.pop("params", None)
        headers = {**self.headers, **dict(kwargs.pop("headers", {}) or {})}
        json_body = kwargs.pop("json", None)
        data = kwargs.pop("data", None)
        timeout = kwargs.pop("timeout", kwargs.pop("timeout_seconds", 60.0))
        if params:
            query = urllib.parse.urlencode(params, doseq=True)
            url = f"{url}{'&' if urllib.parse.urlsplit(url).query else '?'}{query}"
        body: str | None = None
        if json_body is not None:
            headers.setdefault("Content-Type", "application/json")
            body = json.dumps(json_body, separators=(",", ":"), ensure_ascii=False)
        elif data is not None:
            if isinstance(data, bytes):
                body = data.decode("utf-8")
            elif isinstance(data, str):
                body = data
            elif isinstance(data, Mapping):
                headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
                body = urllib.parse.urlencode(data, doseq=True)
            else:
                body = str(data)
        result = self.client.request(
            url,
            method=method,
            headers=headers,
            body=body,
            timeout_seconds=float(timeout or 60.0),
        )
        return LiveChromeResponse(result)


class PoliteLiveChromeHttpClient:
    """Apply JobCtrl's source policy before delegating acquisition to Chrome."""

    def __init__(self, session: Any, client: LiveChromeDiscoveryClient, *, default_timeout: float = 20.0) -> None:
        self._session = session
        self._client = client
        self._default_timeout = default_timeout

    def fetch_json(
        self,
        url: str,
        *,
        method: str = "GET",
        json_body: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        with self._session.guard(url) as decision:
            if not decision.allowed:
                return None
            try:
                return self._client.fetch_json(
                    url,
                    method=method,
                    json_body=json_body,
                    timeout=timeout or self._default_timeout,
                )
            except LiveBrowserHttpError as exc:
                if exc.status_code in {429, 503}:
                    self._session.record_server_rate_limit(url, None)
                    return None
                raise

    def fetch_text(
        self,
        url: str,
        *,
        timeout: float | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> str | None:
        with self._session.guard(url) as decision:
            if not decision.allowed:
                return None
            result = self._client.request(
                url,
                method="GET",
                headers=extra_headers,
                timeout_seconds=timeout or self._default_timeout,
            )
            if result.status_code in {429, 503}:
                self._session.record_server_rate_limit(url, None)
                return None
            if result.status_code is not None and not 200 <= result.status_code < 400:
                raise LiveBrowserHttpError(
                    result.status_code,
                    f"Discovery source returned HTTP {result.status_code}",
                )
            return result.body_text

    def rendered_page(self, url: str, *, timeout: float | None = None) -> LiveBrowserResult | None:
        with self._session.guard(url) as decision:
            if not decision.allowed:
                return None
            return self._client.rendered_page(url, timeout_seconds=timeout or self._default_timeout)


def prefer_live_browser(
    client: LiveChromeDiscoveryClient,
    *,
    cancel_event: threading.Event | None = None,
) -> LiveChromeDiscoveryClient | None:
    """Choose once at setup; acquisition errors never trigger another transport.

    Only the loopback availability probe can select anonymous acquisition. A
    selected extension still enforces token authentication and execution fences
    on every task, and a later disconnect fails that acquisition normally.
    """

    if cancel_event is not None and cancel_event.is_set():
        raise TransientNetworkError("Discovery acquisition canceled")
    available = True
    try:
        client.ensure_available()
    except (ConfigurationError, TransientNetworkError):
        available = False
    if cancel_event is not None and cancel_event.is_set():
        raise TransientNetworkError("Discovery acquisition canceled")
    return client if available else None


def live_jobstreaming_registry(
    execution: DiscoveryExecutionRef,
    *,
    cancel_event: threading.Event | None = None,
) -> Any:
    """Prefer live Chrome per adapter setup; keep provider HTTP when offline."""

    from jobstreaming import default_registry

    source = default_registry()
    registry = source.copy()
    for site in source.sites:

        def factory(*, _site: Any = site, **kwargs: Any) -> Any:
            adapter = source.create(_site, **kwargs)
            client = LiveChromeDiscoveryClient(
                execution,
                source_family="jobspy",
                source_id=f"jobspy:{_site.value}",
                cancel_event=cancel_event,
            )
            if prefer_live_browser(client, cancel_event=cancel_event) is None:
                original_track = adapter.track_transport

                def track_public(transport: Any) -> Any:
                    original_track(transport)
                    return original_track(_public_provider_session(transport, cancel_event=cancel_event))

                adapter.track_transport = track_public
                if getattr(adapter, "session", None) is not None:
                    adapter.session = track_public(adapter.session)
                return adapter
            session = LiveChromeSession(client)
            original_session = getattr(adapter, "session", None)
            if original_session is not None:
                session.headers.update(dict(getattr(original_session, "headers", {}) or {}))

            # Some provider adapters replace their session inside scrape() or
            # create per-detail sessions. Returning this session from their own
            # transport hook keeps those code paths on the same extension-only
            # boundary without changing JobStreaming's parsers or checkpoints.
            adapter.track_transport = lambda _transport: session
            adapter.session = session
            return adapter

        registry.register(site, factory, replace=True)
    return registry


class _PublicHTTPConnection(HTTPConnection):
    def _new_conn(self) -> Any:
        return create_public_connection((self.host, self.port), self.timeout, self.source_address)


class _PublicHTTPSConnection(HTTPSConnection):
    def _new_conn(self) -> Any:
        return create_public_connection((self.host, self.port), self.timeout, self.source_address)


class _PublicHTTPPool(HTTPConnectionPool):
    ConnectionCls = _PublicHTTPConnection


class _PublicHTTPSPool(HTTPSConnectionPool):
    ConnectionCls = _PublicHTTPSConnection


class _PublicProviderAdapter(requests.adapters.HTTPAdapter):
    """Keep Requests pooling/TLS semantics while pinning each new socket."""

    @staticmethod
    def _guard_pools(manager: Any) -> None:
        # PoolManager's default mapping is shared globally; only change ours.
        manager.pool_classes_by_scheme = {"http": _PublicHTTPPool, "https": _PublicHTTPSPool}

    def init_poolmanager(self, *args: Any, **kwargs: Any) -> None:
        super().init_poolmanager(*args, **kwargs)
        self._guard_pools(self.poolmanager)

    def proxy_manager_for(self, proxy: str, **kwargs: Any) -> Any:
        raise ConfigurationError("Anonymous Discovery cannot pin destination DNS through a proxy")


def _public_provider_session(transport: Any, *, cancel_event: threading.Event | None) -> requests.Session:
    """Guard native provider sends, including redirects and recreated sessions.

    Requests sessions keep their provider configuration. tls-client has no
    public-address socket hook, so those providers use Requests with compatible
    request options, headers and cookies in anonymous mode. Configured proxy
    routing is retained so the guard rejects it instead of silently going direct.
    """
    from jobstreaming.util import RequestsRotating, TLSRotating

    if isinstance(transport, TLSRotating):
        class PublicTLSCompatibleSession(RequestsRotating):
            def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
                kwargs.setdefault("allow_redirects", False)
                if "timeout_seconds" in kwargs:
                    kwargs["timeout"] = kwargs.pop("timeout_seconds")
                kwargs.setdefault("timeout", transport.timeout_seconds)
                if "insecure_skip_verify" in kwargs:
                    kwargs["verify"] = not kwargs.pop("insecure_skip_verify")
                if "proxy" in kwargs:
                    proxy = kwargs.pop("proxy")
                    kwargs["proxies"] = {"http": proxy, "https": proxy} if isinstance(proxy, str) else proxy
                return super().request(method, url, **kwargs)

            def get(self, url: str, **kwargs: Any) -> requests.Response:
                return self.request("GET", url, **kwargs)

            execute_request = request

        session = PublicTLSCompatibleSession()
        session.headers.update(transport.headers or {})
        session.cookies = transport.cookies
        session.proxies = transport.proxies
        session.proxy_cycle = transport.proxy_cycle
    elif isinstance(transport, requests.Session):
        session = transport
    else:
        raise ConfigurationError("Unsupported anonymous Discovery provider transport")

    # Requests otherwise discovers local netrc credentials before send() and
    # again when rebuilding redirect auth. Anonymous acquisition must not adopt
    # them; explicit provider headers/auth and cookies retain Requests semantics.
    session.trust_env = False
    if getattr(session, "_jobctrl_public_guarded", False):
        return session
    original_send = session.send

    def send_public(request: requests.PreparedRequest, **kwargs: Any) -> requests.Response:
        if cancel_event is not None and cancel_event.is_set():
            raise TransientNetworkError("Discovery acquisition canceled")
        decision = validate_public_http_url(request.url)
        if not decision.allowed:
            raise UnsafePublicDestinationError(
                decision.reason or "URL is not a public HTTP(S) destination",
                failure_kind=decision.failure_kind or PublicFetchFailureKind.UNSAFE_DESTINATION,
                destination_url=request.url,
            )
        proxies = kwargs.get("proxies") or {}
        # trust_env=False also disables automatic environment proxy selection.
        # Check it explicitly on every hop so it cannot silently become direct.
        environment_proxies = requests.utils.get_environ_proxies(request.url, no_proxy=proxies.get("no_proxy"))
        if requests.utils.select_proxy(request.url, proxies) or requests.utils.select_proxy(
            request.url, environment_proxies
        ):
            raise ConfigurationError("Anonymous Discovery cannot pin destination DNS through a proxy")
        if cancel_event is not None and cancel_event.is_set():
            raise TransientNetworkError("Discovery acquisition canceled")
        return original_send(request, **kwargs)

    # Requests follows redirects through self.send(), so each hop re-enters the
    # URL check. The connection classes resolve/check again and connect to the
    # validated numeric address, closing the DNS check/use gap for direct fetches.
    session.send = send_public
    for scheme in ("http://", "https://"):
        previous = session.adapters.get(scheme)
        session.mount(scheme, _PublicProviderAdapter())
        if previous is not None:
            previous.close()
    session._jobctrl_public_guarded = True
    return session


def _safe_headers(headers: Mapping[str, object]) -> dict[str, str]:
    safe: dict[str, str] = {}
    for name, value in headers.items():
        normalized = str(name).strip()
        normalized_folded = normalized.casefold()
        if (
            not normalized
            or normalized_folded in _FORBIDDEN_BROWSER_HEADERS
            or normalized_folded.startswith(("sec-", "proxy-"))
        ):
            continue
        safe[normalized[:80]] = str(value)[:4096]
        if len(safe) >= 32:
            break
    return safe


def _task_id(task_input: Mapping[str, Any]) -> str:
    canonical = json.dumps(task_input, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:40]
    return f"discover-browser:{digest}"


def _default_api_base_url() -> str:
    raw_port = os.environ.get("JOBCTRL_API_PORT") or os.environ.get("PORT") or "8766"
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise ConfigurationError("JOBCTRL_API_PORT must be an integer") from exc
    if not 1 <= port <= 65535:
        raise ConfigurationError("JOBCTRL_API_PORT must be between 1 and 65535")
    return f"http://127.0.0.1:{port}"


def _urllib_transport(
    method: str,
    url: str,
    data: bytes | None,
    headers: Mapping[str, str],
    timeout: float,
) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=data, headers=dict(headers), method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed loopback base URL
            return int(response.status), response.read()
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read()


__all__ = [
    "LiveBrowserHttpError",
    "LiveBrowserResult",
    "LiveChromeDiscoveryClient",
    "LiveChromeResponse",
    "LiveChromeSession",
    "PoliteLiveChromeHttpClient",
    "live_jobstreaming_registry",
    "prefer_live_browser",
]
