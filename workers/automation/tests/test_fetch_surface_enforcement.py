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

from jobhunter.domain.discovery.source_registry import SourceKind, SourcePriority
from jobhunter.infrastructure.discovery.production_wiring import _adapter_for_source
from jobhunter.infrastructure.network.http_client import GatewayHttpClient

SRC_ROOT = pathlib.Path(__file__).resolve().parents[1] / "src" / "jobhunter"

# Files that have been rerouted through the gateway and must not import a raw
# outbound HTTP transport. Extended per phase (P2b Workday, P2c compensation, ...).
ROUTED_NON_BROWSER_SURFACES = [
    "infrastructure/discovery/ats_adapters.py",
    "infrastructure/compensation/sqlite_market_repository.py",
    "discovery/workday.py",
]


def _imports_raw_http(source: str) -> list[str]:
    tree = ast.parse(source)
    offenders: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] == "urllib" and alias.name != "urllib.parse":
                    offenders.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] == "urllib" and node.module != "urllib.parse":
                offenders.append(node.module or "")
    return offenders


def test_routed_non_browser_surfaces_have_no_adhoc_urllib() -> None:
    for rel in ROUTED_NON_BROWSER_SURFACES:
        source = (SRC_ROOT / rel).read_text(encoding="utf-8")
        offenders = _imports_raw_http(source)
        assert offenders == [], f"{rel} still imports raw HTTP transport: {offenders}"


# Browser surfaces whose Playwright contexts must carry the honest UA, never a
# spoofed desktop browser. The authenticated LinkedIn persistent context is the
# owner-scoped exception (real user session, user_agent=None) per D1/D3.
BROWSER_UA_SURFACES = [
    "enrichment/detail.py",
    "discovery/smartextract.py",
    "infrastructure/enrichment/playwright_fetcher.py",
]


def test_browser_surfaces_have_no_spoofed_browser_ua() -> None:
    for rel in BROWSER_UA_SURFACES:
        source = (SRC_ROOT / rel).read_text(encoding="utf-8")
        assert "Mozilla" not in source, f"{rel} still contains a spoofed browser UA"
        assert "AppleWebKit" not in source, f"{rel} still contains a spoofed browser UA"


def test_browser_ua_constants_resolve_to_the_honest_identity() -> None:
    from jobhunter.discovery.smartextract import UA as smartextract_ua
    from jobhunter.enrichment.detail import UA as detail_ua
    from jobhunter.infrastructure.enrichment.playwright_fetcher import _USER_AGENT

    for ua in (detail_ua, smartextract_ua, _USER_AGENT):
        assert ua.startswith("JobHunter/")
        assert "Mozilla" not in ua


# Browser surfaces that drive ``page.goto`` and must route every navigation
# through the politeness gateway's ``guard`` (P3). The behavioral proof — a
# robots-disallowed page performing zero navigation — lives in
# ``test_enrichment_politeness_gate.py``; this is the structural tripwire that a
# new ungated navigation surface (or a removed guard) can't slip through.
BROWSER_NAV_SURFACES = [
    "enrichment/detail.py",
    "infrastructure/enrichment/playwright_fetcher.py",
    "discovery/smartextract.py",
]


def _goto_calls(source: str) -> list[ast.Call]:
    tree = ast.parse(source)
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "goto"
    ]


def test_browser_nav_surfaces_route_through_the_politeness_gate() -> None:
    for rel in BROWSER_NAV_SURFACES:
        source = (SRC_ROOT / rel).read_text(encoding="utf-8")
        assert _goto_calls(source), f"{rel} unexpectedly has no page.goto"
        # Every nav surface wires the gateway session and holds a guard slot.
        assert "PolitenessSession" in source, f"{rel} does not wire a politeness session"
        assert ".guard(" in source, f"{rel} does not guard its navigation"


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
