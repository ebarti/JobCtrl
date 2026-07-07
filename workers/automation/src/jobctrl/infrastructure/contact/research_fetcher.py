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

import logging
import urllib.error
import urllib.request

from bs4 import BeautifulSoup

from jobctrl.domain.contact.research import ResearchSourceOutcome
from jobctrl.domain.contact.source_policy import ContactResearchSourcePolicy
from jobctrl.domain.ports.contact import ResearchPageFetch
from jobctrl.infrastructure.network import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    RunBudgetCounter,
    build_opener,
    parse_retry_after,
)

log = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 20.0
_MAX_TEXT_CHARS = 40000


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
    ) -> None:
        self._policy = policy
        self._timeout = timeout
        self._opener = opener or build_opener()
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
        with self._session.guard(url) as decision:
            if not decision.allowed:
                return ResearchPageFetch(outcome=decision.outcome.value)
            return self._get(url, decision.user_agent)

    def _get(self, url: str, user_agent: str) -> ResearchPageFetch:
        request = urllib.request.Request(url, method="GET")
        request.add_header("User-Agent", user_agent)
        request.add_header("Accept", "text/html, */*;q=0.8")
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                status = getattr(response, "status", None)
                body = response.read()
        except urllib.error.HTTPError as exc:
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
            final_url=url,
            status=int(status) if status is not None else None,
        )


def _visible_text(body: bytes) -> str:
    try:
        soup = BeautifulSoup(body, "html.parser")
    except Exception:  # noqa: BLE001 — a parse failure yields no text, an outcome not a crash
        return ""
    for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
        tag.decompose()
    text = soup.get_text(separator="\n", strip=True)
    return text[:_MAX_TEXT_CHARS]


__all__ = ["GatewayContactResearchFetcher"]
