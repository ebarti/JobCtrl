from __future__ import annotations

from typing import Any

from jobhunter.domain.discovery import AtsKind
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.discovery import (
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
        "https://acme.wd1.myworkdayjobs.com/External/job/Remote-USA/"
        "Senior-Platform-Engineer_JR-123"
    )
    assert posting.ats_kind is AtsKind.WORKDAY


def test_greenhouse_adapter_maps_job_board_payload_to_scraped_posting() -> None:
    def http(url: str) -> dict[str, Any]:
        assert url == "https://boards-api.greenhouse.io/v1/boards/acme/jobs"
        return {
            "jobs": [
                {
                    "id": 123456,
                    "title": "Staff Backend Engineer",
                    "absolute_url": "https://boards.greenhouse.io/acme/jobs/123456",
                    "location": {"name": "Remote"},
                    "company_name": "Acme Corp",
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
    assert posting.source.board == "Acme Corp"
    assert posting.source_id == "greenhouse:acme"
    assert posting.source_native_id == "123456"
    assert posting.canonical_url == "https://boards.greenhouse.io/acme/jobs/123456"
    assert posting.ats_kind is AtsKind.GREENHOUSE


def test_lever_adapter_maps_postings_payload_to_scraped_posting() -> None:
    def http(url: str) -> list[dict[str, Any]]:
        assert url == "https://api.lever.co/v0/postings/acme?mode=json"
        return [
            {
                "id": "lever-posting-1",
                "text": "Product Platform Engineer",
                "hostedUrl": "https://jobs.lever.co/acme/lever-posting-1",
                "categories": {"location": "Remote"},
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
    assert posting.source.board == "Acme Corp"
    assert posting.source_id == "lever:acme"
    assert posting.source_native_id == "lever-posting-1"
    assert posting.canonical_url == "https://jobs.lever.co/acme/lever-posting-1"
    assert posting.ats_kind is AtsKind.LEVER


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
                }
            ]
        }

    adapter = AshbyBoardAdapter(
        source_id="ashby:acme",
        board_name="acme",
        company="Acme Corp",
        http=http,
    )

    postings = list(
        adapter.scrape(tenant_id=LOCAL_TENANT, query="Infrastructure", location="Remote")
    )

    assert len(postings) == 1
    posting = postings[0]
    assert posting.metadata.title == "Infrastructure Engineer"
    assert posting.metadata.location == "Remote"
    assert posting.source.board == "Acme Corp"
    assert posting.source_id == "ashby:acme"
    assert posting.source_native_id == "ashby-posting-1"
    assert posting.canonical_url == "https://jobs.ashbyhq.com/acme/ashby-posting-1"
    assert posting.ats_kind is AtsKind.ASHBY
