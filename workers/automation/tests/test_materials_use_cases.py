"""Phase 6 / S-23 + S-24: Materials use case happy / fail / judge-rejected paths.

Three use cases live under ``jobhunter.domain.materials.use_cases``:

  * :class:`TailorResumeUseCase`        — generate, validate, judge, persist.
  * :class:`GenerateCoverLetterUseCase` — generate, validate, persist.
  * :class:`RenderPdfUseCase`           — render missing PDFs, persist.

These tests exercise every code path with fakes for the ``LlmPort``,
``MaterialsRepository`` and ``PdfRendererPort`` so they run fast and
never touch sqlite or pdflatex.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

import pytest

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials import (
    Artifact,
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    MaterialsSet,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.materials.adversarial import ADVERSARIAL_REVIEW_RESPONSE_SCHEMA
from jobhunter.domain.materials.aggregate import MaterialsLifecycle
from jobhunter.domain.materials.requirement_coverage import COVERAGE_PLANNER_RESPONSE_SCHEMA
from jobhunter.domain.materials.services import ContentValidator, ResumeAssembler
from jobhunter.domain.materials.use_cases import (
    COVER_LETTER_COMPLETION_MARKER,
    GenerateCoverLetterUseCase,
    RenderPdfUseCase,
    TAILORED_RESUME_RESPONSE_SCHEMA,
    TAILORING_JUDGE_RESPONSE_SCHEMA,
    TailoringLlmPolicy,
    TailorResumeUseCase,
)
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.ports.llm import LlmMessage, LlmPort
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.model_defaults import DEFAULT_PIPELINE_LLM_MODEL_SPEC


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _profile_dict() -> dict:
    return {
        "personal": {"full_name": "Jane Doe", "email": "jane@example.com"},
        "resume_constraints": {"real_metrics": ["40%"]},
        "resume": {
            "executive_profile": {"baseline_text": "Senior engineer."},
            "experience_entries": [
                {
                    "id": "acme_swe",
                    "date_range": "2020-Present",
                    "title": "Senior SWE",
                    "company": "Acme Corp",
                    "location": "Remote",
                    "bullets": ["Built distributed systems."],
                }
            ],
            "education_entries": [
                {
                    "id": "edu_state",
                    "degree": "BSc CS",
                    "institution": "State University",
                    "location": "City",
                    "date": "2015",
                }
            ],
            "skill_categories": [
                {"id": "languages", "label": "Languages", "items": ["Python", "Go"]}
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["acme_swe"],
                "required_skill_category_ids": ["languages"],
                "max_experience_bullets": 4,
            },
        },
    }


def _profile_with_evidence_dict() -> dict:
    profile = _profile_dict()
    profile["resume_constraints"] = {"real_metrics": ["35% latency reduction"]}
    profile["resume"]["experience_entries"][0]["achievement_evidence"] = [
        {
            "id": "ev_latency",
            "source_text": "Reduced API latency 35% by replacing synchronous calls.",
            "scope": "owned backend service",
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
    ]
    return profile


def _profile_with_draft_claim_policy_dict() -> dict:
    profile = _profile_with_evidence_dict()
    profile["resume"]["tailoring_rules"]["tailoring_policy"] = {
        "claim_mode": "draft_requires_confirmation",
        "auto_approvable_claim_modes": ["verified_only", "evidence_reframing"],
    }
    return profile


@pytest.fixture()
def snapshot() -> ProfileSnapshot:
    return ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, _profile_dict()))


@pytest.fixture()
def job() -> dict:
    return {
        "url": "https://example.com/job/1",
        "title": "Backend Engineer",
        "site": "Acme",
        "full_description": "Build a Python service.",
        "fit_score": 7,
    }


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _FakeAnalyzeUseCase:
    """Stand-in for ``AnalyzeJobUseCase`` so tailor tests skip the live ensemble.

    Returns a fixed canonical analysis whose keywords cover the terms the tailor
    test jobs use (python / postgresql / api / latency), so ``build_tailoring_plan``
    gets its keywords from the analysis (D-21) without any SDK call.
    """

    def execute(self, *, job: dict, tenant_id=LOCAL_TENANT, force: bool = False):
        from jobhunter.domain.materials.analysis import (
            AnalysisAgreement,
            EmployerAnalysis,
            JobAnalysis,
            ReasonedKeyword,
            compute_snapshot_hash,
        )
        from jobhunter.domain.materials.analyze_use_case import AnalyzeJobOutcome

        canonical = JobAnalysis(
            role_framing="Backend ownership.",
            inferred_seniority="senior",
            ideal_candidate_narrative="A hands-on backend owner.",
            requirements=[],
            keywords=[
                ReasonedKeyword(keyword=term, evidence_span=term)
                for term in ("python", "postgresql", "api", "latency", "backend")
            ],
        )
        analysis = EmployerAnalysis.build(
            tenant_id=tenant_id,
            job_id=JobId(str(job["url"])),
            generation=1,
            snapshot_hash=compute_snapshot_hash(str(job.get("full_description") or "jd")),
            canonical=canonical,
            sub_analyses=(),
            failures=(),
            agreement=AnalysisAgreement(score=1.0),
            legs_attempted=2,
        )
        return AnalyzeJobOutcome(analysis=analysis, cached=False)


class _FakeRepository:
    def __init__(self) -> None:
        self.saved: list[MaterialsSet] = []
        self._by_key: dict[tuple[str, str, int | None], MaterialsSet] = {}

    def load(self, tenant_id, job_id, *, generation=None) -> MaterialsSet | None:
        # Return the most recently saved aggregate for this (tenant, job).
        candidates = [
            m for m in reversed(self.saved)
            if str(m.tenant_id) == str(tenant_id) and str(m.job_id) == str(job_id)
            and (generation is None or m.generation == generation)
        ]
        return candidates[0] if candidates else None

    def load_current_approved(self, tenant_id, job_id) -> MaterialsSet | None:
        candidates = [
            m for m in reversed(self.saved)
            if str(m.tenant_id) == str(tenant_id)
            and str(m.job_id) == str(job_id)
            and m.is_resume_approved
        ]
        return candidates[0] if candidates else None

    def save(self, materials: MaterialsSet) -> None:
        self.saved.append(materials)

    def list_pending_tailor(self, *args, **kwargs):
        return []

    def list_pending_cover(self, *args, **kwargs):
        return []

    def list_pending_pdf(self, *args, **kwargs):
        return []

    def list_by_status(self, *args, **kwargs):
        return []

    def suppress_active_artifacts(self, tenant_id, job_id, *, reason, suppressed_at):
        materials = self.load(tenant_id, job_id)
        if materials is None:
            return None
        suppressed = materials.suppress_active_artifacts(at=suppressed_at, reason=reason)
        self.save(suppressed)
        return suppressed


class _TemplateRepository(_FakeRepository):
    def __init__(self, resume_template: dict) -> None:
        super().__init__()
        self.resume_template = resume_template

    def resolve_effective_resume_template(self, job_id) -> dict:
        return self.resume_template


class _ScriptedLlm:
    """Replays a queue of canned LLM responses so tests stay deterministic."""

    def __init__(self, responses: Iterable[str]) -> None:
        self._responses = list(responses)
        self.calls: list[list[LlmMessage]] = []
        self.kwargs: list[dict] = []

    def chat(self, messages: list[LlmMessage], **kwargs) -> str:
        self.calls.append(messages)
        self.kwargs.append(dict(kwargs))
        if not self._responses:
            raise RuntimeError("no scripted response left")
        return self._responses.pop(0)

    def chat_json(self, messages: list[LlmMessage], **kwargs) -> dict:
        return json.loads(self.chat(messages, **kwargs))

    def ask(self, prompt: str, **kwargs) -> str:
        return self.chat([LlmMessage(role="user", content=prompt)], **kwargs)


class _RecordingPublisher:
    def __init__(self) -> None:
        self.events: list = []

    def publish(self, event) -> None:
        self.events.append(event)


def _good_json_payload() -> str:
    return json.dumps(
        {
            "executive_profile": "Senior engineer focused on systems.",
            "experience_updates": [
                {"id": "acme_swe", "title": "", "bullets": ["Cut latency 40%."]},
            ],
            "skill_category_updates": [
                {"id": "languages", "items": ["Python", "Go"]},
            ],
            "generated_claim_mappings": _positioning_claim_mappings("Cut latency 40%."),
        }
    )


def _unbound_claim_mapping_payload() -> str:
    payload = json.loads(_good_json_payload())
    payload["generated_claim_mappings"] = [
        {
            "claim_id": "claim-unbound",
            "location": "experience.acme_swe.bullets[99]",
            "text": "This text is not in the generated resume.",
            "claim_label": "positioning",
            "coverage_edge_ids": [],
            "requirement_ids": [],
            "evidence_ids": [],
            "non_requirement_reason": "positioning",
            "review_required": False,
        }
    ]
    return json.dumps(payload)


def _review_required_claim_payload() -> str:
    payload = json.loads(_quality_json_payload())
    payload["executive_profile"] = "Draft developer-experience translation requires confirmation."
    bullet = payload["experience_updates"][0]["bullets"][0]
    payload["generated_claim_mappings"] = [
        {
            "claim_id": "claim-draft",
            "location": "executive_profile",
            "text": "Draft developer-experience translation requires confirmation.",
            "claim_label": "draft_requires_confirmation",
            "coverage_edge_ids": [],
            "requirement_ids": [],
            "evidence_ids": [],
            "non_requirement_reason": "positioning",
            "review_required": True,
        },
        *_positioning_claim_mappings(bullet),
    ]
    return json.dumps(payload)


def _positioning_claim_mappings(text: str) -> list[dict[str, Any]]:
    return [
        {
            "claim_id": "claim-positioning-1",
            "location": "experience.acme_swe.bullets[0]",
            "text": text,
            "claim_label": "positioning",
            "coverage_edge_ids": [],
            "requirement_ids": [],
            "evidence_ids": [],
            "non_requirement_reason": "positioning",
            "review_required": False,
        }
    ]


def _keyword_stuffed_json_payload() -> str:
    stuffed = " ".join(["backend"] * 10)
    return json.dumps(
        {
            "executive_profile": f"Senior engineer focused on {stuffed}.",
            "experience_updates": [
                {"id": "acme_swe", "title": "", "bullets": [f"Built {stuffed}."]},
            ],
            "skill_category_updates": [
                {"id": "languages", "items": ["Python", "Go"]},
            ],
            "generated_claim_mappings": _positioning_claim_mappings(f"Built {stuffed}."),
        }
    )


def _quality_json_payload(*, metric: str = "35%") -> str:
    return json.dumps(
        {
            "executive_profile": "Senior backend engineer focused on Python API reliability.",
            "experience_updates": [
                {
                    "id": "acme_swe",
                    "title": "",
                    "bullets": [
                        f"Owned API latency improvements and reduced latency {metric} with Python."
                    ],
                },
            ],
            "skill_category_updates": [
                {"id": "languages", "items": ["Python", "Go"]},
            ],
            "generated_claim_mappings": _positioning_claim_mappings(
                f"Owned API latency improvements and reduced latency {metric} with Python."
            ),
        }
    )


def _stock_phrase_json_payload() -> str:
    return json.dumps(
        {
            "executive_profile": "Senior backend engineer focused on Python API reliability.",
            "experience_updates": [
                {
                    "id": "acme_swe",
                    "title": "",
                    "bullets": [
                        (
                            "Owned results-driven backend initiatives, leveraged "
                            "dynamic professional impactful solutions to drive value "
                            "while reducing API latency 35% with Python."
                        )
                    ],
                },
            ],
            "skill_category_updates": [
                {"id": "languages", "items": ["Python", "Go"]},
            ],
            "generated_claim_mappings": _positioning_claim_mappings(
                "Owned results-driven backend initiatives, leveraged dynamic professional impactful solutions to drive value while reducing API latency 35% with Python."
            ),
        }
    )


def _judge_pass() -> str:
    return json.dumps(
        {
            "verdict": "PASS",
            "score": 0.94,
            "criterion_scores": {
                "relevance_to_job": 0.95,
                "evidence_support": 0.95,
                "fabrication_safety": 1.0,
                "required_content_preserved": 1.0,
                "ats_readability": 0.9,
                "specificity_and_metrics": 0.85,
            },
            "issues": [],
            "unsupported_claims": [],
            "fabrications": [],
            "missing_required_evidence": [],
            "repair_instructions": [],
        }
    )


def _judge_fail() -> str:
    return json.dumps(
        {
            "verdict": "FAIL",
            "score": 0.4,
            "criterion_scores": {
                "relevance_to_job": 0.8,
                "evidence_support": 0.2,
                "fabrication_safety": 0.1,
                "required_content_preserved": 0.9,
                "ats_readability": 0.8,
                "specificity_and_metrics": 0.2,
            },
            "issues": ["invented metric"],
            "unsupported_claims": ["Cut latency 40%"],
            "fabrications": [],
            "missing_required_evidence": [],
            "repair_instructions": ["Remove unsupported metric."],
        }
    )


def _judge_with_score(score: float, verdict: str = "PASS") -> str:
    return json.dumps(
        {
            "verdict": verdict,
            "score": score,
            "criterion_scores": {
                "relevance_to_job": score,
                "evidence_support": score,
                "fabrication_safety": score,
                "required_content_preserved": score,
                "ats_readability": score,
                "specificity_and_metrics": score,
            },
            "issues": [] if verdict == "PASS" else ["quality gate failed"],
            "unsupported_claims": [],
            "fabrications": [],
            "missing_required_evidence": [],
            "repair_instructions": [],
        }
    )


def _adversarial_pass(*, warnings: list[str] | None = None) -> str:
    return json.dumps(
        {
            "verdict": "PASS",
            "score": 0.91,
            "score_rationale": "Overall review passed because no persona reported blockers.",
            "personas": [
                {
                    "persona": "evidence_auditor",
                    "verdict": "PASS",
                    "score": 0.92,
                    "score_rationale": "Profile evidence supports the tailored claims.",
                    "blockers": [],
                    "warnings": warnings or [],
                    "repair_instructions": [],
                }
            ],
            "blockers": [],
            "warnings": warnings or [],
            "repair_instructions": [],
        }
    )


def _adversarial_fail() -> str:
    return json.dumps(
        {
            "verdict": "FAIL",
            "score": 0.31,
            "score_rationale": "Overall review failed because interview defensibility found an unsupported claim.",
            "personas": [
                {
                    "persona": "interview_defensibility_critic",
                    "verdict": "FAIL",
                    "score": 0.25,
                    "score_rationale": "The claim cannot be defended with available profile evidence.",
                    "blockers": ["Claim cannot be defended in interview."],
                    "warnings": [],
                    "repair_instructions": ["Replace the unsupported claim with verified evidence."],
                }
            ],
            "blockers": ["Unsupported high-fit resume claim."],
            "warnings": [],
            "repair_instructions": ["Use only verified evidence from ev_latency."],
        }
    )


# ---------------------------------------------------------------------------
# TailorResumeUseCase
# ---------------------------------------------------------------------------


def _assert_openai_strict_schema(schema: dict[str, Any], path: str = "$") -> None:
    unsupported = {"minLength", "maxLength"}
    assert unsupported.isdisjoint(schema), f"{path} uses unsupported string constraints"

    if "anyOf" in schema:
        for index, child in enumerate(schema["anyOf"]):
            _assert_openai_strict_schema(child, f"{path}.anyOf[{index}]")
        return

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        for child_type in schema_type:
            if child_type != "null":
                child = dict(schema)
                child["type"] = child_type
                _assert_openai_strict_schema(child, path)
        return

    if schema_type == "object":
        properties = schema.get("properties", {})
        assert schema.get("additionalProperties") is False, (
            f"{path} must set additionalProperties to false"
        )
        assert set(schema.get("required", [])) == set(properties), (
            f"{path} must require every property"
        )
        for name, child in properties.items():
            _assert_openai_strict_schema(child, f"{path}.{name}")
    elif schema_type == "array":
        _assert_openai_strict_schema(schema["items"], f"{path}[]")


@pytest.mark.parametrize(
    "schema",
    [
        TAILORED_RESUME_RESPONSE_SCHEMA,
        TAILORING_JUDGE_RESPONSE_SCHEMA,
        COVERAGE_PLANNER_RESPONSE_SCHEMA,
        ADVERSARIAL_REVIEW_RESPONSE_SCHEMA,
    ],
)
def test_tailoring_structured_output_schemas_are_openai_strict_compatible(
    schema: dict[str, Any],
) -> None:
    _assert_openai_strict_schema(schema)


def test_tailoring_policy_defaults_to_pipeline_gemini_flash() -> None:
    policy = TailoringLlmPolicy()

    assert policy.effective_candidate_models == (DEFAULT_PIPELINE_LLM_MODEL_SPEC,)
    assert policy.effective_judge_model == DEFAULT_PIPELINE_LLM_MODEL_SPEC


def test_tailor_use_case_happy_path(tmp_path: Path, snapshot: ProfileSnapshot, job: dict) -> None:
    repo = _FakeRepository()
    llm = _ScriptedLlm([_good_json_payload(), _judge_pass()])
    publisher = _RecordingPublisher()
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        publisher=publisher,
    )
    outcome = use_case.execute(
        job=job,
        profile_snapshot=snapshot,
        tailored_dir=tmp_path,
    )
    assert outcome.status == "approved"
    assert outcome.materials is not None
    assert outcome.materials.is_resume_approved
    assert outcome.materials.status == MaterialsLifecycle.RESUME_APPROVED
    assert outcome.materials.last_verdict is not None
    assert outcome.materials.last_verdict.criterion_scores["fabrication_safety"] == 1.0
    assert outcome.text_path is not None and Path(outcome.text_path).exists()
    assert any(getattr(e, "event_type", "") == "ResumeApproved" for e in publisher.events)


def test_tailor_use_case_injects_quality_plan_and_persists_metadata(
    tmp_path: Path, job: dict
) -> None:
    snapshot = ProfileSnapshot.from_profile(
        Profile.from_dict(LOCAL_TENANT, _profile_with_evidence_dict())
    )
    job = {
        **job,
        "title": "Senior Backend Engineer",
        "skills": ["Python", "PostgreSQL", "API performance"],
        "responsibilities": ["Own backend latency improvements"],
        "full_description": "Own Python services and improve API latency.",
    }
    repo = _FakeRepository()
    llm = _ScriptedLlm([_quality_json_payload(), _judge_pass()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )

    outcome = use_case.execute(job=job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "approved"
    assert "TAILORING QUALITY PLAN" in llm.calls[0][0].content
    assert "WRITING METHOD" in llm.calls[0][0].content
    assert "Tailoring mode" not in llm.calls[0][0].content
    assert "Minor inferred phrasing" not in llm.calls[0][0].content
    assert "pinned must-include achievements" in llm.calls[0][0].content
    assert "result-first CAR/PAR achievements" in llm.calls[0][0].content
    assert "select and order exact existing skill strings" in llm.calls[0][0].content
    assert "ev_latency" in llm.calls[0][0].content
    assert "TAILORING QUALITY PLAN" in llm.calls[1][0].content
    assert "Artifact quality checks" in llm.calls[1][0].content
    assert "Achievement strength" in llm.calls[1][0].content
    assert outcome.materials is not None
    assert outcome.materials.tailored_resume is not None
    metadata = outcome.materials.tailored_resume.metadata
    assert metadata["quality_plan"]["target_seniority"] == "senior"
    assert metadata["quality_plan"]["required_evidence_ids"] == ["ev_latency"]
    assert "target_profile" in metadata["quality_plan"]
    assert "coverage_graph" in metadata["quality_plan"]
    quality_plan_json = json.dumps(metadata["quality_plan"]).lower()
    assert "source_text" not in quality_plan_json
    assert "system_prompt" not in quality_plan_json
    assert "full_description" not in quality_plan_json
    assert metadata["quality_checks"]["passed"] is True
    assert metadata["change_annotations"][0]["section"] == "executive_profile"
    assert metadata["change_annotations"][0]["change_type"] == "summary_reframed"
    assert metadata["change_annotations"][1]["section"] == "experience"
    assert metadata["change_annotations"][1]["source_id"] == "acme_swe"
    assert metadata["change_annotations"][1]["evidence_ids"] == ["ev_latency"]
    assert outcome.report["tailoring_quality"]["quality_checks"]["passed"] is True


def test_tailor_use_case_persists_review_required_draft_claim_as_candidate(
    tmp_path: Path, job: dict
) -> None:
    snapshot = ProfileSnapshot.from_profile(
        Profile.from_dict(LOCAL_TENANT, _profile_with_draft_claim_policy_dict())
    )
    job = {
        **job,
        "title": "Senior Backend Engineer",
        "skills": ["Python", "developer experience"],
        "responsibilities": ["Improve developer experience for backend teams"],
        "full_description": "Improve developer experience for Python backend services.",
    }
    repo = _FakeRepository()
    publisher = _RecordingPublisher()
    llm = _ScriptedLlm([_review_required_claim_payload(), _judge_pass()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        publisher=publisher,
    )

    outcome = use_case.execute(job=job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "review_required"
    assert outcome.materials is not None
    assert not outcome.materials.is_resume_approved
    assert outcome.materials.status == MaterialsLifecycle.RESUME_IN_PROGRESS
    assert outcome.materials.tailored_resume is not None
    assert outcome.materials.tailored_resume.status == ArtifactStatus.CANDIDATE
    assert outcome.materials.last_validation is not None
    assert outcome.materials.last_validation.passed is True
    metadata = outcome.materials.tailored_resume.metadata
    assert metadata["review_required"] is True
    assert metadata["review_blockers"] == ["claim-draft: draft_requires_confirmation"]
    assert metadata["post_generation_fit"]["revision_decision"]["review_blocked"] is True
    assert not any(getattr(e, "event_type", "") == "ResumeApproved" for e in publisher.events)
    assert not any(getattr(e, "event_type", "") == "ResumeFailed" for e in publisher.events)


def test_tailor_use_case_rejects_unbound_generated_claim_mapping(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    llm = _ScriptedLlm([_unbound_claim_mapping_payload()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )

    outcome = use_case.execute(job=job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "failed_validation"
    assert outcome.report["candidate_summaries"][0]["validation"]["passed"] is False
    errors = outcome.report["candidate_summaries"][0]["validation"]["errors"]
    assert any("does not exist in the generated payload" in error for error in errors)


def test_tailor_use_case_labels_stock_phrases_without_retrying(
    tmp_path: Path, job: dict
) -> None:
    snapshot = ProfileSnapshot.from_profile(
        Profile.from_dict(LOCAL_TENANT, _profile_with_evidence_dict())
    )
    senior_job = {
        **job,
        "title": "Senior Backend Engineer",
        "skills": ["Python", "PostgreSQL", "API performance"],
        "responsibilities": ["Own backend latency improvements"],
        "full_description": "Own Python services and improve API latency.",
    }
    repo = _FakeRepository()
    llm = _ScriptedLlm([_stock_phrase_json_payload(), _judge_pass()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        max_retries=2,
    )

    outcome = use_case.execute(job=senior_job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "approved"
    assert len(llm.calls) == 2
    assert outcome.report["review_feedback"] == {
        "warning_retry_attempted": False,
        "accepted_with_residual_warnings": False,
        "accepted_warning_notes": [],
    }
    assert outcome.materials is not None
    assert outcome.materials.tailored_resume is not None
    quality_checks = outcome.materials.tailored_resume.metadata["quality_checks"]
    assert quality_checks["passed"] is True
    assert any("Stock phrase markers" in warning for warning in quality_checks["warnings"])


def test_tailor_use_case_skips_adversarial_review_below_high_fit_threshold(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    llm = _ScriptedLlm([_good_json_payload(), _judge_pass()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )

    outcome = use_case.execute(job=job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "approved"
    assert len(llm.calls) == 2
    assert outcome.materials is not None
    assert outcome.materials.tailored_resume is not None
    review = outcome.materials.tailored_resume.metadata["adversarial_review"]
    assert review["ran"] is False
    assert review["skipped_reason"] == "below_high_fit_threshold"


def test_tailor_use_case_runs_adversarial_review_for_high_fit_jobs(
    tmp_path: Path, job: dict
) -> None:
    snapshot = ProfileSnapshot.from_profile(
        Profile.from_dict(LOCAL_TENANT, _profile_with_evidence_dict())
    )
    high_fit_job = {
        **job,
        "fit_score": 9,
        "title": "Senior Backend Engineer",
        "skills": ["Python", "PostgreSQL", "API performance"],
        "responsibilities": ["Own backend latency improvements"],
        "full_description": "Own Python services and improve API latency.",
    }
    repo = _FakeRepository()
    llm = _ScriptedLlm([_quality_json_payload(), _judge_pass(), _adversarial_pass()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )

    outcome = use_case.execute(job=high_fit_job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "approved"
    assert len(llm.calls) == 3
    assert "adversarial resume review" in llm.calls[2][0].content
    assert outcome.materials is not None
    assert outcome.materials.tailored_resume is not None
    review = outcome.materials.tailored_resume.metadata["adversarial_review"]
    assert review["ran"] is True
    assert review["passed"] is True
    assert review["normalized_fit_score"] == 0.9
    assert review["llm_audit"]["model"]
    assert "adversarial resume review" in review["llm_audit"]["prompt_messages"][0]["content"]
    assert review["personas"][0]["score_rationale"] == "Profile evidence supports the tailored claims."
    assert review["personas"][0]["prompt_rubric"]
    assert review["personas"][0]["response"]["verdict"] == "PASS"


def test_tailor_use_case_retries_adversarial_warnings_before_accepting(
    tmp_path: Path, job: dict
) -> None:
    snapshot = ProfileSnapshot.from_profile(
        Profile.from_dict(LOCAL_TENANT, _profile_with_evidence_dict())
    )
    high_fit_job = {**job, "fit_score": 9, "title": "Senior Backend Engineer"}
    repo = _FakeRepository()
    llm = _ScriptedLlm(
        [
            _quality_json_payload(),
            _judge_pass(),
            _adversarial_pass(warnings=["Bullet could be more concise."]),
            _quality_json_payload(),
            _judge_pass(),
            _adversarial_pass(),
        ]
    )
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        max_retries=1,
    )

    outcome = use_case.execute(job=high_fit_job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "approved"
    assert len(llm.calls) == 6
    assert "Bullet could be more concise." in llm.calls[3][0].content
    assert outcome.report["review_feedback"]["warning_retry_attempted"] is True
    assert outcome.report["review_feedback"]["accepted_with_residual_warnings"] is False
    assert outcome.report["attempt_history"][0]["status"] == "approved_with_warnings_retry"
    assert outcome.materials is not None
    assert outcome.materials.tailored_resume is not None
    review = outcome.materials.tailored_resume.metadata["adversarial_review"]
    assert review["warnings"] == []
    assert outcome.materials.tailored_resume.metadata["review_feedback"] == {
        "warning_retry_attempted": True,
        "accepted_with_residual_warnings": False,
        "accepted_warning_notes": [],
    }


def test_tailor_use_case_persists_residual_adversarial_warnings_without_retries(
    tmp_path: Path, job: dict
) -> None:
    snapshot = ProfileSnapshot.from_profile(
        Profile.from_dict(LOCAL_TENANT, _profile_with_evidence_dict())
    )
    high_fit_job = {**job, "fit_score": 9, "title": "Senior Backend Engineer"}
    repo = _FakeRepository()
    llm = _ScriptedLlm(
        [
            _quality_json_payload(),
            _judge_pass(),
            _adversarial_pass(warnings=["Bullet could be more concise."]),
        ]
    )
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        max_retries=0,
    )

    outcome = use_case.execute(job=high_fit_job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "approved"
    assert len(llm.calls) == 3
    assert outcome.report["review_feedback"] == {
        "warning_retry_attempted": False,
        "accepted_with_residual_warnings": True,
        "accepted_warning_notes": ["Bullet could be more concise."],
    }
    assert outcome.materials is not None
    assert outcome.materials.tailored_resume is not None
    review = outcome.materials.tailored_resume.metadata["adversarial_review"]
    assert review["warnings"] == ["Bullet could be more concise."]
    assert outcome.materials.tailored_resume.metadata["review_feedback"] == {
        "warning_retry_attempted": False,
        "accepted_with_residual_warnings": True,
        "accepted_warning_notes": ["Bullet could be more concise."],
    }


def test_tailor_use_case_adversarial_blocker_fails_and_feeds_retry_notes(
    tmp_path: Path, job: dict
) -> None:
    snapshot = ProfileSnapshot.from_profile(
        Profile.from_dict(LOCAL_TENANT, _profile_with_evidence_dict())
    )
    high_fit_job = {
        **job,
        "fit_score": 9,
        "title": "Senior Backend Engineer",
        "skills": ["Python", "PostgreSQL", "API performance"],
        "responsibilities": ["Own backend latency improvements"],
        "full_description": "Own Python services and improve API latency.",
    }
    repo = _FakeRepository()
    llm = _ScriptedLlm([
        _quality_json_payload(),
        _judge_pass(),
        _adversarial_fail(),
        _quality_json_payload(),
        _judge_pass(),
        _adversarial_pass(),
    ])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        max_retries=1,
    )

    outcome = use_case.execute(job=high_fit_job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "approved"
    assert len(llm.calls) == 6
    assert "Unsupported high-fit resume claim" in llm.calls[3][0].content
    first_candidate = outcome.report["attempt_history"][0]["candidates"][0]
    assert first_candidate["status"] == "adversarial_rejected"
    assert first_candidate["adversarial_review"]["passed"] is False


def test_tailor_use_case_quality_failure_feeds_retry_notes(
    tmp_path: Path, job: dict
) -> None:
    snapshot = ProfileSnapshot.from_profile(
        Profile.from_dict(LOCAL_TENANT, _profile_with_evidence_dict())
    )
    job = {
        **job,
        "title": "Senior Backend Engineer",
        "skills": ["Python", "PostgreSQL", "API performance"],
        "responsibilities": ["Own backend latency improvements"],
        "full_description": "Own Python services and improve API latency.",
    }
    repo = _FakeRepository()
    llm = _ScriptedLlm([
        _quality_json_payload(metric="80%"),
        _quality_json_payload(metric="35%"),
        _judge_pass(),
    ])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )

    outcome = use_case.execute(job=job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "approved"
    assert len(llm.calls) == 3
    assert "Unknown metric" in llm.calls[1][0].content
    first_candidate = outcome.report["attempt_history"][0]["candidates"][0]
    assert first_candidate["status"] == "failed_validation"
    assert any("Unknown metric" in error for error in first_candidate["validator"]["errors"])


def test_tailor_use_case_judge_rejected_fails_quality_gate(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    # Judge fails on every retry -> no tailored resume is approved.
    responses = []
    for _ in range(4):
        responses.append(_good_json_payload())
        responses.append(_judge_fail())
    llm = _ScriptedLlm(responses)
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )
    outcome = use_case.execute(
        job=job, profile_snapshot=snapshot, tailored_dir=tmp_path
    )
    assert outcome.status == "failed_judge"
    assert outcome.materials is not None
    # Aggregate stays in RESUME_IN_PROGRESS because the judge rejected the artifact.
    assert outcome.materials.status == MaterialsLifecycle.RESUME_IN_PROGRESS
    assert outcome.materials.last_verdict is not None
    assert "Cut latency 40%" in outcome.materials.last_verdict.issues


def test_tailor_use_case_routes_multiple_candidate_models_and_persists_safe_metadata(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    bad = json.dumps({"executive_profile": "", "experience_updates": [], "skill_category_updates": []})
    llm = _ScriptedLlm([bad, _good_json_payload(), _judge_pass()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        llm_policy=TailoringLlmPolicy(
            candidate_models=("local:draft-a", "openai:draft-b"),
            judge_model="gemini:judge-c",
        ),
    )

    outcome = use_case.execute(job=job, profile_snapshot=snapshot, tailored_dir=tmp_path)

    assert outcome.status == "approved"
    assert [kwargs.get("model") for kwargs in llm.kwargs] == [
        "local:draft-a",
        "openai:draft-b",
        "gemini:judge-c",
    ]
    assert outcome.report["selected_model"] == "openai:draft-b"
    assert outcome.materials is not None
    assert outcome.materials.tailored_resume is not None
    metadata = outcome.materials.tailored_resume.metadata
    assert metadata["selected_model"] == "openai:draft-b"
    assert metadata["judge_model"] == "gemini:judge-c"
    assert metadata["tailoring_policy_version"] == 1
    assert metadata["tailoring_policy"]["prompt_fingerprint"].startswith("sha256:")
    assert metadata["tailoring_policy"]["config_fingerprint"].startswith("sha256:")
    assert metadata["candidate_summaries"][0]["generator"] == "local:draft-a"
    assert "api_key" not in json.dumps(metadata).lower()
    assert "platform leadership language" not in json.dumps(metadata).lower()


def test_tailor_use_case_lenient_skips_judge(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    llm = _ScriptedLlm([_good_json_payload()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )

    outcome = use_case.execute(
        job=job,
        profile_snapshot=snapshot,
        tailored_dir=tmp_path,
        validation_mode="lenient",
    )

    assert outcome.status == "approved"
    assert len(llm.calls) == 1
    assert outcome.report["judge"]["verdict"] == "SKIPPED"


def test_tailor_use_case_failed_validation_persists_rejected_artifact(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    bad = json.dumps({"executive_profile": "", "experience_updates": [], "skill_category_updates": []})
    llm = _ScriptedLlm([bad] * 4)
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )
    outcome = use_case.execute(
        job=job, profile_snapshot=snapshot, tailored_dir=tmp_path
    )
    assert outcome.status == "failed_validation"


def test_tailor_use_case_tries_multiple_candidate_models_and_separate_judge(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    llm = _ScriptedLlm(["not json", _good_json_payload(), _judge_pass()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        llm_policy=TailoringLlmPolicy(
            candidate_models=("local:bad-candidate", "local:good-candidate"),
            judge_model="local:judge",
        ),
    )

    outcome = use_case.execute(
        job=job, profile_snapshot=snapshot, tailored_dir=tmp_path
    )

    assert outcome.status == "approved"
    assert [kwargs.get("model") for kwargs in llm.kwargs] == [
        "local:bad-candidate",
        "local:good-candidate",
        "local:judge",
    ]
    assert outcome.report["selected_model"] == "local:good-candidate"
    assert outcome.materials is not None
    metadata = outcome.materials.tailored_resume.metadata if outcome.materials.tailored_resume else {}
    assert metadata["selected_model"] == "local:good-candidate"
    assert metadata["judge"]["judge_model"] == "local:judge"


def test_tailor_use_case_pass_verdict_below_threshold_fails_judge(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    llm = _ScriptedLlm([_good_json_payload(), _judge_with_score(0.6)])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        llm_policy=TailoringLlmPolicy(judge_min_score=0.9),
    )

    outcome = use_case.execute(
        job=job, profile_snapshot=snapshot, tailored_dir=tmp_path
    )

    assert outcome.status == "failed_judge"
    assert outcome.materials is not None
    assert not outcome.materials.is_resume_approved


def test_tailor_use_case_lenient_skips_structured_judge(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    llm = _ScriptedLlm([_good_json_payload()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        llm_policy=TailoringLlmPolicy(judge_model="local:judge"),
    )

    outcome = use_case.execute(
        job=job,
        profile_snapshot=snapshot,
        tailored_dir=tmp_path,
        validation_mode="lenient",
    )

    assert outcome.status == "approved"
    assert len(llm.kwargs) == 1
    assert outcome.report["judge"]["verdict"] == "SKIPPED"


def test_tailor_use_case_exhausted_when_no_parseable_json(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    llm = _ScriptedLlm(["not json"] * 4)
    publisher = _RecordingPublisher()
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
        publisher=publisher,
    )
    outcome = use_case.execute(
        job=job, profile_snapshot=snapshot, tailored_dir=tmp_path
    )
    assert outcome.status == "exhausted_retries"
    assert any(getattr(e, "event_type", "") == "ResumeFailed" for e in publisher.events)


def test_tailor_use_case_retailor_supersedes_previous_generation(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    # Pre-seed a previous approved generation.
    initial = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path="/tmp/old.txt",
            created_at="2024-01-01T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(initial)

    llm = _ScriptedLlm([_good_json_payload(), _judge_pass()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )
    outcome = use_case.execute(
        job=job,
        profile_snapshot=snapshot,
        tailored_dir=tmp_path,
        retailor=True,
    )
    assert outcome.materials is not None
    assert outcome.materials.generation == 2
    # Previous generation must have been re-saved with superseded artifacts.
    superseded_save = next(
        (m for m in repo.saved if m.generation == 1
         and m.tailored_resume is not None
         and m.tailored_resume.status is ArtifactStatus.SUPERSEDED),
        None,
    )
    assert superseded_save is not None


def test_tailor_use_case_retailor_suppresses_previous_generation_when_requested(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    initial = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path="/tmp/old.txt",
            created_at="2024-01-01T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(initial)

    llm = _ScriptedLlm([_good_json_payload(), _judge_pass()])
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )
    outcome = use_case.execute(
        job=job,
        profile_snapshot=snapshot,
        tailored_dir=tmp_path,
        retailor=True,
        suppress_existing_artifacts=True,
    )

    assert outcome.materials is not None
    assert outcome.materials.generation == 2
    suppressed_save = next(
        (
            m
            for m in repo.saved
            if m.generation == 1
            and m.tailored_resume is not None
            and m.tailored_resume.status is ArtifactStatus.SUPPRESSED
        ),
        None,
    )
    assert suppressed_save is not None
    assert suppressed_save.tailored_resume is not None
    assert suppressed_save.tailored_resume.metadata["suppression"]["reason"] == (
        "retailor_current_policy"
    )


def test_tailor_use_case_failed_retailor_keeps_previous_generation_active(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    initial = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path="/tmp/old.txt",
            created_at="2024-01-01T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(initial)

    llm = _ScriptedLlm([_keyword_stuffed_json_payload()] * 4)
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyzeUseCase(),
    )
    outcome = use_case.execute(
        job=job,
        profile_snapshot=snapshot,
        tailored_dir=tmp_path,
        retailor=True,
        suppress_existing_artifacts=True,
    )

    assert outcome.materials is not None
    assert outcome.status == "failed_validation"
    assert outcome.materials.generation == 2
    assert outcome.materials.tailored_resume is not None
    assert outcome.materials.tailored_resume.status is ArtifactStatus.REJECTED
    previous = repo.load(LOCAL_TENANT, JobId(job["url"]), generation=1)
    assert previous is not None
    assert previous.tailored_resume is not None
    assert previous.tailored_resume.status is ArtifactStatus.APPROVED


# ---------------------------------------------------------------------------
# GenerateCoverLetterUseCase
# ---------------------------------------------------------------------------


def test_cover_letter_use_case_requires_existing_materials(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    use_case = GenerateCoverLetterUseCase(
        repository=repo,
        llm=_ScriptedLlm([]),
        validator=ContentValidator(),
    )
    outcome = use_case.execute(job=job, profile_snapshot=snapshot, cover_letter_dir=tmp_path)
    assert outcome.status == "error"
    assert "tailor" in outcome.error.lower()


def test_cover_letter_use_case_requires_approved_resume(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    in_progress = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2024-01-01T00:00:00+00:00",
    )
    repo.save(in_progress)
    use_case = GenerateCoverLetterUseCase(
        repository=repo,
        llm=_ScriptedLlm([]),
        validator=ContentValidator(),
    )
    outcome = use_case.execute(job=job, profile_snapshot=snapshot, cover_letter_dir=tmp_path)
    assert outcome.status == "error"


def test_cover_letter_use_case_requires_approved_resume_pdf(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    resume_path = tmp_path / "resume.txt"
    resume_path.write_text("Tailored resume body", encoding="utf-8")
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(resume_path),
            created_at="2024-01-01T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(materials)
    use_case = GenerateCoverLetterUseCase(
        repository=repo,
        llm=_ScriptedLlm([]),
        validator=ContentValidator(),
    )

    outcome = use_case.execute(job=job, profile_snapshot=snapshot, cover_letter_dir=tmp_path)

    assert outcome.status == "error"
    assert "resume pdf" in outcome.error.lower()


def test_cover_letter_use_case_happy_path(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    # Seed an approved tailored resume on disk.
    resume_path = tmp_path / "resume.txt"
    resume_path.write_text("Tailored resume body", encoding="utf-8")
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(resume_path),
            created_at="2024-01-01T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_resume_pdf(
        Artifact.create(
            type=ArtifactType.RESUME_PDF,
            path=str(tmp_path / "resume.pdf"),
            created_at="2024-01-02T01:00:00+00:00",
            render_format=RenderFormat.LATEX_PDF,
        ),
        updated_at="2024-01-02T01:00:00+00:00",
    )
    repo.save(materials)
    llm = _ScriptedLlm([
        (
            "Dear Hiring Manager,\n\n"
            "I built distributed systems that map to this role.\n\n"
            f"Jane\n{COVER_LETTER_COMPLETION_MARKER}"
        ),
    ])
    publisher = _RecordingPublisher()
    use_case = GenerateCoverLetterUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        publisher=publisher,
    )
    outcome = use_case.execute(
        job=job, profile_snapshot=snapshot, cover_letter_dir=tmp_path
    )
    assert outcome.status == "ok"
    assert outcome.text_path is not None
    saved_text = Path(outcome.text_path).read_text(encoding="utf-8")
    assert COVER_LETTER_COMPLETION_MARKER not in saved_text
    assert saved_text.endswith("Jane")
    assert llm.kwargs[0]["max_tokens"] == 8192
    assert "thinking_budget" not in llm.kwargs[0]
    assert COVER_LETTER_COMPLETION_MARKER in llm.calls[0][0].content
    assert any(getattr(e, "event_type", "") == "CoverLetterGenerated" for e in publisher.events)


def test_cover_letter_use_case_retries_when_completion_marker_missing(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    resume_path = tmp_path / "resume.txt"
    resume_path.write_text("Tailored resume body", encoding="utf-8")
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(resume_path),
            created_at="2024-01-01T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_resume_pdf(
        Artifact.create(
            type=ArtifactType.RESUME_PDF,
            path=str(tmp_path / "resume.pdf"),
            created_at="2024-01-02T01:00:00+00:00",
            render_format=RenderFormat.LATEX_PDF,
        ),
        updated_at="2024-01-02T01:00:00+00:00",
    )
    repo.save(materials)
    llm = _ScriptedLlm([
        "Dear Hiring Manager,\n\nI built distributed systems that map to this role.\n\nJane",
        (
            "Dear Hiring Manager,\n\n"
            "I built distributed systems that map to this role.\n\n"
            f"Jane\n{COVER_LETTER_COMPLETION_MARKER}"
        ),
    ])
    use_case = GenerateCoverLetterUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
    )

    outcome = use_case.execute(
        job=job, profile_snapshot=snapshot, cover_letter_dir=tmp_path
    )

    assert outcome.status == "ok"
    assert len(llm.calls) == 2
    assert "Missing END_OF_COVER_LETTER completion marker" in llm.calls[1][0].content
    assert outcome.text_path is not None
    assert COVER_LETTER_COMPLETION_MARKER not in Path(outcome.text_path).read_text(
        encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# RenderPdfUseCase
# ---------------------------------------------------------------------------


class _CapturingRenderer:
    def __init__(self) -> None:
        self.resume_calls = 0
        self.cover_calls = 0
        self.last_resume_template = None
        self.last_resume_theme = None

    def render_resume_to_pdf(
        self,
        *,
        tailored_payload,
        profile_dict,
        output_path,
        created_at,
        resume_theme=None,
        resume_template=None,
    ) -> Artifact:
        self.resume_calls += 1
        self.last_resume_theme = resume_theme
        self.last_resume_template = resume_template
        Path(output_path).write_bytes(b"%PDF-r")
        return Artifact.create(
            type=ArtifactType.RESUME_PDF,
            path=output_path,
            created_at=created_at,
            render_format=RenderFormat.LATEX_PDF,
            size_bytes=len(b"%PDF-r"),
        )

    def render_cover_letter_to_pdf(self, *, cover_letter_text, output_path, created_at) -> Artifact:
        self.cover_calls += 1
        Path(output_path).write_bytes(b"%PDF-c")
        return Artifact.create(
            type=ArtifactType.COVER_LETTER_PDF,
            path=output_path,
            created_at=created_at,
        render_format=RenderFormat.HTML_PDF,
        size_bytes=len(b"%PDF-c"),
    )


def test_render_pdf_use_case_renders_missing_pdfs(tmp_path: Path, job: dict) -> None:
    repo = _FakeRepository()
    resume_path = tmp_path / "resume.txt"
    resume_path.write_text("body", encoding="utf-8")
    cover_path = tmp_path / "cover.txt"
    cover_path.write_text("Dear Hiring Manager, ...", encoding="utf-8")

    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(resume_path),
            created_at="2024-01-01T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_cover_letter(
        Artifact.create(
            type=ArtifactType.COVER_LETTER,
            path=str(cover_path),
            created_at="2024-01-01T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        updated_at="2024-01-03T00:00:00+00:00",
    )
    repo.save(materials)

    publisher = _RecordingPublisher()
    renderer = _CapturingRenderer()
    use_case = RenderPdfUseCase(
        repository=repo,
        resume_renderer=renderer,
        cover_letter_renderer=renderer,
        publisher=publisher,
    )
    outcome = use_case.execute(
        job_id=JobId(job["url"]),
        tailored_payload=_good_json_payload_dict(),
        profile_dict=_profile_dict(),
    )
    assert outcome.status == "ok"
    assert ArtifactType.RESUME_PDF in outcome.rendered
    assert ArtifactType.COVER_LETTER_PDF in outcome.rendered
    pdf_events = [e for e in publisher.events if getattr(e, "event_type", "") == "PdfRendered"]
    assert len(pdf_events) == 2


def test_render_pdf_use_case_passes_effective_template_to_resume_renderer(
    tmp_path: Path,
    job: dict,
) -> None:
    template = {
        "theme": {"fontFamily": "serif", "accentColor": "#123456"},
        "metadata": {
            "templateId": "template_custom",
            "templateVersionId": "template_custom:v2",
            "templateVersionNumber": 2,
            "templateName": "Custom serif",
            "templateHash": "sha256:test",
            "assignmentSource": "job_override",
        },
    }
    repo = _TemplateRepository(template)
    resume_path = tmp_path / "resume.txt"
    resume_path.write_text("body", encoding="utf-8")
    repo.save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(job["url"]),
            created_at="2024-01-01T00:00:00+00:00",
        ).with_resume_attempt(
            Artifact.create(
                type=ArtifactType.TAILORED_RESUME,
                path=str(resume_path),
                created_at="2024-01-01T00:00:00+00:00",
                render_format=RenderFormat.TEXT,
            ),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
    )

    renderer = _CapturingRenderer()
    use_case = RenderPdfUseCase(
        repository=repo,
        resume_renderer=renderer,
        cover_letter_renderer=renderer,
    )
    outcome = use_case.execute(
        job_id=JobId(job["url"]),
        tailored_payload=_good_json_payload_dict(),
        profile_dict=_profile_dict(),
    )

    assert outcome.status == "ok"
    assert renderer.resume_calls == 1
    assert renderer.last_resume_theme == template["theme"]
    assert renderer.last_resume_template == template["metadata"]


def test_render_pdf_use_case_noop_when_pdfs_already_present(
    tmp_path: Path, job: dict
) -> None:
    repo = _FakeRepository()
    resume_path = tmp_path / "resume.txt"
    resume_path.write_text("body", encoding="utf-8")
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(job["url"]),
        created_at="2024-01-01T00:00:00+00:00",
    ).with_resume_attempt(
        Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(resume_path),
            created_at="2024-01-01T00:00:00+00:00",
            render_format=RenderFormat.TEXT,
        ),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at="2024-01-02T00:00:00+00:00",
    ).with_resume_pdf(
        Artifact.create(
            type=ArtifactType.RESUME_PDF,
            path=str(tmp_path / "resume.pdf"),
            created_at="2024-01-02T00:00:00+00:00",
            render_format=RenderFormat.LATEX_PDF,
        ),
        updated_at="2024-01-02T00:00:00+00:00",
    )
    repo.save(materials)

    renderer = _CapturingRenderer()
    use_case = RenderPdfUseCase(
        repository=repo,
        resume_renderer=renderer,
        cover_letter_renderer=renderer,
    )
    outcome = use_case.execute(
        job_id=JobId(job["url"]),
        tailored_payload=_good_json_payload_dict(),
        profile_dict=_profile_dict(),
    )
    assert outcome.status == "noop"
    assert renderer.resume_calls == 0


def _good_json_payload_dict() -> dict:
    return json.loads(_good_json_payload())


# ---------------------------------------------------------------------------
# Smoke type checks
# ---------------------------------------------------------------------------


def test_repository_protocol_satisfied_by_fake() -> None:
    fake: object = _FakeRepository()
    # Structural typing — any class with the right methods passes.
    for name in (
        "load",
        "load_current_approved",
        "save",
        "list_pending_tailor",
        "list_pending_cover",
        "list_pending_pdf",
        "suppress_active_artifacts",
    ):
        assert hasattr(fake, name)


def test_llm_protocol_satisfied_by_fake() -> None:
    fake: LlmPort = _ScriptedLlm([])
    assert callable(fake.chat)


def test_publisher_protocol_satisfied_by_fake() -> None:
    fake: EventPublisher = _RecordingPublisher()
    assert callable(fake.publish)
