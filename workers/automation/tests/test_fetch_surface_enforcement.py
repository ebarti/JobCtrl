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

from jobctl.domain.discovery.source_registry import SourceKind, SourcePriority
from jobctl.infrastructure.discovery.production_wiring import _adapter_for_source
from jobctl.infrastructure.network.http_client import GatewayHttpClient

SRC_ROOT = pathlib.Path(__file__).resolve().parents[1] / "src" / "jobctl"

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


def _linkedin_resolver_user_agent_args(source: str) -> list[ast.expr | None]:
    """Return the ``user_agent`` argument node for every ``LinkedInApplyUrlResolver(...)``
    construction in *source* (``None`` when the call omits the keyword)."""
    tree = ast.parse(source)
    args: list[ast.expr | None] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "LinkedInApplyUrlResolver"
        ):
            ua = next((kw.value for kw in node.keywords if kw.arg == "user_agent"), None)
            args.append(ua)
    return args


def test_authenticated_linkedin_context_never_uses_bot_ua_at_any_site() -> None:
    """The authenticated LinkedIn persistent context is constructed in two places
    -- the module-level factory and the ``scrape_site_batch`` inline construction.
    Both must present the owner's real logged-in browser identity
    (``user_agent=None``), never the honest bot UA; otherwise the authenticated
    session self-identifies as ``JobCtl/<ver>`` on the primary batch path,
    contradicting the module comment and the D1/D3 owner-scoped posture. This is
    the assertion that would have caught the divergence between the two sites.
    """
    source = (SRC_ROOT / "enrichment" / "detail.py").read_text(encoding="utf-8")
    ua_args = _linkedin_resolver_user_agent_args(source)
    assert len(ua_args) >= 2, (
        "expected both LinkedInApplyUrlResolver construction sites (factory + batch)"
    )
    for ua in ua_args:
        assert isinstance(ua, ast.Constant) and ua.value is None, (
            "every LinkedInApplyUrlResolver(...) must pass user_agent=None; a "
            "non-None user_agent presents the bot UA on the authenticated session"
        )


def test_linkedin_apply_resolver_factory_uses_owner_browser_identity() -> None:
    from jobctl.enrichment import detail

    resolver = detail._default_linkedin_apply_resolver_factory()
    assert resolver._user_agent is None


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


def _browser_context_ua_args(source: str) -> list[ast.expr]:
    """The ``user_agent`` argument for every Playwright ``new_context`` /
    ``new_page`` construction in *source*. Calls that omit the keyword (the
    authenticated-LinkedIn ``resolver.new_page()``, which keeps the owner's real
    browser identity) are skipped."""
    tree = ast.parse(source)
    args: list[ast.expr] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"new_context", "new_page"}
        ):
            ua = next((kw.value for kw in node.keywords if kw.arg == "user_agent"), None)
            if ua is not None:
                args.append(ua)
    return args


def _module_constant_names(source: str) -> set[str]:
    tree = ast.parse(source)
    return {
        target.id
        for node in tree.body
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }


def test_browser_context_ua_comes_from_the_gateway_not_a_constant() -> None:
    """#316 High: a Playwright context bound its UA from an import-time
    ``default_honest_user_agent()`` module constant, so an owner env override
    never reached the fetch and ``robots.txt`` was evaluated as one identity
    while the page fetched as another. Every ``new_context``/``new_page`` that
    stamps a UA must read it from the gateway-resolved value at call time
    (``session``/``decision``/``gateway`` ``.user_agent``, or a local threaded
    directly from it), never a module-level constant -- this is the structural
    tripwire that would have caught the divergence."""
    for rel in BROWSER_UA_SURFACES:
        source = (SRC_ROOT / rel).read_text(encoding="utf-8")
        module_constants = _module_constant_names(source)
        ua_args = _browser_context_ua_args(source)
        assert ua_args, f"{rel} has no user_agent-bearing browser context to check"
        for ua in ua_args:
            if isinstance(ua, ast.Attribute):
                assert ua.attr == "user_agent", (
                    f"{rel} stamps a browser user_agent from {ast.dump(ua)}; "
                    "expected a gateway-resolved *.user_agent"
                )
            elif isinstance(ua, ast.Name):
                assert ua.id not in module_constants, (
                    f"{rel} stamps the browser user_agent from module constant "
                    f"{ua.id!r}; resolve it from the gateway at call time so an "
                    "owner override propagates and robots identity == fetch identity"
                )
            else:
                raise AssertionError(
                    f"{rel}: unexpected user_agent expression {ast.dump(ua)}"
                )


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
