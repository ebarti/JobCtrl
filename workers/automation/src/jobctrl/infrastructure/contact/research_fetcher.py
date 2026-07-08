"""Gateway-routed public-page fetcher for contact research (INV-3, §5.3).

Implements ``ResearchPageFetcherPort`` as a thin wrapper over the merged
politeness gateway: every fetch is a single ``PolitenessSession.guard(url)`` —
the one outbound choke point. A blocked decision (robots-denial / rate-limit /
budget-exhaustion) returns the outcome with empty text (recorded by the session
as a first-class operational outcome, never raised); an allowed decision fetches
the page with the honest user-agent the gateway resolved and returns cleaned
visible text for schema-driven LLM extraction. No research fetch path bypasses
this guard.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

from bs4 import BeautifulSoup

from jobctrl.domain.contact.research import ResearchSourceOutcome
from jobctrl.domain.contact.source_policy import (
    ContactResearchSourcePolicy,
    ResearchSourceCategory,
    ResearchSourceDecision,
)
from jobctrl.domain.ports.contact import ResearchPageFetch
from jobctrl.infrastructure.network import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    RunBudgetCounter,
    parse_retry_after,
)

log = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 20.0
_MAX_TEXT_CHARS = 40000
_MAX_REDIRECTS = 5
_REDIRECT_STATUS_CODES = frozenset({301, 302, 303, 307, 308})

TargetResolver = Callable[[str, int | None], tuple[str, ...]]


class GatewayContactResearchFetcher:
    """Local-mode ``ResearchPageFetcherPort`` implementation."""

    def __init__(
        self,
        *,
        policy: ContactResearchSourcePolicy,
        session: PolitenessSession | None = None,
        recorder_conn=None,
        timeout: float = _DEFAULT_TIMEOUT,
        opener: urllib.request.OpenerDirector | None = None,
        target_resolver: TargetResolver | None = None,
    ) -> None:
        self._policy = policy
        self._timeout = timeout
        self._opener = opener or urllib.request.build_opener(_NoRedirectHandler())
        self._target_resolver = target_resolver or _resolve_target_addresses
        self._session = session or PolitenessSession(
            PolitenessGateway(),
            policy=policy.source_policy,
            budget=RunBudgetCounter(policy.source_policy.max_requests_per_run),
            context=PolitenessSourceContext(
                stage="contact_research", adapter="contact_research_fetcher"
            ),
            recorder_conn=recorder_conn,
        )

    def fetch(self, url: str) -> ResearchPageFetch:
        if not self._source_allowed(url):
            return ResearchPageFetch(outcome=ResearchSourceOutcome.REJECTED.value, final_url=url)
        return self._fetch_guarded(url, redirects_remaining=_MAX_REDIRECTS)

    def _fetch_guarded(self, url: str, *, redirects_remaining: int) -> ResearchPageFetch:
        with self._session.guard(url) as decision:
            if not decision.allowed:
                return ResearchPageFetch(outcome=decision.outcome.value)
            return self._get(url, decision.user_agent, redirects_remaining=redirects_remaining)

    def _get(self, url: str, user_agent: str, *, redirects_remaining: int) -> ResearchPageFetch:
        if not _is_public_network_target(url, self._target_resolver):
            log.warning("Contact research network target rejected for %s", url)
            return ResearchPageFetch(outcome=ResearchSourceOutcome.REJECTED.value, final_url=url)
        request = urllib.request.Request(url, method="GET")
        request.add_header("User-Agent", user_agent)
        request.add_header("Accept", "text/html, */*;q=0.8")
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                final_url = response.geturl()
                if final_url != url and (
                    not self._source_allowed(final_url)
                    or not _is_public_network_target(final_url, self._target_resolver)
                ):
                    log.warning("Contact research final URL rejected for %s -> %s", url, final_url)
                    return ResearchPageFetch(
                        outcome=ResearchSourceOutcome.REJECTED.value,
                        final_url=final_url,
                        status=getattr(response, "status", None),
                    )
                status = getattr(response, "status", None)
                body = response.read()
        except urllib.error.HTTPError as exc:
            if exc.code in _REDIRECT_STATUS_CODES:
                return self._handle_redirect(
                    url,
                    exc,
                    redirects_remaining=redirects_remaining,
                )
            if exc.code in (429, 503):
                retry_after = parse_retry_after(
                    exc.headers.get("Retry-After") if exc.headers else None
                )
                if retry_after:
                    self._session.note_retry_after(url, retry_after)
                self._session.record_server_rate_limit(url, retry_after)
                return ResearchPageFetch(outcome=ResearchSourceOutcome.RATE_LIMITED.value)
            log.warning("Contact research fetch failed for %s: HTTP %s", url, exc.code)
            return ResearchPageFetch(
                outcome=ResearchSourceOutcome.ALLOWED.value, final_url=url, status=exc.code
            )
        except (urllib.error.URLError, ValueError) as exc:
            log.warning("Contact research fetch error for %s: %s", url, exc)
            return ResearchPageFetch(outcome=ResearchSourceOutcome.ALLOWED.value, final_url=url)
        return ResearchPageFetch(
            outcome=ResearchSourceOutcome.ALLOWED.value,
            text=_visible_text(body),
            final_url=final_url,
            status=int(status) if status is not None else None,
        )

    def _handle_redirect(
        self,
        url: str,
        exc: urllib.error.HTTPError,
        *,
        redirects_remaining: int,
    ) -> ResearchPageFetch:
        if redirects_remaining <= 0:
            log.warning("Contact research redirect limit exceeded for %s", url)
            return ResearchPageFetch(
                outcome=ResearchSourceOutcome.REJECTED.value,
                final_url=url,
                status=exc.code,
            )
        location = exc.headers.get("Location") if exc.headers else None
        if not location:
            log.warning("Contact research redirect for %s omitted Location", url)
            return ResearchPageFetch(
                outcome=ResearchSourceOutcome.ALLOWED.value,
                final_url=url,
                status=exc.code,
            )
        redirect_url = urllib.parse.urljoin(url, location)
        if not self._source_allowed(redirect_url):
            log.warning("Contact research redirect rejected for %s -> %s", url, redirect_url)
            return ResearchPageFetch(
                outcome=ResearchSourceOutcome.REJECTED.value,
                final_url=redirect_url,
                status=exc.code,
            )
        return self._fetch_guarded(redirect_url, redirects_remaining=redirects_remaining - 1)

    def _source_allowed(self, url: str) -> bool:
        return (
            self._policy.authorize(
                category=ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
                url=url,
            )
            is ResearchSourceDecision.ALLOWED
        )


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
        return None


def _visible_text(body: bytes) -> str:
    try:
        soup = BeautifulSoup(body, "html.parser")
    except Exception:  # noqa: BLE001 — a parse failure yields no text, an outcome not a crash
        return ""
    for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
        tag.decompose()
    text = soup.get_text(separator="\n", strip=True)
    return text[:_MAX_TEXT_CHARS]


def _is_public_network_target(url: str, resolver: TargetResolver) -> bool:
    try:
        parts = urllib.parse.urlsplit(url)
        hostname = (parts.hostname or "").lower().rstrip(".")
        port = parts.port
    except ValueError:
        return False
    if parts.scheme not in {"http", "https"} or not hostname:
        return False
    literal = _ip_address(hostname)
    if literal is not None:
        return literal.is_global
    addresses = resolver(hostname, port)
    return bool(addresses) and all(_is_public_ip_address(address) for address in addresses)


def _resolve_target_addresses(hostname: str, port: int | None) -> tuple[str, ...]:
    try:
        results = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return ()
    addresses: list[str] = []
    for result in results:
        sockaddr = result[4]
        if sockaddr:
            addresses.append(str(sockaddr[0]))
    return tuple(dict.fromkeys(addresses))


def _is_public_ip_address(address: str) -> bool:
    ip = _ip_address(address)
    return bool(ip and ip.is_global)


def _ip_address(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


__all__ = ["GatewayContactResearchFetcher"]
