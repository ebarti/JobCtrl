"""Execution-bound Discovery acquisition through the user's live Chrome profile.

The paired extension owns every remote page/API request. This worker-side client
talks only to the loopback JobCtrl API broker, so it neither launches Chrome nor
copies a browser profile. Temporal remains the durability authority: brokered
request bodies and authenticated page content stay process-memory-only.
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
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

from jobctrl import config
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.errors import ConfigurationError, TransientNetworkError
from jobctrl.domain.ports.politeness import RobotsPort, RobotsVerdict


DiscoveryBrowserSourceFamily = Literal[
    "jobspy",
    "ats_api",
    "workday",
    "smartextract",
    "enrichment",
]
ApiTransport = Callable[[str, str, bytes | None, Mapping[str, str], float], tuple[int, bytes]]

_TOKEN_FILENAME = "extension-capability-token"
_ROBOTS_TTL_SECONDS = 3_600.0
_ROBOTS_UNREACHABLE_TTL_SECONDS = 300.0
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


class _DiscoveryCapacityBusy(TransientNetworkError):
    """The bounded extension executor pool is full; retry admission locally."""


@dataclass(frozen=True, slots=True)
class _LiveRobotsEntry:
    parser: RobotFileParser | None
    verdict: RobotsVerdict | None
    expires_at: float
    browser_user_agent: str


class LiveChromeRobotsCache(RobotsPort):
    """Evaluate robots.txt through the same live-profile extension boundary."""

    def __init__(
        self,
        client: LiveChromeDiscoveryClient,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._clock = clock
        self._lock = threading.Lock()
        self._cache: dict[str, _LiveRobotsEntry] = {}

    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:
        parts = urlsplit(url)
        if not parts.scheme or not parts.netloc:
            return RobotsVerdict.UNKNOWN
        host_key = f"{parts.scheme}://{parts.netloc}"
        now = self._clock()
        with self._lock:
            entry = self._cache.get(host_key)
            if entry is None or entry.expires_at <= now:
                entry = self._fetch(host_key, user_agent)
                self._cache[host_key] = entry
        if entry.verdict is not None:
            return entry.verdict
        if entry.parser is None:
            return RobotsVerdict.UNKNOWN
        effective_user_agent = entry.browser_user_agent or user_agent
        return RobotsVerdict.ALLOW if entry.parser.can_fetch(effective_user_agent, url) else RobotsVerdict.DISALLOW

    def _fetch(self, host_key: str, fallback_user_agent: str) -> _LiveRobotsEntry:
        result = self._client.request(
            f"{host_key}/robots.txt",
            headers={"Accept": "text/plain"},
            timeout_seconds=5.0,
        )
        now = self._clock()
        status = result.status_code
        if status is not None and 400 <= status < 500:
            parser = RobotFileParser()
            parser.parse([])
            parser.modified()
            return _LiveRobotsEntry(
                parser,
                None,
                now + _ROBOTS_TTL_SECONDS,
                result.browser_user_agent or fallback_user_agent,
            )
        if status is None or status >= 500:
            return _LiveRobotsEntry(
                None,
                RobotsVerdict.UNKNOWN,
                now + _ROBOTS_UNREACHABLE_TTL_SECONDS,
                result.browser_user_agent or fallback_user_agent,
            )
        parser = RobotFileParser()
        parser.parse(result.body_text.splitlines())
        parser.modified()
        return _LiveRobotsEntry(
            parser,
            None,
            now + _ROBOTS_TTL_SECONDS,
            result.browser_user_agent or fallback_user_agent,
        )


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
        status = self._api_json("GET", "/v1/discovery/browser-extension/status", authenticated=False)
        if not bool(status.get("connected")):
            raise ConfigurationError(
                "Discovery requires the paired JobCtrl extension to be running in the user's Chrome profile."
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
            raise TransientNetworkError("Discovery source returned invalid JSON through Chrome") from exc

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
                    if bool(result.get("retryable")):
                        raise TransientNetworkError(message)
                    raise ConfigurationError(message)
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
            except (ConfigurationError, TransientNetworkError):
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
            except (ConfigurationError, TransientNetworkError):
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
                5.0,
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


def live_jobstreaming_registry(
    execution: DiscoveryExecutionRef,
    *,
    cancel_event: threading.Event | None = None,
) -> Any:
    """Return the provider registry with every adapter bound to live Chrome."""

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
    "LiveChromeRobotsCache",
    "LiveChromeResponse",
    "LiveChromeSession",
    "PoliteLiveChromeHttpClient",
    "live_jobstreaming_registry",
]
