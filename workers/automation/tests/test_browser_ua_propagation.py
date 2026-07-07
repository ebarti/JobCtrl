"""R10 #316 High 1 — the owner-overridable honest UA reaches every browser surface.

Before the fix, the three Playwright surfaces (``PlaywrightDetailPageFetcher``,
``smartextract.collect_page_intelligence``, ``detail.scrape_site_batch``) bound
their page/context ``user_agent`` from an import-time ``default_honest_user_agent()``
constant. That made ``JOBCTRL_CRAWL_UA_*`` env overrides invisible to the browser
fetch, and — worse — the gateway would evaluate ``robots.txt`` as the *overridden*
identity while the page fetched as the *default* one.

Each test here sets an owner UA override, drives the surface through a gateway whose
robots port records the identity it is evaluated with, and asserts that the browser
context/page was stamped with the SAME overridden string the gateway used for robots
— i.e. robots identity == fetch identity == owner override, by construction. All
Playwright and robots traffic is faked; the suite needs no browser and no network.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.discovery import smartextract
from jobctrl.domain.discovery.source_registry import (
    ENRICHMENT_CRAWL_POLICY,
    SMART_EXTRACT_EXPERIMENTAL_POLICY,
)
from jobctrl.domain.ports.politeness import RobotsVerdict, default_honest_user_agent
from jobctrl.enrichment import detail
from jobctrl.infrastructure.enrichment.playwright_fetcher import PlaywrightDetailPageFetcher
from jobctrl.infrastructure.network import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    RunBudgetCounter,
)
from jobctrl.infrastructure.network.politeness import UA_CONTACT_ENV, UA_PRODUCT_ENV

from .politeness_helpers import no_sleep_limiter

OWNER_PRODUCT = "AcmeJobBot"
OWNER_CONTACT = "https://acme.example/crawler"
LONG_DESC = "Build reliable distributed systems with Python and TypeScript. " * 8


def _expected_ua() -> str:
    return f"{OWNER_PRODUCT}/{default_honest_user_agent().version} (+{OWNER_CONTACT})"


class _UASpyRobots:
    """``RobotsPort`` that records the User-Agent it is evaluated with, allows all."""

    def __init__(self) -> None:
        self.seen_user_agents: list[str] = []

    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:  # noqa: ARG002
        self.seen_user_agents.append(user_agent)
        return RobotsVerdict.ALLOW


# ---------------------------------------------------------------------------
# Fake Playwright that records the user_agent stamped on each context / page
# ---------------------------------------------------------------------------


class _Resp:
    status = 200


class _RecordingPage:
    def __init__(self) -> None:
        self.url = "https://example.test/final"

    def goto(self, url: str, **_kw: object) -> _Resp:
        return _Resp()

    def wait_for_load_state(self, *_a: object, **_k: object) -> None:
        return None

    def title(self) -> str:
        return "Role"

    def on(self, *_a: object, **_k: object) -> None:
        return None

    def query_selector_all(self, *_a: object, **_k: object) -> list[object]:
        return []

    def query_selector(self, *_a: object, **_k: object) -> None:
        return None

    def evaluate(self, *_a: object, **_k: object) -> str:
        return ""

    def content(self) -> str:
        return ""

    def close(self) -> None:
        return None


class _RecordingBrowser:
    def __init__(self, recorder: "_RecordingPlaywright") -> None:
        self._recorder = recorder

    def new_context(self, *, user_agent: str | None = None, **_kw: object) -> "_RecordingBrowser":
        self._recorder.context_user_agents.append(user_agent)
        return self

    def new_page(self, *, user_agent: str | None = None, **_kw: object) -> _RecordingPage:
        if user_agent is not None:
            self._recorder.page_user_agents.append(user_agent)
        return _RecordingPage()

    def close(self) -> None:
        return None


class _RecordingChromium:
    def __init__(self, recorder: "_RecordingPlaywright") -> None:
        self._recorder = recorder

    def launch(self, **_kw: object) -> _RecordingBrowser:
        return _RecordingBrowser(self._recorder)


class _RecordingPlaywright:
    """``sync_playwright()`` stand-in recording every stamped user_agent."""

    def __init__(self) -> None:
        self.context_user_agents: list[str | None] = []
        self.page_user_agents: list[str | None] = []
        self.chromium = _RecordingChromium(self)

    def __enter__(self) -> "_RecordingPlaywright":
        return self

    def __exit__(self, *_a: object) -> None:
        return None


class _OfflineLlm:
    def chat(self, *_a: object, **_k: object) -> str:
        raise AssertionError("LLM tier must not run in these fixtures")

    def chat_json(self, *_a: object, **_k: object) -> dict:
        raise AssertionError("LLM tier must not run in these fixtures")

    def ask(self, *_a: object, **_k: object) -> str:
        raise AssertionError("LLM tier must not run in these fixtures")


def _owner_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(UA_PRODUCT_ENV, OWNER_PRODUCT)
    monkeypatch.setenv(UA_CONTACT_ENV, OWNER_CONTACT)


def _spy_gateway(robots: _UASpyRobots) -> PolitenessGateway:
    # Constructed after the env override so its UA reflects the owner value.
    return PolitenessGateway(robots=robots, rate_limiter=no_sleep_limiter())


# ---------------------------------------------------------------------------
# 1) PlaywrightDetailPageFetcher (infrastructure/enrichment/playwright_fetcher.py)
# ---------------------------------------------------------------------------


def test_playwright_fetcher_context_uses_owner_overridden_ua(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _owner_override(monkeypatch)
    robots = _UASpyRobots()
    gateway = _spy_gateway(robots)
    session = PolitenessSession(
        gateway,
        policy=ENRICHMENT_CRAWL_POLICY,
        budget=RunBudgetCounter(ENRICHMENT_CRAWL_POLICY.max_requests_per_run),
        context=PolitenessSourceContext(stage="enrich", adapter="test"),
    )
    fetcher = PlaywrightDetailPageFetcher(session=session)
    rec = _RecordingPlaywright()
    # playwright_fetcher imports sync_playwright lazily inside _fetch_page.
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: rec)

    fetcher.fetch("https://example.test/jobs/1")

    expected = _expected_ua()
    assert gateway.user_agent == expected
    assert rec.context_user_agents == [expected]  # fetch identity == override
    assert robots.seen_user_agents  # robots really ran
    assert all(ua == expected for ua in robots.seen_user_agents)  # robots == fetch


# ---------------------------------------------------------------------------
# 2) smartextract.collect_page_intelligence (discovery/smartextract.py)
# ---------------------------------------------------------------------------


def test_smartextract_page_uses_owner_overridden_ua(monkeypatch: pytest.MonkeyPatch) -> None:
    _owner_override(monkeypatch)
    robots = _UASpyRobots()
    gateway = _spy_gateway(robots)
    session = PolitenessSession(
        gateway,
        policy=SMART_EXTRACT_EXPERIMENTAL_POLICY,
        budget=RunBudgetCounter(SMART_EXTRACT_EXPERIMENTAL_POLICY.max_requests_per_run),
        context=PolitenessSourceContext(stage="discover", adapter="smart_extract"),
    )
    rec = _RecordingPlaywright()
    monkeypatch.setattr(smartextract, "sync_playwright", lambda: rec)

    smartextract.collect_page_intelligence("https://example.test/list", session=session)

    expected = _expected_ua()
    assert gateway.user_agent == expected
    assert rec.page_user_agents == [expected]  # fetch identity == override
    assert robots.seen_user_agents
    assert all(ua == expected for ua in robots.seen_user_agents)  # robots == fetch


# ---------------------------------------------------------------------------
# 3) detail.scrape_site_batch anonymous context (enrichment/detail.py)
# ---------------------------------------------------------------------------


def test_enrichment_batch_context_uses_owner_overridden_ua(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _owner_override(monkeypatch)
    monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "0")
    # Tier-1 (JSON-LD) success so navigation proceeds without touching the LLM.
    monkeypatch.setattr(detail, "get_llm_adapter", lambda: _OfflineLlm())
    monkeypatch.setattr(
        detail,
        "_collect_json_ld",
        lambda _page: [
            {
                "@type": "JobPosting",
                "description": LONG_DESC,
                "url": "https://example.test/apply",
                "directApply": True,
            }
        ],
    )
    monkeypatch.setattr(detail, "_collect_main_content", lambda _page: "<main>role</main>")

    robots = _UASpyRobots()
    gateway = _spy_gateway(robots)
    rec = _RecordingPlaywright()
    monkeypatch.setattr(detail, "sync_playwright", lambda: rec)

    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    url = "https://example.test/jobs/1"
    try:
        conn.execute(
            "INSERT INTO jobs (url, title, site, discovered_at) VALUES (?, ?, ?, ?)",
            (url, "Engineer", "RemoteOK", "2026-01-01T00:00:00+00:00"),
        )
        conn.commit()

        detail.scrape_site_batch(conn, "RemoteOK", [(url, "Role")], gateway=gateway)

        expected = _expected_ua()
        assert gateway.user_agent == expected
        assert rec.context_user_agents == [expected]  # anonymous fetch identity
        assert robots.seen_user_agents
        assert all(ua == expected for ua in robots.seen_user_agents)  # robots == fetch
    finally:
        close_connection(db_path)
