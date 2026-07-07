"""Contact-research source-access policy (INV-3) — R6 Phase 2.

Covers the conservative allowlist: disallowed source categories are rejected
before any fetch, ``third_party_control_bypass`` stays locked False, no public
source is auto-fetched by default (per-source opt-in), and any login-walled /
paywalled URL routes to manual capture instead of being auto-fetched.
"""

from __future__ import annotations

import pytest

from jobctrl.domain.contact.source_policy import (
    ContactResearchSourcePolicy,
    ResearchSourceCategory,
    ResearchSourceDecision,
    looks_protected,
)
from jobctrl.domain.discovery.source_registry import (
    SourceAuthenticationMode,
    SourcePolicy,
    SourcePolicyMethod,
)

_ALLOWED_HOST = "acme.example"


def test_disallowed_source_category_is_rejected_before_any_fetch() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_ALLOWED_HOST,))
    for category in ("third_party_account_scraping", "login_walled_harvesting", ""):
        assert (
            policy.authorize(category=category, url=f"https://{_ALLOWED_HOST}/x")
            is ResearchSourceDecision.REJECTED
        )


def test_third_party_control_bypass_is_locked_false() -> None:
    # The discovery SourcePolicy itself refuses a truthy bypass...
    with pytest.raises(ValueError, match="third_party_control_bypass"):
        SourcePolicy(
            policy_id="x",
            allowed_methods=(SourcePolicyMethod.STATIC_PAGE,),
            third_party_control_bypass=True,
        )
    # ...and the default research policy inherits the locked-false stance.
    assert ContactResearchSourcePolicy().source_policy.third_party_control_bypass is False


def test_authenticated_source_policy_is_rejected() -> None:
    with pytest.raises(ValueError, match="authentication must be 'none'"):
        ContactResearchSourcePolicy(
            source_policy=SourcePolicy(
                policy_id="x",
                allowed_methods=(SourcePolicyMethod.STATIC_PAGE,),
                authentication=SourceAuthenticationMode.USER_SESSION,
            )
        )


def test_default_no_public_source_is_auto_fetched() -> None:
    policy = ContactResearchSourcePolicy()  # empty allowlist == conservative default
    assert (
        policy.authorize(
            category=ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
            url="https://acme.example/team",
        )
        is ResearchSourceDecision.REJECTED
    )


def test_opted_in_public_source_is_allowed() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_ALLOWED_HOST,))
    assert (
        policy.authorize(
            category=ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
            url="https://acme.example/team",
        )
        is ResearchSourceDecision.ALLOWED
    )
    # A host outside the opt-in list stays rejected even when others are enabled.
    assert (
        policy.authorize(
            category=ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
            url="https://evil.example/scrape",
        )
        is ResearchSourceDecision.REJECTED
    )


def test_public_source_must_use_http_or_https() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_ALLOWED_HOST,))
    for url in (
        f"file://{_ALLOWED_HOST}/etc/passwd",
        f"ftp://{_ALLOWED_HOST}/contacts.csv",
        f"javascript://{_ALLOWED_HOST}/alert",
        f"{_ALLOWED_HOST}/team",
    ):
        assert (
            policy.authorize(category=ResearchSourceCategory.PUBLIC_WEB_PAGE.value, url=url)
            is ResearchSourceDecision.REJECTED
        )


def test_protected_url_routes_to_manual_capture_not_auto_fetch() -> None:
    policy = ContactResearchSourcePolicy(domain_allowlist=(_ALLOWED_HOST,))
    for path in ("/login", "/sso/start", "/members?paywall=1"):
        assert (
            policy.authorize(
                category=ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
                url=f"https://{_ALLOWED_HOST}{path}",
            )
            is ResearchSourceDecision.MANUAL_CAPTURE_REQUIRED
        )
    assert looks_protected("https://acme.example/login") is True
    assert looks_protected("https://acme.example/team") is False


def test_user_provided_categories_never_fetch() -> None:
    policy = ContactResearchSourcePolicy()
    for category in (
        ResearchSourceCategory.USER_ENTERED.value,
        ResearchSourceCategory.USER_IMPORTED_LIST.value,
    ):
        assert policy.authorize(category=category) is ResearchSourceDecision.ALLOWED


def test_source_availability_reports_public_source_opt_in_state() -> None:
    unconfigured = {
        entry["sourceKind"]: entry
        for entry in ContactResearchSourcePolicy().source_availability()
    }
    assert unconfigured["public_web_page"]["availability"] == "unavailable"
    assert unconfigured["public_web_page"]["configured"] is False
    assert unconfigured["public_web_page"]["disabledReason"]
    assert unconfigured["user_entered"]["availability"] == "available"

    configured = {
        entry["sourceKind"]: entry
        for entry in ContactResearchSourcePolicy(
            domain_allowlist=(_ALLOWED_HOST,)
        ).source_availability()
    }
    assert configured["public_web_page"]["availability"] == "available"
    assert configured["public_web_page"]["configured"] is True
    assert configured["public_web_page"]["disabledReason"] is None
