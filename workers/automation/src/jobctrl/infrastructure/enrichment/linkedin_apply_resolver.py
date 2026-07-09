"""Authenticated LinkedIn apply URL resolver.

This adapter is intentionally narrow: it uses a logged-in Chrome profile to
inspect LinkedIn job pages and capture the external apply target, then stops
before any application form interaction. It does not submit applications.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qsl, unquote, urljoin, urlparse

from jobctrl import config
from jobctrl.infrastructure.network import (
    PublicHttpUrlRouteGuard,
    PublicUrlDecision,
    validate_public_http_url,
)
from jobctrl.infrastructure.network.proxy import ProxyConfig

log = logging.getLogger(__name__)

LINKEDIN_APPLY_RESOLVER_ENABLED_ENV = "JOBCTRL_LINKEDIN_APPLY_RESOLVER"
LINKEDIN_APPLY_PROFILE_DIR_ENV = "JOBCTRL_LINKEDIN_APPLY_PROFILE_DIR"
LINKEDIN_APPLY_SOURCE_PROFILE_DIR_ENV = "JOBCTRL_LINKEDIN_APPLY_SOURCE_PROFILE_DIR"
LINKEDIN_APPLY_CHROME_PROFILE_ENV = "JOBCTRL_LINKEDIN_APPLY_CHROME_PROFILE"
LINKEDIN_APPLY_HEADLESS_ENV = "JOBCTRL_LINKEDIN_APPLY_HEADLESS"
LINKEDIN_APPLY_TIMEOUT_SECONDS_ENV = "JOBCTRL_LINKEDIN_APPLY_TIMEOUT_SECONDS"

_DEFAULT_TIMEOUT_SECONDS = 20.0
_NAV_TIMEOUT_MS = 45000
_LOAD_TIMEOUT_MS = 15000
_EXTERNAL_URL_PARAM_NAMES = {
    "url",
    "u",
    "target",
    "target_url",
    "targeturl",
    "redirect",
    "redirect_url",
    "redirecturl",
    "external_url",
    "externalurl",
}
_APPLY_TEXT_RE = re.compile(r"\b(apply|solicitar)\b", re.IGNORECASE)

UrlSafetyChecker = Callable[[str], PublicUrlDecision]


@dataclass(frozen=True)
class LinkedInApplyResolution:
    """Result of one authenticated LinkedIn apply target lookup."""

    application_url: str | None
    method: str
    error: str | None = None

    @property
    def ok(self) -> bool:
        return bool(self.application_url)


def linkedin_apply_resolver_enabled() -> bool:
    """Return whether authenticated LinkedIn apply resolution should run."""

    raw = os.environ.get(LINKEDIN_APPLY_RESOLVER_ENABLED_ENV)
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def default_linkedin_apply_profile_dir() -> Path:
    """Dedicated persistent Chrome profile used for LinkedIn apply resolving."""

    configured = os.environ.get(LINKEDIN_APPLY_PROFILE_DIR_ENV)
    if configured:
        return Path(configured).expanduser()
    return config.CHROME_WORKER_DIR / "linkedin-apply-url-resolver"


def linkedin_apply_headless_default() -> bool:
    """Resolve the headless flag for the authenticated Chrome profile."""

    raw = os.environ.get(LINKEDIN_APPLY_HEADLESS_ENV)
    if raw is None:
        return False
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def linkedin_apply_timeout_seconds() -> float:
    raw = os.environ.get(LINKEDIN_APPLY_TIMEOUT_SECONDS_ENV)
    if raw is None:
        return _DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        log.warning("Invalid %s=%r; using default", LINKEDIN_APPLY_TIMEOUT_SECONDS_ENV, raw)
        return _DEFAULT_TIMEOUT_SECONDS
    return max(1.0, value)


def linkedin_apply_chrome_profile() -> str:
    raw = os.environ.get(LINKEDIN_APPLY_CHROME_PROFILE_ENV)
    if raw and raw.strip():
        return raw.strip()
    return "Default"


class LinkedInApplyUrlResolver:
    """Playwright-backed resolver using a persistent authenticated profile."""

    def __init__(
        self,
        *,
        profile_dir: Path | None = None,
        headless: bool | None = None,
        proxy: ProxyConfig | None = None,
        timeout_seconds: float | None = None,
        user_agent: str | None = None,
        playwright: Any | None = None,
        chrome_profile: str | None = None,
        url_safety_checker: UrlSafetyChecker | None = None,
    ) -> None:
        self._profile_dir = profile_dir or default_linkedin_apply_profile_dir()
        self._chrome_profile = chrome_profile or linkedin_apply_chrome_profile()
        self._headless = linkedin_apply_headless_default() if headless is None else headless
        self._proxy = proxy
        self._timeout_seconds = timeout_seconds or linkedin_apply_timeout_seconds()
        self._user_agent = user_agent
        self._external_playwright = playwright
        self._url_safety_checker = url_safety_checker or validate_public_http_url
        self._playwright: Any | None = None
        self._context: Any | None = None

    def __enter__(self) -> "LinkedInApplyUrlResolver":
        self.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    @property
    def started(self) -> bool:
        return self._context is not None

    def start(self) -> None:
        if self._context is not None:
            return
        self._profile_dir.mkdir(parents=True, exist_ok=True)
        _bootstrap_profile_dir(self._profile_dir, chrome_profile=self._chrome_profile)
        if self._external_playwright is None:
            from playwright.sync_api import sync_playwright

            self._playwright = sync_playwright().start()
            playwright = self._playwright
        else:
            playwright = self._external_playwright
        launch_opts: dict[str, Any] = {
            "headless": self._headless,
            "executable_path": config.get_chrome_path(),
            "args": (
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-notifications",
                "--disable-popup-blocking=false",
                "--disable-session-crashed-bubble",
                "--hide-crash-restore-bubble",
                f"--profile-directory={self._chrome_profile}",
            ),
        }
        if self._proxy is not None:
            launch_opts["proxy"] = self._proxy.playwright
        if self._user_agent:
            launch_opts["user_agent"] = self._user_agent
        self._context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(self._profile_dir),
            **launch_opts,
        )

    def close(self) -> None:
        context = self._context
        playwright = self._playwright
        self._context = None
        self._playwright = None
        if context is not None:
            try:
                context.close()
            except Exception:
                log.debug("LinkedIn apply resolver context close failed", exc_info=True)
        if playwright is not None:
            try:
                playwright.stop()
            except Exception:
                log.debug("LinkedIn apply resolver playwright stop failed", exc_info=True)

    def new_page(self) -> Any:
        if self._context is None:
            self.start()
        assert self._context is not None
        return self._context.new_page()

    def resolve(self, job_url: str) -> LinkedInApplyResolution:
        """Navigate to ``job_url`` and capture the external apply target."""

        initial_safety = self._url_safety_checker(job_url)
        if not initial_safety.allowed:
            return _unsafe_url_resolution(initial_safety.reason)

        page = self.new_page()
        route_guard = _install_public_route_guard(page, context=self._context)
        try:
            try:
                page.goto(job_url, timeout=_NAV_TIMEOUT_MS)
                page.wait_for_load_state("domcontentloaded", timeout=_LOAD_TIMEOUT_MS)
                try:
                    page.wait_for_load_state("networkidle", timeout=5000)
                except Exception:
                    pass
            except Exception as exc:
                if route_guard.blocked:
                    return _unsafe_url_resolution(route_guard.blocked_reason)
                return LinkedInApplyResolution(None, "navigation_error", str(exc)[:300])
            result = self._resolve_loaded_page(page, job_url)
            if route_guard.blocked:
                return _unsafe_url_resolution(route_guard.blocked_reason)
            return result
        finally:
            route_guard.close()
            try:
                page.close()
            except Exception:
                pass

    def resolve_loaded_page(self, page: Any, job_url: str) -> LinkedInApplyResolution:
        """Capture the apply target from an already-loaded LinkedIn page."""

        route_guard = _install_public_route_guard(page)
        try:
            result = self._resolve_loaded_page(page, job_url)
            if route_guard.blocked:
                return _unsafe_url_resolution(route_guard.blocked_reason)
            return result
        finally:
            route_guard.close()

    def _resolve_loaded_page(self, page: Any, job_url: str) -> LinkedInApplyResolution:
        direct = _extract_external_from_redirect_url(
            getattr(page, "url", "") or "",
            job_url,
            url_safety_checker=self._url_safety_checker,
        )
        if direct:
            return LinkedInApplyResolution(direct, "current_url")

        locator = _first_visible_apply_locator(page)
        if locator is None:
            return LinkedInApplyResolution(None, "apply_button_missing")

        href = _locator_href(locator, getattr(page, "url", "") or job_url)
        if href:
            direct = _extract_external_from_redirect_url(
                href,
                job_url,
                url_safety_checker=self._url_safety_checker,
            )
            if direct:
                return LinkedInApplyResolution(direct, "href_redirect")
            if _is_safe_external_apply_url(href, job_url, self._url_safety_checker):
                return LinkedInApplyResolution(href, "href")

        clicked = _click_and_capture_apply_target(
            page,
            locator,
            job_url,
            timeout_seconds=self._timeout_seconds,
            url_safety_checker=self._url_safety_checker,
        )
        if clicked:
            return LinkedInApplyResolution(clicked, "click")
        return LinkedInApplyResolution(None, "external_url_missing")


def _first_visible_apply_locator(page: Any) -> Any | None:
    locators = (
        page.locator("button.jobs-apply-button").first,
        page.locator("a.jobs-apply-button").first,
        page.locator("button:has-text('Apply')").first,
        page.locator("a:has-text('Apply')").first,
        page.locator("button:has-text('Solicitar')").first,
        page.locator("a:has-text('Solicitar')").first,
        page.get_by_role("button", name=_APPLY_TEXT_RE).first,
        page.get_by_role("link", name=_APPLY_TEXT_RE).first,
    )
    for locator in locators:
        try:
            locator.wait_for(state="visible", timeout=1500)
            return locator
        except Exception:
            continue
    return None


def _install_public_route_guard(page: Any, *, context: Any | None = None) -> PublicHttpUrlRouteGuard:
    """Install the route guard on the broadest available Playwright target."""

    route_target = context if callable(getattr(context, "route", None)) else None
    if route_target is None:
        page_context = getattr(page, "context", None)
        if callable(page_context):
            try:
                page_context = page_context()
            except Exception:
                page_context = None
        if callable(getattr(page_context, "route", None)):
            route_target = page_context
    if route_target is None:
        route_target = page
    return PublicHttpUrlRouteGuard(route_target).install()


def _bootstrap_profile_dir(profile_dir: Path, *, chrome_profile: str) -> None:
    """Initialize the dedicated resolver profile from an existing Chrome profile."""

    if (profile_dir / chrome_profile).exists():
        return
    source = _source_profile_dir()
    if source is None or not source.exists():
        return
    try:
        if source.resolve() == profile_dir.resolve():
            return
    except OSError:
        pass
    log.info("Initializing LinkedIn apply resolver Chrome profile from %s", source)
    profile_dir.mkdir(parents=True, exist_ok=True)
    skip = {
        "ShaderCache",
        "GrShaderCache",
        "Service Worker",
        "Cache",
        "Code Cache",
        "GPUCache",
        "CacheStorage",
        "Crashpad",
        "BrowserMetrics",
        "SafeBrowsing",
        "Crowd Deny",
        "MEIPreload",
        "SSLErrorAssistant",
        "recovery",
        "Temp",
        "SingletonLock",
        "SingletonSocket",
        "SingletonCookie",
    }
    for item in source.iterdir():
        if item.name in skip:
            continue
        destination = profile_dir / item.name
        try:
            if item.is_dir():
                shutil.copytree(
                    item,
                    destination,
                    dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(
                        "Cache",
                        "Code Cache",
                        "GPUCache",
                        "Service Worker",
                    ),
                )
            else:
                shutil.copy2(item, destination)
        except (OSError, PermissionError):
            log.debug("Skipped Chrome profile item during LinkedIn resolver bootstrap: %s", item)


def _source_profile_dir() -> Path | None:
    configured = os.environ.get(LINKEDIN_APPLY_SOURCE_PROFILE_DIR_ENV)
    if configured:
        return Path(configured).expanduser()
    return config.get_chrome_user_data()


def _locator_href(locator: Any, base_url: str) -> str | None:
    for getter in (
        lambda: locator.get_attribute("href", timeout=1000),
        lambda: locator.evaluate(
            """(el) => {
                if (el.href) return el.href;
                const anchor = el.closest("a[href]");
                return anchor ? anchor.href : null;
            }""",
            timeout=1000,
        ),
    ):
        try:
            value = getter()
        except Exception:
            continue
        if isinstance(value, str) and value.strip():
            return urljoin(base_url, value.strip())
    return None


def _click_and_capture_apply_target(
    page: Any,
    locator: Any,
    original_job_url: str,
    *,
    timeout_seconds: float,
    url_safety_checker: UrlSafetyChecker,
) -> str | None:
    popup = None
    try:
        try:
            from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        except Exception:  # pragma: no cover - only used when Playwright import shape changes
            PlaywrightTimeoutError = TimeoutError  # type: ignore[assignment]

        try:
            with page.expect_popup(timeout=5000) as popup_info:
                locator.click(timeout=5000)
            popup = popup_info.value
            try:
                popup.wait_for_load_state("domcontentloaded", timeout=_LOAD_TIMEOUT_MS)
            except Exception:
                pass
            return _wait_for_external_apply_url(
                popup,
                original_job_url,
                timeout_seconds=timeout_seconds,
                url_safety_checker=url_safety_checker,
            )
        except PlaywrightTimeoutError:
            return _wait_for_external_apply_url(
                page,
                original_job_url,
                timeout_seconds=timeout_seconds,
                url_safety_checker=url_safety_checker,
            )
    except Exception as exc:
        log.debug("LinkedIn apply click capture failed for %s: %s", original_job_url, exc)
        return None
    finally:
        if popup is not None:
            try:
                popup.close()
            except Exception:
                pass


def _wait_for_external_apply_url(
    page: Any,
    original_job_url: str,
    *,
    timeout_seconds: float,
    url_safety_checker: UrlSafetyChecker,
) -> str | None:
    deadline = time.monotonic() + timeout_seconds
    last_url = ""
    while time.monotonic() < deadline:
        try:
            current = str(getattr(page, "url", "") or "")
        except Exception:
            current = ""
        if current and current != last_url:
            extracted = _extract_external_from_redirect_url(
                current,
                original_job_url,
                url_safety_checker=url_safety_checker,
            )
            if extracted:
                return extracted
            if _is_safe_external_apply_url(current, original_job_url, url_safety_checker):
                return current
            last_url = current
        try:
            page.wait_for_timeout(250)
        except Exception:
            time.sleep(0.25)
    return None


def _extract_external_from_redirect_url(
    url: str,
    original_job_url: str,
    *,
    url_safety_checker: UrlSafetyChecker = validate_public_http_url,
) -> str | None:
    """Extract an external target embedded inside a redirect/tracking URL."""

    if not url:
        return None
    parsed = urlparse(url)
    for key, value in parse_qsl(parsed.query, keep_blank_values=False):
        normalized_key = key.strip().lower().replace("-", "_")
        if normalized_key not in _EXTERNAL_URL_PARAM_NAMES:
            continue
        candidate = unquote(value.strip())
        if _is_safe_external_apply_url(candidate, original_job_url, url_safety_checker):
            return candidate
    return None


def _is_external_apply_url(candidate_url: str, original_job_url: str) -> bool:
    if not candidate_url:
        return False
    parsed = urlparse(candidate_url)
    original = urlparse(original_job_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    host = parsed.netloc.lower()
    original_host = original.netloc.lower()
    if _is_linkedin_host(host):
        return False
    if original_host and host == original_host:
        return False
    return True


def _is_safe_external_apply_url(
    candidate_url: str,
    original_job_url: str,
    url_safety_checker: UrlSafetyChecker,
) -> bool:
    if not _is_external_apply_url(candidate_url, original_job_url):
        return False
    decision = url_safety_checker(candidate_url)
    if decision.allowed:
        return True
    log.debug(
        "Rejected LinkedIn apply resolver target %s: %s",
        candidate_url,
        decision.reason or "URL is not a public HTTP(S) destination",
    )
    return False


def _unsafe_url_resolution(reason: str | None) -> LinkedInApplyResolution:
    return LinkedInApplyResolution(
        None,
        "unsafe_url",
        reason or "URL is not a public HTTP(S) destination",
    )


def _is_linkedin_host(host: str) -> bool:
    normalized = host.split("@")[-1].split(":")[0].lower()
    return normalized == "linkedin.com" or normalized.endswith(".linkedin.com")


__all__ = [
    "LINKEDIN_APPLY_CHROME_PROFILE_ENV",
    "LINKEDIN_APPLY_HEADLESS_ENV",
    "LINKEDIN_APPLY_PROFILE_DIR_ENV",
    "LINKEDIN_APPLY_RESOLVER_ENABLED_ENV",
    "LINKEDIN_APPLY_SOURCE_PROFILE_DIR_ENV",
    "LinkedInApplyResolution",
    "LinkedInApplyUrlResolver",
    "default_linkedin_apply_profile_dir",
    "linkedin_apply_chrome_profile",
    "linkedin_apply_resolver_enabled",
]
