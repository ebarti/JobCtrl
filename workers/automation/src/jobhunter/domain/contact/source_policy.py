"""Source-access policy for supervised contact research (INV-3).

Exactly three source categories are permitted, defaulting to the most
restrictive posture (fail-closed), modelled on the discovery access policies:

  * ``user_entered`` — data the user typed; no network fetch.
  * ``public_web_page`` — an unauthenticated GET of a public URL, only when the
    URL's host is on the per-source opt-in ``domain_allowlist`` and is not
    login-walled/paywalled/bot-protected. Fetched exclusively through the merged
    politeness gateway (outreach planner plan §5.3). No source is auto-fetched
    by default (resolved decision 3).
  * ``user_imported_list`` — a local file the user provided; no network fetch.

Third-party account scraping and login-walled harvesting are NOT modelled as
sources — a request for any unmodelled category is rejected before any fetch.

The policy reuses the discovery guardrails: ``SourcePolicy`` with
``third_party_control_bypass`` hard-locked ``False`` and
``authentication == none`` (never a stored login), plus a ``LocatorPolicy`` with
``allow_autonomous_broad_discovery == False`` (never crawl the open web). Any
login-walled/paywalled URL routes to the manual-capture path
(``ManualCaptureMode``) instead of being auto-fetched, reusing the
discovery ``ManualActionReason`` classification.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import ipaddress
import socket
from urllib.parse import urlsplit

from jobhunter.domain.discovery.source_registry import (
    LocatorPolicy,
    ManualActionReason,
    ManualCaptureMode,
    SourceAuthenticationMode,
    SourcePolicy,
    SourcePolicyMethod,
)


class ResearchSourceCategory(str, Enum):
    """The three permitted contact-research source categories (INV-3)."""

    USER_ENTERED = "user_entered"
    PUBLIC_WEB_PAGE = "public_web_page"
    USER_IMPORTED_LIST = "user_imported_list"


RESEARCH_SOURCE_CATEGORIES: frozenset[str] = frozenset(
    category.value for category in ResearchSourceCategory
)


class ResearchSourceDecision(str, Enum):
    """The policy verdict for one prospective research source."""

    ALLOWED = "allowed"
    MANUAL_CAPTURE_REQUIRED = "manual_capture_required"
    REJECTED = "rejected"


# Manual-capture modes offered for a login-walled/paywalled/bot-protected URL —
# reusing the discovery vocabulary (no auto-fetch across the login wall, INV-3).
CONTACT_RESEARCH_MANUAL_CAPTURE_MODES: tuple[ManualCaptureMode, ...] = (
    ManualCaptureMode.COPIED_URL,
    ManualCaptureMode.PASTED_TEXT,
    ManualCaptureMode.SAVED_HTML,
)

# Login-walled / paywalled / bot-protected URL markers. A match always routes to
# manual capture and is never auto-fetched (mirrors the discovery
# ``_looks_protected`` classification; kept in the domain so the policy has no
# infrastructure dependency).
_PROTECTED_URL_MARKERS: tuple[str, ...] = (
    "login",
    "signin",
    "sign-in",
    "sso",
    "oauth",
    "captcha",
    "paywall",
    "subscribe",
    "protected",
    "internal",
    "/auth",
)


def looks_protected(url: str) -> bool:
    """Return True when a URL looks login-walled/paywalled/bot-protected."""
    text = (url or "").lower()
    return any(marker in text for marker in _PROTECTED_URL_MARKERS)


_BLOCKED_HOSTNAMES: frozenset[str] = frozenset(
    {
        "localhost",
        "metadata.google.internal",
    }
)


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _is_blocked_ip_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _hostname_resolves_to_blocked_address(hostname: str) -> bool:
    try:
        addresses = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        # Keep the policy focused on the SSRF boundary without making source
        # configuration depend on local DNS reachability; the fetch will fail
        # later if the host truly cannot resolve.
        return False
    return any(_is_blocked_ip_address(result[4][0]) for result in addresses)


def _is_public_web_url(url: str) -> bool:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return False
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return False
    hostname = (parts.hostname or "").lower().rstrip(".")
    if not hostname:
        return False
    if hostname in _BLOCKED_HOSTNAMES or hostname.endswith(".localhost"):
        return False
    if _is_blocked_ip_address(hostname):
        return False
    return not _hostname_resolves_to_blocked_address(hostname)


def contact_research_source_policy() -> SourcePolicy:
    """The discovery ``SourcePolicy`` guardrails reused for contact research.

    ``authentication`` stays ``NONE`` and ``third_party_control_bypass`` stays
    ``False`` (both enforced again by :class:`ContactResearchSourcePolicy`); the
    politeness gateway enforces robots, rate, concurrency, and the per-run
    request budget declared here.
    """
    return SourcePolicy(
        policy_id="contact_research_public_page",
        allowed_methods=(SourcePolicyMethod.STATIC_PAGE, SourcePolicyMethod.RENDERED_DETAIL),
        authentication=SourceAuthenticationMode.NONE,
        max_pages_per_run=25,
        max_run_frequency="PT24H",
        min_request_interval_seconds=2.0,
        max_concurrent_requests_per_host=1,
        max_requests_per_run=50,
    )


@dataclass(frozen=True)
class ContactResearchSourcePolicy:
    """Conservative, explicit allowlist for supervised contact research (INV-3).

    ``domain_allowlist`` is the per-source opt-in set: a public web page is only
    fetched when its host is listed here. The default (empty) means **no public
    source is auto-fetched** — the resolved conservative default.
    """

    domain_allowlist: tuple[str, ...] = ()
    source_policy: SourcePolicy = field(default_factory=contact_research_source_policy)
    locator_policy: LocatorPolicy = field(
        default_factory=lambda: LocatorPolicy(allow_autonomous_broad_discovery=False)
    )

    def __post_init__(self) -> None:
        if self.source_policy.third_party_control_bypass is not False:
            raise ValueError(
                "ContactResearchSourcePolicy: third_party_control_bypass must remain False (INV-3)"
            )
        if self.source_policy.authentication is not SourceAuthenticationMode.NONE:
            raise ValueError(
                "ContactResearchSourcePolicy: authentication must be 'none' — "
                "no login-walled or authenticated-session source (INV-3)"
            )
        if self.locator_policy.allow_autonomous_broad_discovery is not False:
            raise ValueError(
                "ContactResearchSourcePolicy: allow_autonomous_broad_discovery must "
                "stay False — never autonomously crawl the open web (INV-3)"
            )

    def is_allowlisted(self, url: str) -> bool:
        host = _host(url)
        if not host:
            return False
        return any(
            host == domain or host.endswith("." + domain) for domain in self.domain_allowlist
        )

    def authorize(self, *, category: str, url: str = "") -> ResearchSourceDecision:
        """Decide whether a prospective source may be fetched — before any fetch.

        An attempt against a disallowed source category (e.g. third-party
        account scraping, login-walled harvesting) is REJECTED. A public web
        page is rejected unless its host is explicitly opted in, and a
        login-walled/paywalled URL always routes to manual capture.
        """
        if category not in RESEARCH_SOURCE_CATEGORIES:
            return ResearchSourceDecision.REJECTED
        if category in (
            ResearchSourceCategory.USER_ENTERED.value,
            ResearchSourceCategory.USER_IMPORTED_LIST.value,
        ):
            return ResearchSourceDecision.ALLOWED
        # public_web_page
        if not url.strip():
            return ResearchSourceDecision.REJECTED
        if not _is_public_web_url(url):
            return ResearchSourceDecision.REJECTED
        if looks_protected(url):
            return ResearchSourceDecision.MANUAL_CAPTURE_REQUIRED
        if not self.is_allowlisted(url):
            return ResearchSourceDecision.REJECTED
        return ResearchSourceDecision.ALLOWED

    def manual_capture_reason(self, url: str) -> ManualActionReason:
        text = (url or "").lower()
        if "captcha" in text:
            return ManualActionReason.CAPTCHA
        if "paywall" in text or "subscribe" in text:
            return ManualActionReason.PAYWALL
        return ManualActionReason.LOGIN_REQUIRED

    def source_availability(self) -> tuple[dict[str, object], ...]:
        """Display descriptors mirroring the compensation-source policy idiom.

        Each descriptor reports ``availability`` / ``configured`` /
        ``disabledReason`` so the UI shows why a source is (un)available, exactly
        as the compensation source registry does.
        """
        public_available = bool(self.domain_allowlist)
        return (
            {
                "sourceKind": ResearchSourceCategory.USER_ENTERED.value,
                "availability": "available",
                "configured": True,
                "disabledReason": None,
            },
            {
                "sourceKind": ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
                "availability": "available" if public_available else "unavailable",
                "configured": public_available,
                "disabledReason": (
                    None
                    if public_available
                    else "No public source opted in. Add an allowlisted domain to enable "
                    "supervised, rate-limited fetching; login-walled URLs always route to "
                    "manual capture."
                ),
            },
            {
                "sourceKind": ResearchSourceCategory.USER_IMPORTED_LIST.value,
                "availability": "available",
                "configured": True,
                "disabledReason": None,
            },
        )


__all__ = [
    "CONTACT_RESEARCH_MANUAL_CAPTURE_MODES",
    "RESEARCH_SOURCE_CATEGORIES",
    "ContactResearchSourcePolicy",
    "ResearchSourceCategory",
    "ResearchSourceDecision",
    "contact_research_source_policy",
    "looks_protected",
]
