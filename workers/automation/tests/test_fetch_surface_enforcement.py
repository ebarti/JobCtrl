"""Fetch-surface enforcement tests (R10).

Proves outbound fetch surfaces route through the politeness gateway and no
longer construct ad-hoc ``urllib`` transport. This file grows one surface at a
time as each phase reroutes it; a surface that bypasses the gateway is the exact
defect class this train exists to kill.
"""

from __future__ import annotations

import ast
import pathlib
from types import SimpleNamespace

from jobctrl.domain.discovery.source_registry import SourceKind, SourcePriority
from jobctrl.infrastructure.discovery.production_wiring import _adapter_for_source
from jobctrl.infrastructure.network.http_client import GatewayHttpClient

SRC_ROOT = pathlib.Path(__file__).resolve().parents[1] / "src" / "jobctrl"

# Files that have been rerouted through the gateway and must not import a raw
# outbound HTTP transport. Extended per phase (P2b compensation, P2c Workday, ...).
ROUTED_NON_BROWSER_SURFACES = [
    "infrastructure/discovery/ats_adapters.py",
    "infrastructure/compensation/sqlite_market_repository.py",
    "discovery/workday.py",
]


def _is_raw_transport(module: str) -> bool:
    """True when *module* is an ad-hoc outbound HTTP/network transport.

    Covers the stdlib (``urllib.request``/``error``, ``http.client``, ``socket``)
    and the common third-party clients (``requests``, ``httpx``, ``urllib3``) — a
    routed surface must reach the network only through the gateway client.
    ``urllib.parse`` (URL utilities) and ``http.server`` (test loopback) are not
    transports and stay allowed.
    """
    module = module or ""
    root = module.split(".")[0]
    if root == "urllib":
        return module != "urllib.parse"
    if root == "http":
        return module == "http.client" or module.startswith("http.client.")
    return root in {"socket", "requests", "httpx", "urllib3"}


def _imports_raw_http(source: str) -> list[str]:
    tree = ast.parse(source)
    offenders: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            offenders.extend(alias.name for alias in node.names if _is_raw_transport(alias.name))
        elif isinstance(node, ast.ImportFrom):
            if _is_raw_transport(node.module or ""):
                offenders.append(node.module or "")
    return offenders


def test_raw_transport_detector_flags_every_known_transport() -> None:
    # Self-test: the tripwire is only as good as its vocabulary, so pin what it
    # must catch and what it must not (a false positive would block a clean PR).
    for snippet in (
        "import urllib.request",
        "from urllib.error import HTTPError",
        "import http.client",
        "import socket",
        "import requests",
        "import httpx",
        "import urllib3",
        "from requests import get",
        "from httpx import Client",
    ):
        assert _imports_raw_http(snippet), f"detector missed a raw transport: {snippet!r}"
    for snippet in (
        "import urllib.parse",
        "from urllib.parse import urlsplit",
        "import http.server",
        "import json",
        "import logging",
    ):
        assert _imports_raw_http(snippet) == [], f"detector false-positive: {snippet!r}"


def test_routed_non_browser_surfaces_have_no_adhoc_transport() -> None:
    for rel in ROUTED_NON_BROWSER_SURFACES:
        source = (SRC_ROOT / rel).read_text(encoding="utf-8")
        offenders = _imports_raw_http(source)
        assert offenders == [], f"{rel} still imports raw HTTP transport: {offenders}"


def test_linkedin_apply_resolver_factory_uses_owner_browser_identity() -> None:
    from jobctrl.enrichment import detail

    resolver = detail._default_linkedin_apply_resolver_factory()
    assert resolver._user_agent is None


def test_ats_adapter_uses_gateway_client_when_no_http_injected() -> None:
    source = SimpleNamespace(
        source_id="greenhouse:acme",
        source_kind=SourceKind.ATS_API,
        priority=SourcePriority.STANDARD,
        adapter_config={"board_token": "acme"},
    )
    adapter = _adapter_for_source(
        source,
        http=None,
        gateway=None,
        conn=None,
        run_id="discovery:ats:test",
        search_cfg={},
    )
    assert adapter is not None
    # Production wiring routes the adapter's fetcher through the gateway client.
    assert isinstance(getattr(adapter._http, "__self__", None), GatewayHttpClient)
    assert getattr(adapter._http, "__name__", "") == "fetch_json"
