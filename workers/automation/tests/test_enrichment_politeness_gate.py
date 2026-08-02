"""R10 P3b — every enrichment browser navigation is politeness-gated.

The mandated fixture proves a robots-disallowed detail page never gets a
``page.goto`` and folds cleanly into the JobEnrichment stage lifecycle as a
first-class ``blocked`` outcome (never a scrape failure). Also covers the
per-run budget stop, the ``scrape_detail_page`` guard, the owner-authenticated
LinkedIn robots carve-out (D1/D3), and two-host parallel per-host pacing (the
browser-side complement to P1's HTTP-side rate fixture).

All network is loopback (127.0.0.1) or stubbed; Playwright is faked so the
suite needs no browser binary and performs no live board traffic.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Iterator

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId, generate_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment import detail
from jobctrl.enrichment.detail import scrape_detail_page, scrape_site_batch
from jobctrl.infrastructure.network import (
    HostRateLimiter,
    PolitenessGateway,
    PublicUrlDecision,
    RobotsCache,
    RunBudgetCounter,
)

from .politeness_helpers import (
    AllowAllRobots,
    DenyAllRobots,
    VirtualClock,
    no_sleep_limiter,
    offline_gateway,
    offline_session,
    public_loopback_opener,
)

LONG_DESC = "Build reliable distributed systems with Python and TypeScript. " * 8


def _allow_test_url_safety(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _url: PublicUrlDecision(True))


def _seed_pending(conn: sqlite3.Connection, url: str, site: str = "RemoteOK") -> None:
    job_id = generate_job_id()
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (str(LOCAL_TENANT), str(job_id), url, "Engineer", site, "2026-01-01T00:00:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value, is_current,
            first_seen_at, last_seen_at, retired_at
        ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?, NULL)
        """,
        (
            str(LOCAL_TENANT),
            str(job_id),
            url,
            "2026-01-01T00:00:00+00:00",
            "2026-01-01T00:00:00+00:00",
        ),
    )
    conn.commit()


def _job_id(conn: sqlite3.Connection, url: str) -> JobId:
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE tenant_id = ? AND url = ?",
        (str(LOCAL_TENANT), url),
    ).fetchone()
    assert row is not None
    return JobId(str(row["job_id"]))


def _enrich_stage(conn: sqlite3.Connection, url: str) -> sqlite3.Row:
    conn.row_factory = sqlite3.Row
    return conn.execute(
        "SELECT state, error_code, next_action FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'",
        (_job_id(conn, url),),
    ).fetchone()


def _blocked_metric(conn: sqlite3.Connection, url: str) -> sqlite3.Row | None:
    conn.row_factory = sqlite3.Row
    source = conn.execute("SELECT site FROM jobs WHERE url = ?", (url,)).fetchone()
    assert source is not None
    return conn.execute(
        "SELECT outcome, failure_category, is_scrape_failure, is_operational_failure, stage, source_id "
        "FROM operational_attempt_metrics "
        "WHERE stage = 'enrich' AND source_id = ? AND outcome = 'blocked' "
        "ORDER BY metric_id DESC LIMIT 1",
        (source[0],),
    ).fetchone()


def _enrichment_status(conn: sqlite3.Connection, url: str) -> str | None:
    row = conn.execute(
        "SELECT current_status FROM job_enrichments WHERE job_id = ?", (_job_id(conn, url),)
    ).fetchone()
    return None if row is None else row[0]


# ---------------------------------------------------------------------------
# Fake Playwright that records every navigation
# ---------------------------------------------------------------------------


class _Resp:
    status = 200


class _SpyPage:
    """A Playwright page stand-in that records the URLs it was told to open."""

    def __init__(self, sink: list[str], lock: threading.Lock | None = None) -> None:
        self._sink = sink
        self._lock = lock or threading.Lock()
        self.url = "https://example.test/final"

    def goto(self, url: str, **_kwargs: object) -> _Resp:
        with self._lock:
            self._sink.append(url)
        return _Resp()

    def wait_for_load_state(self, *_args: object, **_kwargs: object) -> None:
        return None

    def title(self) -> str:
        return "Role"

    def on(self, *_args: object, **_kwargs: object) -> None:
        return None

    def close(self) -> None:
        return None


class _SpyBrowser:
    def __init__(self, sink: list[str], lock: threading.Lock) -> None:
        self._sink = sink
        self._lock = lock

    def new_context(self, **_kwargs: object) -> "_SpyBrowser":
        return self

    def new_page(self, **_kwargs: object) -> _SpyPage:
        return _SpyPage(self._sink, self._lock)

    def close(self) -> None:
        return None


class _SpyChromium:
    def __init__(self, sink: list[str], lock: threading.Lock) -> None:
        self._sink = sink
        self._lock = lock

    def launch(self, **_kwargs: object) -> _SpyBrowser:
        return _SpyBrowser(self._sink, self._lock)


class _SpyPlaywright:
    """``sync_playwright()`` stand-in; ``goto_calls`` accumulates navigations."""

    def __init__(self, sink: list[str] | None = None, lock: threading.Lock | None = None) -> None:
        self.goto_calls: list[str] = sink if sink is not None else []
        self._lock = lock or threading.Lock()
        self.chromium = _SpyChromium(self.goto_calls, self._lock)

    def __enter__(self) -> "_SpyPlaywright":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


class _OfflineLlm:
    def chat(self, *_a: object, **_k: object) -> str:
        raise AssertionError("LLM tier must not run in these fixtures")

    def chat_json(self, *_a: object, **_k: object) -> dict:
        raise AssertionError("LLM tier must not run in these fixtures")

    def ask(self, *_a: object, **_k: object) -> str:
        raise AssertionError("LLM tier must not run in these fixtures")


@pytest.fixture
def tier1_extraction(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the detail cascade succeed at Tier 1 (JSON-LD) over the fake page."""
    _allow_test_url_safety(monkeypatch)
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


# ---------------------------------------------------------------------------
# Loopback robots server (returns Disallow: / for every user-agent)
# ---------------------------------------------------------------------------


class _RobotsServer:
    def __init__(self, robots_body: str) -> None:
        self.requested_paths: list[str] = []
        self.seen_user_agents: list[str] = []
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - stdlib name
                server_self.requested_paths.append(self.path)
                server_self.seen_user_agents.append(self.headers.get("User-Agent", ""))
                self.send_response(200)
                self.end_headers()
                if self.path == "/robots.txt":
                    self.wfile.write(robots_body.encode("utf-8"))
                else:
                    self.wfile.write(b"ok")

            def log_message(self, *_args: object) -> None:
                pass

        self._httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://robots.example:{self._httpd.server_port}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def __enter__(self) -> "_RobotsServer":
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=2)


@contextmanager
def _disallow_all_robots() -> Iterator[_RobotsServer]:
    with _RobotsServer("User-agent: *\nDisallow: /\n") as server:
        yield server


# ---------------------------------------------------------------------------
# 1) robots-disallowed → zero navigation, folded as a first-class 'blocked'
# ---------------------------------------------------------------------------


def test_robots_disallowed_job_never_navigates_and_folds_blocked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with _disallow_all_robots() as server:
        db_path = tmp_path / "jobs.db"
        conn = init_db(db_path)
        url = f"{server.base_url}/jobs/1"
        try:
            _seed_pending(conn, url, "RemoteOK")
            spy = _SpyPlaywright()
            monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "0")
            monkeypatch.setattr(detail, "sync_playwright", lambda: spy)
            _allow_test_url_safety(monkeypatch)

            # Real RobotsCache fetches the loopback robots.txt; no-sleep limiter.
            gateway = PolitenessGateway(
                robots=RobotsCache(opener=public_loopback_opener()),
                rate_limiter=no_sleep_limiter(),
            )
            stats = scrape_site_batch(conn, "RemoteOK", [(_job_id(conn, url), "Role")], gateway=gateway)

            # The invariant: a disallowed page is NEVER navigated.
            assert spy.goto_calls == []
            assert stats["blocked"] == 1
            assert stats["processed"] == 0
            assert "/robots.txt" in server.requested_paths

            stage = _enrich_stage(conn, url)
            assert stage["state"] == "blocked"
            assert stage["error_code"] == "ENRICH_ROBOTS_DISALLOWED"
            assert "manually" in (stage["next_action"] or "").lower()

            metric = _blocked_metric(conn, url)
            assert metric is not None
            assert metric["failure_category"] == "robots_disallowed"
            assert metric["is_scrape_failure"] == 0
            assert metric["is_operational_failure"] == 0
            assert metric["stage"] == "enrich"

            event = conn.execute(
                "SELECT event_type, level FROM job_events WHERE job_id = ? AND event_type = 'StageBlocked'",
                (_job_id(conn, url),),
            ).fetchone()
            assert event is not None

            # The job stays enrichment-pending (no aggregate attempt recorded), so
            # a later run re-evaluates robots or the owner imports it manually.
            assert _enrichment_status(conn, url) is None
        finally:
            close_connection(db_path)


# ---------------------------------------------------------------------------
# 2) per-run budget stop
# ---------------------------------------------------------------------------


def test_budget_exhausted_defers_job_without_navigation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    url = "https://example.test/jobs/1"
    try:
        _seed_pending(conn, url, "RemoteOK")
        spy = _SpyPlaywright()
        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "0")
        monkeypatch.setattr(detail, "sync_playwright", lambda: spy)

        exhausted = RunBudgetCounter(1)
        assert exhausted.try_consume(1) is True  # drain to zero

        stats = scrape_site_batch(
            conn, "RemoteOK", [(_job_id(conn, url), "Role")], gateway=offline_gateway(), run_budget=exhausted
        )

        assert spy.goto_calls == []
        assert stats["processed"] == 0
        metric = _blocked_metric(conn, url)
        assert metric is not None
        assert metric["failure_category"] == "budget_exhausted"
        assert metric["is_scrape_failure"] == 0
        assert _enrichment_status(conn, url) is None
    finally:
        close_connection(db_path)


def test_run_budget_decrements_per_navigation_and_stops_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tier1_extraction: None
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    urls = [f"https://example.test/jobs/{i}" for i in range(3)]
    try:
        for url in urls:
            _seed_pending(conn, url, "RemoteOK")
        spy = _SpyPlaywright()
        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "0")
        monkeypatch.setattr(detail, "sync_playwright", lambda: spy)

        budget = RunBudgetCounter(2)  # only two navigations allowed this run
        stats = scrape_site_batch(
            conn,
            "RemoteOK",
            [(_job_id(conn, u), "Role") for u in urls],
            gateway=offline_gateway(),
            run_budget=budget,
        )

        # Exactly two navigations happened; the third was deferred on budget.
        assert spy.goto_calls == urls[:2]
        assert stats["processed"] == 2
        assert budget.remaining() == 0
        assert _blocked_metric(conn, urls[2])["failure_category"] == "budget_exhausted"
        assert _enrichment_status(conn, urls[2]) is None
    finally:
        close_connection(db_path)


# ---------------------------------------------------------------------------
# 3) scrape_detail_page guard blocks navigation directly
# ---------------------------------------------------------------------------


def test_scrape_detail_page_blocked_skips_goto(monkeypatch: pytest.MonkeyPatch) -> None:
    _allow_test_url_safety(monkeypatch)
    calls: list[str] = []
    page = _SpyPage(calls)
    session = offline_session(robots=DenyAllRobots())

    result = scrape_detail_page(page, "https://example.test/jobs/1", session=session)

    assert result["status"] == "blocked"
    assert result["politeness_outcome"] == "robots_disallowed"
    assert result["error"]
    assert calls == []


# ---------------------------------------------------------------------------
# 4) owner-authenticated LinkedIn session: robots carve-out (D1/D3), budget kept
# ---------------------------------------------------------------------------


class _FakeResolver:
    """Stand-in for the authenticated LinkedIn persistent-context resolver."""

    def __init__(self, sink: list[str], **_kwargs: object) -> None:
        self._sink = sink

    def start(self) -> None:
        return None

    def new_page(self):  # noqa: ANN201 - test double
        return _SpyPage(self._sink)

    def resolve_loaded_page(self, _page: object, _url: str):  # noqa: ANN201
        from jobctrl.infrastructure.enrichment.linkedin_apply_resolver import (
            LinkedInApplyResolution,
        )

        return LinkedInApplyResolution(None, "apply_button_missing")

    def close(self) -> None:
        return None


def test_authenticated_linkedin_session_skips_robots_but_keeps_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tier1_extraction: None
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    url = "https://www.linkedin.com/jobs/view/1"
    try:
        _seed_pending(conn, url, "linkedin")
        sink: list[str] = []
        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "1")
        monkeypatch.setattr(detail, "linkedin_apply_resolver_enabled", lambda: True)
        monkeypatch.setattr(
            detail, "LinkedInApplyUrlResolver", lambda **kw: _FakeResolver(sink, **kw)
        )
        # sync_playwright is only used for the anonymous fallback; the fake
        # resolver supplies the page here.
        monkeypatch.setattr(detail, "sync_playwright", lambda: _SpyPlaywright())

        stats = scrape_site_batch(
            conn,
            "linkedin",
            [(_job_id(conn, url), "Role")],
            gateway=offline_gateway(robots=DenyAllRobots()),
        )

        # Robots disallows the host, yet the owner's authenticated LinkedIn
        # session navigates (D1/D3 carve-out) — it is NOT folded as robots-blocked.
        assert sink == [url]
        assert stats["blocked"] == 0
        assert _blocked_metric(conn, url) is None
        assert _enrich_stage(conn, url)["state"] == "succeeded"
    finally:
        close_connection(db_path)


def test_non_linkedin_url_with_linkedin_substring_uses_anonymous_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tier1_extraction: None
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    url = "https://mail.google.com/mail/u/0/#inbox/linkedin.com/jobs/123"
    try:
        _seed_pending(conn, url, "linkedin")
        authenticated_constructed: list[object] = []
        anonymous_playwright = _SpyPlaywright()

        def _resolver_factory(**kwargs: object) -> _FakeResolver:
            authenticated_constructed.append(kwargs)
            return _FakeResolver([], **kwargs)

        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "1")
        monkeypatch.setattr(detail, "linkedin_apply_resolver_enabled", lambda: True)
        monkeypatch.setattr(detail, "LinkedInApplyUrlResolver", _resolver_factory)
        monkeypatch.setattr(detail, "sync_playwright", lambda: anonymous_playwright)

        stats = scrape_site_batch(conn, "linkedin", [(_job_id(conn, url), "Role")], gateway=offline_gateway())

        assert authenticated_constructed == []
        assert anonymous_playwright.goto_calls == [url]
        assert stats["ok"] == 1
        assert _enrich_stage(conn, url)["state"] == "succeeded"
    finally:
        close_connection(db_path)


def test_mixed_linkedin_batch_does_not_reuse_authenticated_page_for_other_hosts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tier1_extraction: None
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    linkedin_url = "https://www.linkedin.com/jobs/view/1"
    non_linkedin_url = "https://mail.google.com/mail/u/0/#inbox/linkedin.com/jobs/123"
    try:
        _seed_pending(conn, linkedin_url, "linkedin")
        _seed_pending(conn, non_linkedin_url, "linkedin")
        authenticated_gotos: list[str] = []
        anonymous_playwright = _SpyPlaywright()

        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "1")
        monkeypatch.setattr(
            detail,
            "LinkedInApplyUrlResolver",
            lambda **kw: _FakeResolver(authenticated_gotos, **kw),
        )
        monkeypatch.setattr(detail, "linkedin_apply_resolver_enabled", lambda: True)
        monkeypatch.setattr(detail, "sync_playwright", lambda: anonymous_playwright)

        stats = scrape_site_batch(
            conn,
            "linkedin",
            [
                (_job_id(conn, linkedin_url), "LinkedIn role"),
                (_job_id(conn, non_linkedin_url), "Spoofed role"),
            ],
            gateway=offline_gateway(),
        )

        assert authenticated_gotos == [linkedin_url]
        assert anonymous_playwright.goto_calls == [non_linkedin_url]
        assert stats["ok"] == 2
        assert _enrich_stage(conn, linkedin_url)["state"] == "succeeded"
        assert _enrich_stage(conn, non_linkedin_url)["state"] == "succeeded"
    finally:
        close_connection(db_path)


def test_owner_authenticated_robots_allows_but_budget_still_applies() -> None:
    session = offline_session(robots=detail._OwnerAuthenticatedRobots(), budget=1)
    url = "https://www.linkedin.com/jobs/view/1"

    assert session.check(url).allowed is True  # robots skipped
    with session.guard(url) as decision:
        assert decision.allowed is True  # consumes the only budget unit
    assert session.check(url).outcome.value == "budget_exhausted"


# ---------------------------------------------------------------------------
# 5) two-host parallel run respects per-host min-interval (SITE_DELAYS removed)
# ---------------------------------------------------------------------------


class _GrantRecordingLimiter(HostRateLimiter):
    """Records (host, virtual-time) at each granted slot.

    Sleep-count assertions are racy under parallel workers: one host's virtual
    sleep advances the shared clock, which can legitimately satisfy the other
    host's min-interval without a second sleep. Grant times let a test assert
    the actual pacing invariant per host, independent of thread interleaving.
    """

    def __init__(self, clock: VirtualClock) -> None:
        super().__init__(clock=clock.now, sleep=clock.sleep)
        self._virtual_clock = clock
        self._granted_lock = threading.Lock()
        self.granted: list[tuple[str, float]] = []

    @contextmanager
    def slot(
        self, host: str, *, min_interval_seconds: float, max_concurrency: int
    ) -> Iterator[None]:
        with super().slot(
            host,
            min_interval_seconds=min_interval_seconds,
            max_concurrency=max_concurrency,
        ):
            with self._granted_lock:
                self.granted.append((host, self._virtual_clock.now()))
            yield


def test_parallel_two_host_run_paces_each_host_via_shared_limiter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tier1_extraction: None
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    host_a = [f"http://host-a.test/jobs/{i}" for i in range(2)]
    host_b = [f"http://host-b.test/jobs/{i}" for i in range(2)]
    try:
        for url in host_a:
            _seed_pending(conn, url, "RemoteOK")
        for url in host_b:
            _seed_pending(conn, url, "BuiltIn Remote")

        clock = VirtualClock()
        limiter = _GrantRecordingLimiter(clock)
        shared_gateway = PolitenessGateway(robots=AllowAllRobots(), rate_limiter=limiter)
        # _run_detail_scraper builds the shared run gateway via PolitenessGateway();
        # hand it our virtual-clock, allow-all gateway so pacing is observable.
        monkeypatch.setattr(detail, "PolitenessGateway", lambda **_kw: shared_gateway)
        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "0")

        sink: list[str] = []
        sink_lock = threading.Lock()
        monkeypatch.setattr(detail, "sync_playwright", lambda: _SpyPlaywright(sink, sink_lock))

        stats = detail._run_detail_scraper(
            conn, workers=2, reset_linkedin_candidates=False
        )

        # Parallel enrichment across two hosts still processes every job.
        assert stats["processed"] == 4
        assert sorted(sink) == sorted(host_a + host_b)
        # Per-host min-interval (2.0s) — the SITE_DELAYS replacement enforced by
        # the shared limiter: each host's consecutive grants are >= 2.0s apart
        # in virtual time, whatever the thread interleaving.
        grants: dict[str, list[float]] = {}
        for host, granted_at in limiter.granted:
            grants.setdefault(host, []).append(granted_at)
        assert sorted(grants) == ["host-a.test", "host-b.test"]
        for times in grants.values():
            times.sort()
            assert len(times) == 2
            assert times[1] - times[0] >= 2.0
        # And honoring the interval required at least one virtual sleep.
        assert clock.sleeps
    finally:
        close_connection(db_path)


# ---------------------------------------------------------------------------
# 6) robots-block -> allow recovery: a blocked job re-enriches, never stranded
# ---------------------------------------------------------------------------


def test_robots_blocked_job_re_enriches_after_robots_allows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tier1_extraction: None
) -> None:
    """A robots-blocked enrich stage re-enriches once robots allows (#314 High).

    The stage folds into ``blocked`` while its aggregate stays
    enrichment-pending, so a later run re-selects it. The state machine has no
    ``Blocked -> Running`` edge, so without the Unblock the running transition
    raised ``ValueError`` -> ``ENRICH_INTERNAL_ERROR`` and the job was excluded
    from the pending queue forever. Unblocking (``Blocked -> Pending``) before
    the running transition restores the "a later run re-evaluates robots"
    promise the ``_record_enrich_robots_blocked`` docstring makes.
    """
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    url = "https://example.test/jobs/reeval"
    try:
        _seed_pending(conn, url, "RemoteOK")
        spy = _SpyPlaywright()
        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "0")
        monkeypatch.setattr(detail, "sync_playwright", lambda: spy)

        # Run 1 — robots disallows: folded blocked, zero navigation, je pending.
        blocked = scrape_site_batch(
            conn, "RemoteOK", [(_job_id(conn, url), "Role")], gateway=offline_gateway(robots=DenyAllRobots())
        )
        assert blocked["blocked"] == 1
        assert spy.goto_calls == []
        assert _enrichment_status(conn, url) is None

        # Run 2 — robots now allows: the job re-enriches instead of stranding.
        # ``error == 0`` is the direct proof the Blocked->Running ValueError path
        # (which would have recorded ENRICH_INTERNAL_ERROR) never fired.
        allowed = scrape_site_batch(
            conn, "RemoteOK", [(_job_id(conn, url), "Role")], gateway=offline_gateway(robots=AllowAllRobots())
        )
        assert allowed["processed"] == 1
        assert allowed["error"] == 0
        assert spy.goto_calls == [url]

        stage = _enrich_stage(conn, url)
        assert stage["state"] == "succeeded"
        assert stage["error_code"] != "ENRICH_INTERNAL_ERROR"
        assert _enrichment_status(conn, url) == "enriched"

        # The unblock is auditable — exactly one StageReset event marks the
        # robots re-evaluation of the previously blocked job.
        reset_events = conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_id = ? AND stage = 'enrich' "
            "AND event_type = 'StageReset'",
            (_job_id(conn, url),),
        ).fetchone()[0]
        assert reset_events == 1
    finally:
        close_connection(db_path)


def test_repeatedly_robots_blocked_job_stays_blocked_never_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Re-evaluating a still-disallowed job keeps it blocked, never failed (#314).

    Repeated robots blocks must not accumulate into a spurious failure: each run
    re-folds ``blocked`` (an idempotent no-op transition), the aggregate stays
    enrichment-pending, and ``error`` stays 0 so the job keeps being
    re-evaluated on later runs rather than being stranded.
    """
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    url = "https://example.test/jobs/still-blocked"
    try:
        _seed_pending(conn, url, "RemoteOK")
        spy = _SpyPlaywright()
        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "0")
        monkeypatch.setattr(detail, "sync_playwright", lambda: spy)

        for _ in range(3):
            stats = scrape_site_batch(
                conn,
                "RemoteOK",
                [(_job_id(conn, url), "Role")],
                gateway=offline_gateway(robots=DenyAllRobots()),
            )
            assert stats["blocked"] == 1
            assert stats["error"] == 0

        assert spy.goto_calls == []
        stage = _enrich_stage(conn, url)
        assert stage["state"] == "blocked"
        assert stage["error_code"] == "ENRICH_ROBOTS_DISALLOWED"
        assert _enrichment_status(conn, url) is None
    finally:
        close_connection(db_path)
