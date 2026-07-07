"""Phase 1: deterministic EEO red-flag screen (AI-SPEC §6 Dimension 9).

The code half of the EEO guardrail — the prompt asks the models not to emit
protected-class signals; this screen is what enforces it when a model does
anyway. Proves a protected-class requirement/keyword is DROPPED from the
canonical set and the drop is RECORDED as an audit note, that orphaned children
of a dropped requirement are removed too, and that legitimate requirement text
is not a false positive.
"""

from __future__ import annotations

from jobctl.domain.materials.analysis import (
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
)
from jobctl.domain.materials.analysis_eeo_screen import (
    EeoScreenHit,
    find_eeo_hits,
    screen_eeo_red_flags,
)


def _analysis(*, requirements, keywords) -> JobAnalysis:
    return JobAnalysis(
        role_framing="Own the platform.",
        inferred_seniority="staff",
        ideal_candidate_narrative="A distributed-systems owner.",
        requirements=requirements,
        keywords=keywords,
    )


def test_clean_analysis_passes_through_unchanged() -> None:
    analysis = _analysis(
        requirements=[
            Requirement(
                id="r1",
                text="8+ years in Go",
                tier="must_have",
                weight=0.95,
                evidence_span="8+ years in Go",
            )
        ],
        keywords=[ReasonedKeyword(keyword="Go", evidence_span="8+ years in Go", requirement_ref="r1")],
    )

    result = screen_eeo_red_flags(analysis)

    assert result.has_hits is False
    assert result.hits == ()
    # Same object returned when clean (no needless copy).
    assert result.analysis is analysis


def test_red_flag_requirement_is_dropped_and_recorded() -> None:
    analysis = _analysis(
        requirements=[
            Requirement(
                id="r1",
                text="8+ years in Go",
                tier="must_have",
                weight=0.95,
                evidence_span="8+ years in Go",
            ),
            Requirement(
                id="r2",
                text="recent grad, digital native",
                tier="nice_to_have",
                weight=0.2,
                evidence_span="recent grad",
            ),
        ],
        keywords=[ReasonedKeyword(keyword="Go", evidence_span="8+ years in Go", requirement_ref="r1")],
    )

    result = screen_eeo_red_flags(analysis)

    assert result.has_hits is True
    # The age-coded requirement is gone; the genuine one survives.
    assert [req.id for req in result.analysis.requirements] == ["r1"]
    # The hit is recorded as audit data naming the dropped requirement + category.
    assert len(result.hits) == 1
    hit = result.hits[0]
    assert isinstance(hit, EeoScreenHit)
    assert hit.kind == "requirement"
    assert hit.ref_id == "r2"
    assert hit.category == "age"
    assert hit.matched_text.lower() == "recent grad"


def test_red_flag_keyword_is_dropped_and_recorded() -> None:
    analysis = _analysis(
        requirements=[
            Requirement(
                id="r1",
                text="8+ years in Go",
                tier="must_have",
                weight=0.95,
                evidence_span="8+ years in Go",
            )
        ],
        keywords=[
            ReasonedKeyword(keyword="Go", evidence_span="8+ years in Go", requirement_ref="r1"),
            ReasonedKeyword(keyword="digital native", evidence_span="8+ years in Go", requirement_ref="r1"),
        ],
    )

    result = screen_eeo_red_flags(analysis)

    assert [kw.keyword for kw in result.analysis.keywords] == ["Go"]
    assert [h.ref_id for h in result.hits] == ["digital native"]
    assert result.hits[0].kind == "keyword"
    assert result.hits[0].category == "age"


def test_keyword_orphaned_by_dropped_requirement_is_also_removed() -> None:
    # A keyword that is itself CLEAN (neither its text nor its evidence span trips
    # the screen) but only supports a dropped protected-class requirement must not
    # survive it — it would otherwise dangle, supporting a requirement that is gone.
    analysis = _analysis(
        requirements=[
            Requirement(
                id="r1",
                text="young and energetic team player",
                tier="nice_to_have",
                weight=0.2,
                evidence_span="young and energetic",
            )
        ],
        keywords=[
            ReasonedKeyword(keyword="collaboration", evidence_span="team player", requirement_ref="r1")
        ],
    )

    result = screen_eeo_red_flags(analysis)

    assert result.analysis.requirements == []
    assert result.analysis.keywords == []
    # Only the requirement hit is recorded (the keyword was dropped as a child,
    # not for tripping the screen itself).
    assert [(h.kind, h.ref_id) for h in result.hits] == [("requirement", "r1")]


def test_gendered_job_title_keyword_is_flagged() -> None:
    analysis = _analysis(
        requirements=[],
        keywords=[
            ReasonedKeyword(keyword="salesman", evidence_span="experienced salesman", requirement_ref=None)
        ],
    )

    result = screen_eeo_red_flags(analysis)

    assert result.analysis.keywords == []
    assert result.hits[0].category == "gender"


def test_legitimate_text_is_not_a_false_positive() -> None:
    # Words that contain protected-class substrings but are not EEO signals:
    # "management"/"human" (not "man"/"men"), "craftsmanship" (not "craftsman"),
    # and incidental "men and women" inside an evidence span.
    analysis = _analysis(
        requirements=[
            Requirement(
                id="r1",
                text="People management and craftsmanship",
                tier="must_have",
                weight=0.9,
                evidence_span="led cross-functional teams of men and women across the org",
            )
        ],
        keywords=[
            ReasonedKeyword(
                keyword="human-centered design",
                evidence_span="human-centered design",
                requirement_ref="r1",
            )
        ],
    )

    assert find_eeo_hits(analysis) == []
    result = screen_eeo_red_flags(analysis)
    assert result.has_hits is False
    assert [req.id for req in result.analysis.requirements] == ["r1"]
    assert [kw.keyword for kw in result.analysis.keywords] == ["human-centered design"]
