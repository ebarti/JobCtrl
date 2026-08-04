"""Enrichment value objects.

See ddd-target.md §4.2. All value objects are frozen dataclasses;
constructors enforce invariants up front.

Invariants enforced here:

  ``FullDescription`` — non-empty trimmed string. The value object is the
                        canonical fact about the extracted job description;
                        legacy ``jobs.full_description`` carries the same
                        text but the read-side fallback is opaque to this
                        layer.
  ``ApplicationUrl``  — non-empty trimmed string (URL syntax not strictly
                        enforced; some scrapers store the posting URL as
                        the application URL when no separate apply link
                        exists).
  ``ExtractionTier``  — enum constrained to the three tiers from §4.2:
                        ``json_ld``, ``css_selectors``, ``llm_assisted``.
  ``EnrichmentError`` — code + message + retryable flag, captured per
                        failed ``EnrichmentAttempt``.
  ``DetailPage``      — value object handed to the extractors. Carries the
                        raw HTML, page title, final URL, and any JSON-LD
                        blobs found on the page. The fetcher port returns
                        this — the extractors consume it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from jobctrl.domain.errors import TransientNetworkError
from jobctrl.domain.tenant import TenantId


@dataclass(frozen=True)
class EnrichmentExecutionLease:
    """Fencing token for one Discover execution's active enrichment activity."""

    tenant_id: TenantId
    workflow_id: str
    run_id: str
    owner_token: str
    epoch: int
    generation: int
    activity_phase: int
    activity_attempt: int

    def __post_init__(self) -> None:
        if not self.workflow_id.strip() or not self.run_id.strip():
            raise ValueError("enrichment lease execution ids must be non-empty")
        if not self.owner_token.strip():
            raise ValueError("enrichment lease owner_token must be non-empty")
        if (
            self.epoch < 1
            or self.generation < 1
            or self.activity_phase < 1
            or self.activity_attempt < 1
        ):
            raise ValueError(
                "enrichment lease epoch, generation, phase, and attempt must be positive"
            )


class StaleEnrichmentExecutionLease(TransientNetworkError):
    """Raised when an older enrichment activity tries to mutate durable state."""


# ---------------------------------------------------------------------------
# FullDescription
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FullDescription:
    """The full job description text extracted from the detail page."""

    text: str

    def __post_init__(self) -> None:
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("FullDescription.text must be a non-empty string")

    def __str__(self) -> str:
        return self.text


# ---------------------------------------------------------------------------
# ApplicationUrl
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ApplicationUrl:
    """The URL where the candidate can submit their application.

    May equal the posting URL when the source board hosts the apply
    flow (the legacy detail extractor falls back to ``page.url`` when
    no dedicated apply button exists).
    """

    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not self.value.strip():
            raise ValueError("ApplicationUrl.value must be a non-empty string")

    def __str__(self) -> str:
        return self.value


# ---------------------------------------------------------------------------
# ExtractionTier
# ---------------------------------------------------------------------------


class ExtractionTier(str, Enum):
    """Which tier of the three-tier extraction cascade succeeded.

    Per §4.2 the legal values are ``json_ld``, ``css_selectors``,
    ``llm_assisted``. The string enum stays compatible with the
    ``job_enrichments.extraction_tier`` TEXT column so the SQLite
    adapter can round-trip without translation.
    """

    JSON_LD = "json_ld"
    CSS_SELECTORS = "css_selectors"
    LLM_ASSISTED = "llm_assisted"

    @classmethod
    def from_optional(cls, value: Any) -> "ExtractionTier | None":
        if value is None:
            return None
        text = str(value).strip().lower()
        if not text:
            return None
        for member in cls:
            if member.value == text:
                return member
        return None


# ---------------------------------------------------------------------------
# EnrichmentError
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EnrichmentError:
    """Failure metadata recorded on a failed ``EnrichmentAttempt``.

    ``retryable`` distinguishes transient failures (timeouts, 5xx) from
    permanent ones (404, 410, 451). The orchestrator inspects this flag
    when deciding whether to enqueue another attempt.
    """

    code: str
    message: str
    retryable: bool = True

    def __post_init__(self) -> None:
        if not isinstance(self.code, str) or not self.code.strip():
            raise ValueError("EnrichmentError.code must be a non-empty string")
        if not isinstance(self.message, str):
            raise ValueError("EnrichmentError.message must be a string")
        if not isinstance(self.retryable, bool):
            raise ValueError("EnrichmentError.retryable must be a bool")

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }


# ---------------------------------------------------------------------------
# DetailPage
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DetailPage:
    """Raw detail-page payload returned by ``DetailPageFetcherPort``.

    The fetcher is responsible for navigating to ``url`` (typically with
    Playwright in local mode, Browserbase in hosted mode) and producing
    this value object. The extractors then consume it via pure
    functions — no I/O beyond what the fetcher already did.

    ``json_ld`` is the parsed list of ``<script type="application/ld+json">``
    payloads; ``html`` is the cleaned main-content HTML chunk used for
    Tier-3 LLM extraction. ``status`` mirrors the HTTP status code so
    extractors / orchestrators can short-circuit on permanent failures.
    """

    url: str
    final_url: str = ""
    page_title: str = ""
    html: str = ""
    json_ld: tuple[Any, ...] = field(default_factory=tuple)
    status: int | None = None
    fetched_at: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.url, str) or not self.url.strip():
            raise ValueError("DetailPage.url must be a non-empty string")
        if not isinstance(self.json_ld, tuple):
            raise ValueError("DetailPage.json_ld must be a tuple (got list?)")
