"""Explicit public-acquisition policy values, without a feature/runtime owner."""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum


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
class LocatorPolicy:
    allow_autonomous_broad_discovery: bool = False


@dataclass(frozen=True)
class SourcePolicy:
    policy_id: str
    allowed_methods: tuple[SourcePolicyMethod, ...]
    authentication: SourceAuthenticationMode = SourceAuthenticationMode.NONE
    max_pages_per_run: int = 100
    max_run_frequency: str = "PT24H"
    min_request_interval_seconds: float = 1.0
    max_concurrent_requests_per_host: int = 1
    max_requests_per_run: int = 500
    third_party_control_bypass: bool = False

    def __post_init__(self):
        if not isinstance(self.policy_id, str) or not self.policy_id.strip() or not self.allowed_methods:
            raise ValueError("An acquisition policy requires its identity and allowed methods.")
        if any(type(value) is not int or value <= 0 for value in
               (self.max_pages_per_run, self.max_concurrent_requests_per_host, self.max_requests_per_run)):
            raise ValueError("Acquisition limits must be positive integers.")
        if (type(self.min_request_interval_seconds) not in (int, float)
                or not math.isfinite(self.min_request_interval_seconds) or self.min_request_interval_seconds < 0):
            raise ValueError("Acquisition spacing must be finite and nonnegative.")
        if self.third_party_control_bypass is not False:
            raise ValueError("Third-party controls cannot be bypassed.")


ATS_API_POLICY = SourcePolicy("ats_api_canonical", (SourcePolicyMethod.API,), max_pages_per_run=500,
                             max_run_frequency="PT6H", max_requests_per_run=2000)
ENRICHMENT_CRAWL_POLICY = SourcePolicy("enrichment_detail_crawl", (SourcePolicyMethod.RENDERED_DETAIL,),
                                     max_pages_per_run=500, max_run_frequency="PT6H", min_request_interval_seconds=2,
                                     max_requests_per_run=1000)
