"""Source locator and registry model for Discovery.

The model is intentionally local-first and additive: legacy scrapers still
load their current YAML, while this contract gives those YAML records typed
source identities, policy guardrails, and quality placeholders.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from jobhunter.domain.tenant import TenantId


class SourceKind(str, Enum):
    ATS_API = "ats_api"
    EMPLOYER_CAREERS_PAGE = "employer_careers_page"
    OFFICIAL_API = "official_api"
    LICENSED_FEED = "licensed_feed"
    NICHE_BOARD = "niche_board"
    BROAD_BOARD = "broad_board"
    SMART_EXTRACT = "smart_extract"
    USER_MEDIATED_CAPTURE = "user_mediated_capture"


class SourceState(str, Enum):
    ACTIVE = "active"
    EXPERIMENTAL = "experimental"
    QUARANTINED = "quarantined"
    DISABLED = "disabled"


class SourcePriority(str, Enum):
    CANONICAL = "canonical"
    PREFERRED = "preferred"
    STANDARD = "standard"
    FALLBACK = "fallback"
    LEAD_GENERATOR = "lead_generator"


class SourcePolicyMethod(str, Enum):
    API = "api"
    FEED = "feed"
    STATIC_PAGE = "static_page"
    RENDERED_LISTING = "rendered_listing"
    RENDERED_DETAIL = "rendered_detail"
    USER_MEDIATED_CAPTURE = "user_mediated_capture"


class SourceAuthenticationMode(str, Enum):
    NONE = "none"
    USER_SESSION = "user_session"
    API_KEY = "api_key"
    OAUTH = "oauth"
    MANUAL = "manual"


class ManualActionReason(str, Enum):
    CAPTCHA = "captcha"
    LOGIN_REQUIRED = "login_required"
    PAYWALL = "paywall"
    BOT_DETECTION = "bot_detection"
    RATE_LIMIT = "rate_limit"
    PROTECTED_INTERNAL_SITE = "protected_internal_site"
    AMBIGUOUS_CAREER_SYSTEM = "ambiguous_career_system"
    BROWSER_EXTENSION_CAPTURE = "browser_extension_capture"


class ManualCaptureMode(str, Enum):
    CURRENT_PAGE = "current_page"
    SAVED_HTML = "saved_html"
    COPIED_URL = "copied_url"
    PASTED_TEXT = "pasted_text"
    EMAIL_IMPORT = "email_import"


@dataclass(frozen=True)
class ManualInterventionPolicy:
    allowed: bool = True
    triggers: tuple[ManualActionReason, ...] = (
        ManualActionReason.CAPTCHA,
        ManualActionReason.LOGIN_REQUIRED,
        ManualActionReason.PAYWALL,
        ManualActionReason.BOT_DETECTION,
        ManualActionReason.RATE_LIMIT,
    )
    capture_modes: tuple[ManualCaptureMode, ...] = (
        ManualCaptureMode.CURRENT_PAGE,
        ManualCaptureMode.SAVED_HTML,
        ManualCaptureMode.COPIED_URL,
        ManualCaptureMode.PASTED_TEXT,
        ManualCaptureMode.EMAIL_IMPORT,
    )


@dataclass(frozen=True)
class ContentFilterOverridePolicy:
    allowed: bool = False
    requires_reason: bool = True
    allowed_filters: tuple[str, ...] = ()


@dataclass(frozen=True)
class SourcePolicy:
    policy_id: str
    allowed_methods: tuple[SourcePolicyMethod, ...]
    authentication: SourceAuthenticationMode = SourceAuthenticationMode.NONE
    attribution: str = "none"
    max_pages_per_run: int = 100
    max_run_frequency: str = "PT24H"
    locator_max_requests_per_domain: int = 5
    manual_intervention: ManualInterventionPolicy = field(default_factory=ManualInterventionPolicy)
    content_filter_override: ContentFilterOverridePolicy = field(default_factory=ContentFilterOverridePolicy)
    third_party_control_bypass: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.policy_id, str) or not self.policy_id.strip():
            raise ValueError("SourcePolicy.policy_id must be a non-empty string")
        if not self.allowed_methods:
            raise ValueError("SourcePolicy.allowed_methods must contain at least one method")
        if self.max_pages_per_run <= 0:
            raise ValueError("SourcePolicy.max_pages_per_run must be positive")
        if self.locator_max_requests_per_domain <= 0:
            raise ValueError("SourcePolicy.locator_max_requests_per_domain must be positive")
        if self.third_party_control_bypass is not False:
            raise ValueError("SourcePolicy.third_party_control_bypass must remain false")


SMART_EXTRACT_EXPERIMENTAL_POLICY = SourcePolicy(
    policy_id="smart_extract_experimental",
    allowed_methods=(
        SourcePolicyMethod.STATIC_PAGE,
        SourcePolicyMethod.RENDERED_LISTING,
        SourcePolicyMethod.RENDERED_DETAIL,
    ),
    max_pages_per_run=50,
    content_filter_override=ContentFilterOverridePolicy(
        allowed=True,
        requires_reason=True,
        allowed_filters=("low_confidence_extraction", "short_description"),
    ),
)

BROAD_BOARD_LEAD_POLICY = SourcePolicy(
    policy_id="broad_board_lead_generator",
    allowed_methods=(SourcePolicyMethod.RENDERED_LISTING,),
    max_pages_per_run=100,
    max_run_frequency="PT6H",
)

WORKDAY_API_POLICY = SourcePolicy(
    policy_id="workday_api_canonical",
    allowed_methods=(SourcePolicyMethod.API,),
    max_pages_per_run=500,
    max_run_frequency="PT6H",
)

ATS_API_POLICY = SourcePolicy(
    policy_id="ats_api_canonical",
    allowed_methods=(SourcePolicyMethod.API,),
    max_pages_per_run=500,
    max_run_frequency="PT6H",
)


@dataclass(frozen=True)
class SourceQualityPlaceholder:
    active_rate: float | None = None
    duplicate_rate: float | None = None
    detail_success_rate: float | None = None
    apply_url_success_rate: float | None = None
    stale_rate: float | None = None
    sample_size: int = 0


@dataclass(frozen=True)
class SourceRegistryEntry:
    tenant_id: TenantId
    source_id: str
    kind: SourceKind
    display_name: str
    owner: str
    priority: SourcePriority
    state: SourceState
    policy: SourcePolicy
    adapter_config: dict[str, Any] = field(default_factory=dict)
    quality: SourceQualityPlaceholder = field(default_factory=SourceQualityPlaceholder)

    def __post_init__(self) -> None:
        if not isinstance(self.source_id, str) or not self.source_id.strip():
            raise ValueError("SourceRegistryEntry.source_id must be a non-empty string")
        if not isinstance(self.display_name, str) or not self.display_name.strip():
            raise ValueError("SourceRegistryEntry.display_name must be a non-empty string")
        if self.owner not in {"system", "user"}:
            raise ValueError("SourceRegistryEntry.owner must be 'system' or 'user'")


@dataclass(frozen=True)
class SourceDiscoveryEvidence:
    matched_url: str
    page_title: str | None = None
    detected_ats_kind: str | None = None
    source_native_token: str | None = None
    employer_domain_matched: bool = False
    redirect_chain: tuple[str, ...] = ()
    validation_fetch_status: int | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.matched_url, str) or not self.matched_url.strip():
            raise ValueError("SourceDiscoveryEvidence.matched_url must be a non-empty string")


@dataclass(frozen=True)
class ManualActionRequired:
    originating_url: str
    source_id: str | None
    reason: ManualActionReason
    retry_context: dict[str, Any]
    required_at: str

    def __post_init__(self) -> None:
        if not isinstance(self.originating_url, str) or not self.originating_url.strip():
            raise ValueError("ManualActionRequired.originating_url must be a non-empty string")


@dataclass(frozen=True)
class ManualCaptureProvenance:
    source_kind: str
    originating_url: str
    captured_at: str
    capture_mode: ManualCaptureMode
    future_manual_action_required: bool
    capture_client: str | None = None
    extension_version: str | None = None

    def __post_init__(self) -> None:
        if self.source_kind != SourceKind.USER_MEDIATED_CAPTURE.value:
            raise ValueError("ManualCaptureProvenance.source_kind must be user_mediated_capture")
        if not isinstance(self.originating_url, str) or not self.originating_url.strip():
            raise ValueError("ManualCaptureProvenance.originating_url must be a non-empty string")


@dataclass(frozen=True)
class SourceLocationCandidate:
    tenant_id: TenantId
    candidate_id: str
    candidate_url: str
    source_kind: SourceKind
    confidence: float
    evidence: SourceDiscoveryEvidence
    manual_action_required: ManualActionRequired | None = None
    discovered_at: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.candidate_id, str) or not self.candidate_id.strip():
            raise ValueError("SourceLocationCandidate.candidate_id must be a non-empty string")
        if not isinstance(self.candidate_url, str) or not self.candidate_url.strip():
            raise ValueError("SourceLocationCandidate.candidate_url must be a non-empty string")
        if self.confidence < 0 or self.confidence > 1:
            raise ValueError("SourceLocationCandidate.confidence must be between 0 and 1")


@dataclass(frozen=True)
class LocatorPolicy:
    user_agent: str = "JobHunter Source Locator (local)"
    max_requests_per_domain: int = 5
    min_promotion_confidence: float = 0.75
    min_manual_review_confidence: float = 0.4
    domain_allowlist: tuple[str, ...] = ()
    allow_autonomous_broad_discovery: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.user_agent, str) or not self.user_agent.strip():
            raise ValueError("LocatorPolicy.user_agent must be a non-empty string")
        if self.max_requests_per_domain <= 0:
            raise ValueError("LocatorPolicy.max_requests_per_domain must be positive")
        for field_name in ("min_promotion_confidence", "min_manual_review_confidence"):
            value = getattr(self, field_name)
            if value < 0 or value > 1:
                raise ValueError(f"LocatorPolicy.{field_name} must be between 0 and 1")


LocatorDecision = str


def validate_locator_candidate(
    candidate: SourceLocationCandidate,
    policy: LocatorPolicy | None = None,
) -> LocatorDecision:
    """Return the next safe action for a source locator candidate."""
    active_policy = policy or LocatorPolicy()
    if candidate.manual_action_required is not None:
        return "manual_action_required"
    if candidate.confidence >= active_policy.min_manual_review_confidence:
        return "promote"
    return "reject"
