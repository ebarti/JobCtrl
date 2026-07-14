"""Crawl-politeness config surface + doctor disclosure (R10 P5)."""

from __future__ import annotations

import sqlite3

from jobctrl.cli import politeness_doctor_notices
from jobctrl.domain.ports.politeness import (
    PolitenessDecision,
    PolitenessOutcome,
    default_honest_user_agent,
)
from jobctrl.infrastructure.network.politeness import (
    PolitenessGateway,
    PolitenessSourceContext,
    record_politeness_outcome,
    resolve_honest_user_agent,
)
from jobctrl.operational_metrics import ensure_operational_metric_tables


# --- SQLite-owned honest-UA settings ----------------------------------------


def test_resolve_honest_ua_defaults_to_the_builtin_identity() -> None:
    ua = resolve_honest_user_agent({})
    default = default_honest_user_agent()
    assert ua.product == default.product == "JobCtrl"
    assert ua.contact_url == default.contact_url
    assert ua.header_value().startswith("JobCtrl/")
    assert "Mozilla" not in ua.header_value()


def test_saved_discovery_identity_overrides_product_and_contact() -> None:
    ua = resolve_honest_user_agent({
        "crawl_user_agent": {
            "product": "AcmeJobBot",
            "contact": "https://acme.example/bot",
        }
    })
    assert ua.product == "AcmeJobBot"
    assert ua.contact_url == "https://acme.example/bot"
    assert ua.header_value() == f"AcmeJobBot/{ua.version} (+https://acme.example/bot)"


def test_saved_empty_contact_drops_the_contact_suffix() -> None:
    ua = resolve_honest_user_agent({"crawl_user_agent": {"contact": ""}})
    assert ua.contact_url is None
    assert ua.header_value() == f"JobCtrl/{ua.version}"


def test_persisted_discovery_identity_is_used() -> None:
    ua = resolve_honest_user_agent({
        "crawl_user_agent": {
            "product": "JobCtrlResearch",
            "contact": "ops@example.test",
        }
    })

    assert ua.product == "JobCtrlResearch"
    assert ua.contact_url == "ops@example.test"


def test_gateway_uses_the_saved_discovery_identity() -> None:
    user_agent = resolve_honest_user_agent({
        "crawl_user_agent": {
            "product": "AcmeJobBot",
            "contact": "https://acme.example/bot",
        }
    })
    gateway = PolitenessGateway(user_agent=user_agent)
    assert gateway.user_agent == f"AcmeJobBot/{default_honest_user_agent().version} (+https://acme.example/bot)"
    assert "Mozilla" not in gateway.user_agent


# --- doctor disclosure notices ----------------------------------------------


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_operational_metric_tables(conn)
    return conn


def _rows_by_check(rows: list[tuple[str, str, str]]) -> dict[str, tuple[str, str]]:
    return {check: (level, note) for check, level, note in rows}


def test_doctor_notice_reports_effective_ua() -> None:
    notices = _rows_by_check(politeness_doctor_notices(_conn(), {"boards": ["greenhouse"]}))
    level, note = notices["crawl user-agent"]
    assert level == "ok"
    assert note.startswith("JobCtrl/")
    assert "review" in note.lower()


def test_doctor_notice_warns_when_broad_boards_active() -> None:
    notices = _rows_by_check(politeness_doctor_notices(_conn(), {"boards": ["indeed", "greenhouse"]}))
    level, note = notices["broad-board discovery"]
    assert level == "warn"
    assert "indeed" in note


def test_doctor_notice_ok_when_no_broad_boards() -> None:
    notices = _rows_by_check(politeness_doctor_notices(_conn(), {"boards": ["greenhouse"]}))
    assert notices["broad-board discovery"][0] == "ok"


def test_doctor_notice_warns_on_recently_blocked_sources() -> None:
    conn = _conn()
    record_politeness_outcome(
        conn,
        decision=PolitenessDecision(
            allowed=False,
            outcome=PolitenessOutcome.ROBOTS_DISALLOWED,
            user_agent="JobCtrl/test",
            reason="robots.txt disallows this path",
        ),
        context=PolitenessSourceContext(stage="discover", source_id="greenhouse:acme"),
    )
    conn.commit()
    notices = _rows_by_check(politeness_doctor_notices(conn, {"boards": ["greenhouse"]}))
    level, note = notices["robots/rate-limited sources"]
    assert level == "warn"
    assert "greenhouse:acme" in note


def test_doctor_notice_ok_when_no_blocked_sources_and_tolerates_missing_table() -> None:
    # Fresh conn with tables but no blocked rows => ok.
    assert _rows_by_check(politeness_doctor_notices(_conn(), {"boards": ["greenhouse"]}))[
        "robots/rate-limited sources"
    ][0] == "ok"
    # A connection without the metrics table must not crash the disclosure.
    bare = sqlite3.connect(":memory:")
    assert _rows_by_check(politeness_doctor_notices(bare, {"boards": ["greenhouse"]}))[
        "robots/rate-limited sources"
    ][0] == "ok"
