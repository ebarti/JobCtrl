from __future__ import annotations

from jobctl.infrastructure.enrichment.linkedin_apply_resolver import (
    _extract_external_from_redirect_url,
    _is_external_apply_url,
)


def test_external_apply_url_rejects_linkedin_hosts() -> None:
    original = "https://www.linkedin.com/jobs/view/123"

    assert not _is_external_apply_url("https://www.linkedin.com/jobs/view/123", original)
    assert not _is_external_apply_url("https://linkedin.com/jobs/apply/123", original)
    assert not _is_external_apply_url("mailto:jobs@example.com", original)


def test_external_apply_url_accepts_company_hosts() -> None:
    original = "https://www.linkedin.com/jobs/view/123"

    assert _is_external_apply_url("https://boards.greenhouse.io/acme/jobs/1", original)
    assert _is_external_apply_url("https://jobs.ashbyhq.com/acme/role", original)


def test_extract_external_url_from_linkedin_redirect_query() -> None:
    original = "https://www.linkedin.com/jobs/view/123"
    redirect = (
        "https://www.linkedin.com/jobs/apply/123?"
        "url=https%3A%2F%2Fjobs.ashbyhq.com%2Facme%2Frole"
    )

    assert _extract_external_from_redirect_url(redirect, original) == (
        "https://jobs.ashbyhq.com/acme/role"
    )


def test_extract_external_url_ignores_linkedin_redirect_target() -> None:
    original = "https://www.linkedin.com/jobs/view/123"
    redirect = (
        "https://www.linkedin.com/jobs/apply/123?"
        "url=https%3A%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2F123"
    )

    assert _extract_external_from_redirect_url(redirect, original) is None
