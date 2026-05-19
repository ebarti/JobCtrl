from __future__ import annotations

from jobhunter.discovery.title_filter import title_matches_query


def test_title_filter_matches_leadership_aliases() -> None:
    assert title_matches_query("Vice President, Engineering", "VP of Engineering")
    assert title_matches_query("Chief Information Security Officer", "CISO")
    assert title_matches_query("Director, Information Security", "Director of IT & Security")


def test_title_filter_rejects_loose_workday_results() -> None:
    assert not title_matches_query("Independent Trauma Counsellor", "Director of Engineering")
    assert not title_matches_query("Director, Investment Consulting", "Director of IT & Security")
