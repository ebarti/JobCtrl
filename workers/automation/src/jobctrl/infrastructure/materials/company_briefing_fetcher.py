"""Bounded anonymous fetching through the existing public-page gateway."""

from dataclasses import replace
from urllib.parse import urlsplit

from jobctrl.domain.contact.source_policy import ContactResearchSourcePolicy, contact_research_source_policy
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.company_briefings import public_source_url
from jobctrl.infrastructure.contact.research_fetcher import GatewayContactResearchFetcher
from jobctrl.infrastructure.network import (
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    RunBudgetCounter,
)


class CompanyBriefingFetcher(GatewayContactResearchFetcher):
    def __init__(self, *, urls, **kwargs):
        self._hosts = {urlsplit(url).netloc for url in urls}
        super().__init__(**kwargs, max_body_bytes=1024 * 1024, max_redirects=1, timeout=10.0)

    def _source_allowed(self, url):
        try:
            canonical = public_source_url(url)
        except DeterminationFailure:
            return False
        return urlsplit(canonical).netloc in self._hosts and super()._source_allowed(canonical)


def company_briefing_fetcher(urls, *, connection):
    policy = ContactResearchSourcePolicy(
        domain_allowlist=tuple(urlsplit(url).hostname for url in urls),
        source_policy=replace(
            contact_research_source_policy(),
            policy_id="company_briefing_public_page",
            max_pages_per_run=3,
            max_requests_per_run=6,
        ),
    )
    session = PolitenessSession(
        PolitenessGateway(),
        policy=policy.source_policy,
        budget=RunBudgetCounter(6),
        context=PolitenessSourceContext(stage="enrichment", adapter="company_briefing"),
        recorder_conn=connection,
    )
    return CompanyBriefingFetcher(urls=urls, policy=policy, session=session)
