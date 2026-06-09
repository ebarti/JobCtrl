"""Phase 2: TailorResumeUseCase emits provenance + enforces never-fabricate.

Integration-level tests over the real ``TailorResumeUseCase`` with scripted LLM
responses and in-memory fakes (mirrors ``test_materials_use_cases`` doubles):

  * an accepted generation records one ``BulletProvenance`` per rendered bullet
    and publishes ``BulletProvenanceRecorded`` (GROUND-03 wired end-to-end);
  * the deterministic never-fabricate detector HARD-REJECTS a candidate whose
    bullet invents a metric — the resume is not approved and NO provenance is
    saved, so the last accepted generation is preserved (CONTROL-03 /
    success criterion 2 + 5).
"""

from __future__ import annotations

import json
from pathlib import Path

from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials.aggregate import MaterialsSet
from jobhunter.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobhunter.domain.materials.analyze_use_case import AnalyzeJobOutcome
from jobhunter.domain.materials.provenance import BulletProvenanceSet
from jobhunter.domain.materials.services import ContentValidator, ResumeAssembler
from jobhunter.domain.materials.use_cases import TailorResumeUseCase
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.ports.llm import LlmMessage
from jobhunter.domain.tenant import LOCAL_TENANT

JOB_URL = "https://example.com/job/provenance"


# --------------------------------------------------------------------------
# Test doubles
# --------------------------------------------------------------------------


class _FakeAnalyze:
    """Returns an analysis with real requirements so provenance can bind FKs."""

    def execute(self, *, job: dict, tenant_id=LOCAL_TENANT, force: bool = False) -> AnalyzeJobOutcome:
        canonical = JobAnalysis(
            role_framing="Backend ownership.",
            inferred_seniority="senior",
            ideal_candidate_narrative="A hands-on backend owner.",
            requirements=[
                Requirement(
                    id="req_latency",
                    text="improve API latency",
                    tier="must_have",
                    weight=0.9,
                    evidence_span="improve API latency",
                ),
            ],
            keywords=[
                ReasonedKeyword(
                    keyword="latency",
                    evidence_span="improve API latency",
                    requirement_ref="req_latency",
                ),
                ReasonedKeyword(keyword="python", evidence_span="Python", requirement_ref="req_latency"),
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
            legs_attempted=1,
        )
        return AnalyzeJobOutcome(analysis=analysis, cached=False)


class _FakeMaterialsRepo:
    def __init__(self) -> None:
        self.saved: list[MaterialsSet] = []

    def load(self, tenant_id, job_id, *, generation=None) -> MaterialsSet | None:
        candidates = [
            m
            for m in reversed(self.saved)
            if str(m.tenant_id) == str(tenant_id)
            and str(m.job_id) == str(job_id)
            and (generation is None or m.generation == generation)
        ]
        return candidates[0] if candidates else None

    def save(self, materials: MaterialsSet) -> None:
        self.saved.append(materials)

    def list_pending_tailor(self, *a, **k):
        return []

    def list_pending_cover(self, *a, **k):
        return []

    def list_pending_pdf(self, *a, **k):
        return []

    def list_by_status(self, *a, **k):
        return []

    def suppress_active_artifacts(self, *a, **k):
        return None


class _FakeProvenanceRepo:
    def __init__(self) -> None:
        self.saved: list[BulletProvenanceSet] = []

    def load(self, tenant_id, job_id, *, generation=None) -> BulletProvenanceSet | None:
        candidates = [
            s
            for s in reversed(self.saved)
            if str(s.tenant_id) == str(tenant_id)
            and str(s.job_id) == str(job_id)
            and (generation is None or s.generation == generation)
        ]
        return candidates[0] if candidates else None

    def save(self, provenance: BulletProvenanceSet) -> None:
        if provenance.is_empty:
            return
        self.saved.append(provenance)


class _ScriptedLlm:
    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)

    def chat(self, messages: list[LlmMessage], **kwargs) -> str:
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


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


def _profile_dict() -> dict:
    """A profile that passes the base ``ContentValidator`` (mirrors the
    happy-path fixture in ``test_materials_use_cases``) with real evidence so
    provenance can bind FK ids. ``real_metrics`` includes 40% so the grounded
    payload's "40%" traces to evidence, while an invented "200%" does not."""
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
                    "achievement_evidence": [
                        {
                            "id": "ev_latency",
                            "source_text": "Cut latency 40% by replacing synchronous calls.",
                            "scope": "owned backend service",
                            "action": "replaced synchronous enrichment calls",
                            "tools": ["Python", "PostgreSQL"],
                            "metrics": ["40%"],
                            "outcome": "faster API responses",
                            "seniority_signal": "technical ownership",
                            "evidence_strength": "verified",
                            "claim_confidence": 0.95,
                            "user_confirmed": True,
                            "tags": ["latency", "backend"],
                        }
                    ],
                }
            ],
            "education_entries": [
                {"id": "edu", "degree": "BSc CS", "institution": "State University", "date": "2015"}
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
            },
        },
    }


def _snapshot() -> ProfileSnapshot:
    return ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, _profile_dict()))


def _job() -> dict:
    return {
        "url": JOB_URL,
        "title": "Senior Backend Engineer",
        "site": "Acme",
        "full_description": "Own Python services and improve API latency.",
        "fit_score": 7,
    }


def _payload(bullet: str) -> str:
    return json.dumps(
        {
            "executive_profile": "Senior backend engineer focused on Python API reliability.",
            "experience_updates": [{"id": "acme_swe", "title": "", "bullets": [bullet]}],
            "skill_category_updates": [{"id": "languages", "items": ["Python", "Go"]}],
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


def _use_case(
    materials_repo: _FakeMaterialsRepo,
    provenance_repo: _FakeProvenanceRepo,
    llm: _ScriptedLlm,
    publisher: _RecordingPublisher,
) -> TailorResumeUseCase:
    return TailorResumeUseCase(
        repository=materials_repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyze(),
        provenance_repository=provenance_repo,
        publisher=publisher,
    )


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------


def test_accepted_resume_records_provenance_and_publishes_event(tmp_path: Path) -> None:
    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    # A grounded bullet: "40%" is recorded in the profile evidence + real_metrics.
    # "Owned" carries the seniority signal the senior-role quality gate requires.
    llm = _ScriptedLlm(
        [
            _payload("Owned the API and cut latency 40% with Python by replacing synchronous calls."),
            _judge_pass(),
        ]
    )
    outcome = _use_case(materials_repo, provenance_repo, llm, publisher).execute(
        job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path
    )

    assert outcome.status == "approved"
    assert outcome.materials is not None and outcome.materials.is_resume_approved

    # Provenance was saved for the accepted generation, bound to the artifact.
    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None
    assert saved.artifact_id == outcome.materials.tailored_resume.artifact_id
    assert saved.generation == outcome.materials.generation
    sections = {row.section for row in saved.bullets}
    assert {"executive_profile", "experience", "skills"}.issubset(sections)
    experience = next(row for row in saved.bullets if row.section == "experience")
    assert "req_latency" in experience.requirement_ids  # FK bound to the analysis
    assert "latency" in experience.matched_keywords

    # The BulletProvenanceRecorded event was published with the bullet count.
    provenance_events = [
        e for e in publisher.events if getattr(e, "event_type", "") == "BulletProvenanceRecorded"
    ]
    assert len(provenance_events) == 1
    assert provenance_events[0].payload["bullet_count"] == len(saved.bullets)
    assert provenance_events[0].payload["artifact_id"] == saved.artifact_id


def test_fabricated_employer_is_hard_rejected_by_detector_and_writes_no_provenance(
    tmp_path: Path,
) -> None:
    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    # The candidate invents an employer ("Globex Corporation") the user never
    # worked at. The base quality gate does NOT check employers and the scripted
    # judge "passes" — so ONLY the deterministic never-fabricate detector
    # (independent of the prompt) can catch this. It must HARD-REJECT the resume.
    fabricated = _payload("Owned the API and cut latency 40% at Globex Corporation.")
    llm = _ScriptedLlm([fabricated, _judge_pass()] * 4)  # responses for every retry
    outcome = _use_case(materials_repo, provenance_repo, llm, publisher).execute(
        job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path
    )

    # The resume is NOT approved despite the judge pass — the detector gated it.
    assert outcome.materials is not None
    assert not outcome.materials.is_resume_approved
    # No provenance was persisted for a rejected candidate (last accepted
    # generation, if any, is preserved — here there is none).
    assert provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL)) is None
    assert not any(
        getattr(e, "event_type", "") == "BulletProvenanceRecorded" for e in publisher.events
    )
    # The fabrication is surfaced as the rejection reason on the validation errors.
    errors = " ".join(outcome.materials.last_validation.errors)
    assert "fabricate" in errors.lower() or "fabrication" in errors.lower()
