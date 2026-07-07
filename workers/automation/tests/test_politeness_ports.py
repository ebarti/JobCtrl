"""Tests for the crawl-politeness port contract value objects (R10 P0).

P0 declares types + Protocols only; these assert the honest-UA value object
and the decision/verdict vocabulary the enforcement gateway (P1) will use.
"""

from __future__ import annotations

import pytest

from jobctl.domain.ports.politeness import (
    PROJECT_REPOSITORY_URL,
    HonestUserAgent,
    PolitenessDecision,
    PolitenessOutcome,
    RobotsVerdict,
    default_honest_user_agent,
)


def test_honest_user_agent_renders_product_version_and_contact() -> None:
    ua = HonestUserAgent(product="JobCtl", version="1.2.3", contact_url="https://example.com")
    assert ua.header_value() == "JobCtl/1.2.3 (+https://example.com)"


def test_honest_user_agent_omits_empty_contact() -> None:
    ua = HonestUserAgent(product="JobCtl", version="1.2.3", contact_url=None)
    assert ua.header_value() == "JobCtl/1.2.3"
    assert HonestUserAgent(product="JobCtl", version="1.2.3", contact_url="  ").header_value() == (
        "JobCtl/1.2.3"
    )


def test_honest_user_agent_rejects_empty_components() -> None:
    with pytest.raises(ValueError, match="product"):
        HonestUserAgent(product="  ", version="1.0")
    with pytest.raises(ValueError, match="version"):
        HonestUserAgent(product="JobCtl", version="")


def test_default_honest_user_agent_is_honest_and_carries_repo_contact() -> None:
    ua = default_honest_user_agent()
    rendered = ua.header_value()
    assert ua.product == "JobCtl"
    # Never impersonate a browser on a surface we control.
    assert "Mozilla" not in rendered
    assert "AppleWebKit" not in rendered
    assert rendered.startswith("JobCtl/")
    assert f"(+{PROJECT_REPOSITORY_URL})" in rendered


def test_politeness_outcome_separates_allow_from_blocked_reasons() -> None:
    assert PolitenessOutcome.ALLOWED.value == "allowed"
    blocked = {
        PolitenessOutcome.ROBOTS_DISALLOWED,
        PolitenessOutcome.RATE_LIMITED,
        PolitenessOutcome.BUDGET_EXHAUSTED,
    }
    assert PolitenessOutcome.ALLOWED not in blocked
    assert len(blocked) == 3


def test_politeness_decision_carries_outcome_and_user_agent() -> None:
    decision = PolitenessDecision(
        allowed=False,
        outcome=PolitenessOutcome.ROBOTS_DISALLOWED,
        user_agent="JobCtl/0 (+https://example.com)",
        reason="Disallow: /jobs",
    )
    assert decision.allowed is False
    assert decision.outcome is PolitenessOutcome.ROBOTS_DISALLOWED
    assert decision.retry_after_seconds is None


def test_robots_verdict_has_allow_disallow_unknown() -> None:
    assert {v.value for v in RobotsVerdict} == {"allow", "disallow", "unknown"}
