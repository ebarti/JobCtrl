from __future__ import annotations

from jobhunter.infrastructure.discovery.location_filter import (
    configured_location_filters,
    location_matches_target,
)


EUROPE_ACCEPT = ["Remote", "Barcelona", "Spain", "Europe", "EMEA", "EU"]
EUROPE_REJECT = ["United States", "USA", "Canada", "North America", "Brazil"]


def test_remote_country_scoped_locations_do_not_bypass_reject_patterns() -> None:
    for location in (
        "Remote, United States",
        "Remote US",
        "US Remote",
        "Remote - US",
        "USA, Remote",
        "U.S. Remote",
        "Remote Canada",
        "North America Remote",
        "Brazil Remote Work",
    ):
        assert not location_matches_target(
            location,
            accept=EUROPE_ACCEPT,
            reject=EUROPE_REJECT,
            search_location="Remote",
        )


def test_remote_region_locations_pass_when_region_is_accepted() -> None:
    for location in (
        "Remote EMEA",
        "Europe Remote",
        "Barcelona, Spain (Remote)",
    ):
        assert location_matches_target(
            location,
            accept=EUROPE_ACCEPT,
            reject=EUROPE_REJECT,
            search_location="Remote",
        )


def test_short_accept_patterns_match_tokens_not_substrings() -> None:
    assert location_matches_target("EU Remote", accept=EUROPE_ACCEPT, reject=[])
    assert not location_matches_target("Neuenstein, DE", accept=["EU"], reject=[])


def test_configured_location_filters_reads_nested_and_legacy_shapes() -> None:
    accept, reject = configured_location_filters(
        {
            "location_accept": ["Remote", "Spain"],
            "location_reject_non_remote": ["USA"],
            "location": {
                "accept_patterns": ["EMEA"],
                "reject_patterns": ["Brazil"],
            },
        }
    )

    assert accept == ["Remote", "Spain", "EMEA"]
    assert reject == ["USA", "Brazil"]
