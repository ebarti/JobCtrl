"""Crawl-politeness config surface + doctor disclosure (R10 P5).

Covers the honest-UA env override wiring (owner picks the string; the wiring
stays generic) and the ``doctor`` disclosure notices (effective UA, broad-board
activity, robots/rate-limited sources).
"""

from __future__ import annotations

import sqlite3

from jobhunter.cli import politeness_doctor_notices
from jobhunter.domain.ports.politeness import (
    PolitenessDecision,
    PolitenessOutcome,
    default_honest_user_agent,
)
from jobhunter.infrastructure.network.politeness import (
    UA_CONTACT_ENV,
    UA_PRODUCT_ENV,
    PolitenessGateway,
    PolitenessSourceContext,
    record_politeness_outcome,
    resolve_honest_user_agent,
)
from jobhunter.operational_metrics import ensure_operational_metric_tables


# --- honest-UA env override -------------------------------------------------


def test_resolve_honest_ua_defaults_to_the_builtin_identity(monkeypatch) -> None:
    monkeypatch.delenv(UA_PRODUCT_ENV, raising=False)
    monkeypatch.delenv(UA_CONTACT_ENV, raising=False)
    ua = resolve_honest_user_agent()
    default = default_honest_user_agent()
    assert ua.product == default.product == "JobHunter"
    assert ua.contact_url == default.contact_url
    assert ua.header_value().startswith("JobHunter/")
    assert "Mozilla" not in ua.header_value()


def test_owner_env_overrides_product_and_contact(monkeypatch) -> None:
    monkeypatch.setenv(UA_PRODUCT_ENV, "AcmeJobBot")
    monkeypatch.setenv(UA_CONTACT_ENV, "https://acme.example/bot")
    ua = resolve_honest_user_agent()
    assert ua.product == "AcmeJobBot"
    assert ua.contact_url == "https://acme.example/bot"
    assert ua.header_value() == f"AcmeJobBot/{ua.version} (+https://acme.example/bot)"


def test_empty_contact_env_drops_the_contact_suffix(monkeypatch) -> None:
    monkeypatch.delenv(UA_PRODUCT_ENV, raising=False)
    monkeypatch.setenv(UA_CONTACT_ENV, "")
    ua = resolve_honest_user_agent()
    assert ua.contact_url is None
    assert ua.header_value() == f"JobHunter/{ua.version}"


def test_gateway_default_ua_reflects_the_owner_override(monkeypatch) -> None:
    monkeypatch.setenv(UA_PRODUCT_ENV, "AcmeJobBot")
    monkeypatch.setenv(UA_CONTACT_ENV, "https://acme.example/bot")
    # A gateway built without an explicit UA resolves the effective owner UA, so
    # every fetch surface picks up the override at once.
    assert PolitenessGateway().user_agent == f"AcmeJobBot/{default_honest_user_agent().version} (+https://acme.example/bot)"
    assert "Mozilla" not in PolitenessGateway().user_agent


# --- doctor disclosure notices ----------------------------------------------


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_operational_metric_tables(conn)
    return conn


def _rows_by_check(rows: list[tuple[str, str, str]]) -> dict[str, tuple[str, str]]:
    return {check: (level, note) for check, level, note in rows}


def test_doctor_notice_reports_effective_ua(monkeypatch) -> None:
    monkeypatch.delenv(UA_PRODUCT_ENV, raising=False)
    monkeypatch.delenv(UA_CONTACT_ENV, raising=False)
    notices = _rows_by_check(politeness_doctor_notices(_conn(), {"boards": ["greenhouse"]}))
    level, note = notices["crawl user-agent"]
    assert level == "ok"
    assert note.startswith("JobHunter/")
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
            user_agent="JobHunter/test",
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
