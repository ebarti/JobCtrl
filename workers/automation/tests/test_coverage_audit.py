"""Final keyword-coverage audit against rendered text (GROUND-06, Phase 3).

Coverage is computed at generation time against the ACTUAL rendered resume text
both renderers consume — never inferred from the job description (Anti-Pattern 2)
— and a keyword counts as covered ONLY when it appears in a bullet backed by real
profile EVIDENCE (success criterion 4 / Pitfall 10): an unsourced skills-dump line
or a substring false positive does NOT count.

These tests pin the audit's cardinal invariants directly over
``compute_keyword_coverage`` with hand-built provenance rows. Coverage partitions
the planned keywords into three honestly-labeled buckets — ``covered`` (demonstrated),
``declared`` (rendered from the canonical profile skills declaration but not
demonstrated), ``missing`` (rendered nowhere the employer legitimately reads):

  * covered ⇒ the keyword appears in a bullet carrying a canonical evidence FK, OR
    the keyword itself traces (word-boundary) to the profile evidence corpus;
  * a requirement FK alone does NOT count toward ``covered`` — the provenance builder
    binds a requirement whenever the keyword appears in the line, so crediting
    coverage off it is circular (the keyword grounds itself). A keyword whose only
    home is a requirement-bound-but-evidence-free SKILLS line (absent from the
    corpus) is ``declared`` — it genuinely ships in the resume's skills section, so
    reporting it ``missing`` would lie the other way — but never ``covered``;
  * ``declared`` is skills-only: a keyword in an ungrounded NON-skills line, or in no
    shipped line at all, is ``missing``;
  * a substring collision ("java" inside "javascript") does not count as covered, on
    either the bullet text or the corpus-trace path.
"""

from __future__ import annotations

from jobctl.domain.materials.analysis import (
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
)
from jobctl.domain.materials.coverage_audit import KeywordCoverage, compute_keyword_coverage
from jobctl.domain.materials.fabrication_detector import EvidenceCorpus
from jobctl.domain.materials.provenance import BulletProvenance
from jobctl.domain.materials.value_objects import ControlRule, TransformType


def _analysis(*keywords: str) -> JobAnalysis:
    return JobAnalysis(
        role_framing="Backend.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A backend owner.",
        requirements=[
            Requirement(
                id="req1",
                text="own backend services",
                tier="must_have",
                weight=0.9,
                evidence_span="own backend services",
            ),
        ],
        keywords=[
            ReasonedKeyword(keyword=kw, evidence_span=kw, requirement_ref="req1")
            for kw in keywords
        ],
    )


def _corpus(*phrases: str) -> EvidenceCorpus:
    """A minimal profile evidence corpus; only ``.text`` gates coverage crediting.

    ``text`` mirrors what ``build_evidence_corpus`` produces: a lowercased,
    whitespace-collapsed concatenation of the grounded profile fragments a real
    keyword must trace to.
    """
    return EvidenceCorpus(
        text=" ".join(phrases).lower(),
        numeric_keys=frozenset(),
        title_tokens=frozenset(),
        date_tokens=frozenset(),
    )


def _evidence_backed_bullet(text: str, *, bullet_id: str = "experience:e#0") -> BulletProvenance:
    """A bullet carrying a canonical evidence FK => backed by real profile evidence."""
    return BulletProvenance(
        bullet_id=bullet_id,
        section="experience",
        source_id="e",
        evidence_ids=("ev1",),
        requirement_ids=(),
        matched_keywords=(),
        transform_type=TransformType.REPHRASE,
        control=ControlRule.REPHRASE_ALLOWED,
        rationale="",
        generated_text=text,
    )


def _requirement_only_skill_line(text: str, *, bullet_id: str = "skills:s#0") -> BulletProvenance:
    """A skills line as the REAL builder emits it: a requirement FK bound purely
    because the keyword appears in the line (``_served_requirements``), but NO
    evidence FK.

    This is the case the impossible old fixture could not construct: it is
    "grounded" under the buggy evidence-OR-requirement rule yet carries zero profile
    evidence, so on its own it must NOT credit coverage.
    """
    return BulletProvenance(
        bullet_id=bullet_id,
        section="skills",
        source_id="s",
        evidence_ids=(),
        requirement_ids=("req1",),
        matched_keywords=(),
        transform_type=TransformType.VERBATIM,
        control=ControlRule.REPHRASE_ALLOWED,
        rationale="",
        generated_text=text,
    )


def test_keyword_in_evidence_backed_bullet_counts_as_covered() -> None:
    analysis = _analysis("kubernetes")
    rows = (_evidence_backed_bullet("Ran services on Kubernetes across three clusters."),)
    coverage = compute_keyword_coverage(analysis, rows, _corpus())
    assert "kubernetes" in coverage.covered
    assert "kubernetes" not in coverage.missing
    assert coverage.computed_against == "rendered_text"


def test_keyword_only_in_requirement_bound_skills_dump_is_declared_not_covered() -> None:
    """Success criterion 4 / Pitfall 10 (the circular-grounding regression) + A6b.

    The provenance builder binds ``req1`` to the skills line purely because
    "kubernetes" appears in it, so under the old evidence-OR-requirement rule that
    self-bound requirement marked the line "grounded" and the keyword counted as
    covered with ZERO evidence. The anti-stuffing guard must still reject that
    self-match: the keyword is NOT ``covered``. But the skills line genuinely ships
    "Kubernetes" (skills rows render the canonical profile declaration), so the honest
    bucket is ``declared`` — reporting it ``missing`` would be the A6b lying surface in
    the other direction. It records the DECLARING skills bullet, not a demonstration.
    """
    analysis = _analysis("kubernetes")
    rows = (
        _evidence_backed_bullet("Owned the billing service end to end."),
        _requirement_only_skill_line("Skills: Kubernetes, Terraform, Helm"),
    )
    # The corpus (real profile evidence) does NOT mention Kubernetes.
    corpus = _corpus("owned the billing service end to end")
    coverage = compute_keyword_coverage(analysis, rows, corpus)
    assert "kubernetes" not in coverage.covered
    assert "kubernetes" not in coverage.missing
    assert "kubernetes" in coverage.declared
    assert coverage.declared_by["kubernetes"] == "skills:s#0"


def test_keyword_in_skills_line_counts_when_it_traces_to_evidence_corpus() -> None:
    """Preserve user value: a REAL skill in the skills line (no evidence FK on the
    line) still counts when the keyword traces to the profile evidence corpus — only
    fabricated/stuffed keywords absent from the corpus fall into ``missing``."""
    analysis = _analysis("python")
    rows = (_requirement_only_skill_line("Skills: Python, Terraform, Helm"),)
    # "python" is a real skill recorded in the profile evidence (e.g. evidence tools).
    corpus = _corpus("cut latency 40% with python and postgresql")
    coverage = compute_keyword_coverage(analysis, rows, corpus)
    assert "python" in coverage.covered
    assert coverage.covered_by["python"] == "skills:s#0"


def test_substring_false_positive_does_not_count() -> None:
    """'java' must not be 'covered' just because 'javascript' appears (Pitfall 10)."""
    analysis = _analysis("java")
    rows = (_evidence_backed_bullet("Shipped a JavaScript SPA for the dashboard."),)
    coverage = compute_keyword_coverage(analysis, rows, _corpus())
    assert "java" not in coverage.covered
    assert "java" in coverage.missing


def test_corpus_trace_is_word_boundary_not_substring() -> None:
    """The corpus-trace path is word-boundary too: a requirement-only bullet whose
    keyword ("java") is a real word must NOT be credited as COVERED off a corpus that
    only contains "javascript" (no evidence FK, no genuine corpus trace). It still
    ships in the skills line, so it lands in ``declared`` — the corpus mismatch bars
    ``covered``, not the honest declaration record."""
    analysis = _analysis("java")
    rows = (_requirement_only_skill_line("Skills: Java, Kotlin"),)
    corpus = _corpus("shipped a javascript single page app")
    coverage = compute_keyword_coverage(analysis, rows, corpus)
    assert "java" not in coverage.covered
    assert "java" in coverage.declared
    assert "java" not in coverage.missing


def test_declared_is_skills_only_ungrounded_non_skills_line_is_missing() -> None:
    """``declared`` is a SKILLS-section privilege: the skills line renders the canonical
    profile declaration, so a keyword there is at least declared. A keyword whose only
    home is an ungrounded NON-skills line (no evidence FK, absent from the corpus) has
    no such backing and is reported ``missing``, never declared."""
    analysis = _analysis("kubernetes")
    # An experience-section row with NO evidence FK and a corpus that omits the keyword.
    ungrounded_experience = BulletProvenance(
        bullet_id="experience:acme#1",
        section="experience",
        source_id="acme",
        evidence_ids=(),
        requirement_ids=("req1",),
        matched_keywords=(),
        transform_type=TransformType.REPHRASE,
        control=ControlRule.REPHRASE_ALLOWED,
        rationale="",
        generated_text="Explored Kubernetes on a side project.",
    )
    coverage = compute_keyword_coverage(analysis, (ungrounded_experience,), _corpus("owned billing"))
    assert "kubernetes" not in coverage.covered
    assert "kubernetes" not in coverage.declared
    assert "kubernetes" in coverage.missing


def test_covered_takes_precedence_over_declared() -> None:
    """A keyword demonstrated in an evidence-backed bullet AND declared in the skills
    line is ``covered`` (the stronger claim), recorded against the demonstrating
    bullet — not double-counted into ``declared``."""
    analysis = _analysis("python")
    rows = (
        _requirement_only_skill_line("Skills: Python, Go"),
        _evidence_backed_bullet("Built Python services.", bullet_id="experience:acme#0"),
    )
    # Corpus omits python so ``covered`` must come from the evidence FK, not a trace.
    coverage = compute_keyword_coverage(analysis, rows, _corpus("owned billing"))
    assert "python" in coverage.covered
    assert coverage.covered_by["python"] == "experience:acme#0"
    assert "python" not in coverage.declared


def test_covered_records_the_evidence_backed_bullet_it_was_found_in() -> None:
    """Coverage is inspectable: each covered keyword records WHERE it was covered."""
    analysis = _analysis("python")
    rows = (_evidence_backed_bullet("Built Python services.", bullet_id="experience:acme#0"),)
    coverage = compute_keyword_coverage(analysis, rows, _corpus())
    assert coverage.covered_by["python"] == "experience:acme#0"


def test_missing_list_is_never_empty_when_a_keyword_is_absent() -> None:
    """The missing list is computed (analysis_keywords - covered), never suppressed."""
    analysis = _analysis("python", "rust", "kafka")
    rows = (_evidence_backed_bullet("Built Python services."),)
    coverage = compute_keyword_coverage(analysis, rows, _corpus())
    assert coverage.covered == ("python",)
    assert set(coverage.missing) == {"rust", "kafka"}


def test_empty_analysis_keywords_is_neutral() -> None:
    analysis = _analysis()
    rows = (_evidence_backed_bullet("Built Python services."),)
    coverage = compute_keyword_coverage(analysis, rows, _corpus())
    assert coverage.covered == ()
    assert coverage.declared == ()
    assert coverage.missing == ()
    assert coverage.coverage_ratio == 0.0


def test_coverage_to_read_model_is_serialisable_and_complete() -> None:
    analysis = _analysis("python", "kubernetes", "rust")
    rows = (
        _evidence_backed_bullet("Built Python services."),
        _requirement_only_skill_line("Skills: Kubernetes, Helm"),
    )
    # Corpus omits kubernetes so it is declared (skills line) not covered.
    read = compute_keyword_coverage(analysis, rows, _corpus("built python services")).to_read_model()
    assert read["covered"] == ["python"]
    assert read["declared"] == ["kubernetes"]
    assert read["missing"] == ["rust"]
    assert read["computed_against"] == "rendered_text"
    assert read["covered_by"] == {"python": "experience:e#0"}
    assert read["declared_by"] == {"kubernetes": "skills:s#0"}
    assert read["counts"] == {"planned": 3, "covered": 1, "declared": 1, "missing": 1}


def test_coverage_from_read_model_defaults_declared_for_pre_a6b_rows() -> None:
    """Backward-compatible read: a persisted row from before A6b carries no
    ``declared`` / ``declared_by`` keys; rehydration defaults them to empty rather
    than raising, so old generations still open in the inspector."""
    pre_a6b = {
        "computed_against": "rendered_text",
        "planned": ["python", "rust"],
        "covered": ["python"],
        "missing": ["rust"],
        "covered_by": {"python": "experience:e#0"},
        "counts": {"planned": 2, "covered": 1, "missing": 1},
    }
    coverage = KeywordCoverage.from_read_model(pre_a6b)
    assert coverage is not None
    assert coverage.declared == ()
    assert coverage.declared_by == {}
    assert coverage.covered == ("python",)
    # Re-serialising fills the three-bucket shape so downstream readers are uniform.
    assert coverage.to_read_model()["declared"] == []
    assert coverage.to_read_model()["counts"]["declared"] == 0
