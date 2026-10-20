"""Source-bound company context; no personal data or implicit identity matching."""

from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import Field, StrictStr

from jobctrl.domain.determinations import (
    Citation,
    DeterminationFailure,
    DeterminationModel,
    Source,
    determine,
)

PROMPT_VERSION = "company-briefing-v1"
FRESH_DAYS = 7
MAX_SOURCES = 3
MAX_TEXT = 12000


def public_source_url(value: str) -> str:
    """Parse an explicit anonymous URL. DNS/pinning is enforced at fetch time."""
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
        if (
            parts.scheme not in {"http", "https"}
            or not host
            or parts.username is not None
            or parts.password is not None
            or parts.query
            or parts.fragment
            or parts.port not in {None, 80 if parts.scheme == "http" else 443}
            or any(character.isspace() or ord(character) < 32 for character in value)
            or "\\" in value
            or len(value) > 2000
        ):
            raise ValueError
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
            raise ValueError
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError
        if ":" in host:
            host = "[" + host + "]"
        return urlunsplit((parts.scheme, host, parts.path or "/", "", ""))
    except (ValueError, UnicodeError):
        raise DeterminationFailure("briefing_invalid_public_url") from None


def company_key(homepage: str) -> str:
    return hashlib.sha256(public_source_url(homepage).encode()).hexdigest()


class BriefingClaim(DeterminationModel):
    kind: Literal["company_fact", "reported_event", "hypothesis"]
    text: StrictStr = Field(min_length=1, max_length=1500)
    uncertainty: StrictStr = Field(min_length=1, max_length=1000)
    event_date: StrictStr | None = Field(max_length=100)
    citations: list[Citation] = Field(min_length=1, max_length=3)


class CompanyBriefingDetermination(DeterminationModel):
    identity: Literal["confirmed", "needs_review"]
    identity_reason: StrictStr = Field(min_length=1, max_length=1000)
    identity_citations: list[Citation] = Field(min_length=1, max_length=3)
    claims: list[BriefingClaim] = Field(max_length=12)


def validate_briefing_result(result):
    for claim in result.claims:
        if claim.event_date is not None and not any(
            claim.event_date in citation.exact_values for citation in claim.citations
        ):
            raise DeterminationFailure("mismatched_value")


def draft_briefing(*, company, sources, dependencies):
    return determine(
        kind="company_briefing",
        schema=CompanyBriefingDetermination,
        schema_version="1",
        prompt_version=PROMPT_VERSION,
        instruction=(
            "Prepare a concise reusable company briefing from these public pages only. "
            "First determine whether the pages refer to the explicitly selected company "
            "and homepage. Ambiguous names, unrelated pages or insufficient identity evidence "
            "require needs_review. Separate company facts, reported market events and "
            "hypotheses. Copy any event_date literally from a citation and list it in exact_values. Every claim needs verbatim source citations and an explicit "
            "uncertainty statement; distinguish reported assertions from independently "
            "verified facts. Include an event_date only when cited, otherwise null. "
            "Do not infer publication dates from observation dates. Omit unsupported claims. "
            "Do not draft job-specific implications or candidate advice; their owners keep "
            "those separate from shared company facts. Return at most twelve claims."
        ),
        sources=[Source(source_id=row["sourceId"], text=row["text"]) for row in sources],
        context={
            "company": {key: company[key] for key in ("companyId", "name", "homepageUrl")},
            "publicSources": [
                {key: row[key] for key in ("sourceId", "url", "finalUrl", "contentHash")} for row in sources
            ],
        },
        entity_id=company["companyId"],
        validate=validate_briefing_result,
        **dependencies,
    )


def briefing_view(*, company, accepted, attempt, identity_current, now=None):
    now = now or datetime.now(timezone.utc)
    reasons = []
    if not identity_current:
        reasons.append("identity_review_required")
    if attempt and attempt["failureCode"] == "briefing_identity_needs_review":
        reasons.append("source_identity_needs_review")
    if accepted is not None:
        if datetime.fromisoformat(accepted["observedAt"]) + timedelta(days=FRESH_DAYS) <= now:
            reasons.append("sources_older_than_seven_days")
        if accepted["configurationId"] != company["revision"]:
            reasons.append("sources_changed")
        if accepted["promptVersion"] != PROMPT_VERSION:
            reasons.append("briefing_version_changed")
    return {
        "company": company,
        "accepted": accepted,
        "lastAttempt": attempt,
        "staleReasons": reasons,
        "status": "needs_review"
        if not identity_current or "source_identity_needs_review" in reasons
        else "missing"
        if accepted is None
        else "stale"
        if reasons
        else "current",
    }
