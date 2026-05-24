from __future__ import annotations

from jobhunter.discovery.title_filter import title_matches_query


def test_strict_title_matching_preserves_exact_query_precision() -> None:
    assert title_matches_query("Director of Engineering", "Director of Engineering")
    assert not title_matches_query("Head of Technology", "Director of Engineering")


def test_recall_title_matching_accepts_leadership_domain_variants() -> None:
    assert title_matches_query("Head of Technology", "technology director", match_mode="recall")
    assert title_matches_query("Director, Cybersecurity", "security director", match_mode="recall")
    assert title_matches_query("Platform Engineering Manager", "platform director", match_mode="recall")


def test_recall_title_matching_rejects_non_leadership_ic_titles() -> None:
    assert not title_matches_query("Software Engineer", "engineering director", match_mode="recall")
    assert not title_matches_query("Security Analyst", "security director", match_mode="recall")
