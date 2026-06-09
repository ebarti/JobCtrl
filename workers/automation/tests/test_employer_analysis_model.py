"""Phase 1: employer-analysis domain model + grounding validator.

Covers the deterministic shipping gates (AI-SPEC §5 Dimensions 1, 2, 3):

  * grounding — literal-substring evidence check (Dimension 1, the cardinal gate)
  * schema/invariants — tier+weight, orphan flagging (Dimension 2)
  * ensemble completeness / degraded signal (Dimension 3)

No LLM/SDK calls — these are pure domain tests.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.analysis import (
    PROMPT_VERSION,
    SDK_SET_VERSION,
    AnalysisAgreement,
    AnalysisFailure,
    EmployerAnalysis,
    JobAnalysis,
    JobAnalysisDraft,
    ReasonedKeyword,
    Requirement,
    cache_key,
    compute_snapshot_hash,
)
from jobhunter.domain.materials.analysis_grounding import (
    GroundingError,
    find_grounding_violations,
    ground_and_snap,
    is_grounded,
    locate_grounded_span,
    validate_evidence_spans,
)
from jobhunter.domain.tenant import LOCAL_TENANT

JD_SNAPSHOT = (
    "Senior Platform Engineer\n\n"
    "We need 5+ years of Python and hands-on Kubernetes operating production "
    "clusters. Experience with Terraform is a plus. You will own the developer "
    "platform and mentor a small team."
)


def _requirement(**overrides) -> Requirement:
    base = {
        "id": "r1",
        "text": "5+ years of Python",
        "tier": "must_have",
        "weight": 0.9,
        "evidence_span": "5+ years of Python",
    }
    base.update(overrides)
    return Requirement(**base)


def _analysis(**overrides) -> JobAnalysis:
    base = {
        "role_framing": "Own and scale the developer platform.",
        "inferred_seniority": "senior",
        "ideal_candidate_narrative": "A hands-on platform owner who mentors.",
        "requirements": [_requirement()],
        "keywords": [
            ReasonedKeyword(
                keyword="Python",
                evidence_span="5+ years of Python",
                requirement_ref="r1",
                rationale="core language",
            )
        ],
    }
    base.update(overrides)
    return JobAnalysis(**base)


# --------------------------------------------------------------------------- #
# Schema + invariants (Dimension 2)
# --------------------------------------------------------------------------- #


class TestSchemaInvariants:
    def test_weight_out_of_range_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            _requirement(weight=1.5)
        with pytest.raises(ValidationError):
            _requirement(weight=-0.1)

    def test_tier_must_be_closed_enum(self) -> None:
        with pytest.raises(ValidationError):
            _requirement(tier="maybe")

    def test_orphan_keyword_flagged_when_ref_missing(self) -> None:
        analysis = _analysis(
            keywords=[
                ReasonedKeyword(keyword="Go", evidence_span="own the developer", requirement_ref="r999"),
                ReasonedKeyword(keyword="Python", evidence_span="5+ years of Python", requirement_ref="r1"),
            ]
        )
        by_kw = {kw.keyword: kw for kw in analysis.keywords}
        assert by_kw["Go"].is_orphan is True  # ref does not resolve
        assert by_kw["Python"].is_orphan is False  # ref resolves to r1

    def test_orphan_keyword_flagged_when_ref_none(self) -> None:
        analysis = _analysis(
            keywords=[ReasonedKeyword(keyword="Python", evidence_span="5+ years of Python")]
        )
        assert analysis.keywords[0].is_orphan is True

    def test_must_have_and_nice_to_have_partition(self) -> None:
        analysis = _analysis(
            requirements=[
                _requirement(id="r1", tier="must_have"),
                _requirement(id="r2", tier="nice_to_have", text="Terraform", evidence_span="Terraform is a plus"),
            ]
        )
        assert [r.id for r in analysis.must_have_requirements] == ["r1"]
        assert [r.id for r in analysis.nice_to_have_requirements] == ["r2"]


# --------------------------------------------------------------------------- #
# Grounding (Dimension 1 — cardinal gate, failure mode #1)
# --------------------------------------------------------------------------- #


class TestGrounding:
    def test_verbatim_substring_is_grounded(self) -> None:
        assert is_grounded("5+ years of Python", JD_SNAPSHOT) is True

    def test_whitespace_normalized_span_is_grounded(self) -> None:
        # Trailing/collapsed whitespace differences must not produce a false reject.
        assert is_grounded("5+ years   of\nPython", JD_SNAPSHOT) is True

    def test_paraphrase_is_not_grounded(self) -> None:
        # The JD says "5+ years of Python"; a reworded claim is fabrication.
        assert is_grounded("at least five years of Python", JD_SNAPSHOT) is False

    def test_over_inference_is_not_grounded(self) -> None:
        # Classic over-inference: inventing a concrete requirement the JD never states.
        assert is_grounded("must know Istio service mesh", JD_SNAPSHOT) is False

    def test_empty_span_is_not_grounded(self) -> None:
        assert is_grounded("", JD_SNAPSHOT) is False
        assert is_grounded("   ", JD_SNAPSHOT) is False

    def test_validate_passes_for_grounded_analysis(self) -> None:
        validate_evidence_spans(_analysis(), JD_SNAPSHOT)  # no raise

    def test_validate_raises_for_fabricated_requirement_span(self) -> None:
        bad = _analysis(requirements=[_requirement(evidence_span="ten years of Rust")])
        with pytest.raises(GroundingError) as exc:
            validate_evidence_spans(bad, JD_SNAPSHOT)
        assert any(v.kind == "requirement" for v in exc.value.violations)

    def test_validate_raises_for_fabricated_keyword_span(self) -> None:
        bad = _analysis(
            keywords=[ReasonedKeyword(keyword="Rust", evidence_span="deep Rust expertise", requirement_ref="r1")]
        )
        violations = find_grounding_violations(bad, JD_SNAPSHOT)
        assert [v.kind for v in violations] == ["keyword"]
        assert violations[0].ref_id == "Rust"


# --------------------------------------------------------------------------- #
# Formatting-tolerant grounding + snap-to-source (Dimension 1, D-15)
#
# The matcher is normalize -> locate -> snap-to-source: formatting-insignificant
# differences (Unicode hyphen/dash variants, whitespace/newlines, smart quotes,
# case) GROUND, and the stored span is rewritten to the JD's verbatim text. The
# no-fabrication guarantee is UNCHANGED — different WORDS (paraphrase / synonym /
# hallucination) are still rejected. These tests pin both halves.
# --------------------------------------------------------------------------- #

# U+2011 NON-BREAKING HYPHEN — the exact char that wrongly rejected a real span
# in the live E2E ("high‑availability" in the JD vs ASCII "high-availability").
_JD_UNICODE_HYPHEN = (
    "Head of Security Operations\n\n"
    "You will run a high‑availability SOC and own incident response."
)


class TestNormalizedGroundingAndSnap:
    # --- Unicode hyphen variant (the regression that motivated this change) --- #

    def test_unicode_hyphen_span_grounds(self) -> None:
        # JD has U+2011; the model quoted ASCII "-". Genuinely present -> grounds.
        assert is_grounded("high-availability", _JD_UNICODE_HYPHEN) is True

    def test_unicode_hyphen_snaps_to_verbatim_jd_text(self) -> None:
        # Snap-to-source returns the JD's ACTUAL text — the U+2011 variant, not
        # the model's ASCII hyphen.
        snapped = locate_grounded_span("high-availability", _JD_UNICODE_HYPHEN)
        assert snapped == "high‑availability"  # contains U+2011
        assert "‑" in snapped and "-" not in snapped

    def test_en_and_em_dash_variants_ground(self) -> None:
        jd = "Coverage is 24/7 — on‑call rotation with end–to–end ownership."
        assert is_grounded("on-call rotation", jd) is True
        assert is_grounded("end-to-end ownership", jd) is True
        assert locate_grounded_span("end-to-end ownership", jd) == "end–to–end ownership"

    # --- Whitespace / newline tolerance --- #

    def test_span_split_across_newline_grounds_and_snaps(self) -> None:
        # The phrase is split across a line break + multiple spaces in the JD; the
        # model quoted it with single spaces. It grounds and snaps to the JD's
        # actual (multi-line) text so highlighting offsets are exact.
        jd = "You will operate production\n   Kubernetes clusters at scale."
        assert is_grounded("production Kubernetes clusters", jd) is True
        assert locate_grounded_span("production Kubernetes clusters", jd) == (
            "production\n   Kubernetes clusters"
        )

    # --- Smart vs straight quotes --- #

    def test_smart_quotes_ground_and_snap_to_jd_quotes(self) -> None:
        jd = "Maintain the team’s “PostgreSQL” fleet and its uptime SLOs."
        # Model quoted with straight ASCII quotes; JD uses curly quotes.
        assert is_grounded("team's \"PostgreSQL\" fleet", jd) is True
        assert locate_grounded_span("team's \"PostgreSQL\" fleet", jd) == (
            "team’s “PostgreSQL” fleet"
        )

    # --- Case-insensitive --- #

    def test_case_insensitive_grounds_and_snaps_to_jd_case(self) -> None:
        jd = "Deep PostgreSQL tuning and Kafka streaming required."
        assert is_grounded("postgresql tuning", jd) is True
        # Snaps to the JD's actual casing, not the model's lowercase quote.
        assert locate_grounded_span("postgresql tuning", jd) == "PostgreSQL tuning"

    # --- THE GUARANTEE: different WORDS are still rejected --- #

    def test_paraphrase_with_different_words_is_still_rejected(self) -> None:
        # JD says "high availability"; "99.9999% uptime" is a synonym/paraphrase
        # whose WORDS are not in the JD. Formatting tolerance must NOT relax this.
        jd = "We need high availability and resilient systems."
        assert is_grounded("99.9999% uptime", jd) is False

    def test_invented_technology_is_still_rejected(self) -> None:
        # Classic hallucination: a concrete tool the JD never names.
        jd = "We need high availability and resilient systems."
        assert is_grounded("Kubernetes", jd) is False

    def test_ground_and_snap_raises_for_paraphrased_requirement(self) -> None:
        jd = "We need high availability and resilient systems."
        bad = _analysis(
            requirements=[
                _requirement(id="r1", text="HA", evidence_span="99.9999% uptime")
            ],
            keywords=[],
        )
        with pytest.raises(GroundingError) as exc:
            ground_and_snap(bad, jd)
        assert any(v.kind == "requirement" and v.span == "99.9999% uptime" for v in exc.value.violations)

    # --- Snap-to-source on the whole analysis + idempotence --- #

    def test_ground_and_snap_rewrites_spans_to_verbatim_source(self) -> None:
        analysis = _analysis(
            requirements=[
                _requirement(id="r1", text="HA", evidence_span="high-availability")
            ],
            keywords=[
                ReasonedKeyword(
                    keyword="HA",
                    evidence_span="high-availability",
                    requirement_ref="r1",
                )
            ],
        )
        snapped = ground_and_snap(analysis, _JD_UNICODE_HYPHEN)
        # Every span now equals the JD's verbatim (U+2011) text.
        assert snapped.requirements[0].evidence_span == "high‑availability"
        assert snapped.keywords[0].evidence_span == "high‑availability"
        # Non-span fields are preserved unchanged.
        assert snapped.requirements[0].id == "r1"
        assert snapped.keywords[0].requirement_ref == "r1"
        # The input is never mutated (returns a copy when spans change).
        assert analysis.requirements[0].evidence_span == "high-availability"

    def test_ground_and_snap_is_idempotent_on_verbatim_spans(self) -> None:
        # An already-verbatim analysis is returned unchanged (no-op) — snapping a
        # snapped analysis is a no-op.
        analysis = _analysis()  # spans are already exact JD substrings
        once = ground_and_snap(analysis, JD_SNAPSHOT)
        twice = ground_and_snap(once, JD_SNAPSHOT)
        assert once is analysis  # same object: nothing to rewrite
        assert twice is once
        assert once.requirements[0].evidence_span == "5+ years of Python"

    def test_ground_and_snap_preserves_draft_model_id(self) -> None:
        # Snapping a JobAnalysisDraft must keep its model_id tag and return a draft.
        draft = JobAnalysisDraft(
            model_id="gpt-5.4",
            **_analysis(
                requirements=[_requirement(id="r1", text="HA", evidence_span="high-availability")],
                keywords=[],
            ).model_dump(),
        )
        snapped = ground_and_snap(draft, _JD_UNICODE_HYPHEN)
        assert isinstance(snapped, JobAnalysisDraft)
        assert snapped.model_id == "gpt-5.4"
        assert snapped.requirements[0].evidence_span == "high‑availability"


# --------------------------------------------------------------------------- #
# Cache key (D-11/D-12)
# --------------------------------------------------------------------------- #


class TestCacheKey:
    def test_snapshot_hash_is_stable(self) -> None:
        assert compute_snapshot_hash(JD_SNAPSHOT) == compute_snapshot_hash(JD_SNAPSHOT)

    def test_snapshot_hash_differs_for_different_text(self) -> None:
        assert compute_snapshot_hash(JD_SNAPSHOT) != compute_snapshot_hash(JD_SNAPSHOT + " extra")

    def test_cache_key_includes_prompt_and_sdk_versions(self) -> None:
        snap = compute_snapshot_hash(JD_SNAPSHOT)
        key = cache_key(snap)
        assert key == f"{snap}:{PROMPT_VERSION}:{SDK_SET_VERSION}"

    def test_cache_key_changes_when_prompt_version_bumps(self) -> None:
        snap = compute_snapshot_hash(JD_SNAPSHOT)
        assert cache_key(snap, prompt_version="v2") != cache_key(snap, prompt_version="v1")


# --------------------------------------------------------------------------- #
# EmployerAnalysis aggregate + ensemble completeness (Dimension 3 / D-08/D-13)
# --------------------------------------------------------------------------- #


def _draft(model_id: str) -> JobAnalysisDraft:
    return JobAnalysisDraft(model_id=model_id, **_analysis().model_dump())


class TestEmployerAnalysisAggregate:
    def test_records_full_ensemble_completeness_when_all_legs_succeed(self) -> None:
        record = EmployerAnalysis.build(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("https://example.com/job/1"),
            generation=1,
            snapshot_hash=compute_snapshot_hash(JD_SNAPSHOT),
            canonical=_analysis(),
            sub_analyses=(_draft("claude-opus-4-8"), _draft("gpt-5.4")),
            failures=(),
            agreement=AnalysisAgreement(score=0.95),
            legs_attempted=2,
        )
        assert record.legs_succeeded == 2
        assert record.ensemble_completeness == "2/2"
        assert record.is_degraded is False
        assert record.cache_key.endswith(f"{PROMPT_VERSION}:{SDK_SET_VERSION}")

    def test_degraded_ensemble_is_surfaced_not_masked(self) -> None:
        record = EmployerAnalysis.build(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("https://example.com/job/1"),
            generation=1,
            snapshot_hash=compute_snapshot_hash(JD_SNAPSHOT),
            canonical=_analysis(),
            sub_analyses=(_draft("claude-opus-4-8"),),
            failures=(AnalysisFailure(model_id="gpt-5.4", error="boom", raw_output="{}"),),
            agreement=AnalysisAgreement(score=1.0),
            legs_attempted=2,
        )
        assert record.ensemble_completeness == "1/2"
        assert record.is_degraded is True
        # Failure persisted as audit data, never silently dropped (failure mode #2).
        assert record.failures[0].model_id == "gpt-5.4"

    def test_read_model_carries_sub_analyses_failures_and_agreement(self) -> None:
        record = EmployerAnalysis.build(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("https://example.com/job/1"),
            generation=2,
            snapshot_hash=compute_snapshot_hash(JD_SNAPSHOT),
            canonical=_analysis(),
            sub_analyses=(_draft("claude-opus-4-8"),),
            failures=(AnalysisFailure(model_id="gpt-5.4", error="timeout"),),
            agreement=AnalysisAgreement(score=0.8, flagged_keywords=("Go",)),
            legs_attempted=2,
        )
        read = record.to_read_model()
        assert read["generation"] == 2
        assert read["ensemble_completeness"] == "1/2"
        assert read["is_degraded"] is True
        assert read["agreement"]["flagged_keywords"] == ["Go"]
        assert read["requirements"][0]["tier"] == "must_have"
        assert read["sub_analyses"][0]["model_id"] == "claude-opus-4-8"
        assert read["failures"][0]["model_id"] == "gpt-5.4"

    def test_generation_must_be_positive(self) -> None:
        with pytest.raises(ValueError):
            EmployerAnalysis.build(
                tenant_id=LOCAL_TENANT,
                job_id=JobId("https://example.com/job/1"),
                generation=0,
                snapshot_hash=compute_snapshot_hash(JD_SNAPSHOT),
                canonical=_analysis(),
                sub_analyses=(_draft("claude-opus-4-8"),),
                failures=(),
                agreement=AnalysisAgreement(),
                legs_attempted=1,
            )
