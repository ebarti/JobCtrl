from __future__ import annotations

from pathlib import Path
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
    assert posting.source.board == "workday"
    assert posting.employer.name == "Acme Corp"
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
                    "company_name": "Acme",
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
    assert posting.source.board == "greenhouse"
    assert posting.employer.name == "Acme"
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
    assert posting.source.board == "lever"
    assert posting.employer.name == "Acme Corp"
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
    assert posting.source.board == "ashby"
    assert posting.employer.name == "Acme Corp"
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


def _ashby_posting(**overrides: Any) -> dict[str, Any]:
    # Synthetic fields from the documented public posting API; no board fetch.
    return {
        "id": "synthetic-posting",
        "title": "Infrastructure Engineer",
        "jobUrl": "https://jobs.ashbyhq.com/synthetic/synthetic-posting",
        "location": "Austin",
        "descriptionPlain": "Operate synthetic infrastructure systems.",
        **overrides,
    }


def _scrape_ashby_fixture(
    raw: dict[str, Any],
    *,
    location: str = "Austin",
    accept: tuple[str, ...] = (),
    reject: tuple[str, ...] = (),
) -> list[Any]:
    adapter = AshbyBoardAdapter(
        source_id="ashby:synthetic",
        board_name="synthetic",
        http=lambda _url: {"jobs": [raw]},
        location_accept=accept,
        location_reject=reject,
    )
    return list(adapter.scrape(tenant_id=LOCAL_TENANT, query="Infrastructure", location=location))


@pytest.mark.parametrize(
    ("listing", "admitted"),
    [
        ({}, True),
        ({"isListed": True}, True),
        ({"isListed": False}, False),
        ({"isListed": None}, True),
        ({"isListed": 0}, True),
        ({"isListed": "false"}, True),
    ],
)
def test_ashby_listing_flag_requires_explicit_boolean_false(
    listing: dict[str, Any],
    admitted: bool,
) -> None:
    assert bool(_scrape_ashby_fixture(_ashby_posting(**listing))) is admitted


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        ({}, "Austin"),
        ({"secondaryLocations": []}, "Austin"),
        ({"secondaryLocations": None}, "Austin"),
        ({"secondaryLocations": "Madrid"}, "Austin"),
        ({"secondaryLocations": {"location": "Madrid"}}, "Austin"),
        ({"secondaryLocations": True}, "Austin"),
        ({"secondaryLocations": 7}, "Austin"),
        ({"secondaryLocations": [{"location": None}, {"location": "Madrid"}, "Barcelona"]},
         "Austin; Madrid"),
        ({"locationName": "Ignored fallback"}, "Austin"),
        ({"secondaryLocations": [None, "Madrid", 5, [], {}, {"location": None},
                                 {"location": 7}, {"location": False}, {"location": []},
                                 {"location": {}}, {"location": ""}, {"location": "  "},
                                 {"locationName": "Madrid"}]}, "Austin"),
        ({"location": " Austin ", "secondaryLocations": [
            {"location": " austin "}, {"location": " Madrid "},
            {"location": "MADRID"}, {"location": "Barcelona"},
        ]}, "Austin; Madrid; Barcelona"),
        ({"location": "", "locationName": " Madrid ",
          "secondaryLocations": [{"location": "Madrid"}, {"location": "Austin"}]}, "Madrid; Austin"),
        ({"location": None, "locationName": "Madrid"}, "Madrid"),
        ({"location": "", "secondaryLocations": [{"location": "Madrid"}]}, "Madrid"),
        ({"location": "", "secondaryLocations": []}, ""),
    ],
)
def test_ashby_preserves_distinct_location_names_primary_first(
    fields: dict[str, Any],
    expected: str,
) -> None:
    # Unrestricted empty locations remain admissible; target the primary otherwise.
    postings = _scrape_ashby_fixture(_ashby_posting(**fields), location=expected.split("; ")[0])
    assert len(postings) == 1
    assert postings[0].metadata.location == expected


def test_ashby_secondary_location_matches_target_without_losing_primary() -> None:
    postings = _scrape_ashby_fixture(
        _ashby_posting(secondaryLocations=[{"location": "Madrid"}]),
        location="Madrid",
        accept=("Madrid",),
    )
    assert len(postings) == 1
    assert postings[0].metadata.location == "Austin; Madrid"


_ASHBY_LOCATION_CONTEXT_CASES = [
    ("Austin", "Madrid", "Madrid", (), True),
    ("Toronto, ON, CA", "Madrid, Spain", "Madrid, Spain", ("Canada",), False),
    ("Madrid, Spain", "Toronto, ON, CA", "Madrid, Spain", ("Canada",), False),
    ("Barcelona, Venezuela", "Madrid, Spain", "Barcelona, Spain", (), False),
    ("Madrid, Spain", "Barcelona, Venezuela", "Barcelona, Spain", (), False),
    ("Toronto, ON, CA", "Madrid, Spain", "Madrid, Spain", (), True),
    ("Barcelona, Venezuela", "Madrid, Spain", "Madrid, Spain", (), True),
    ("Barcelona, CT, ES", "Madrid, Spain", "Barcelona, Spain", ("Canada",), True),
    ("Barcelona, CT, ES", "Madrid, Spain", "Barcelona, Spain", ("USA",), True),
]


@pytest.mark.parametrize(
    ("primary", "secondary", "target", "reject", "admitted"),
    _ASHBY_LOCATION_CONTEXT_CASES,
)
def test_ashby_location_admission_preserves_each_names_geography_context(
    primary: str,
    secondary: str,
    target: str,
    reject: tuple[str, ...],
    admitted: bool,
) -> None:
    postings = _scrape_ashby_fixture(
        _ashby_posting(location=primary, secondaryLocations=[{"location": secondary}]),
        location=target,
        accept=(target,),
        reject=reject,
    )
    assert bool(postings) is admitted
    if admitted:
        assert postings[0].metadata.location == f"{primary}; {secondary}"


@pytest.mark.parametrize(
    ("fields", "accept", "reject"),
    [
        ({"title": "Sales Manager"}, (), ()),
        ({"title": ""}, (), ()),
        ({"id": ""}, (), ()),
        ({"jobUrl": ""}, (), ()),
        ({"descriptionPlain": ""}, (), ()),
        ({"location": ""}, ("Madrid",), ()),
        ({}, ("Madrid",), ()),
        ({"secondaryLocations": [{"location": "Madrid"}]}, ("Madrid",), ("Austin",)),
        ({"location": "Madrid", "secondaryLocations": [{"location": "Austin"}]},
         ("Madrid",), ("Austin",)),
    ],
)
def test_ashby_existing_admission_rules_remain_in_force(
    fields: dict[str, Any],
    accept: tuple[str, ...],
    reject: tuple[str, ...],
) -> None:
    assert _scrape_ashby_fixture(_ashby_posting(**fields), accept=accept, reject=reject) == []


@pytest.mark.parametrize("use_apply_url", [False, True])
def test_ashby_preserves_native_id_and_canonical_url_fallback(use_apply_url: bool) -> None:
    url = "https://jobs.ashbyhq.com/synthetic/synthetic-posting"
    fields = {"jobUrl": "", "applyUrl": url} if use_apply_url else {"applyUrl": url + "/application"}
    posting = _scrape_ashby_fixture(_ashby_posting(**fields))[0]
    assert posting.source_native_id == "synthetic-posting"
    assert posting.canonical_url == posting.posting_url.value == url
    assert posting.ats_kind is AtsKind.ASHBY
    assert posting.metadata.description == "Operate synthetic infrastructure systems."


@pytest.mark.parametrize(
    ("primary", "secondary", "target", "reject", "admitted"),
    _ASHBY_LOCATION_CONTEXT_CASES,
)
def test_ashby_scheduled_discovery_persists_secondary_target_and_repeat_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    primary: str,
    secondary: str,
    target: str,
    reject: tuple[str, ...],
    admitted: bool,
) -> None:
    from jobctrl import config
    from jobctrl.database import close_connection, init_db
    from jobctrl.domain.discovery.scheduler import DiscoveryScheduler
    from jobctrl.domain.discovery.source_registry import SourceKind
    from jobctrl.infrastructure.discovery.production_wiring import run_scheduled_ats_sources

    db_path = tmp_path / "synthetic-ashby.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    conn = init_db(db_path)
    registry = config.load_source_registry(
        search_cfg={"boards": []},
        employers_cfg={"employers": {}},
        sites_cfg={"sources": [{
            "id": "ashby:synthetic", "kind": "ats_api", "priority": "canonical",
            "display_name": "Synthetic Ashby", "company": "Synthetic Company",
            "seed_url": "https://api.ashbyhq.com/posting-api/job-board/synthetic",
            "board_name": "synthetic", "ats_kind": "ashby",
        }], "sites": []},
    )
    sources = DiscoveryScheduler().plan(registry=registry).for_kinds(SourceKind.ATS_API)
    payload = {"jobs": [
        _ashby_posting(
            id=native_id,
            title=f"{role} Engineer",
            jobUrl=f"https://jobs.ashbyhq.com/synthetic/{native_id}",
            descriptionPlain=" ".join(f"{native_id}-system-{i}" for i in range(50)),
            location=primary,
            secondaryLocations=[{"location": secondary}, {"location": f" {secondary.lower()} "}],
            **listing,
        )
        for native_id, role, listing in [
            ("listed", "Infrastructure", {"isListed": True}),
            ("legacy", "Platform", {}),
            ("unlisted", "Backend", {"isListed": False}),
        ]
    ]}
    requests: list[str] = []

    def http(url: str) -> dict[str, Any]:
        assert url == "https://api.ashbyhq.com/posting-api/job-board/synthetic"
        requests.append(url)
        return payload

    search_cfg = {
        "queries": [{"query": "Engineer", "tier": 1}],
        "locations": [{"location": target}], "location_accept": [target],
        "location_reject_non_remote": list(reject),
    }
    try:
        job_ids: dict[str, str] = {}
        for run_number in range(2):
            result = run_scheduled_ats_sources(
                conn, sources, search_cfg=search_cfg,
                run_id=f"synthetic:ashby:{run_number}", http=http,
            )
            assert result["failed_sources"] == []
            expected_count = 2 if admitted else 0
            assert result["total"] == expected_count
            assert result["new_jobs"] == (expected_count if run_number == 0 else 0)
            assert result["observed_jobs"] == (0 if run_number == 0 else expected_count)
            rows = conn.execute("SELECT job_id, url, location, description FROM jobs").fetchall()
            assert len(rows) == expected_count
            current_ids = {row["url"]: row["job_id"] for row in rows}
            expected_urls = {
                f"https://jobs.ashbyhq.com/synthetic/{native_id}" for native_id in ("listed", "legacy")
            } if admitted else set()
            assert set(current_ids) == expected_urls
            if run_number:
                assert current_ids == job_ids
            job_ids = current_ids
            assert all(row["location"] == f"{primary}; {secondary}" for row in rows)
            for row in rows:
                native_id = row["url"].rsplit("/", 1)[1]
                assert row["description"] == " ".join(f"{native_id}-system-{i}" for i in range(50))
            identities = conn.execute(
                "SELECT job_id, ats_kind, source_native_id, canonical_url FROM job_canonical_identities"
            ).fetchall()
            assert len(identities) == expected_count
            for row in identities:
                assert row["ats_kind"] == "ashby"
                assert row["source_native_id"] in {"listed", "legacy"}
                url = f"https://jobs.ashbyhq.com/synthetic/{row['source_native_id']}"
                assert row["canonical_url"] == url
                assert row["job_id"] == job_ids[url]
            observations = conn.execute(
                "SELECT job_id, source_id, source_native_id, observed_url, run_id FROM job_source_observations"
            ).fetchall()
            assert len(observations) == expected_count
            for row in observations:
                assert row["source_id"] == "ashby:synthetic"
                assert row["source_native_id"] in {"listed", "legacy"}
                assert row["observed_url"] == f"https://jobs.ashbyhq.com/synthetic/{row['source_native_id']}"
                assert row["job_id"] == job_ids[row["observed_url"]]
                assert row["run_id"] == f"synthetic:ashby:{run_number}"
        assert len(requests) == 2
    finally:
        close_connection(db_path)
