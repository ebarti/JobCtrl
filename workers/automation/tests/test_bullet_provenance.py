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
from jobctrl.domain.materials.provenance import BulletProvenance, BulletProvenanceSet
from jobctrl.domain.materials.provenance_builder import (
    build_bullet_provenance,
)
from jobctrl.domain.materials.quality import build_tailoring_plan as _build_tailoring_plan
from tests.determination_fakes import job_interpretation
from jobctrl.domain.materials.services import ResumeAssembler
from jobctrl.domain.materials.value_objects import ControlRule, TransformType
from jobctrl.infrastructure.materials.bullet_provenance_repository import (
    SqliteBulletProvenanceRepository,
)
from jobctrl.infrastructure.materials.html_resume_pdf import build_resume_document
from jobctrl.infrastructure.materials.unit_of_work import SqliteUnitOfWork
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.resume_profile import mark_current_artifact_budget

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
    return build_bullet_provenance(profile, payload, plan, analysis)


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
    assert sections == {"personal", "executive_profile", "experience", "education", "skills"}
    # Every transform_type is a member of the closed taxonomy (GROUND-04).
    for row in rows:
        assert isinstance(row.transform_type, TransformType)
        assert isinstance(row.control, ControlRule)
        assert row.generated_text.strip()  # coverage anchor is the rendered text

    experience = next(
        row for row in rows if row.section == "experience" and "#" in row.bullet_id and "#" in row.bullet_id
    )
    # Bullet equals the source profile bullet verbatim -> VERBATIM transform.
    assert experience.transform_type is TransformType.UNRECORDED
    assert experience.source_id == "acme_swe"
    assert experience.bullet_id == "experience:acme_swe#0"


def _assembled_summary_line(profile: dict, payload: dict) -> str:
    """The exact summary line the assembler ships (line after EXECUTIVE PROFILE)."""
    text = ResumeAssembler().assemble_resume_text(payload, profile)
    lines = text.splitlines()
    idx = lines.index("EXECUTIVE PROFILE")
    return lines[idx + 1].strip()


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

    experience_row = next(r for r in rows if r.section == "experience" and "#" in r.bullet_id)
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
            "line_id": f"experience:acme_swe#{index}",
            "reason": "Explicit generator anchor",
            "transform_type": "rephrase",
            "location": f"experience.acme_swe.bullets[{index}]",
            "text": bullet,
            "coverage_edge_ids": ["edge_req_latency_ev_latency_direct"],
            "requirement_ids": ["req_latency"],
            "evidence_ids": ["ev_latency"],
            "review_required": False,
        }
        for index, bullet in enumerate(bullets[:4])
    ]
    payload = mark_current_artifact_budget(payload)

    rows = _build(profile, payload, _analysis())
    experience_texts = [
        row.generated_text
        for row in rows
        if row.section == "experience" and "#" in row.bullet_id and "#" in row.bullet_id
    ]

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


# --------------------------------------------------------------------------
# Fabricated FK reject (GROUND-05, success criterion 2)
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
# Deterministic never-fabricate detector (CONTROL-03 / success criterion 4)
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
# Deterministic prose skill/tool gate (allowlist) — the #1 truthfulness leak
# --------------------------------------------------------------------------


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


def build_tailoring_plan(profile, job, **kwargs):
    kwargs.setdefault("job_interpretation", job_interpretation(kwargs["employer_analysis"].canonical.requirements))
    return _build_tailoring_plan(profile, job, **kwargs)
