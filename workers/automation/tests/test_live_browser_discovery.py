from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path

import pytest

from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.errors import ConfigurationError
from jobctrl.domain.ports.politeness import RobotsVerdict
from jobctrl.infrastructure.discovery.live_browser import (
    LiveBrowserResult,
    LiveChromeDiscoveryClient,
    LiveChromeRobotsCache,
    LiveChromeSession,
    PoliteLiveChromeHttpClient,
    live_jobstreaming_registry,
)
from jobctrl.infrastructure.discovery.production_wiring import run_scheduled_ats_sources


def _execution() -> DiscoveryExecutionRef:
    return DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-live-profile",
        temporal_run_id="run-live-profile",
    )


class _ScriptedTransport:
    def __init__(self, app_dir: Path) -> None:
        self.calls: list[tuple[str, str, bytes | None, Mapping[str, str]]] = []
        self.task_id = ""
        (app_dir / "extension-capability-token").write_text("paired-token\n", encoding="utf-8")

    def __call__(
        self,
        method: str,
        url: str,
        data: bytes | None,
        headers: Mapping[str, str],
        _timeout: float,
    ) -> tuple[int, bytes]:
        self.calls.append((method, url, data, dict(headers)))
        if url.endswith("/v1/discovery/browser-extension/status"):
            return 200, b'{"ok":true,"connected":true}'
        if method == "POST" and url.endswith("/v1/extension/discovery/tasks"):
            payload = json.loads((data or b"{}").decode("utf-8"))
            self.task_id = payload["taskId"]
            return 202, json.dumps({"ok": True, "taskId": self.task_id, "status": "pending"}).encode()
        if method == "GET" and "/v1/extension/discovery/tasks/" in url:
            return 200, json.dumps(
                {
                    "ok": True,
                    "taskId": self.task_id,
                    "status": "succeeded",
                    "result": {
                        "status": "succeeded",
                        "finalUrl": "https://example.com/jobs?q=platform",
                        "statusCode": 200,
                        "contentType": "application/json",
                        "title": "",
                        "bodyText": '{"jobs":[]}',
                    },
                }
            ).encode()
        if method == "DELETE" and "/v1/extension/discovery/tasks/" in url:
            return 204, b""
        raise AssertionError(f"unexpected local API call: {method} {url}")


def test_client_requires_live_extension_in_users_chrome_profile(tmp_path: Path) -> None:
    def unavailable(
        _method: str,
        _url: str,
        _data: bytes | None,
        _headers: Mapping[str, str],
        _timeout: float,
    ) -> tuple[int, bytes]:
        return 200, b'{"ok":true,"connected":false}'

    client = LiveChromeDiscoveryClient(
        _execution(),
        source_family="jobspy",
        app_dir=tmp_path,
        transport=unavailable,
    )

    with pytest.raises(ConfigurationError, match="user's Chrome profile"):
        client.ensure_available()


def test_integrated_ats_discovery_rejects_a_direct_transport_override() -> None:
    with pytest.raises(ConfigurationError, match="live Chrome extension transport"):
        run_scheduled_ats_sources(
            None,  # type: ignore[arg-type] - the invariant fails before storage access
            (),
            search_cfg={},
            run_id="run-live-profile",
            http=lambda _url: {},
            discovery_execution=_execution(),
        )


def test_client_brokers_http_acquisition_without_browser_owned_headers(tmp_path: Path) -> None:
    transport = _ScriptedTransport(tmp_path)
    client = LiveChromeDiscoveryClient(
        _execution(),
        source_family="ats_api",
        source_id="greenhouse:fixture",
        app_dir=tmp_path,
        transport=transport,
        poll_interval_seconds=0.01,
    )

    client.ensure_available()
    payload = client.fetch_json(
        "https://example.com/jobs?q=platform",
        headers={
            "Accept": "application/json",
            "Cookie": "must-not-cross",
            "User-Agent": "must-not-cross",
            "Sec-CH-UA": '"Hard-coded browser";v="1"',
            "Proxy-Authorization": "must-not-cross",
        },
    )

    assert payload == {"jobs": []}
    create = next(json.loads(call[2] or b"{}") for call in transport.calls if call[0] == "POST")
    assert create["workflowId"] == "discover-live-profile"
    assert create["temporalRunId"] == "run-live-profile"
    assert create["sourceFamily"] == "ats_api"
    assert create["sourceId"] == "greenhouse:fixture"
    assert create["request"]["headers"] == {"Accept": "application/json"}
    assert transport.calls[-1][0] == "DELETE"
    assert all(call[3].get("Authorization") == "Bearer paired-token" for call in transport.calls[1:])


def test_client_waits_for_bounded_extension_capacity_before_starting_lease_deadline(
    tmp_path: Path,
) -> None:
    scripted = _ScriptedTransport(tmp_path)
    capacity_rejections = 0

    def transport(
        method: str,
        url: str,
        data: bytes | None,
        headers: Mapping[str, str],
        timeout: float,
    ) -> tuple[int, bytes]:
        nonlocal capacity_rejections
        if method == "POST" and url.endswith("/v1/extension/discovery/tasks") and capacity_rejections < 2:
            capacity_rejections += 1
            return 429, b'{"ok":false,"error":"discovery_browser_capacity","message":"busy"}'
        return scripted(method, url, data, headers, timeout)

    client = LiveChromeDiscoveryClient(
        _execution(),
        source_family="smartextract",
        app_dir=tmp_path,
        transport=transport,
        poll_interval_seconds=0.01,
    )

    result = client.request("https://example.com/jobs?q=platform")

    assert result.status_code == 200
    assert capacity_rejections == 2


def test_jobstreaming_registry_replaces_every_provider_session_with_extension_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobstreaming import default_registry

    monkeypatch.setattr(LiveChromeDiscoveryClient, "ensure_available", lambda _self: None)
    registry = live_jobstreaming_registry(_execution())

    for site in default_registry().sites:
        adapter = registry.create(site)
        assert isinstance(adapter.session, LiveChromeSession)
        assert adapter.track_transport(object()) is adapter.session


def test_workday_client_uses_live_extension_transport_for_integrated_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.discovery import workday

    execution = _execution()
    monkeypatch.setattr(workday, "_politeness", None)
    monkeypatch.setattr(workday, "get_connection", lambda: None)
    workday.configure_workday_politeness(
        discovery_execution=execution,
        opener=object(),
    )

    client = workday._employer_client(  # noqa: SLF001 - pins the production routing seam
        {
            "name": "Acme",
            "employer_key": "acme",
            "_source_id": "workday:acme",
        }
    )

    assert isinstance(client, PoliteLiveChromeHttpClient)
    assert client._client.execution == execution  # noqa: SLF001 - routing invariant


def test_smartextract_run_passes_live_extension_client_to_every_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.discovery import smartextract

    execution = _execution()
    captured: list[PoliteLiveChromeHttpClient | None] = []
    monkeypatch.setattr(smartextract, "init_db", lambda: object())
    monkeypatch.setattr(
        smartextract,
        "get_stats",
        lambda _conn: {"total": 0, "pending_detail": 0},
    )

    def fake_run_one_site(
        name: str,
        _url: str,
        _cancel_event: object,
        browser_client: PoliteLiveChromeHttpClient | None,
    ) -> dict[str, object]:
        captured.append(browser_client)
        return {
            "name": name,
            "status": "PASS",
            "strategy": "fixture",
            "total": 0,
            "titles": 0,
            "jobs": [],
        }

    monkeypatch.setattr(smartextract, "_run_one_site", fake_run_one_site)

    result = smartextract._run_all(  # noqa: SLF001 - pins the production routing seam
        [{"name": "Acme Careers", "url": "https://careers.example.com/jobs"}],
        [],
        [],
        discovery_execution=execution,
    )

    assert result == {
        "total_new": 0,
        "total_existing": 0,
        "passed": 1,
        "errors": 0,
        "total": 1,
    }
    assert len(captured) == 1
    assert isinstance(captured[0], PoliteLiveChromeHttpClient)
    assert captured[0]._client.execution == execution  # noqa: SLF001 - routing invariant


def test_live_session_preserves_query_and_json_body_for_browser_task(tmp_path: Path) -> None:
    transport = _ScriptedTransport(tmp_path)
    session = LiveChromeSession(
        LiveChromeDiscoveryClient(
            _execution(),
            source_family="jobspy",
            source_id="jobspy:fixture",
            app_dir=tmp_path,
            transport=transport,
            poll_interval_seconds=0.01,
        )
    )
    session.headers["Accept"] = "application/json"

    response = session.post(
        "https://example.com/jobs",
        params={"q": "platform", "tag": ["staff", "principal"]},
        json={"page": 2},
        timeout=15,
    )

    assert response.ok is True
    create = next(json.loads(call[2] or b"{}") for call in transport.calls if call[0] == "POST")
    request = create["request"]
    assert request["url"] == "https://example.com/jobs?q=platform&tag=staff&tag=principal"
    assert request["method"] == "POST"
    assert json.loads(request["body"]) == {"page": 2}
    assert request["headers"] == {"Accept": "application/json", "Content-Type": "application/json"}


def test_robots_policy_is_fetched_and_cached_through_the_live_profile() -> None:
    class _RobotsClient:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def request(self, url: str, **_kwargs: object) -> LiveBrowserResult:
            self.calls.append(url)
            return LiveBrowserResult(
                final_url=url,
                status_code=200,
                content_type="text/plain",
                title="",
                body_text=(
                    "User-agent: ChromeProbe\n"
                    "Disallow: /private\n"
                    "User-agent: JobCtrl\n"
                    "Allow: /\n"
                ),
                browser_user_agent="ChromeProbe",
            )

    client = _RobotsClient()
    robots = LiveChromeRobotsCache(client)  # type: ignore[arg-type]

    assert robots.evaluate("https://example.com/public", "JobCtrl/1") is RobotsVerdict.ALLOW
    assert robots.evaluate("https://example.com/private/role", "JobCtrl/1") is RobotsVerdict.DISALLOW
    assert client.calls == ["https://example.com/robots.txt"]
