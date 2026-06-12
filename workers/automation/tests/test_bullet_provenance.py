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

from jobhunter.database import close_connection, init_db
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobhunter.domain.materials.fabrication_detector import (
    build_evidence_corpus,
    employer_name_set,
    find_fabricated_tokens,
    scan_resume_bullets,
)
from jobhunter.domain.materials.provenance import BulletProvenance, BulletProvenanceSet
from jobhunter.domain.materials.provenance_builder import (
    ProvenanceBindingError,
    build_bullet_provenance,
)
from jobhunter.domain.materials.quality import build_tailoring_plan
from jobhunter.domain.materials.services import ResumeAssembler
from jobhunter.domain.materials.value_objects import ControlRule, TransformType
from jobhunter.infrastructure.materials.bullet_provenance_repository import (
    SqliteBulletProvenanceRepository,
)
from jobhunter.domain.tenant import LOCAL_TENANT

JOB_URL = "https://example.com/senior-backend"


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
        job_id=JobId(JOB_URL),
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
                            "source_text": (
                                "Reduced API latency 35% by replacing synchronous "
                                "enrichment calls."
                            ),
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
    profile["resume"]["experience_entries"][0]["bullets"] = [
        "Replaced synchronous enrichment calls."
    ]
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
    from jobhunter.domain.materials.provenance_builder import (
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
    from jobhunter.domain.materials.provenance_builder import (
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
    profile["resume"]["executive_profile"] = {
        "baseline_text": "Engineering Director with 12+ years of experience."
    }
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
    profile["resume_constraints"] = {"real_metrics": ["$1.2M ARR"]}
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
def test_detector_flags_suffixed_bare_magnitude_against_numberless_profile(
    bullet: str, needle: str
) -> None:
    """Regression (criterion 4 / CONTROL-03): a bare magnitude with a suffix and NO
    leading ``$`` (``10M`` / ``5K`` / ``2B`` / ``100K`` / ``3.5M`` / ``35 million``)
    is a numeric the model invented. Before the fix the trailing ``\\b`` of the
    bare-number branch failed between the digit and the suffix letter, so these were
    NOT extracted at all and an unsourced metric sailed past the deterministic gate
    against a numberless profile. Each must now be flagged."""
    profile = _numberless_profile()  # the profile carries NO numerics at all
    corpus = build_evidence_corpus(profile)
    findings = find_fabricated_tokens(
        "experience:acme_swe#0", bullet, corpus, employers=employer_name_set(profile)
    )
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
    profile["resume_constraints"] = {"real_metrics": ["$1.2M budget", "$5K monthly"]}
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
    findings = scan_resume_bullets(
        [(row.bullet_id, row.generated_text) for row in rows], corpus, employers=employers
    )
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
        f.kind == "title"
        and f.token.lower() == "lead engineer"
        and f.control is ControlRule.NEVER_FABRICATE_TITLES
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
# Persistence: generation-versioning + supersede-not-destroy (criterion 5)
# --------------------------------------------------------------------------


@pytest.fixture()
def conn(tmp_path) -> Iterator[sqlite3.Connection]:
    """A real tmp-file DB with the canonical schema (avoids the shared
    ``:memory:`` singleton that ``get_connection`` returns)."""
    connection = init_db(tmp_path / "jobs.db")
    connection.execute(
        "INSERT INTO jobs (url, title, site) VALUES (?, ?, ?)",
        (JOB_URL, "Senior Backend Engineer", "example"),
    )
    connection.commit()
    yield connection
    close_connection()


def _seed_materials_generation(connection: sqlite3.Connection, generation: int, *, ts: str) -> None:
    """Insert the ``job_materials`` FK parent row for a generation."""
    connection.execute(
        "INSERT INTO job_materials (job_url, generation, tenant_id, status, created_at, updated_at) "
        "VALUES (?, ?, 'local', 'complete', ?, ?)",
        (JOB_URL, generation, ts, ts),
    )
    connection.commit()


def _provenance_set(generation: int, *, artifact_id: str, text: str) -> BulletProvenanceSet:
    return BulletProvenanceSet(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(JOB_URL),
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

    loaded = repo.load(LOCAL_TENANT, JobId(JOB_URL))
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
    latest = repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert latest is not None and latest.generation == 2 and latest.artifact_id == "art-gen2"
    # ...and generation 1's provenance is retained as audit history (not destroyed).
    historical = repo.load(LOCAL_TENANT, JobId(JOB_URL), generation=1)
    assert historical is not None
    assert historical.bullets[0].generated_text == "Gen 1 bullet."


def test_saving_empty_provenance_set_is_a_noop(conn: sqlite3.Connection) -> None:
    _seed_materials_generation(conn, 1, ts="2026-06-08T12:00:00Z")
    repo = SqliteBulletProvenanceRepository(conn)
    empty = BulletProvenanceSet(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(JOB_URL),
        generation=1,
        artifact_id="art-empty",
        bullets=(),
    )
    repo.save(empty)
    assert repo.load(LOCAL_TENANT, JobId(JOB_URL)) is None
