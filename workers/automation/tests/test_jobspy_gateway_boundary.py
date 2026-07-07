"""jobspy invocation-boundary politeness (R10 P2d, surface #1).

python-jobspy owns its transport, so we enforce a per-run request budget +
inter-search pacing at OUR call boundary (owner decision D3). This proves the
budget stops a crawl and records a first-class non-error outcome.
"""

from __future__ import annotations

import sqlite3

from jobctrl.discovery import jobspy
from jobctrl.domain.discovery.source_registry import SourcePolicy, SourcePolicyMethod
from jobctrl.infrastructure.network.rate_limiter import HostRateLimiter
from jobctrl.operational_metrics import ensure_operational_metric_tables


class _VirtualClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += max(0.0, seconds)


def test_jobspy_budget_exhaustion_stops_crawl_and_records(monkeypatch) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE jobs (url TEXT)")
    ensure_operational_metric_tables(conn)

    tiny_policy = SourcePolicy(
        policy_id="broad-board-tiny-budget",
        allowed_methods=(SourcePolicyMethod.RENDERED_LISTING,),
        min_request_interval_seconds=0.0,
        max_requests_per_run=2,
    )
    monkeypatch.setattr(jobspy, "BROAD_BOARD_LEAD_POLICY", tiny_policy)
    monkeypatch.setattr(jobspy, "init_db", lambda: None)
    monkeypatch.setattr(jobspy, "get_connection", lambda: conn)

    calls: list[str] = []

    def fake_run_one_search(search, *_args, **_kwargs) -> dict:
        calls.append(search["query"])
        return {"new": 0, "existing": 0, "errors": 0}

    monkeypatch.setattr(jobspy, "_run_one_search", fake_run_one_search)

    jobspy._full_crawl(
        {
            "queries": [{"query": f"q{i}"} for i in range(4)],
            "locations": [{"label": "remote", "location": "Remote"}],
            "defaults": {},
        },
        sites=["indeed"],
        limit=0,
        run_id="discovery:jobspy:test",
    )

    # The per-run budget of 2 stopped the crawl before the 3rd search.
    assert calls == ["q0", "q1"]
    row = conn.execute(
        "SELECT * FROM operational_attempt_metrics WHERE failure_category = 'budget_exhausted'"
    ).fetchone()
    assert row is not None
    assert row["source_id"] == "jobspy"
    assert row["outcome"] == "blocked"
    assert row["is_operational_failure"] == 0
    assert row["is_scrape_failure"] == 0


def test_jobspy_searches_are_paced_between_invocations(monkeypatch) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE jobs (url TEXT)")
    ensure_operational_metric_tables(conn)

    paced_policy = SourcePolicy(
        policy_id="broad-board-paced",
        allowed_methods=(SourcePolicyMethod.RENDERED_LISTING,),
        min_request_interval_seconds=3.0,
        max_requests_per_run=100,
    )
    monkeypatch.setattr(jobspy, "BROAD_BOARD_LEAD_POLICY", paced_policy)
    monkeypatch.setattr(jobspy, "init_db", lambda: None)
    monkeypatch.setattr(jobspy, "get_connection", lambda: conn)

    # Inject a virtual clock into the shared limiter the crawl paces on, so the
    # assertion is deterministic (no wall-clock sleeps).
    clock = _VirtualClock()
    monkeypatch.setattr(
        jobspy, "get_shared_rate_limiter", lambda: HostRateLimiter(clock=clock.now, sleep=clock.sleep)
    )
    monkeypatch.setattr(jobspy, "_run_one_search", lambda *_a, **_k: {"new": 0, "existing": 0, "errors": 0})

    jobspy._full_crawl(
        {
            "queries": [{"query": f"q{i}"} for i in range(3)],
            "locations": [{"label": "remote", "location": "Remote"}],
            "defaults": {},
        },
        sites=["indeed"],
        limit=0,
        run_id="discovery:jobspy:pacing",
    )

    # Three searches paced by the 3.0s min interval => at least two 3.0s gaps.
    assert clock.now() >= 2 * 3.0
