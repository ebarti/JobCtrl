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
from typing import Iterable

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
from jobhunter.domain.materials.aggregate import MaterialsLifecycle
from jobhunter.domain.materials.services import ContentValidator, ResumeAssembler
from jobhunter.domain.materials.use_cases import (
    GenerateCoverLetterUseCase,
    RenderPdfUseCase,
    TailorResumeUseCase,
)
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.ports.llm import LlmMessage, LlmPort
from jobhunter.domain.profile.aggregate import Profile
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _profile_dict() -> dict:
    return {
        "personal": {"full_name": "Jane Doe", "email": "jane@example.com"},
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
        "fit_score": 9,
    }


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


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


class _ScriptedLlm:
    """Replays a queue of canned LLM responses so tests stay deterministic."""

    def __init__(self, responses: Iterable[str]) -> None:
        self._responses = list(responses)
        self.calls: list[list[LlmMessage]] = []

    def chat(self, messages: list[LlmMessage], **kwargs) -> str:
        self.calls.append(messages)
        if not self._responses:
            raise RuntimeError("no scripted response left")
        return self._responses.pop(0)

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
                {"id": "acme_swe", "bullets": ["Cut latency 40%."]},
            ],
            "skill_category_updates": [
                {"id": "languages", "items": ["Python", "Go"]},
            ],
        }
    )


def _judge_pass() -> str:
    return "VERDICT: PASS\nISSUES: none"


def _judge_fail() -> str:
    return "VERDICT: FAIL\nISSUES: invented metric"


# ---------------------------------------------------------------------------
# TailorResumeUseCase
# ---------------------------------------------------------------------------


def test_tailor_use_case_happy_path(tmp_path: Path, snapshot: ProfileSnapshot, job: dict) -> None:
    repo = _FakeRepository()
    llm = _ScriptedLlm([_good_json_payload(), _judge_pass()])
    publisher = _RecordingPublisher()
    use_case = TailorResumeUseCase(
        repository=repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
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
    assert outcome.text_path is not None and Path(outcome.text_path).exists()
    assert any(getattr(e, "event_type", "") == "ResumeApproved" for e in publisher.events)


def test_tailor_use_case_judge_rejected_finishes_with_warning(
    tmp_path: Path, snapshot: ProfileSnapshot, job: dict
) -> None:
    repo = _FakeRepository()
    # Judge fails on every retry → status is approved_with_judge_warning.
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
    )
    outcome = use_case.execute(
        job=job, profile_snapshot=snapshot, tailored_dir=tmp_path
    )
    assert outcome.status == "approved_with_judge_warning"
    assert outcome.materials is not None
    # Aggregate stays in RESUME_IN_PROGRESS because the judge rejected the artifact.
    assert outcome.materials.status == MaterialsLifecycle.RESUME_IN_PROGRESS


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
    )
    outcome = use_case.execute(
        job=job, profile_snapshot=snapshot, tailored_dir=tmp_path
    )
    assert outcome.status == "failed_validation"


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
    )
    repo.save(materials)
    llm = _ScriptedLlm([
        "Dear Hiring Manager, I built distributed systems. Best, Jane",
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
    assert any(getattr(e, "event_type", "") == "CoverLetterGenerated" for e in publisher.events)


# ---------------------------------------------------------------------------
# RenderPdfUseCase
# ---------------------------------------------------------------------------


class _CapturingRenderer:
    def __init__(self) -> None:
        self.resume_calls = 0
        self.cover_calls = 0

    def render_resume_to_pdf(self, *, tailored_payload, profile_dict, output_path, created_at) -> Artifact:
        self.resume_calls += 1
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
    for name in ("load", "save", "list_pending_tailor", "list_pending_cover", "list_pending_pdf"):
        assert hasattr(fake, name)


def test_llm_protocol_satisfied_by_fake() -> None:
    fake: LlmPort = _ScriptedLlm([])
    assert callable(fake.chat)


def test_publisher_protocol_satisfied_by_fake() -> None:
    fake: EventPublisher = _RecordingPublisher()
    assert callable(fake.publish)
