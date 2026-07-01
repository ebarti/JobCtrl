from __future__ import annotations

import sqlite3

from jobhunter.discovery.title_filter import reset_role_match_feedback_cache, title_matches_query


class _FakeRoleMatcher:
    def __init__(self, result: bool) -> None:
        self.result = result
        self.calls: list[dict[str, object]] = []

    def matches(self, **kwargs: object) -> bool:
        self.calls.append(kwargs)
        return self.result


def test_strict_title_matching_preserves_exact_query_precision() -> None:
    assert title_matches_query("Director of Engineering", "Director of Engineering")
    assert title_matches_query("Head of Platform Engineering", "Head of Engineering")
    assert title_matches_query("Director of Software Engineering", "Director of Engineering")
    assert title_matches_query("Platform Director", "Director of Platform Engineering")
    assert title_matches_query("Vice President, Engineering", "VP of Engineering")
    assert not title_matches_query("Head of Technology", "Director of Engineering")
    assert not title_matches_query("Sales Director Platform", "Director of Platform Engineering")
    assert not title_matches_query(
        "Director, Product Management (BSS/Platform Services)",
        "Director of Platform Engineering",
    )
    assert not title_matches_query(
        "Director, Electrical Engineering - North America, Data Centers",
        "Director of Engineering",
    )
    assert not title_matches_query(
        "Head of School - School of Biomedical Engineering",
        "Head of Engineering",
    )
    assert not title_matches_query(
        "Director of Customer Success for Engineering Platforms",
        "Director of Engineering",
    )


def test_loose_strict_title_matching_uses_role_adjudicator() -> None:
    matcher = _FakeRoleMatcher(False)

    assert not title_matches_query(
        "Finance & Vendor Manager for Product and Engineering - Remote-First",
        "Engineering Manager",
        role_matcher=matcher,
    )

    assert matcher.calls == [
        {
            "title": "Finance & Vendor Manager for Product and Engineering - Remote-First",
            "query": "Engineering Manager",
            "match_mode": "strict",
            "target_track": None,
            "seniority_floor": None,
        }
    ]


def test_verbatim_title_matching_does_not_call_role_adjudicator() -> None:
    matcher = _FakeRoleMatcher(False)

    assert title_matches_query("Engineering Manager", "Engineering Manager", role_matcher=matcher)

    assert matcher.calls == []


def test_recall_title_matching_accepts_leadership_domain_variants() -> None:
    assert title_matches_query("Head of Technology", "technology director", match_mode="recall")
    assert title_matches_query("Director, Cybersecurity", "security director", match_mode="recall")
    assert title_matches_query("Platform Director", "Head of Platform", match_mode="recall")


def test_recall_title_matching_rejects_non_leadership_ic_titles() -> None:
    assert not title_matches_query("Software Engineer", "engineering director", match_mode="recall")
    assert not title_matches_query("Security Analyst", "security director", match_mode="recall")
    assert not title_matches_query(
        "Head of School - School of Biomedical Engineering",
        "engineering manager",
        match_mode="recall",
    )
    assert not title_matches_query(
        "Director, Electrical Engineering - North America, Data Centers",
        "technical director",
        match_mode="recall",
    )
    assert not title_matches_query("Sales Director Platform", "platform director", match_mode="recall")
    assert not title_matches_query("PMO Engineering Manager", "engineering manager", match_mode="recall")
    assert not title_matches_query("Account Platform Director", "platform director", match_mode="recall")
    assert not title_matches_query(
        "Director, Product Management (BSS/Platform Services)",
        "platform director",
        match_mode="recall",
    )


def test_recall_title_matching_respects_track_and_seniority_boundaries() -> None:
    assert title_matches_query(
        "Principal Platform Engineer",
        "Staff Platform Engineer",
        match_mode="recall",
        target_track="ic",
        seniority_floor="staff",
    )
    assert not title_matches_query(
        "Senior Platform Engineer",
        "Principal Platform Engineer",
        match_mode="recall",
        target_track="ic",
        seniority_floor="principal",
    )
    assert not title_matches_query(
        "Platform Engineering Manager",
        "Platform Director",
        match_mode="recall",
        target_track="management",
        seniority_floor="director",
    )
    assert not title_matches_query(
        "Principal Platform Engineer",
        "Platform Director",
        match_mode="recall",
        target_track="management",
        seniority_floor="director",
    )


def test_recall_title_matching_normalizes_c_level_seniority_floor() -> None:
    assert title_matches_query(
        "Chief Technology Officer",
        "CTO",
        match_mode="recall",
        target_track="executive",
        seniority_floor="C-level",
    )
    assert not title_matches_query(
        "VP Technology",
        "CTO",
        match_mode="recall",
        target_track="executive",
        seniority_floor="C-level",
    )
    assert not title_matches_query(
        "Technology Director",
        "CTO",
        match_mode="recall",
        target_track="executive",
        seniority_floor="C suite",
    )


def test_loose_recall_title_matching_uses_role_adjudicator() -> None:
    matcher = _FakeRoleMatcher(False)

    assert not title_matches_query(
        "Project & Construction Manager - Engineer/Architect",
        "Engineering Manager",
        match_mode="recall",
        role_matcher=matcher,
    )

    assert len(matcher.calls) == 1


def test_approved_role_feedback_title_exclusions_apply(monkeypatch, tmp_path) -> None:
    from jobhunter import config

    db_path = tmp_path / "jobhunter.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE role_match_feedback_suggestions (
              tenant_id TEXT,
              suggestion_id TEXT,
              status TEXT,
              rule_kind TEXT,
              title_pattern TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO role_match_feedback_suggestions (
              tenant_id, suggestion_id, status, rule_kind, title_pattern
            ) VALUES ('local', 'suggestion-1', 'approved', 'exact_title_exclusion', ?)
            """,
            ("manager test engineering",),
        )

    monkeypatch.setattr(config, "DB_PATH", db_path)
    reset_role_match_feedback_cache()

    assert not title_matches_query("Manager, Test Engineering", "Engineering Manager")
    assert title_matches_query("Engineering Manager", "Engineering Manager")

    reset_role_match_feedback_cache()


# Engineering-primary titles that carry a non-adjacent business-function token as a
# team/domain qualifier. They must never be dropped deterministically.
_MUST_SURVIVE_ENGINEERING_TITLES = (
    ("Staff Engineer, Pricing Platform", "Staff Engineer"),
    ("Engineering Manager, Accounts", "Engineering Manager"),
    ("Software Engineer, Sales Platform", "Software Engineer"),
    ("Engineer, Commercial Systems", "Engineer"),
)

# Business-primary titles that still contain a genuine (non-adjacent) engineering head.
# Deterministic rules cannot distinguish these from the must-survive titles, so they
# must be routed to the LLM adjudicator rather than verbatim-accepted.
_AMBIGUOUS_BUSINESS_ENGINEERING_TITLES = (
    ("Sales Director, Engineering", "Engineering"),
    ("Head of Sales, Platform Engineering", "Engineering"),
    ("Pre-Sales Solutions Engineer", "Engineer"),
    ("Solutions Engineer, Sales", "Engineer"),
    ("Sales Development Engineer", "Engineer"),
)


def test_business_and_engineering_titles_default_to_accept_without_adjudicator() -> None:
    for title, query in _MUST_SURVIVE_ENGINEERING_TITLES + _AMBIGUOUS_BUSINESS_ENGINEERING_TITLES:
        assert title_matches_query(title, query, role_matcher=None), title


def test_business_and_engineering_titles_are_routed_to_the_adjudicator() -> None:
    for title, query in _MUST_SURVIVE_ENGINEERING_TITLES + _AMBIGUOUS_BUSINESS_ENGINEERING_TITLES:
        accepting = _FakeRoleMatcher(True)
        assert title_matches_query(title, query, role_matcher=accepting), title
        assert len(accepting.calls) == 1, title


def test_business_primary_engineering_titles_are_rejected_when_adjudicator_declines() -> None:
    for title, query in _AMBIGUOUS_BUSINESS_ENGINEERING_TITLES:
        rejecting = _FakeRoleMatcher(False)
        assert not title_matches_query(title, query, role_matcher=rejecting), title
        assert len(rejecting.calls) == 1, title


def test_business_function_primary_roles_are_deterministically_rejected() -> None:
    # When the business token IS the role head or its immediate modifier and there is
    # no genuine engineering head, the title is business-primary and hard-rejected
    # before adjudication. Queries share the non-business token so a bypassed filter
    # would verbatim-match, proving the deterministic reject fires and the accepting
    # matcher is never consulted.
    matcher = _FakeRoleMatcher(True)
    assert not title_matches_query("Account Executive", "Executive", role_matcher=matcher)
    assert not title_matches_query("Sales Manager", "Manager", role_matcher=matcher)
    assert not title_matches_query("Commercial Director", "Director", role_matcher=matcher)
    assert not title_matches_query("Pricing Analyst", "Analyst", role_matcher=matcher)
    assert not title_matches_query("Sales Engineer", "Engineer", role_matcher=matcher)
    assert matcher.calls == []
