from __future__ import annotations

from typing import Any

import pytest

from jobctrl.domain.discovery import AtsKind
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import (
    AshbyBoardAdapter,
    GreenhouseBoardAdapter,
    LeverBoardAdapter,
    WorkdayBoardAdapter,
    WorkdayEmployer,
)


def test_workday_adapter_maps_cxs_payload_to_scraped_posting() -> None:
    requested_urls: list[str] = []

    def http(
        url: str,
        *,
        method: str = "GET",
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        requested_urls.append(url)
        assert method == "POST"
        assert json_body == {
            "appliedFacets": {},
            "limit": 20,
            "offset": 0,
            "searchText": "Platform",
        }
        return {
            "total": 1,
            "jobPostings": [
                {
                    "title": "Senior Platform Engineer",
                    "externalPath": "/job/Remote-USA/Senior-Platform-Engineer_JR-123",
                    "locationsText": "Remote, United States",
                }
            ],
        }

    adapter = WorkdayBoardAdapter(
        source_id="workday:acme",
        employer=WorkdayEmployer(
            employer_key="acme",
            name="Acme Corp",
            base_url="https://acme.wd1.myworkdayjobs.com",
            tenant="acme",
            site_id="External",
        ),
        http=http,
    )

    postings = list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Platform", location="Remote"))

    assert requested_urls[0] == "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs"
    assert len(postings) == 1
    posting = postings[0]
    assert posting.metadata.title == "Senior Platform Engineer"
    assert posting.metadata.location == "Remote, United States"
    assert posting.source.board == "Acme Corp"
    assert posting.source_id == "workday:acme"
    assert posting.source_native_id == "Senior-Platform-Engineer_JR-123"
    assert posting.canonical_url == (
        "https://acme.wd1.myworkdayjobs.com/External/job/Remote-USA/Senior-Platform-Engineer_JR-123"
    )
    assert posting.ats_kind is AtsKind.WORKDAY


def test_workday_adapter_rejects_country_scoped_remote_locations() -> None:
    def http(
        url: str,
        *,
        method: str = "GET",
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "total": 2,
            "jobPostings": [
                {
                    "title": "Senior Platform Engineer",
                    "externalPath": "/job/Remote-USA/Senior-Platform-Engineer_JR-123",
                    "locationsText": "Remote, United States",
                },
                {
                    "title": "Principal Platform Engineer",
                    "externalPath": "/job/Remote-EMEA/Principal-Platform-Engineer_JR-456",
                    "locationsText": "Remote EMEA",
                },
            ],
        }

    adapter = WorkdayBoardAdapter(
        source_id="workday:acme",
        employer=WorkdayEmployer(
            employer_key="acme",
            name="Acme Corp",
            base_url="https://acme.wd1.myworkdayjobs.com",
            tenant="acme",
            site_id="External",
        ),
        http=http,
        location_accept=["Remote", "Spain", "Europe", "EMEA"],
        location_reject=["United States", "USA"],
    )

    postings = list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Platform", location="Remote"))

    assert [posting.metadata.location for posting in postings] == ["Remote EMEA"]


def test_workday_adapter_rejects_loose_title_matches() -> None:
    def http(
        url: str,
        *,
        method: str = "GET",
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "total": 2,
            "jobPostings": [
                {
                    "title": "Independent Trauma Counsellor",
                    "externalPath": "/job/EMEA/Independent-Trauma-Counsellor_JR-123",
                    "locationsText": "Remote EMEA",
                },
                {
                    "title": "Director of Engineering",
                    "externalPath": "/job/EMEA/Director-of-Engineering_JR-456",
                    "locationsText": "Remote EMEA",
                },
            ],
        }

    adapter = WorkdayBoardAdapter(
        source_id="workday:acme",
        employer=WorkdayEmployer(
            employer_key="acme",
            name="Acme Corp",
            base_url="https://acme.wd1.myworkdayjobs.com",
            tenant="acme",
            site_id="External",
        ),
        http=http,
        location_accept=["Spain", "Europe", "EMEA"],
    )

    postings = list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Director of Engineering", location="Remote"))

    assert [posting.metadata.title for posting in postings] == ["Director of Engineering"]


def test_greenhouse_adapter_maps_job_board_payload_to_scraped_posting() -> None:
    def http(url: str) -> dict[str, Any]:
        assert url == "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true"
        return {
            "jobs": [
                {
                    "id": 123456,
                    "title": "Staff Backend Engineer",
                    "absolute_url": "https://boards.greenhouse.io/acme/jobs/123456",
                    "location": {"name": "Remote"},
                    "company_name": "Acme Corp",
                    "content": "&lt;p&gt;Build backend systems for the platform team.&lt;/p&gt;",
                }
            ]
        }

    adapter = GreenhouseBoardAdapter(
        source_id="greenhouse:acme",
        board_token="acme",
        http=http,
    )

    postings = list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Backend", location="Remote"))

    assert len(postings) == 1
    posting = postings[0]
    assert posting.metadata.title == "Staff Backend Engineer"
    assert posting.metadata.location == "Remote"
    assert posting.metadata.description == "Build backend systems for the platform team."
    assert posting.source.board == "Acme Corp"
    assert posting.source_id == "greenhouse:acme"
    assert posting.source_native_id == "123456"
    assert posting.canonical_url == "https://boards.greenhouse.io/acme/jobs/123456"
    assert posting.ats_kind is AtsKind.GREENHOUSE


@pytest.mark.parametrize("description", ["None", "nan", "<NA>"])
def test_greenhouse_adapter_rejects_serialized_null_descriptions(
    description: str,
) -> None:
    def http(_url: str) -> dict[str, Any]:
        return {
            "jobs": [
                {
                    "id": 123456,
                    "title": "Staff Backend Engineer",
                    "absolute_url": "https://boards.greenhouse.io/acme/jobs/123456",
                    "location": {"name": "Remote"},
                    "company_name": "Acme Corp",
                    "content": description,
                }
            ]
        }

    adapter = GreenhouseBoardAdapter(
        source_id="greenhouse:acme",
        board_token="acme",
        http=http,
    )

    assert list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Backend", location="Remote")) == []


def test_lever_adapter_maps_postings_payload_to_scraped_posting() -> None:
    def http(url: str) -> list[dict[str, Any]]:
        assert url == "https://api.lever.co/v0/postings/acme?mode=json"
        return [
            {
                "id": "lever-posting-1",
                "text": "Product Platform Engineer",
                "hostedUrl": "https://jobs.lever.co/acme/lever-posting-1",
                "categories": {"location": "Remote"},
                "description": "<p>Own the product platform roadmap.</p>",
                "lists": [{"content": "<p>Lead cross-functional delivery.</p>"}],
            }
        ]

    adapter = LeverBoardAdapter(
        source_id="lever:acme",
        site="acme",
        company="Acme Corp",
        http=http,
    )

    postings = list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Platform", location="Remote"))

    assert len(postings) == 1
    posting = postings[0]
    assert posting.metadata.title == "Product Platform Engineer"
    assert posting.metadata.location == "Remote"
    assert posting.metadata.description == "Own the product platform roadmap. Lead cross-functional delivery."
    assert posting.source.board == "Acme Corp"
    assert posting.source_id == "lever:acme"
    assert posting.source_native_id == "lever-posting-1"
    assert posting.canonical_url == "https://jobs.lever.co/acme/lever-posting-1"
    assert posting.ats_kind is AtsKind.LEVER


@pytest.mark.parametrize("description", ["None", "nan", "<NA>"])
def test_lever_adapter_rejects_serialized_null_descriptions(
    description: str,
) -> None:
    def http(_url: str) -> list[dict[str, Any]]:
        return [
            {
                "id": "lever-posting-1",
                "text": "Product Platform Engineer",
                "hostedUrl": "https://jobs.lever.co/acme/lever-posting-1",
                "categories": {"location": "Remote"},
                "description": description,
            }
        ]

    adapter = LeverBoardAdapter(
        source_id="lever:acme",
        site="acme",
        company="Acme Corp",
        http=http,
    )

    assert list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Platform", location="Remote")) == []


def test_ashby_adapter_maps_public_board_payload_to_scraped_posting() -> None:
    def http(url: str) -> dict[str, Any]:
        assert url == "https://api.ashbyhq.com/posting-api/job-board/acme"
        return {
            "jobs": [
                {
                    "id": "ashby-posting-1",
                    "title": "Infrastructure Engineer",
                    "jobUrl": "https://jobs.ashbyhq.com/acme/ashby-posting-1",
                    "location": "Remote",
                    "descriptionHtml": "<p>Operate infrastructure systems.</p>",
                }
            ]
        }

    adapter = AshbyBoardAdapter(
        source_id="ashby:acme",
        board_name="acme",
        company="Acme Corp",
        http=http,
    )

    postings = list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Infrastructure", location="Remote"))

    assert len(postings) == 1
    posting = postings[0]
    assert posting.metadata.title == "Infrastructure Engineer"
    assert posting.metadata.location == "Remote"
    assert posting.metadata.description == "Operate infrastructure systems."
    assert posting.source.board == "Acme Corp"
    assert posting.source_id == "ashby:acme"
    assert posting.source_native_id == "ashby-posting-1"
    assert posting.canonical_url == "https://jobs.ashbyhq.com/acme/ashby-posting-1"
    assert posting.ats_kind is AtsKind.ASHBY


@pytest.mark.parametrize("description", ["None", "nan", "<NA>"])
def test_ashby_adapter_rejects_serialized_null_descriptions(
    description: str,
) -> None:
    def http(_url: str) -> dict[str, Any]:
        return {
            "jobs": [
                {
                    "id": "ashby-posting-1",
                    "title": "Infrastructure Engineer",
                    "jobUrl": "https://jobs.ashbyhq.com/acme/ashby-posting-1",
                    "location": "Remote",
                    "descriptionHtml": description,
                }
            ]
        }

    adapter = AshbyBoardAdapter(
        source_id="ashby:acme",
        board_name="acme",
        company="Acme Corp",
        http=http,
    )

    assert list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Infrastructure", location="Remote")) == []
