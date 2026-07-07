"""Phase 3: voice pass → re-validate → final audit, wired through the use case.

Integration-level tests over the real ``TailorResumeUseCase`` with scripted LLM
responses, an injected fake ``VoicePort``, and in-memory fakes (mirrors the
Phase-2 ``test_tailor_provenance_integration`` doubles). They pin the Phase-3
acceptance gates end to end:

  * the voice pass runs BEFORE the final audit, and the persisted provenance +
    coverage are computed against the VOICED rendered text (GROUND-06);
  * a voiced bullet is recorded with ``transform_type == voice`` (VOICE-02), and
    the voice audit record + canonical coverage ride on the provenance set;
  * provenance + the never-fabricate detector are RE-RUN after voice (VOICE-03):
    a voice edit that injects an unsourced metric is rejected and the pre-voice
    (clean) candidate is shipped instead, with the voice recorded not-accepted;
  * coverage counts a keyword covered only when it appears in a provenance-backed
    grounded bullet (success criterion 4) — measured against the rendered text;
  * round-trip: every persisted provenance row's ``generated_text`` equals the
    line the assembler renders into the shipped resume (audited == rendered).
"""

from __future__ import annotations

import json
from pathlib import Path

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials.aggregate import MaterialsSet
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    Requirement,
    compute_snapshot_hash,
)
from jobctrl.domain.materials.analyze_use_case import AnalyzeJobOutcome
from jobctrl.domain.materials.provenance import BulletProvenanceSet
from jobctrl.domain.materials.services import (
    ContentValidator,
    ResumeAssembler,
    sanitize_text,
)
from jobctrl.domain.materials.use_cases import TailorResumeUseCase
from jobctrl.domain.materials.value_objects import TransformType
from jobctrl.domain.materials.voice import VoiceRequest, VoiceResult
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.ports.llm import LlmMessage
from jobctrl.domain.scoring import (
    FitScore,
    RequirementFitAssessment,
    RequirementFitReport,
    RequirementFitStatus,
    RequirementFitSummary,
    RequirementScoreContribution,
    RequirementTailoringDirective,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.latex_pdf import (
    _escape_latex_light,
    build_latex,
)

JOB_URL = "https://example.com/job/voice"


# --------------------------------------------------------------------------
# Test doubles
# --------------------------------------------------------------------------


class _FakeAnalyze:
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
                    keyword="latency", evidence_span="improve API latency", requirement_ref="req_latency"
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


class _FakeRequirementFitRepo:
    def __init__(self, report: RequirementFitReport) -> None:
        self._report = report
        self.saved: list[RequirementFitReport] = []

    def load(self, tenant_id, job_id, *, score_version=None) -> RequirementFitReport | None:
        _ = tenant_id, score_version
        if str(self._report.job_id) != str(job_id):
            return None
        return self._report

    def save(self, tenant_id, report: RequirementFitReport) -> None:
        _ = tenant_id
        self._report = report
        self.saved.append(report)


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


class _FunctionVoice:
    """A fake ``VoicePort`` driven by a python function over (exec, bullets)."""

    def __init__(self, fn) -> None:
        self._fn = fn
        self.calls: list[VoiceRequest] = []

    @property
    def model_id(self) -> str:
        return "fake-voice-model"

    async def rewrite(self, system_prompt: str, request: VoiceRequest) -> VoiceResult:
        self.calls.append(request)
        return self._fn(request)


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


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
                    # Allow the summary rewrite so the voiced executive profile ships.
                    "allow_summary_rewrite": True,
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


def _requirement_fit_report() -> RequirementFitReport:
    contribution = RequirementScoreContribution(
        max_points=1.125,
        awarded_points=1.125,
        weighted_impact=1.125,
    )
    return RequirementFitReport(
        job_id=JOB_URL,
        score_version=1,
        employer_analysis_generation=1,
        profile_snapshot_version=1,
        scoring_policy_version=1,
        formula_version="requirement-fit-v1",
        resolved_fit_score=FitScore.create(8),
        fit_band="strong",
        confidence="high",
        summary=RequirementFitSummary(weighted_fit=1.0, must_have_coverage=1.0),
        assessments=(
            RequirementFitAssessment(
                requirement_id="req_latency",
                requirement_text="improve API latency",
                tier="must_have",
                weight=0.9,
                job_evidence_span="improve API latency",
                fit=RequirementFitStatus(
                    kind="matched",
                    evidence_ids=("ev_latency",),
                    strength="direct",
                ),
                contribution=contribution,
                tailoring=RequirementTailoringDirective(
                    action="double_down",
                    priority=0.9,
                    allowed_evidence_ids=("ev_latency",),
                    target_keywords=("latency", "python"),
                ),
            ),
        ),
    )


def _coverage_planner_response() -> str:
    return json.dumps(
        {
            "coverage_edges": [
                {
                    "requirement_id": "req_latency",
                    "achievement_evidence_id": "ev_latency",
                    "coverage_kind": "direct",
                    "strength": "direct",
                    "required_claim_policy": "verified_only",
                    "target_terms": ["latency", "python"],
                    "rationale": "Verified latency evidence supports the latency requirement.",
                }
            ],
            "uncovered_requirements": [],
            "unused_achievements": [],
        }
    )


def _claim_mapping(bullet: str) -> list[dict[str, object]]:
    return [
        {
            "claim_id": "claim_latency",
            "location": "experience.acme_swe.bullets[0]",
            "text": bullet,
            "claim_label": "evidence_reframed",
            "coverage_edge_ids": ["edge_req_latency_ev_latency_direct"],
            "requirement_ids": ["req_latency"],
            "evidence_ids": ["ev_latency"],
            "review_required": False,
        }
    ]


def _payload(bullet: str, *, summary: str) -> str:
    return json.dumps(
        {
            "executive_profile": summary,
            "experience_updates": [{"id": "acme_swe", "title": "", "bullets": [bullet]}],
            "skill_category_updates": [{"id": "languages", "items": ["Python", "Go"]}],
            "generated_claim_mappings": _claim_mapping(bullet),
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


def _use_case(materials_repo, provenance_repo, llm, publisher, voice) -> TailorResumeUseCase:
    return TailorResumeUseCase(
        repository=materials_repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
        analyze_use_case=_FakeAnalyze(),
        provenance_repository=provenance_repo,
        requirement_fit_repository=_FakeRequirementFitRepo(_requirement_fit_report()),
        publisher=publisher,
        voice=voice,
    )


# The candidate the generator produces: buzzword-laden but grounded ("40%" is real,
# "Owned" supplies the seniority signal the senior gate requires).
_GENERATOR_BULLET = "Spearheaded a robust, scalable platform; owned the API and cut latency 40% with Python."
_GENERATOR_SUMMARY = "Results-driven engineer leveraging robust scalable solutions to drive value."


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------


def test_voice_runs_before_audit_and_provenance_anchors_to_voiced_text(tmp_path: Path) -> None:
    """The voiced wording is what the audit + provenance see (voice before audit)."""

    def voice_fn(request: VoiceRequest) -> VoiceResult:
        # De-buzzword: keep the grounded "40%"/"Python", drop "spearheaded/robust".
        return VoiceResult(
            executive_profile="Backend engineer who cut API latency with Python.",
            experience_bullets=(
                ("acme_swe", ("Owned the API and cut latency 40% with Python.",)),
            ),
        )

    voice = _FunctionVoice(voice_fn)
    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    llm = _ScriptedLlm([_payload(_GENERATOR_BULLET, summary=_GENERATOR_SUMMARY), _judge_pass()] * 4)
    outcome = _use_case(materials_repo, provenance_repo, llm, publisher, voice).execute(
        job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path
    )

    assert outcome.status == "approved"
    assert voice.calls, "voice pass must have run"
    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None
    experience = next(row for row in saved.bullets if row.section == "experience")
    # The provenance anchors to the VOICED bullet, not the buzzword generator draft.
    assert "spearheaded" not in experience.generated_text.lower()
    assert experience.generated_text == "Owned the API and cut latency 40% with Python."

    # The shipped resume text on disk also carries the voiced bullet.
    shipped = Path(outcome.text_path).read_text(encoding="utf-8")
    assert "Owned the API and cut latency 40% with Python." in shipped
    assert "spearheaded" not in shipped.lower()


def test_gate_grounding_and_shipped_fit_persist_with_lifecycle_labels(tmp_path: Path) -> None:
    """The gate record carries its grounding audit; the shipped artifact persists
    a lifecycle-labeled post-voice grounded fit; claim evidence never leaks onto
    provenance rows (the #216 keyword-coverage stuffing vector stays closed)."""

    def voice_fn(request: VoiceRequest) -> VoiceResult:
        return VoiceResult(
            executive_profile="Backend engineer who cut API latency with Python.",
            experience_bullets=(
                ("acme_swe", ("Owned the API and cut latency 40% with Python.",)),
            ),
        )

    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    llm = _ScriptedLlm([_payload(_GENERATOR_BULLET, summary=_GENERATOR_SUMMARY), _judge_pass()] * 4)
    outcome = _use_case(
        materials_repo, provenance_repo, llm, _RecordingPublisher(), _FunctionVoice(voice_fn)
    ).execute(job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path)

    assert outcome.status == "approved"

    # The selected candidate's gate record is grounded and inspectable.
    gate = outcome.report["post_generation_fit"]
    assert gate["fit_score"]["coverage_basis"] == "grounded_shipped_text_v1"
    assert gate["grounding"]["basis"] == "grounded_shipped_text_v1"
    assert gate["grounding"]["claimed_only_requirement_ids"] == []

    # The artifact persists the lifecycle-labeled post-voice grounded fit: the
    # voice pass reworded the claim's bullet, so the claim stays grounded via
    # the same bullet's pre-voice text and the shipped record passes the gate.
    final = outcome.report["tailoring_quality"]["post_generation_fit_final"]
    assert final["lifecycle"] == "post_voice_shipped"
    assert final["passed"] is True
    assert final["warnings"] == []
    assert final["fit_score"]["coverage_basis"] == "grounded_shipped_text_v1"
    assert final["fit_score"]["covered_requirement_ids"] == ["req_latency"]
    assert final["fit_score"]["must_have_coverage"] == 1.0
    assert final["gate_thresholds"]["must_have_coverage"] > 0

    # Persisted provenance rows carry the grounded claim requirement link on the
    # voiced bullet, and enrichment never injected the claim's evidence ids
    # beyond what the builder bound from the profile.
    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None
    experience = next(row for row in saved.bullets if row.section == "experience")
    assert "req_latency" in experience.requirement_ids
    assert all(evidence_id == "ev_latency" for evidence_id in experience.evidence_ids)


def test_voiced_bullet_is_recorded_as_voice_transform(tmp_path: Path) -> None:
    """VOICE-02: a bullet whose wording the voice pass changed is transform=voice."""

    def voice_fn(request: VoiceRequest) -> VoiceResult:
        return VoiceResult(
            executive_profile="Backend engineer who cut API latency with Python.",
            experience_bullets=(
                ("acme_swe", ("Owned the API and cut latency 40% with Python.",)),
            ),
        )

    voice = _FunctionVoice(voice_fn)
    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    llm = _ScriptedLlm([_payload(_GENERATOR_BULLET, summary=_GENERATOR_SUMMARY), _judge_pass()] * 4)
    _use_case(materials_repo, provenance_repo, llm, publisher, voice).execute(
        job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path
    )

    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None
    experience = next(row for row in saved.bullets if row.section == "experience")
    assert experience.transform_type is TransformType.VOICE
    # The voice audit record is persisted on the set and marked accepted.
    assert saved.voice is not None and saved.voice.ran and saved.voice.accepted
    assert saved.voice.model == "fake-voice-model"


def test_voice_introduced_fabrication_is_rejected_and_pre_voice_ships(tmp_path: Path) -> None:
    """VOICE-03: re-running the detector after voice catches a metric the voice pass
    injected. The voiced payload is discarded and the clean pre-voice candidate is
    shipped; the voice is recorded ran-but-not-accepted."""

    def voice_fn(request: VoiceRequest) -> VoiceResult:
        # The voice pass invents "10M users" — unsourced; the profile has no such number.
        return VoiceResult(
            executive_profile="Backend engineer who scaled to 10M users.",
            experience_bullets=(
                ("acme_swe", ("Owned the API and cut latency 40%, scaling to 10M users.",)),
            ),
        )

    voice = _FunctionVoice(voice_fn)
    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    llm = _ScriptedLlm([_payload(_GENERATOR_BULLET, summary=_GENERATOR_SUMMARY), _judge_pass()] * 4)
    outcome = _use_case(materials_repo, provenance_repo, llm, publisher, voice).execute(
        job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path
    )

    # The resume is STILL approved — the pre-voice candidate was clean and grounded.
    assert outcome.status == "approved"
    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None
    shipped = Path(outcome.text_path).read_text(encoding="utf-8")
    # The fabricated "10m users" never reaches the shipped resume or the provenance.
    assert "10m users" not in shipped.lower()
    assert all("10m" not in row.generated_text.lower() for row in saved.bullets)
    # The voice pass is recorded as ran-but-not-accepted with a fabrication reason.
    assert saved.voice is not None and saved.voice.ran and not saved.voice.accepted
    assert "fabricat" in saved.voice.reason.lower()
    # No row was mislabelled voice — the shipped lines are the pre-voice candidate.
    assert all(row.transform_type is not TransformType.VOICE for row in saved.bullets)


def test_coverage_is_computed_against_rendered_text_and_provenance_backed(tmp_path: Path) -> None:
    """GROUND-06 + success criterion 4: coverage covered/missing reflect the voiced
    rendered text, and a keyword counts only when in a provenance-backed bullet."""

    def voice_fn(request: VoiceRequest) -> VoiceResult:
        # Voiced bullet keeps "latency" + "Python" (both analysis keywords).
        return VoiceResult(
            executive_profile="Backend engineer focused on API latency.",
            experience_bullets=(
                ("acme_swe", ("Owned the API and cut latency 40% with Python.",)),
            ),
        )

    voice = _FunctionVoice(voice_fn)
    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    llm = _ScriptedLlm([_payload(_GENERATOR_BULLET, summary=_GENERATOR_SUMMARY), _judge_pass()] * 4)
    _use_case(materials_repo, provenance_repo, llm, publisher, voice).execute(
        job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path
    )

    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None and saved.coverage is not None
    coverage = saved.coverage
    assert coverage.computed_against == "rendered_text"
    # Both analysis keywords appear in the grounded experience bullet.
    assert "latency" in coverage.covered
    assert "python" in coverage.covered
    assert coverage.missing == ()


def test_round_trip_audited_bullet_text_equals_rendered_text(tmp_path: Path) -> None:
    """The round-trip fixture: every persisted provenance row's generated_text equals
    the exact line the assembler renders into the shipped resume (Pitfall 4)."""

    def voice_fn(request: VoiceRequest) -> VoiceResult:
        return VoiceResult(
            executive_profile="Backend engineer who cut API latency with Python.",
            experience_bullets=(
                ("acme_swe", ("Owned the API and cut latency 40% with Python.",)),
            ),
        )

    voice = _FunctionVoice(voice_fn)
    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    llm = _ScriptedLlm([_payload(_GENERATOR_BULLET, summary=_GENERATOR_SUMMARY), _judge_pass()] * 4)
    outcome = _use_case(materials_repo, provenance_repo, llm, publisher, voice).execute(
        job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path
    )

    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None
    shipped = Path(outcome.text_path).read_text(encoding="utf-8")
    # The rendered resume lines (sanitised exactly as the assembler ships them).
    rendered_lines = {sanitize_text(line.lstrip("- ").strip()) for line in shipped.splitlines() if line.strip()}
    for row in saved.bullets:
        if row.section == "skills":
            # Skills lines render with a "Label: a, b" shape; assert the line is present whole.
            assert row.generated_text in {sanitize_text(line.strip()) for line in shipped.splitlines()}
        else:
            assert row.generated_text in rendered_lines, (
                f"audited bullet not found verbatim in rendered resume: {row.generated_text!r}"
            )


def test_round_trip_audited_bullet_text_equals_rendered_latex(tmp_path: Path) -> None:
    """GROUND-06 / success criterion 3 against the ACTUAL renderer.

    The plain-text round-trip above pins "audited == rendered" for the
    ``ResumeAssembler`` text. But the LaTeX path is the only resume renderer the
    user actually ships (``PlaywrightHtmlPdfAdapter.render_resume_to_pdf`` raises
    ``NotImplementedError``), and ``build_latex`` runs a SEPARATE bullet pipeline:
    ``tailored_experience_bullets`` ⇒ ``sanitize_text`` ⇒ ``_escape_latex_light``.
    This fixture renders the accepted ``TailorOutcome.final_payload`` through the
    real ``build_latex`` and asserts every accepted provenance row's
    ``generated_text`` — LaTeX-escaped with the SAME escaper the renderer uses —
    appears in the rendered LaTeX body. A future change to the LaTeX bullet
    pipeline (a reorder, a transform applied only in ``build_latex``) that broke
    "audited == rendered" for the shipped PDF would now fail here, not silently
    ship a resume whose text diverges from the audit trail.

    Deterministic by design: it asserts on the generated LaTeX SOURCE string, so
    no ``pdflatex``/Playwright/real PDF is required.
    """

    def voice_fn(request: VoiceRequest) -> VoiceResult:
        return VoiceResult(
            executive_profile="Backend engineer who cut API latency with Python.",
            experience_bullets=(
                ("acme_swe", ("Owned the API and cut latency 40% with Python.",)),
            ),
        )

    voice = _FunctionVoice(voice_fn)
    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    llm = _ScriptedLlm([_payload(_GENERATOR_BULLET, summary=_GENERATOR_SUMMARY), _judge_pass()] * 4)
    profile_snapshot = _snapshot()
    outcome = _use_case(materials_repo, provenance_repo, llm, publisher, voice).execute(
        job=_job(), profile_snapshot=profile_snapshot, tailored_dir=tmp_path
    )

    assert outcome.status == "approved"
    assert outcome.final_payload is not None

    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None and saved.bullets

    # Render the ACCEPTED (voiced) payload through the only resume renderer the
    # user ships — the LaTeX builder — and assert on its source string.
    rendered_latex = build_latex(outcome.final_payload, profile_snapshot.as_dict())

    for row in saved.bullets:
        # The renderer escapes every line via ``_escape_latex_light(sanitize_text(...))``;
        # provenance already holds the sanitised line, so escaping it the same way
        # yields exactly the presentation the LaTeX body carries.
        escaped = _escape_latex_light(row.generated_text)
        if row.section == "skills":
            # Skills render as ``\item \textbf{Label:} a, b.`` — the label is bolded
            # and the items follow. Assert both the bolded label and the escaped
            # item list (the audited content) are present in the rendered LaTeX.
            label, _, items = row.generated_text.partition(": ")
            assert f"\\textbf{{{_escape_latex_light(label)}:}}" in rendered_latex, (
                f"audited skills label not bolded in rendered LaTeX: {label!r}"
            )
            assert _escape_latex_light(items) in rendered_latex, (
                f"audited skills items not found in rendered LaTeX: {items!r}"
            )
        else:
            # Executive profile + experience bullets must appear verbatim (escaped)
            # in the rendered LaTeX body — this is the "audited == rendered" anchor
            # for the text the shipped PDF actually contains.
            assert escaped in rendered_latex, (
                f"audited {row.section} text not found in rendered LaTeX: {escaped!r}"
            )

    # Guard the invariant from the other side: the pre-voice buzzword DRAFT must
    # NOT be in the rendered LaTeX, proving the renderer consumed the SAME accepted
    # ``final_payload`` the audit trail anchors to (not the raw selected candidate).
    assert "spearheaded" not in rendered_latex.lower()
    # And the ``%`` in the voiced metric is genuinely LaTeX-escaped in the output,
    # confirming we asserted against renderer presentation, not the plain text.
    assert "cut latency 40\\% with Python." in rendered_latex


def test_voice_failure_falls_back_to_pre_voice_candidate(tmp_path: Path) -> None:
    """A voice SDK error must not sink the resume: the clean pre-voice candidate
    ships and the voice is recorded ran-but-not-accepted with the error reason."""

    def voice_fn(request: VoiceRequest) -> VoiceResult:
        raise RuntimeError("voice SDK exploded")

    voice = _FunctionVoice(voice_fn)
    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    llm = _ScriptedLlm([_payload(_GENERATOR_BULLET, summary=_GENERATOR_SUMMARY), _judge_pass()] * 4)
    outcome = _use_case(materials_repo, provenance_repo, llm, publisher, voice).execute(
        job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path
    )

    assert outcome.status == "approved"
    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None
    assert saved.voice is not None and saved.voice.ran and not saved.voice.accepted
    # The pre-voice (buzzword-y but grounded) bullet shipped — no voice transform rows.
    assert all(row.transform_type is not TransformType.VOICE for row in saved.bullets)


def test_no_voice_port_keeps_pre_phase3_behaviour(tmp_path: Path) -> None:
    """When no VoicePort is injected, the use case behaves exactly as Phase 2:
    provenance is recorded against the un-voiced candidate, coverage is still
    computed (against rendered text), and no voice record is attached."""

    materials_repo = _FakeMaterialsRepo()
    provenance_repo = _FakeProvenanceRepo()
    publisher = _RecordingPublisher()
    # A clean (no-buzzword) candidate so the un-voiced path is grounded + approved.
    clean = _payload("Owned the API and cut latency 40% with Python.", summary="Backend engineer.")
    llm = _ScriptedLlm([clean, _judge_pass()] * 4)
    outcome = TailorResumeUseCase(
        repository=materials_repo,
        llm=llm,
        validator=ContentValidator(),
        assembler=ResumeAssembler(),
            analyze_use_case=_FakeAnalyze(),
            provenance_repository=provenance_repo,
            requirement_fit_repository=_FakeRequirementFitRepo(_requirement_fit_report()),
            publisher=publisher,
            # voice not injected
        ).execute(job=_job(), profile_snapshot=_snapshot(), tailored_dir=tmp_path)

    assert outcome.status == "approved"
    saved = provenance_repo.load(LOCAL_TENANT, JobId(JOB_URL))
    assert saved is not None
    # Coverage is still computed canonically (Phase 3 computes it regardless of voice).
    assert saved.coverage is not None
    assert "latency" in saved.coverage.covered
    # No voice was attempted → voice record is None (or marked skipped/not-ran).
    assert saved.voice is None or not saved.voice.ran
    assert all(row.transform_type is not TransformType.VOICE for row in saved.bullets)
