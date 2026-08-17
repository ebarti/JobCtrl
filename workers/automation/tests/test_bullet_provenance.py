"""Phase 2: per-bullet provenance + the deterministic never-fabricate detector.

Covers the Phase-2 success criteria as pure domain tests (no LLM/SDK calls):

  * fabricated evidence/requirement-ID reject (GROUND-05, success criterion 2)
  * never-fabricate detector — a metrics-hungry job + a numberless profile yields
    zero unsourced numerics (CONTROL-03 / success criterion 4)
  * per-bullet provenance shape + closed transform taxonomy (GROUND-03/04)
  * the governing control rule is recorded per bullet (CONTROL-02 / criterion 3)
  * generation-versioning round-trip + supersede-not-destroy (criterion 5)
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobctrl.domain.materials.coverage_audit import compute_keyword_coverage
from jobctrl.domain.materials.fabrication_detector import (
    build_evidence_corpus,
    build_skill_evidence_corpus,
    build_skill_vocabulary,
    employer_name_set,
    find_fabricated_tokens,
    scan_prose_skill_fabrications,
    scan_resume_bullets,
)
from jobctrl.domain.materials.provenance import BulletProvenance, BulletProvenanceSet
from jobctrl.domain.materials.provenance_builder import (
    ProvenanceBindingError,
    build_bullet_provenance,
)
from jobctrl.domain.materials.quality import build_tailoring_plan
from jobctrl.domain.materials.services import ResumeAssembler
from jobctrl.domain.materials.value_objects import ControlRule, TransformType
from jobctrl.infrastructure.materials.bullet_provenance_repository import (
    SqliteBulletProvenanceRepository,
)
from jobctrl.infrastructure.materials.html_resume_pdf import build_resume_document
from jobctrl.infrastructure.materials.unit_of_work import SqliteUnitOfWork
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId

JOB_URL = "https://example.com/senior-backend"
PERSISTED_JOB_ID = JobId("00000000-0000-4000-8000-000000000041")
OTHER_TENANT = TenantId("other")


# --------------------------------------------------------------------------
# Fixtures (mirror test_materials_quality conventions)
# --------------------------------------------------------------------------


def _analysis(
    *,
    requirements: list[Requirement] | None = None,
    keywords: list[ReasonedKeyword] | None = None,
) -> EmployerAnalysis:
    canonical = JobAnalysis(
        role_framing="Own backend latency.",
        inferred_seniority="senior",
        ideal_candidate_narrative="A hands-on backend owner.",
        requirements=requirements
        or [
            Requirement(
                id="req_python",
                text="5+ years of Python",
                tier="must_have",
                weight=0.9,
                evidence_span="5+ years of Python",
            ),
            Requirement(
                id="req_latency",
                text="improve API latency",
                tier="nice_to_have",
                weight=0.5,
                evidence_span="improve API latency",
            ),
        ],
        keywords=keywords
        or [
            ReasonedKeyword(
                keyword="Python",
                evidence_span="5+ years of Python",
                requirement_ref="req_python",
            ),
            ReasonedKeyword(
                keyword="latency",
                evidence_span="improve API latency",
                requirement_ref="req_latency",
            ),
        ],
    )
    return EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=PERSISTED_JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash("jd"),
        canonical=canonical,
        sub_analyses=(),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )


def _profile() -> dict:
    return {
        "personal": {"full_name": "Jane Doe", "email": "jane@example.com"},
        "resume_constraints": {"real_metrics": ["35% latency reduction"]},
        "resume": {
            "executive_profile": {"baseline_text": "Senior backend engineer."},
            "experience_entries": [
                {
                    "id": "acme_swe",
                    "date_range": "2020-Present",
                    "title": "Senior SWE",
                    "company": "Acme Corp",
                    "location": "Remote",
                    "bullets": ["Reduced API latency 35% by replacing synchronous calls."],
                    "achievement_evidence": [
                        {
                            "id": "ev_latency",
                            "source_text": ("Reduced API latency 35% by replacing synchronous enrichment calls."),
                            "scope": "owned service",
                            "action": "replaced synchronous enrichment calls",
                            "tools": ["Python", "PostgreSQL"],
                            "metrics": ["35% latency reduction"],
                            "outcome": "faster API responses",
                            "seniority_signal": "technical ownership",
                            "evidence_strength": "verified",
                            "claim_confidence": 0.95,
                            "user_confirmed": True,
                            "tags": ["latency", "backend", "performance"],
                        }
                    ],
                }
            ],
            "education_entries": [
                {"id": "edu_state", "degree": "BSc CS", "institution": "State University", "date": "2015"}
            ],
            "skill_categories": [{"id": "languages", "label": "Languages", "items": ["Python", "Go"]}],
            "tailoring_rules": {
                "required_experience_entry_ids": ["acme_swe"],
                "required_skill_category_ids": ["languages"],
                "max_experience_bullets": 4,
                "tailoring_policy": {
                    "claim_mode": "evidence_reframing",
                    "auto_approvable_claim_modes": ["verified_only", "evidence_reframing"],
                },
                "writing_style": {"tone": "direct", "bullet_style": "leadership"},
            },
        },
    }


def _numberless_profile() -> dict:
    """A profile whose experience carries NO numerics/metrics at all."""
    return {
        "personal": {"full_name": "Sam Lee", "email": "sam@example.com"},
        "resume_constraints": {"real_metrics": []},
        "resume": {
            "executive_profile": {"baseline_text": "Backend engineer."},
            "experience_entries": [
                {
                    "id": "acme_swe",
                    "date_range": "recent",
                    "title": "Engineer",
                    "company": "Acme Corp",
                    "location": "Remote",
                    "bullets": ["Improved API responsiveness by removing synchronous calls."],
                    "achievement_evidence": [
                        {
                            "id": "ev_api",
                            "source_text": "Improved API responsiveness by removing synchronous calls.",
                            "scope": "owned service",
                            "action": "removed synchronous calls",
                            "tools": ["Python"],
                            "metrics": [],
                            "outcome": "faster responses",
                            "tags": ["latency", "backend"],
                        }
                    ],
                }
            ],
            "education_entries": [],
            "skill_categories": [{"id": "languages", "label": "Languages", "items": ["Python"]}],
            "tailoring_rules": {
                "required_experience_entry_ids": ["acme_swe"],
                "required_skill_category_ids": ["languages"],
                "max_experience_bullets": 4,
                "tailoring_policy": {"claim_mode": "verified_only"},
            },
        },
    }


def _job() -> dict:
    return {
        "job_id": PERSISTED_JOB_ID,
        "url": JOB_URL,
        "title": "Senior Backend Engineer",
        "full_description": "Own Python backend services and improve API latency.",
    }


def _payload(*, bullets: list[str], summary: str = "Senior backend engineer.") -> dict:
    return {
        "executive_profile": summary,
        "experience_updates": [{"id": "acme_swe", "title": "", "bullets": bullets}],
        "skill_category_updates": [{"id": "languages", "items": ["Python", "Go"]}],
    }


def _build(profile: dict, payload: dict, analysis: EmployerAnalysis) -> tuple[BulletProvenance, ...]:
    plan = build_tailoring_plan(profile, _job(), employer_analysis=analysis)
    return build_bullet_provenance(profile, _job(), payload, plan, analysis)


# --------------------------------------------------------------------------
# Per-bullet shape + transform taxonomy (GROUND-03/04)
# --------------------------------------------------------------------------


def test_provenance_has_one_row_per_rendered_bullet_with_closed_taxonomy() -> None:
    rows = _build(
        _profile(),
        _payload(bullets=["Reduced API latency 35% by replacing synchronous calls."]),
        _analysis(),
    )
    sections = {row.section for row in rows}
    assert sections == {"executive_profile", "experience", "skills"}
    # Every transform_type is a member of the closed taxonomy (GROUND-04).
    for row in rows:
        assert isinstance(row.transform_type, TransformType)
        assert isinstance(row.control, ControlRule)
        assert row.generated_text.strip()  # coverage anchor is the rendered text

    experience = next(row for row in rows if row.section == "experience")
    # Bullet equals the source profile bullet verbatim -> VERBATIM transform.
    assert experience.transform_type is TransformType.VERBATIM
    assert experience.source_id == "acme_swe"
    assert experience.bullet_id == "experience:acme_swe#0"


def _assembled_summary_line(profile: dict, payload: dict) -> str:
    """The exact summary line the assembler ships (line after EXECUTIVE PROFILE)."""
    text = ResumeAssembler().assemble_resume_text(payload, profile)
    lines = text.splitlines()
    idx = lines.index("EXECUTIVE PROFILE")
    return lines[idx + 1].strip()


def test_executive_provenance_anchors_to_shipped_summary_when_rewrite_disabled() -> None:
    """Regression (Pattern 2 / GROUND-06): with ``allow_summary_rewrite`` off the
    resume ships the profile baseline, so the executive-profile provenance
    ``generated_text`` MUST equal the assembled summary line — not the model's
    proposed (never-rendered) rewrite. Without the policy gate the provenance
    anchor and the deterministic detector scan text the user never received."""
    profile = _profile()
    profile["resume"]["tailoring_rules"]["tailoring_policy"]["allow_summary_rewrite"] = False
    # The model proposes a rewrite the resume will NOT ship under this policy.
    proposed = "Backend engineer who delivered 99.99% uptime."
    payload = _payload(
        bullets=["Reduced API latency 35% by replacing synchronous calls."],
        summary=proposed,
    )

    shipped_summary = _assembled_summary_line(profile, payload)
    # Sanity: the assembler ships the baseline, not the proposed rewrite.
    assert shipped_summary == "Senior backend engineer."
    assert shipped_summary != proposed

    rows = _build(profile, payload, _analysis())
    executive = next(row for row in rows if row.section == "executive_profile")
    # Provenance is anchored to the SHIPPED line (byte-identical), never the rewrite.
    assert executive.generated_text == shipped_summary
    assert executive.generated_text != proposed
    # Baseline == shipped -> the transform is VERBATIM, not a phantom REFRAME.
    assert executive.transform_type is TransformType.VERBATIM

    # And the deterministic detector now scans the SHIPPED text: the rewrite's
    # "99.99%" (absent from the profile) must NOT appear in any scanned bullet,
    # so a clean baseline resume is not falsely rejected for the dropped rewrite.
    corpus = build_evidence_corpus(profile)
    findings = scan_resume_bullets(
        [(row.bullet_id, row.generated_text) for row in rows],
        corpus,
        employers=employer_name_set(profile),
    )
    assert all("99.99" not in f.generated_text for f in findings)


def test_executive_provenance_anchors_to_rewrite_when_rewrite_enabled() -> None:
    """The complementary arm: with rewrite ON the shipped summary is the model's
    summary, and provenance anchors to it (still equal to the assembled line)."""
    profile = _profile()
    profile["resume"]["tailoring_rules"]["tailoring_policy"]["allow_summary_rewrite"] = True
    proposed = "Senior backend engineer who owns Python latency."
    payload = _payload(
        bullets=["Reduced API latency 35% by replacing synchronous calls."],
        summary=proposed,
    )

    shipped_summary = _assembled_summary_line(profile, payload)
    assert shipped_summary == proposed

    rows = _build(profile, payload, _analysis())
    executive = next(row for row in rows if row.section == "executive_profile")
    assert executive.generated_text == shipped_summary


def _assembled_section_line(profile: dict, payload: dict, *, prefix: str) -> str:
    """Return the first assembled line beginning with ``prefix`` (e.g. ``"- "``)."""
    text = ResumeAssembler().assemble_resume_text(payload, profile)
    line = next(line for line in text.splitlines() if line.startswith(prefix))
    return line.removeprefix(prefix).strip()


def test_provenance_generated_text_is_byte_identical_to_sanitized_shipped_line() -> None:
    """Regression (Finding 3 / Pattern 2 / GROUND-06): the assembler runs
    ``sanitize_text`` on every rendered line — rewriting curly quotes and smart
    punctuation to ASCII — but the provenance builder previously normalised only
    whitespace, so a bullet with a curly apostrophe shipped as ``team's`` while its
    provenance ``generated_text`` kept the curly ``team’s``. The coverage anchor (and
    the deterministic detector that scans it) then saw text the user never received.
    Provenance ``generated_text`` MUST now byte-match the assembled shipped line."""
    profile = _profile()
    profile["resume"]["tailoring_rules"]["tailoring_policy"]["allow_summary_rewrite"] = True
    # Curly apostrophe + curly double quotes in the summary; curly apostrophe +
    # em dash in the bullet; curly apostrophe in a skill item.
    curly_summary = "Senior engineer who led the company’s “core” platform."
    curly_bullet = "Owned the team’s API roadmap — reduced API latency 35%."
    payload = _payload(bullets=[curly_bullet], summary=curly_summary)
    payload["skill_category_updates"] = [{"id": "languages", "items": ["C’s", "Python"]}]

    rows = _build(profile, payload, _analysis())

    summary_row = next(r for r in rows if r.section == "executive_profile")
    assert summary_row.generated_text == _assembled_summary_line(profile, payload)
    # The smart punctuation was rewritten exactly as the assembler ships it.
    assert summary_row.generated_text == 'Senior engineer who led the company\'s "core" platform.'

    experience_row = next(r for r in rows if r.section == "experience")
    assert experience_row.generated_text == _assembled_section_line(profile, payload, prefix="- ")
    assert experience_row.generated_text == "Owned the team's API roadmap, reduced API latency 35%."

    # Skills: the provenance row holds the whole "Label: items" line; compare to the
    # full assembled SKILLS line (no prefix stripped).
    assembled = ResumeAssembler().assemble_resume_text(payload, profile).splitlines()
    shipped_skills = next(line for line in assembled if line.startswith("Languages:"))
    skills_row = next(r for r in rows if r.section == "skills")
    assert skills_row.generated_text == shipped_skills
    assert skills_row.generated_text == "Languages: C's, Python"

    # And no smart punctuation survives into ANY provenance row (the detector now
    # scans the sanitised shipped text, never the model's pre-sanitised draft).
    import re as _re

    assert all(not _re.search(r"[‘’“”—–]", r.generated_text) for r in rows)


def _assembled_experience_bullets(profile: dict, payload: dict) -> list[str]:
    """Every assembled experience bullet the resume ships, in order."""
    text = ResumeAssembler().assemble_resume_text(payload, profile)
    return [line.removeprefix("- ") for line in text.splitlines() if line.startswith("- ")]


def test_provenance_caps_covered_bullets_to_match_shipped_resume() -> None:
    """GROUND-06 byte identity holds after the per-role hard ceiling is applied."""
    profile = _profile()  # max_experience_bullets == 4
    bullets = [
        "Reduced API latency 35% by replacing synchronous calls.",
        "Led the migration to an event driven ingestion pipeline.",
        "Owned the on call rotation and cut incident volume.",
        "Mentored four engineers through promotion.",
        "Rebuilt the analytics warehouse for faster reporting.",
        "Shipped the customer facing status page.",
    ]
    payload = _payload(bullets=bullets)
    payload["generated_claim_mappings"] = [
        {
            "claim_id": f"claim-{index}",
            "location": f"experience.acme_swe.bullets[{index}]",
            "text": bullet,
            "coverage_edge_ids": ["edge_req_latency_ev_latency_direct"],
            "requirement_ids": ["req_latency"],
            "evidence_ids": ["ev_latency"],
            "review_required": False,
        }
        for index, bullet in enumerate(bullets)
    ]

    rows = _build(profile, payload, _analysis())
    experience_texts = [row.generated_text for row in rows if row.section == "experience"]

    assert experience_texts == _assembled_experience_bullets(profile, payload)
    assert experience_texts == bullets[:4]


# --------------------------------------------------------------------------
# Shipped-entry parity: provenance + coverage audit ONLY the experience
# entries the resume ships (strict subset of required_experience_entry_ids).
# --------------------------------------------------------------------------


def _profile_with_omitted_entry(*, required_experience_entry_ids: list[str] | None) -> dict:
    """A two-entry profile: ``acme_swe`` plus an ``omitted_co`` entry whose only
    keyword is "Kubernetes". ``required_experience_entry_ids`` pins the shipped
    subset; ``None`` leaves it unpinned (the default-all path)."""
    profile = _profile()
    profile["resume"]["experience_entries"].append(
        {
            "id": "omitted_co",
            "date_range": "2016-2020",
            "title": "Platform Engineer",
            "company": "Omitted Co",
            "location": "Remote",
            "bullets": ["Operated the Kubernetes platform across production clusters."],
            "achievement_evidence": [
                {
                    "id": "ev_kube",
                    "source_text": "Operated the Kubernetes platform across production clusters.",
                    "scope": "owned platform",
                    "action": "operated the kubernetes platform",
                    "tools": ["Kubernetes"],
                    "metrics": [],
                    "outcome": "reliable platform",
                    "evidence_strength": "verified",
                    "claim_confidence": 0.9,
                    "user_confirmed": True,
                    "tags": ["kubernetes", "platform"],
                }
            ],
        }
    )
    rules = profile["resume"]["tailoring_rules"]
    if required_experience_entry_ids is None:
        rules.pop("required_experience_entry_ids", None)
    else:
        rules["required_experience_entry_ids"] = list(required_experience_entry_ids)
    return profile


def _analysis_with_platform_requirement() -> EmployerAnalysis:
    """The base analysis plus a Kubernetes requirement/keyword, so the omitted
    entry's bullet is a GROUNDED provenance row (it serves ``req_platform``)."""
    return _analysis(
        requirements=[
            Requirement(
                id="req_python",
                text="5+ years of Python",
                tier="must_have",
                weight=0.9,
                evidence_span="5+ years of Python",
            ),
            Requirement(
                id="req_latency",
                text="improve API latency",
                tier="nice_to_have",
                weight=0.5,
                evidence_span="improve API latency",
            ),
            Requirement(
                id="req_platform",
                text="operate Kubernetes platform",
                tier="must_have",
                weight=0.8,
                evidence_span="operate Kubernetes platform",
            ),
        ],
        keywords=[
            ReasonedKeyword(keyword="Python", evidence_span="5+ years of Python", requirement_ref="req_python"),
            ReasonedKeyword(keyword="latency", evidence_span="improve API latency", requirement_ref="req_latency"),
            ReasonedKeyword(
                keyword="Kubernetes",
                evidence_span="operate Kubernetes platform",
                requirement_ref="req_platform",
            ),
        ],
    )


def test_strict_subset_provenance_and_coverage_reflect_only_shipped_entries() -> None:
    """Regression (rev-211 A4 / auditability): when ``required_experience_entry_ids``
    pins a STRICT SUBSET, the assembler and both PDF renderers ship only those
    entries. Provenance -- and the coverage computed over it -- must audit ONLY the
    shipped entries. A keyword present solely in an OMITTED entry ("Kubernetes")
    must not appear in any provenance row and must be reported missing, never
    inflated as covered with content the employer never receives."""
    profile = _profile_with_omitted_entry(required_experience_entry_ids=["acme_swe"])
    analysis = _analysis_with_platform_requirement()
    payload = _payload(bullets=["Reduced API latency 35% by replacing synchronous Python calls."])

    rows = _build(profile, payload, analysis)

    experience_source_ids = {row.source_id for row in rows if row.section == "experience"}
    assert experience_source_ids == {"acme_swe"}  # the omitted entry is not audited
    assert not any(row.bullet_id.startswith("experience:omitted_co") for row in rows)
    assert all("kubernetes" not in row.generated_text.lower() for row in rows)

    # The full-profile corpus DOES contain "Kubernetes" (it lives in the omitted
    # entry) -- corpus grounding alone must not credit a keyword the shipped text
    # never renders.
    coverage = compute_keyword_coverage(analysis, rows, build_evidence_corpus(profile))
    assert "kubernetes" in coverage.missing
    assert "kubernetes" not in coverage.covered
    # The shipped entry's real coverage is untouched.
    assert "latency" in coverage.covered
    assert "python" in coverage.covered


def test_default_all_entries_still_audited_when_no_strict_subset_pinned() -> None:
    """The default-all path (no ``required_experience_entry_ids`` pinned) is
    unchanged: every experience entry is audited, so a keyword grounded only in the
    second entry ("Kubernetes") is legitimately covered."""
    profile = _profile_with_omitted_entry(required_experience_entry_ids=None)
    analysis = _analysis_with_platform_requirement()
    payload = _payload(bullets=["Reduced API latency 35% by replacing synchronous Python calls."])

    rows = _build(profile, payload, analysis)

    experience_source_ids = {row.source_id for row in rows if row.section == "experience"}
    assert experience_source_ids == {"acme_swe", "omitted_co"}
    coverage = compute_keyword_coverage(analysis, rows, build_evidence_corpus(profile))
    assert "kubernetes" in coverage.covered
    assert "kubernetes" not in coverage.missing


# --------------------------------------------------------------------------
# Shipped-skill-category parity: provenance + coverage audit ONLY the skill
# categories the resume ships (strict subset of required_skill_category_ids).
# --------------------------------------------------------------------------


def _profile_with_omitted_skill_category(*, required_skill_category_ids: list[str] | None) -> dict:
    """A two-category profile: ``languages`` plus a ``cloud`` category whose only
    analysis keyword is "performance". ``required_skill_category_ids`` pins the
    shipped subset; ``None`` leaves it unpinned (the default-all path)."""
    profile = _profile()
    profile["resume"]["skill_categories"].append(
        {"id": "cloud", "label": "Cloud", "items": ["Performance tuning", "Terraform", "PostgreSQL"]}
    )
    rules = profile["resume"]["tailoring_rules"]
    if required_skill_category_ids is None:
        rules.pop("required_skill_category_ids", None)
    else:
        rules["required_skill_category_ids"] = list(required_skill_category_ids)
    return profile


def _analysis_with_performance_requirement() -> EmployerAnalysis:
    """The base analysis plus a performance requirement/keyword, so the omitted
    category's skills line is a GROUNDED provenance row (its "Performance tuning"
    item serves ``req_perf``) — the exact shape that inflated coverage before the
    fix."""
    return _analysis(
        requirements=[
            Requirement(
                id="req_python",
                text="5+ years of Python",
                tier="must_have",
                weight=0.9,
                evidence_span="5+ years of Python",
            ),
            Requirement(
                id="req_latency",
                text="improve API latency",
                tier="nice_to_have",
                weight=0.5,
                evidence_span="improve API latency",
            ),
            Requirement(
                id="req_perf",
                text="performance tuning",
                tier="must_have",
                weight=0.7,
                evidence_span="performance tuning",
            ),
            Requirement(
                id="req_iac",
                text="Terraform infrastructure-as-code",
                tier="nice_to_have",
                weight=0.4,
                evidence_span="Terraform infrastructure-as-code",
            ),
            Requirement(
                id="req_db",
                text="PostgreSQL operations",
                tier="nice_to_have",
                weight=0.4,
                evidence_span="PostgreSQL operations",
            ),
        ],
        keywords=[
            ReasonedKeyword(keyword="Python", evidence_span="5+ years of Python", requirement_ref="req_python"),
            ReasonedKeyword(keyword="latency", evidence_span="improve API latency", requirement_ref="req_latency"),
            ReasonedKeyword(
                keyword="performance",
                evidence_span="performance tuning",
                requirement_ref="req_perf",
            ),
            ReasonedKeyword(
                keyword="Terraform",
                evidence_span="Terraform infrastructure-as-code",
                requirement_ref="req_iac",
            ),
            ReasonedKeyword(
                keyword="PostgreSQL",
                evidence_span="PostgreSQL operations",
                requirement_ref="req_db",
            ),
        ],
    )


def test_strict_subset_provenance_and_coverage_reflect_only_shipped_skill_categories() -> None:
    """Regression (rev-211 A4b / auditability): when ``required_skill_category_ids``
    pins a STRICT SUBSET, the assembler and both PDF renderers ship only those skill
    categories. Provenance -- and the coverage computed over it -- must audit ONLY
    the shipped categories. A keyword present solely in an OMITTED category's skills
    line ("performance") must not appear in any provenance row and must be reported
    missing, never inflated as covered off a line the employer never receives."""
    profile = _profile_with_omitted_skill_category(required_skill_category_ids=["languages"])
    analysis = _analysis_with_performance_requirement()
    payload = _payload(bullets=["Reduced API latency 35% by replacing synchronous Python calls."])

    rows = _build(profile, payload, analysis)

    skill_source_ids = {row.source_id for row in rows if row.section == "skills"}
    assert skill_source_ids == {"languages"}  # the omitted category is not audited
    assert not any(row.bullet_id.startswith("skills:cloud") for row in rows)
    assert all("performance" not in row.generated_text.lower() for row in rows)

    coverage = compute_keyword_coverage(analysis, rows, build_evidence_corpus(profile))
    assert "performance" in coverage.missing
    assert "performance" not in coverage.covered
    # Even a corpus-grounded keyword (PostgreSQL lives in evidence tools) stays
    # missing when its only rendered home is the omitted category's line.
    assert "postgresql" in coverage.missing
    assert "terraform" in coverage.missing
    # The shipped category's + experience real coverage is untouched.
    assert "python" in coverage.covered
    assert "latency" in coverage.covered


def test_default_all_skill_categories_still_audited_when_no_strict_subset_pinned() -> None:
    """The default-all path (no ``required_skill_category_ids`` pinned) is unchanged:
    every skill category is audited (rows exist for both), and the second category's
    line can legitimately credit a corpus-grounded keyword (PostgreSQL, backed by
    evidence tools). A keyword declared ONLY as a skills item and demonstrated in no
    evidence (Terraform) reports ``declared`` (A6b): it genuinely ships in the Cloud
    skills line, so reporting it ``missing`` would lie against the artifact, but it is
    NOT ``covered`` because no evidence demonstrates it. "performance" is deliberately
    NOT asserted here: it flips ``declared`` -> ``covered`` once the #218 prose-gate
    stack adds evidence ``tags`` to the corpus, so the test pins only corpus-stable
    keywords (Terraform never appears in any evidence text or ``tags`` field)."""
    profile = _profile_with_omitted_skill_category(required_skill_category_ids=None)
    analysis = _analysis_with_performance_requirement()
    payload = _payload(bullets=["Reduced API latency 35% by replacing synchronous Python calls."])

    rows = _build(profile, payload, analysis)

    skill_source_ids = {row.source_id for row in rows if row.section == "skills"}
    assert skill_source_ids == {"languages", "cloud"}
    coverage = compute_keyword_coverage(analysis, rows, build_evidence_corpus(profile))
    assert "postgresql" in coverage.covered  # corpus-grounded, shipped on the cloud line
    assert coverage.covered_by["postgresql"] == "skills:cloud#0"
    # Declared-only: shipped in the Cloud skills line, never demonstrated in evidence.
    assert "terraform" in coverage.declared
    assert "terraform" not in coverage.missing
    assert "terraform" not in coverage.covered
    assert coverage.declared_by["terraform"] == "skills:cloud#0"
    assert "python" in coverage.covered  # demonstrated: evidence tools + shipped text


# --------------------------------------------------------------------------
# Cross-surface parity: the shipped skill-category subset is IDENTICAL across
# the THREE surfaces that each re-implement the ``required_skill_category_ids``
# filter -- the .txt assembler, the HTML renderer, and the
# provenance builder. This is the skills-axis analogue of the experience-axis
# renderer parity test (PR #220); it additionally binds the provenance surface
# so the audit trail can never claim a skills set the rendered resume did not
# ship. Drift in ANY single surface breaks these tests.
# --------------------------------------------------------------------------


def _txt_skill_labels(profile: dict, payload: dict) -> set[str]:
    """Skill-category labels the plain-text assembler ships (SKILLS is terminal)."""
    lines = ResumeAssembler().assemble_resume_text(payload, profile).splitlines()
    skills_start = lines.index("SKILLS")
    return {line.split(":", 1)[0] for line in lines[skills_start + 1 :] if ":" in line}


def _html_skill_labels(profile: dict, payload: dict) -> set[str]:
    """Skill-category labels the HTML renderer ships (semantic resume document)."""
    return {category["label"] for category in build_resume_document(payload, profile)["skills"]}


def _provenance_skill_labels(profile: dict, payload: dict, analysis: EmployerAnalysis) -> set[str]:
    """Skill-category labels the provenance audit trail claims shipped."""
    rows = _build(profile, payload, analysis)
    return {row.generated_text.split(":", 1)[0] for row in rows if row.section == "skills"}


def test_all_rendered_surfaces_ship_the_same_pinned_skill_category_subset() -> None:
    """Regression (rev-211 A4c / cross-surface auditability): the shipped-skills
    filter (``required_skill_category_ids``) is duplicated across rendered surfaces --
    the .txt assembler, the HTML renderer, and the provenance
    builder. With a STRICT SUBSET pinned, all surfaces MUST ship the identical skill
    categories so the audit trail's coverage claim matches the resume the employer
    receives. Drift in any single surface (e.g. an edited renderer filter) would
    ship a skills section that diverges from what provenance/coverage audits --
    exactly the class of undetected divergence PR #220 closed for the experience
    axis."""
    profile = _profile_with_omitted_skill_category(required_skill_category_ids=["languages"])
    analysis = _analysis_with_performance_requirement()
    payload = _payload(bullets=["Reduced API latency 35% by replacing synchronous Python calls."])

    txt = _txt_skill_labels(profile, payload)
    assert txt == {"Languages"}  # the pinned subset; the "Cloud" category is omitted

    # Every other surface ships EXACTLY the same set as the reviewed .txt.
    assert _html_skill_labels(profile, payload) == txt
    assert _provenance_skill_labels(profile, payload, analysis) == txt

    # The omitted category's label leaks into NONE of the rendered surfaces.
    all_labels = (
        _txt_skill_labels(profile, payload)
        | _html_skill_labels(profile, payload)
        | _provenance_skill_labels(profile, payload, analysis)
    )
    assert "Cloud" not in all_labels


def test_all_rendered_surfaces_ship_every_skill_category_when_unpinned() -> None:
    """The default-all path (no ``required_skill_category_ids`` pinned): all rendered
    surfaces ship EVERY skill category, so none silently drops or adds one and the
    audit trail stays aligned with the rendered resume."""
    profile = _profile_with_omitted_skill_category(required_skill_category_ids=None)
    analysis = _analysis_with_performance_requirement()
    payload = _payload(bullets=["Reduced API latency 35% by replacing synchronous Python calls."])

    txt = _txt_skill_labels(profile, payload)
    assert txt == {"Languages", "Cloud"}

    assert _html_skill_labels(profile, payload) == txt
    assert _provenance_skill_labels(profile, payload, analysis) == txt


def test_matched_keywords_and_requirement_ids_bind_to_analysis() -> None:
    rows = _build(
        _profile(),
        _payload(bullets=["Reduced API latency 35% by replacing synchronous Python calls."]),
        _analysis(),
    )
    experience = next(row for row in rows if row.section == "experience")
    # "latency" + "python" appear in the generated bullet -> their requirements served.
    assert "latency" in experience.matched_keywords
    assert "req_latency" in experience.requirement_ids
    # requirement_ids are real FK ids from the analysis.
    valid_ids = {req.id for req in _analysis().canonical.requirements}
    assert set(experience.requirement_ids).issubset(valid_ids)


def test_quantify_from_evidence_transform_when_metric_introduced() -> None:
    # Source bullet has no metric; tailored bullet surfaces a verified metric.
    profile = _profile()
    profile["resume"]["experience_entries"][0]["bullets"] = ["Replaced synchronous enrichment calls."]
    rows = _build(
        profile,
        _payload(bullets=["Replaced synchronous calls, cutting 35% latency reduction."]),
        _analysis(),
    )
    experience = next(row for row in rows if row.section == "experience")
    assert experience.transform_type is TransformType.QUANTIFY_FROM_EVIDENCE
    assert experience.control is ControlRule.NEVER_FABRICATE_METRICS


def test_control_recorded_per_bullet_reflects_governing_rule() -> None:
    rows = _build(
        _profile(),
        _payload(bullets=["Reduced API latency 35% by replacing synchronous calls."]),
        _analysis(),
    )
    # A rephrase/verbatim of a real fact is governed by the always-allowed rule.
    experience = next(row for row in rows if row.section == "experience")
    assert experience.control is ControlRule.REPHRASE_ALLOWED


# --------------------------------------------------------------------------
# Fabricated FK reject (GROUND-05, success criterion 2)
# --------------------------------------------------------------------------


def test_fabricated_requirement_id_is_rejected_before_any_row_is_built() -> None:
    # A BulletProvenance constructed with a requirement id NOT in the analysis
    # must be rejected by the builder's FK validation. We simulate by validating
    # directly: the builder only ever emits ids it resolved, so we assert the
    # guard rejects an injected fabricated id.
    from jobctrl.domain.materials.provenance_builder import (
        _sources,
        _validated_requirement_ids,
    )

    analysis = _analysis()
    plan = build_tailoring_plan(_profile(), _job(), employer_analysis=analysis)
    sources = _sources(plan, analysis)
    with pytest.raises(ProvenanceBindingError) as excinfo:
        _validated_requirement_ids(("req_python", "req_FABRICATED"), sources)
    assert "req_FABRICATED" in str(excinfo.value)
    assert excinfo.value.kind == "requirement"


def test_fabricated_evidence_id_is_rejected() -> None:
    from jobctrl.domain.materials.provenance_builder import (
        _sources,
        _validated_evidence_ids,
    )

    analysis = _analysis()
    plan = build_tailoring_plan(_profile(), _job(), employer_analysis=analysis)
    sources = _sources(plan, analysis)
    with pytest.raises(ProvenanceBindingError) as excinfo:
        _validated_evidence_ids(("ev_latency", "ev_FAKE"), sources)
    assert "ev_FAKE" in str(excinfo.value)
    assert excinfo.value.kind == "evidence"


# --------------------------------------------------------------------------
# Deterministic never-fabricate detector (CONTROL-03 / success criterion 4)
# --------------------------------------------------------------------------


def test_detector_passes_when_every_numeric_traces_to_evidence() -> None:
    profile = _profile()
    corpus = build_evidence_corpus(profile)
    # "35%" is recorded in the profile evidence -> grounded.
    findings = find_fabricated_tokens(
        "experience:acme_swe#0",
        "Reduced API latency 35% by replacing synchronous calls.",
        corpus,
        employers=employer_name_set(profile),
    )
    assert findings == []


def test_detector_grounds_profile_summary_and_experience_metadata_numbers() -> None:
    profile = _profile()
    profile["experience"] = {
        "years_of_experience_total": "12",
        "current_job_title": "Director of Engineering",
        "current_company": "Acme Corp",
    }
    profile["resume"]["executive_profile"] = {"baseline_text": "Engineering Director with 12+ years of experience."}
    corpus = build_evidence_corpus(profile)
    findings = find_fabricated_tokens(
        "executive_profile#0",
        "Engineering Director with 12+ years of experience.",
        corpus,
        employers=employer_name_set(profile),
    )
    assert [f for f in findings if f.kind == "numeric"] == []


def test_detector_flags_invented_metric() -> None:
    profile = _profile()
    corpus = build_evidence_corpus(profile)
    # "10x" and "$2M" appear nowhere in the profile evidence -> fabricated.
    findings = find_fabricated_tokens(
        "experience:acme_swe#0",
        "Drove a 10x throughput gain and $2M in savings.",
        corpus,
        employers=employer_name_set(profile),
    )
    kinds = {f.kind for f in findings}
    assert "numeric" in kinds
    assert all(f.control is ControlRule.NEVER_FABRICATE_METRICS for f in findings if f.kind == "numeric")


def test_detector_flags_digit_colliding_fabrication_with_different_unit() -> None:
    """Regression (Pitfall 3 / criterion 4): a fabricated number that merely shares
    a digit run with an unrelated profile number — but has a different unit or
    magnitude — must be flagged. The profile's only number is ``35%``; a bullet
    claiming ``$35M`` or ``35 million`` reuses the digits ``35`` yet states a
    different KIND/magnitude, so digit-run membership would wrongly ground it."""
    profile = _profile()  # only number anywhere is "35% latency reduction"
    corpus = build_evidence_corpus(profile)
    employers = employer_name_set(profile)

    # Currency fabrication: $35M is money, the profile's 35 is a percentage.
    money = find_fabricated_tokens(
        "experience:acme_swe#0",
        "Drove $35M in revenue.",
        corpus,
        employers=employers,
    )
    assert any(f.kind == "numeric" and "$35" in f.token.lower() for f in money), money

    # Magnitude fabrication: "35 million" is a bare magnitude, not 35%.
    magnitude = find_fabricated_tokens(
        "experience:acme_swe#0",
        "Scaled to 35 million users.",
        corpus,
        employers=employers,
    )
    assert any(f.kind == "numeric" for f in magnitude), magnitude

    # Control: the real, same-kind number (35%) still grounds cleanly.
    clean = find_fabricated_tokens(
        "experience:acme_swe#0",
        "Reduced API latency 35% by replacing synchronous calls.",
        corpus,
        employers=employers,
    )
    assert [f for f in clean if f.kind == "numeric"] == []


def test_detector_grounds_equivalent_money_renderings() -> None:
    """The tightened numeric key must NOT over-flag: equivalent renderings of the
    same recorded quantity (``$1.2M`` / ``$1.2 million`` / ``$1,200,000``) collapse
    to one key, so a bullet rendering differs only in format is still grounded."""
    profile = _profile()
    evidence = profile["resume"]["experience_entries"][0]["achievement_evidence"][0]
    evidence["source_text"] += " Grew the book of business to $1.2M ARR."
    evidence["metrics"].append("$1.2M ARR")
    corpus = build_evidence_corpus(profile)
    for rendering in ("$1.2M", "$1.2 million", "$1,200,000"):
        findings = find_fabricated_tokens(
            "experience:acme_swe#0",
            f"Grew the book of business to {rendering}.",
            corpus,
            employers=employer_name_set(profile),
        )
        assert [f for f in findings if f.kind == "numeric"] == [], (rendering, findings)


@pytest.mark.parametrize(
    ("bullet", "needle"),
    [
        ("Scaled the platform to 10M users.", "10m"),
        ("Cut infra cost by 5K monthly.", "5k"),
        ("Grew the user base to 2B accounts.", "2b"),
        ("Onboarded 100K accounts in a quarter.", "100k"),
        ("Drove 3.5M ARR in new revenue.", "3.5m"),
        ("Scaled to 35 million users.", "35 million"),
    ],
)
def test_detector_flags_suffixed_bare_magnitude_against_numberless_profile(bullet: str, needle: str) -> None:
    """Regression (criterion 4 / CONTROL-03): a bare magnitude with a suffix and NO
    leading ``$`` (``10M`` / ``5K`` / ``2B`` / ``100K`` / ``3.5M`` / ``35 million``)
    is a numeric the model invented. Before the fix the trailing ``\\b`` of the
    bare-number branch failed between the digit and the suffix letter, so these were
    NOT extracted at all and an unsourced metric sailed past the deterministic gate
    against a numberless profile. Each must now be flagged."""
    profile = _numberless_profile()  # the profile carries NO numerics at all
    corpus = build_evidence_corpus(profile)
    findings = find_fabricated_tokens("experience:acme_swe#0", bullet, corpus, employers=employer_name_set(profile))
    numeric = [f for f in findings if f.kind == "numeric"]
    assert numeric, (bullet, findings)
    assert all(f.control is ControlRule.NEVER_FABRICATE_METRICS for f in numeric)
    # The flagged token carries the magnitude suffix (proves the suffix was
    # consumed WITH the digits, not dropped as a bare integer).
    assert any(needle in f.token.lower() for f in numeric), (needle, [f.token for f in numeric])


def test_detector_does_not_eat_kmb_initial_word_after_grounded_money() -> None:
    """Regression (Finding 2): a grounded money figure followed by a word that
    starts with k/m/b (``$1,200,000 budget``) must stay grounded. Before the fix
    the money branch's optional space + single-letter suffix ate the ``b`` of
    ``budget`` into the token, minting a phantom ``money:1.2e15`` and hard-rejecting
    a real figure. The single-letter magnitude suffix is now adjacency-only."""
    profile = _profile()
    evidence = profile["resume"]["experience_entries"][0]["achievement_evidence"][0]
    evidence["source_text"] += " Managed a $1.2M budget and trimmed $5K monthly spend."
    evidence["metrics"].extend(["$1.2M budget", "$5K monthly"])
    corpus = build_evidence_corpus(profile)
    employers = employer_name_set(profile)
    for bullet in (
        "Managed a $1,200,000 budget across three teams.",
        "Owned a $1.2 million budget.",
        "Trimmed a $5K monthly spend.",
    ):
        findings = find_fabricated_tokens("experience:acme_swe#0", bullet, corpus, employers=employers)
        assert [f for f in findings if f.kind == "numeric"] == [], (bullet, findings)


def test_metrics_hungry_job_with_numberless_profile_yields_zero_unsourced_numerics() -> None:
    """Success criterion 4: a metrics-hungry job + a numberless profile must not
    let any unsourced numeric survive into the resume."""
    profile = _numberless_profile()
    analysis = _analysis()
    corpus = build_evidence_corpus(profile)
    employers = employer_name_set(profile)

    # The model (under a metrics-hungry job) tries to inject metrics the profile
    # never stated. The detector must flag every one.
    greedy_payload = _payload(
        bullets=[
            "Improved API responsiveness by removing synchronous calls, cutting latency 40%.",
            "Scaled the platform to 5 million requests per day across 12 services.",
        ],
        summary="Backend engineer who delivered 99.99% uptime.",
    )
    plan = build_tailoring_plan(profile, _job(), employer_analysis=analysis)
    rows = build_bullet_provenance(profile, _job(), greedy_payload, plan, analysis)
    findings = scan_resume_bullets([(row.bullet_id, row.generated_text) for row in rows], corpus, employers=employers)
    fabricated_numerics = [f.token for f in findings if f.kind == "numeric"]
    # Every injected number (40%, 5 million, 12, 99.99%) is unsourced and flagged.
    assert fabricated_numerics, "detector must flag the injected numerics"
    # And NONE of them trace to the (numberless) profile evidence corpus.
    for token in fabricated_numerics:
        assert token.lower() not in corpus.text


def test_detector_flags_fabricated_title_and_employer() -> None:
    profile = _profile()  # real title: Senior SWE; real employer: Acme Corp
    corpus = build_evidence_corpus(profile)
    employers = employer_name_set(profile)
    findings = find_fabricated_tokens(
        "executive_profile#0",
        "Chief Technology Officer at Globex Corporation.",
        corpus,
        employers=employers,
    )
    kinds = {f.kind for f in findings}
    assert "title" in kinds  # "Chief"/"CTO"-class token absent from profile
    assert "employer" in kinds  # "Globex Corporation" is not a real employer


def test_detector_does_not_treat_lead_verb_as_title_fabrication() -> None:
    """Regression: standalone ``lead`` is often a verb in generated prose.

    The deterministic title gate must reject invented role/seniority claims, not
    block ordinary phrases like "lead platform reliability work" when the word is
    not presented as a title.
    """
    profile = _profile()
    corpus = build_evidence_corpus(profile)
    findings = find_fabricated_tokens(
        "executive_profile#0",
        "Hands-on engineer who can lead platform reliability work across teams.",
        corpus,
        employers=employer_name_set(profile),
    )
    assert [f for f in findings if f.kind == "title"] == []


def test_detector_flags_ungrounded_lead_title_phrase() -> None:
    profile = _profile()  # real title: Senior SWE; no Lead Engineer title evidence
    corpus = build_evidence_corpus(profile)
    findings = find_fabricated_tokens(
        "executive_profile#0",
        "Lead Engineer for distributed platform systems.",
        corpus,
        employers=employer_name_set(profile),
    )
    assert any(
        f.kind == "title" and f.token.lower() == "lead engineer" and f.control is ControlRule.NEVER_FABRICATE_TITLES
        for f in findings
    )


def test_detector_allows_grounded_lead_title_phrase() -> None:
    profile = _profile()
    profile["resume"]["experience_entries"][0]["title"] = "Lead Engineer"
    corpus = build_evidence_corpus(profile)
    findings = find_fabricated_tokens(
        "executive_profile#0",
        "Lead Engineer for distributed platform systems.",
        corpus,
        employers=employer_name_set(profile),
    )
    assert [f for f in findings if f.kind == "title"] == []


def test_detector_defers_bare_name_employer_to_judge() -> None:
    """Pins the INTENTIONAL suffix-anchored employer limitation (precision-over-
    recall by design): a suffixed fabricated employer ("Globex Corporation") is
    flagged deterministically, but a bare-name fabricated employer ("at Netflix")
    is deliberately NOT flagged at this layer — it is deferred to the prose-aware
    LLM judge. The structured employer field is code-injected from the master
    resume, so it cannot be fabricated through this path; flagging every bare
    capitalised token would over-flag tools/products ("Python", "Docker")."""
    profile = _profile()  # real employer: Acme Corp
    corpus = build_evidence_corpus(profile)
    employers = employer_name_set(profile)

    # Suffixed fabricated employer: flagged here.
    suffixed = find_fabricated_tokens(
        "experience:acme_swe#0",
        "Led platform work at Globex Corporation.",
        corpus,
        employers=employers,
    )
    assert any(f.kind == "employer" for f in suffixed)

    # Bare-name fabricated employer: deliberately NOT flagged at this layer
    # (covered by the judge). "netflix" is also absent from the title/numeric/date
    # arms, so the whole bullet passes the deterministic detector.
    bare = find_fabricated_tokens(
        "experience:acme_swe#0",
        "Owned the API at Netflix.",
        corpus,
        employers=employers,
    )
    assert [f for f in bare if f.kind == "employer"] == []
    assert bare == []


def test_detector_flags_fabricated_date() -> None:
    profile = _profile()  # profile dates: 2020-Present, 2015
    corpus = build_evidence_corpus(profile)
    findings = find_fabricated_tokens(
        "experience:acme_swe#0",
        "Led the platform rebuild in 1998.",
        corpus,
    )
    assert any(f.kind == "date" and f.control is ControlRule.NEVER_FABRICATE_DATES for f in findings)


# --------------------------------------------------------------------------
# Deterministic prose skill/tool gate (allowlist) — the #1 truthfulness leak
# --------------------------------------------------------------------------


def test_build_skill_vocabulary_includes_skill_categories_and_evidence_tools() -> None:
    # skill_categories items: Python, Go; evidence tools: Python, PostgreSQL.
    vocab = build_skill_vocabulary(_profile())
    assert {"python", "go", "postgresql"} <= vocab
    # A job-target tool the candidate never listed is NOT in the allowlist.
    assert "kubernetes" not in vocab
    assert "terraform" not in vocab


def test_prose_skill_gate_flags_target_tool_absent_from_profile() -> None:
    """A job-target tool woven into an experience bullet OR the executive summary
    that traces to neither the skill vocabulary nor the evidence corpus is a
    fabrication (kind ``skill`` / control ``NEVER_FABRICATE_SKILLS``)."""
    profile = _profile()  # no Kubernetes/Terraform anywhere in the profile
    corpus = build_evidence_corpus(profile)
    findings = scan_prose_skill_fabrications(
        [
            ("executive_profile#0", "Backend owner who standardized on Terraform."),
            ("experience:acme_swe#0", "Automated deployments with Kubernetes."),
        ],
        target_skill_terms=["Python", "latency", "Kubernetes", "Terraform"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    flagged = {f.token for f in findings}
    assert flagged == {"Kubernetes", "Terraform"}
    assert all(f.kind == "skill" for f in findings)
    assert all(f.control is ControlRule.NEVER_FABRICATE_SKILLS for f in findings)
    # The finding names the bullet it came from (summary vs experience).
    assert {f.bullet_id for f in findings} == {"executive_profile#0", "experience:acme_swe#0"}


def test_prose_skill_gate_allows_profile_backed_tool() -> None:
    """A tool that IS in the profile allowlist is never a false reject, even though
    it is also a job-target keyword (success criterion 2 + 4)."""
    profile = _profile()  # skills include Python
    corpus = build_evidence_corpus(profile)
    findings = scan_prose_skill_fabrications(
        [("experience:acme_swe#0", "Built resilient services in Python.")],
        target_skill_terms=["Python", "Kubernetes"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert findings == []  # Python grounded; Kubernetes never appears in the prose


def test_prose_skill_gate_grounds_concept_keyword_present_in_evidence_corpus() -> None:
    """Near-zero false positives: a concept keyword the candidate demonstrably
    wrote about (``latency`` in a bullet + on the evidence tags) must NOT be
    flagged. It is both folded into the vocabulary (achievement-evidence tags are
    the bullet's FK) AND a concept keyword the gate never scopes in — only named
    tools absent from every profile source are interview-fatal fabrications."""
    profile = _profile()  # evidence bullet + tags mention "latency"
    # Achievement-evidence tags are folded into the vocabulary (the bullet's FK).
    assert "latency" in build_skill_vocabulary(profile)
    corpus = build_evidence_corpus(profile)
    findings = scan_prose_skill_fabrications(
        [("experience:acme_swe#0", "Reduced API latency further under load.")],
        target_skill_terms=["latency", "api"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert findings == []


def test_prose_skill_gate_never_flags_ordinary_english_words() -> None:
    """Only recognised target skill/tool keywords are candidates, so ordinary
    English prose is never flagged even when it is dense with common words."""
    profile = _profile()
    corpus = build_evidence_corpus(profile)
    findings = scan_prose_skill_fabrications(
        [
            (
                "executive_profile#0",
                "Pragmatic engineer who ships reliable, well-tested software with clear goals.",
            )
        ],
        target_skill_terms=["Kubernetes", "Terraform", "Snowflake"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert findings == []


def test_prose_skill_gate_matches_on_word_boundaries_not_substrings() -> None:
    """Mirrors the grounding gate's boundary approach: a fabricated ``Java`` fires as
    a standalone word but never inside ``JavaScript`` (the ``go`` in ``goals`` case)."""
    profile = _profile()  # Java is absent from the profile -> a fabrication candidate
    corpus = build_evidence_corpus(profile)
    substring_only = scan_prose_skill_fabrications(
        [("experience:acme_swe#0", "Built JavaScript tooling for the frontend.")],
        target_skill_terms=["Java"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert substring_only == []  # "java" must NOT match inside "javascript"

    standalone = scan_prose_skill_fabrications(
        [("experience:acme_swe#0", "Shipped Java services for the platform.")],
        target_skill_terms=["Java"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert [f.token for f in standalone] == ["Java"]


def test_prose_skill_gate_skips_one_and_two_char_targets() -> None:
    """Single/two-character targets (``go`` / ``r`` / ``ai``) are too ambiguous to
    flag deterministically, mirroring the skills-section watchlist length guard."""
    profile = _profile()
    corpus = build_evidence_corpus(profile)
    findings = scan_prose_skill_fabrications(
        [("experience:acme_swe#0", "Go to market motions with AI and R analysis.")],
        target_skill_terms=["Go", "AI", "R"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert findings == []


def test_build_skill_vocabulary_includes_evidence_tags() -> None:
    """Achievement-evidence ``tags`` are the bullet's FK data, so they are folded
    into the trusted vocabulary alongside skill-category items and evidence tools."""
    vocab = build_skill_vocabulary(_profile())
    # _profile() evidence tags: latency, backend, performance.
    assert {"latency", "backend", "performance"} <= vocab


def _reviewer_scenario_profile() -> dict:
    """The reviewer's exact false-positive fixture (PR #218 discussion_r3509803795).

    The candidate demonstrably built "reliable, scalable services" and
    re-architected a monolith into "independent services"; the JD screens on the
    concept keywords scalability / reliability / observability / microservices in
    a different WORD FORM than the evidence uses.
    """
    return {
        "personal": {"full_name": "Dana Ops", "email": "dana@example.com"},
        "resume_constraints": {"real_metrics": []},
        "resume": {
            "executive_profile": {"baseline_text": "Backend engineer who ships reliable, scalable services."},
            "experience_entries": [
                {
                    "id": "acme_swe",
                    "date_range": "2020-Present",
                    "title": "Senior SWE",
                    "company": "Acme Corp",
                    "location": "Remote",
                    "bullets": ["Scaled the platform to serve a large user base."],
                    "achievement_evidence": [
                        {
                            "id": "ev_arch",
                            "source_text": "Re-architected the monolith into independent services.",
                            "scope": "owned platform",
                            "action": "re-architected the monolith",
                            "tools": ["Python"],
                            "outcome": "more resilient platform",
                            "tags": ["backend"],
                        }
                    ],
                }
            ],
            "education_entries": [],
            "skill_categories": [{"id": "languages", "label": "Languages", "items": ["Python"]}],
            "tailoring_rules": {
                "required_experience_entry_ids": ["acme_swe"],
                "required_skill_category_ids": ["languages"],
                "max_experience_bullets": 4,
            },
        },
    }


def test_prose_skill_gate_passes_reviewer_concept_word_form_scenario() -> None:
    """Regression (PR #218 discussion_r3509803795): a legitimate resume that weaves
    the JD's CONCEPT keywords into grounded prose — in a different WORD FORM than the
    profile evidence — must NOT be hard-rejected. ``scalability``/``reliability``
    ground by word form (``scalable``/``reliable`` are in the evidence);
    ``observability``/``microservices`` are pure concepts the gate never scopes in.
    Before the fix all three of scalability/observability/microservices were flagged
    and the whole resume was terminally rejected."""
    profile = _reviewer_scenario_profile()
    corpus = build_evidence_corpus(profile)
    findings = scan_prose_skill_fabrications(
        [
            ("executive_profile#0", "Backend owner focused on scalability and reliability."),
            ("experience:acme_swe#0", "Improved observability and moved to microservices."),
        ],
        target_skill_terms=["scalability", "reliability", "observability", "microservices"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert findings == []


def test_corpus_grounds_word_form_variant_but_not_distinct_tools() -> None:
    """Word-form-tolerant grounding: a stem variant present in the evidence grounds
    the JD keyword (``scalable`` grounds ``scalability``), but a distinct named tool
    with no stem variant anywhere in the profile stays ungrounded — so a fabricated
    ``Kubernetes`` is still caught and ``Java`` never grounds against ``JavaScript``."""
    profile = _reviewer_scenario_profile()
    profile["resume"]["executive_profile"]["baseline_text"] = (
        "Built JavaScript tooling for reliable, scalable services."
    )
    corpus = build_evidence_corpus(profile)
    # Same-root word forms mutually ground.
    assert corpus.contains_term_variant("scalability")
    assert corpus.contains_term_variant("reliability")
    # Distinct proper-noun tools are never collapsed into one another / conjured.
    assert not corpus.contains_term_variant("java")  # must not match inside "javascript"
    assert not corpus.contains_term_variant("kubernetes")


def test_prose_skill_gate_scopes_out_concepts_absent_from_corpus() -> None:
    """Scoping: a concept/qualification keyword that appears NOWHERE in the profile
    is still never flagged, because it is not a named technology — only invented
    named tools are interview-fatal fabrications. This is the arm word-form
    tolerance alone cannot cover (there is no variant to ground against)."""
    profile = _profile()  # no observability / resilience / microservices anywhere
    corpus = build_evidence_corpus(profile)
    findings = scan_prose_skill_fabrications(
        [("experience:acme_swe#0", "Drove observability, resilience, and microservices.")],
        target_skill_terms=["observability", "resilience", "microservices"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert findings == []


def test_prose_skill_gate_flags_homograph_tool_fabricated_from_verb() -> None:
    """Regression (PR #218 r3509984743): a lexicon tool whose name is a homograph of
    a common verb (React/Spark) must NOT ground on the mere verb form. The candidate
    only 'reacted'/'sparked' — they never used React or Spark — so weaving those
    tools into prose is a fabrication and must be flagged. Word-form grounding would
    otherwise collapse react<->reacted and spark<->sparked."""
    profile = _reviewer_scenario_profile()
    profile["resume"]["executive_profile"]["baseline_text"] = "Reacted quickly to incidents."
    profile["resume"]["experience_entries"][0]["achievement_evidence"][0]["source_text"] = (
        "Sparked a 20% increase in adoption."
    )
    corpus = build_evidence_corpus(profile)
    findings = scan_prose_skill_fabrications(
        [("experience:acme_swe#0", "Built React apps on Spark clusters.")],
        target_skill_terms=["react", "spark"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert {f.token for f in findings} == {"react", "spark"}
    assert all(f.control is ControlRule.NEVER_FABRICATE_SKILLS for f in findings)


def test_prose_skill_gate_grounds_homograph_tool_on_literal_token() -> None:
    """The complement: a legitimate React/Spark user who wrote the literal tool name
    (declared `ReactJS`/`Spark`, or wrote `react` in prose) still grounds and is NOT
    flagged. Homograph exact-grounding accepts the tool's own spellings — only the
    verb form is rejected."""
    profile = _reviewer_scenario_profile()
    profile["resume"]["skill_categories"][0]["items"] = ["Python", "ReactJS", "Spark"]
    profile["resume"]["experience_entries"][0]["bullets"] = ["Shipped React features on Spark."]
    corpus = build_evidence_corpus(profile)
    findings = scan_prose_skill_fabrications(
        [("experience:acme_swe#0", "Built React apps on Spark clusters.")],
        target_skill_terms=["react", "spark"],
        allowed_skill_terms=build_skill_vocabulary(profile),
        corpus=corpus,
    )
    assert findings == []


# --------------------------------------------------------------------------
# Skills-row grounding against declared skill items (A6c) — the whole-resume
# corpus excludes skill categories, so declared version numerics need their own
# grounding source or they hard-reject the whole resume.
# --------------------------------------------------------------------------


def _profile_with_versioned_skills() -> dict:
    profile = _profile()
    profile["resume"]["skill_categories"] = [
        {"id": "languages", "label": "Languages", "items": ["Python", "Java 17"]},
        {"id": "protocols", "label": "Protocols", "items": ["OAuth 2.0"]},
    ]
    return profile


def test_skill_evidence_corpus_grounds_declared_version_numerics() -> None:
    """A declared skill's version numeric ("Java 17", "OAuth 2.0") is grounded by the
    skills-only corpus, while the whole-resume corpus still EXCLUDES it (so a skills
    number can never cross-ground an experience metric)."""
    profile = _profile_with_versioned_skills()
    skill_corpus = build_skill_evidence_corpus(profile)
    assert skill_corpus.has_numeric("17")
    assert skill_corpus.has_numeric("2.0")
    # The exclusion invariant of the whole-resume corpus is preserved.
    whole_resume = build_evidence_corpus(profile)
    assert not whole_resume.has_numeric("17")
    assert not whole_resume.has_numeric("2.0")


def test_skills_row_scan_grounds_declared_versioned_items() -> None:
    """The regression: scanning a skills line that renders DECLARED versioned items
    against the skills-only corpus produces NO findings. Before the fix these rows
    were scanned against the whole-resume corpus (which excludes skills), so "17" and
    "2.0" were flagged and the whole resume was hard-rejected."""
    profile = _profile_with_versioned_skills()
    skill_corpus = build_skill_evidence_corpus(profile)
    findings = scan_resume_bullets(
        [
            ("skills:languages#0", "Languages: Python, Java 17"),
            ("skills:protocols#0", "Protocols: OAuth 2.0"),
        ],
        skill_corpus,
    )
    assert findings == []


def test_skills_row_scan_flags_numeric_absent_from_declared_items() -> None:
    """Grounding still catches a genuinely fabricated skills numeric: a version the
    candidate never declared ("Java 25" vs a declared "Java 17") traces to no declared
    item, so it is flagged even though the row is a skills line."""
    profile = _profile_with_versioned_skills()
    skill_corpus = build_skill_evidence_corpus(profile)
    findings = scan_resume_bullets(
        [("skills:languages#0", "Languages: Python, Java 25")],
        skill_corpus,
    )
    assert [f.token for f in findings] == ["25"]
    assert findings[0].kind == "numeric"


# --------------------------------------------------------------------------
# Persistence: generation-versioning + supersede-not-destroy (criterion 5)
# --------------------------------------------------------------------------


@pytest.fixture()
def conn(tmp_path) -> Iterator[sqlite3.Connection]:
    """A real tmp-file DB with the canonical schema (avoids the shared
    ``:memory:`` singleton that ``get_connection`` returns)."""
    connection = init_db(tmp_path / "jobs.db")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(PERSISTED_JOB_ID),
            JOB_URL,
            "Senior Backend Engineer",
            "example",
        ),
    )
    connection.commit()
    yield connection
    close_connection()


def _seed_materials_generation(connection: sqlite3.Connection, generation: int, *, ts: str) -> None:
    """Insert the ``job_materials`` FK parent row for a generation."""
    connection.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'complete', ?, ?)
        """,
        (str(LOCAL_TENANT), str(PERSISTED_JOB_ID), generation, ts, ts),
    )
    connection.commit()


def _provenance_set(
    generation: int,
    *,
    artifact_id: str,
    text: str,
    tenant_id: TenantId = LOCAL_TENANT,
) -> BulletProvenanceSet:
    return BulletProvenanceSet(
        tenant_id=tenant_id,
        job_id=PERSISTED_JOB_ID,
        generation=generation,
        artifact_id=artifact_id,
        bullets=(
            BulletProvenance(
                bullet_id="experience:acme_swe#0",
                section="experience",
                source_id="acme_swe",
                evidence_ids=("ev_latency",),
                requirement_ids=("req_latency",),
                matched_keywords=("latency",),
                transform_type=TransformType.REPHRASE,
                control=ControlRule.REPHRASE_ALLOWED,
                rationale="reworded a real profile bullet",
                generated_text=text,
            ),
        ),
    )


def test_repository_round_trip_preserves_canonical_fields(conn: sqlite3.Connection) -> None:
    _seed_materials_generation(conn, 1, ts="2026-06-08T12:00:00Z")
    repo = SqliteBulletProvenanceRepository(conn)
    repo.save(_provenance_set(1, artifact_id="art-1", text="Reduced API latency 35%."))

    loaded = repo.load(LOCAL_TENANT, PERSISTED_JOB_ID)
    assert loaded is not None
    assert loaded.generation == 1
    assert loaded.artifact_id == "art-1"
    assert loaded.bullets[0].transform_type is TransformType.REPHRASE
    assert loaded.bullets[0].requirement_ids == ("req_latency",)
    assert loaded.to_read_model()[0]["matched_keywords"] == ["latency"]


def test_failed_retailor_never_destroys_last_accepted_generation(conn: sqlite3.Connection) -> None:
    _seed_materials_generation(conn, 1, ts="2026-06-08T12:00:00Z")
    _seed_materials_generation(conn, 2, ts="2026-06-08T13:00:00Z")
    repo = SqliteBulletProvenanceRepository(conn)
    repo.save(_provenance_set(1, artifact_id="art-gen1", text="Gen 1 bullet."))
    repo.save(_provenance_set(2, artifact_id="art-gen2", text="Gen 2 bullet."))

    # The latest generation is served by default...
    latest = repo.load(LOCAL_TENANT, PERSISTED_JOB_ID)
    assert latest is not None and latest.generation == 2 and latest.artifact_id == "art-gen2"
    # ...and generation 1's provenance is retained as audit history (not destroyed).
    historical = repo.load(LOCAL_TENANT, PERSISTED_JOB_ID, generation=1)
    assert historical is not None
    assert historical.bullets[0].generated_text == "Gen 1 bullet."


def test_same_generation_save_replaces_only_that_generation(
    conn: sqlite3.Connection,
) -> None:
    _seed_materials_generation(conn, 1, ts="2026-06-08T12:00:00Z")
    repo = SqliteBulletProvenanceRepository(conn)
    repo.save(
        _provenance_set(
            1,
            artifact_id="art-prior",
            text="Prior bullet.",
        )
    )

    repo.save(
        _provenance_set(
            1,
            artifact_id="art-replacement",
            text="Replacement bullet.",
        )
    )

    loaded = repo.load(LOCAL_TENANT, PERSISTED_JOB_ID)
    assert loaded is not None
    assert loaded.artifact_id == "art-replacement"
    assert tuple(bullet.generated_text for bullet in loaded.bullets) == ("Replacement bullet.",)
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_bullet_provenance WHERE tenant_id = ? AND job_id = ? AND generation = 1",
            (str(LOCAL_TENANT), str(PERSISTED_JOB_ID)),
        ).fetchone()[0]
        == 1
    )


def test_same_job_id_and_generation_are_isolated_by_tenant(
    conn: sqlite3.Connection,
) -> None:
    _seed_materials_generation(conn, 1, ts="2026-06-08T12:00:00Z")
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            str(OTHER_TENANT),
            str(PERSISTED_JOB_ID),
            JOB_URL,
            "Senior Backend Engineer",
            "example",
        ),
    )
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, 1, 'complete', ?, ?)
        """,
        (
            str(OTHER_TENANT),
            str(PERSISTED_JOB_ID),
            "2026-06-08T12:00:00Z",
            "2026-06-08T12:00:00Z",
        ),
    )
    conn.commit()
    repo = SqliteBulletProvenanceRepository(conn)

    repo.save(
        _provenance_set(
            1,
            artifact_id="art-local",
            text="Local bullet.",
        )
    )
    repo.save(
        _provenance_set(
            1,
            artifact_id="art-other",
            text="Other tenant bullet.",
            tenant_id=OTHER_TENANT,
        )
    )

    local = repo.load(LOCAL_TENANT, PERSISTED_JOB_ID)
    other = repo.load(OTHER_TENANT, PERSISTED_JOB_ID)
    assert local is not None and local.artifact_id == "art-local"
    assert other is not None and other.artifact_id == "art-other"
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_bullet_provenance WHERE job_id = ? AND generation = 1",
            (str(PERSISTED_JOB_ID),),
        ).fetchone()[0]
        == 2
    )


def test_saving_empty_provenance_set_is_a_noop(conn: sqlite3.Connection) -> None:
    _seed_materials_generation(conn, 1, ts="2026-06-08T12:00:00Z")
    repo = SqliteBulletProvenanceRepository(conn)
    empty = BulletProvenanceSet(
        tenant_id=LOCAL_TENANT,
        job_id=PERSISTED_JOB_ID,
        generation=1,
        artifact_id="art-empty",
        bullets=(),
    )
    repo.save(empty)
    assert repo.load(LOCAL_TENANT, PERSISTED_JOB_ID) is None


def test_failed_replacement_preserves_complete_prior_generation(
    conn: sqlite3.Connection,
) -> None:
    _seed_materials_generation(conn, 1, ts="2026-06-08T12:00:00Z")
    repo = SqliteBulletProvenanceRepository(conn)
    prior = _provenance_set(
        1,
        artifact_id="art-prior",
        text="Prior accepted bullet.",
    )
    repo.save(prior)
    invalid = BulletProvenanceSet(
        tenant_id=LOCAL_TENANT,
        job_id=PERSISTED_JOB_ID,
        generation=1,
        artifact_id="art-replacement",
        bullets=(prior.bullets[0], prior.bullets[0]),
    )

    with pytest.raises(sqlite3.IntegrityError):
        repo.save(invalid)

    assert conn.in_transaction is False
    conn.commit()
    preserved = repo.load(LOCAL_TENANT, PERSISTED_JOB_ID)
    assert preserved is not None
    assert preserved.artifact_id == "art-prior"
    assert preserved.bullets == prior.bullets


def test_repository_savepoint_does_not_commit_enclosing_unit_of_work(
    conn: sqlite3.Connection,
) -> None:
    _seed_materials_generation(conn, 1, ts="2026-06-08T12:00:00Z")
    unit_of_work = SqliteUnitOfWork(conn)
    repo = SqliteBulletProvenanceRepository(
        conn,
        unit_of_work=unit_of_work,
    )

    with pytest.raises(RuntimeError, match="rollback outer transaction"):
        with unit_of_work:
            repo.save(
                _provenance_set(
                    1,
                    artifact_id="art-staged",
                    text="Staged bullet.",
                )
            )
            assert conn.in_transaction is True
            raise RuntimeError("rollback outer transaction")

    assert repo.load(LOCAL_TENANT, PERSISTED_JOB_ID) is None


def test_repository_rejects_url_shaped_job_id(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteBulletProvenanceRepository(conn)

    with pytest.raises(ValueError, match="canonical UUID"):
        repo.load(LOCAL_TENANT, JobId(JOB_URL))
    with pytest.raises(ValueError, match="canonical UUID"):
        repo.save(
            BulletProvenanceSet(
                tenant_id=LOCAL_TENANT,
                job_id=JobId(JOB_URL),
                generation=1,
                artifact_id="art-empty",
                bullets=(),
            )
        )


def test_repository_does_not_create_runtime_schema() -> None:
    connection = sqlite3.connect(":memory:")
    try:
        SqliteBulletProvenanceRepository(connection)

        assert (
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_bullet_provenance'"
            ).fetchone()
            is None
        )
    finally:
        connection.close()
