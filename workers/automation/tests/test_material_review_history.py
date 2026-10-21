"""Bounded correction carries recorded reviews without changing model authority."""

import json
from pathlib import Path

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.voice import VoiceResult
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
from tests.test_artifact_determinations import (
    JOB_ID, Model, connection, cover_case, cover_request, seed_resume,
)
from tests.test_materials_use_cases import (
    ResumeModel, canonical_scored_target, request, resume_case,
)


class ReviewDecisions:
    """Choose decisions explicitly; no prose classification or response replay."""

    def __init__(self, *, final="pass", constant=False, failures=2, provider_failure=False, **kwargs):
        super().__init__(**kwargs)
        self.final, self.constant, self.failures = final, constant, failures
        self.provider_failure = provider_failure
        self.quality_calls = self.draft_calls = 0

    def chat_json(self, messages, *, response_schema, **kwargs):
        title = response_schema["title"]
        if title in {"GeneratedResumeDraft", "GeneratedProseDraft"}:
            self.draft_calls += 1
            self.draft_text = "Owned revision" + ("" if self.constant else f" {self.draft_calls}")
        if title == "ArtifactQuality":
            self.quality_calls += 1
            if self.provider_failure and self.quality_calls > self.failures:
                raise RuntimeError("private provider detail")
        result = super().chat_json(messages, response_schema=response_schema, **kwargs)
        if title == "ArtifactQuality":
            verdict = "fail" if self.quality_calls <= self.failures else self.final
            data = json.loads(messages[1].content)
            ident = "experience:entry#0" if data["context"]["artifact_kind"] == "resume" else "body:1"
            line = next(s for s in data["sources"] if s["source_id"] == "line:" + ident)
            result.update(
                verdict=verdict, score=0.01 if verdict == "pass" else 0.99,
                findings=[] if verdict == "pass" else [{
                    "line_id": ident, "category": "clarity",
                    "citation": {"source_id": line["source_id"], "quote": line["text"], "exact_values": []},
                    "rationale": "Explicit synthetic model decision",
                    "repair_instruction": f"Synthetic repair {self.quality_calls}",
                }], evidence_corrections=[],
            )
        return result


class ResumeReviews(ReviewDecisions, ResumeModel):
    pass


class CoverReviews(ReviewDecisions, Model):
    pass


def quality_inputs(model):
    return [json.loads(m[1].content) for title, _, m in model.calls if title == "ArtifactQuality"]


@pytest.mark.parametrize("kind", ["resume", "cover"])
@pytest.mark.parametrize("final", ["pass", "fail"])
@pytest.mark.parametrize("constant", [False, True])
def test_every_revision_carries_exact_prior_review_ids_and_findings(tmp_path, kind, final, constant):
    conn = connection()
    if kind == "resume":
        model = ResumeReviews(final=final, constant=constant)
        outcome = resume_case(conn, model, retries=2).execute(**request(tmp_path))
        assert outcome.materials.is_resume_approved is (final == "pass")
    else:
        seed_resume(conn, tmp_path)
        model = CoverReviews(final=final, constant=constant)
        outcome = cover_case(conn, model, retries=2).execute(**cover_request(tmp_path))
        assert (outcome.status == "ok") is (final == "pass")
    supplied = quality_inputs(model)
    assert len(supplied) == 3
    receipts = conn.execute(
        "SELECT determination_id,envelope_json FROM semantic_determinations WHERE kind='artifact_quality' ORDER BY created_at"
    ).fetchall()
    assert len(receipts) == 3 and len({r[0] for r in receipts}) == 3
    for index, data in enumerate(supplied):
        history = json.loads(data["context"]["rubric"]["review_history"])
        assert [r["determination_id"] for r in history] == [r[0] for r in receipts[:index]]
        for item, receipt in zip(history, receipts[:index], strict=True):
            assert item["kind"] == "artifact_quality"
            assert item["decision"] == json.loads(receipt[1])["result"]
        # Historical IDs never join the current factual/citation allowlist.
        assert not {r[0] for r in receipts} & {s["source_id"] for s in data["sources"]}
    generations = [m for title, _, m in model.calls if title in {"GeneratedResumeDraft", "GeneratedProseDraft"}]
    third = next(json.loads(m.content) for m in generations[2] if '"review_history"' in m.content)
    assert [r["determination_id"] for r in third["review_history"]] == [r[0] for r in receipts[:2]]
    assert model.draft_calls == 3
    if constant:
        # Canonical support input stayed unchanged; only review context changed.
        assert len([1 for title, _, _ in model.calls if title == "ClaimVerification"]) == 1


class ChangedVoice:
    model_id = "synthetic-voice"

    async def rewrite(self, _system_prompt, value):
        return VoiceResult(
            executive_profile=value.executive_profile,
            executive_profile_sentences=value.executive_profile_sentences,
            experience_bullets=(("entry", ("Owned voiced revision",)),),
        )


@pytest.mark.parametrize("voice_verdict", ["pass", "fail"])
def test_changed_voice_retains_review_context_and_independent_high_fit_gates(tmp_path, voice_verdict):
    class VoiceReviews(ResumeReviews):
        def chat_json(self, messages, *, response_schema, **kwargs):
            self.final = voice_verdict if self.quality_calls >= 2 else "pass"
            return super().chat_json(messages, response_schema=response_schema, **kwargs)

    conn, model = connection(), VoiceReviews(failures=1)
    args = request(tmp_path)
    args["job"] = canonical_scored_target(conn, 8)
    outcome = resume_case(conn, model, retries=1, voice=ChangedVoice()).execute(**args)
    assert outcome.materials.is_resume_approved
    supplied = quality_inputs(model)
    assert len(supplied) == 3
    history = json.loads(supplied[-1]["context"]["rubric"]["review_history"])
    assert [r["kind"] for r in history] == ["artifact_quality", "artifact_quality", "resume_adversarial"]
    assert history[0]["decision"]["verdict"] == "fail"
    assert history[1]["decision"]["verdict"] == "pass"
    assert history[2]["decision"]["verdict"] == "pass"
    audit = outcome.materials.metadata["tailoring_attempt_audit"]
    assert outcome.materials.tailored_resume.metadata["voice_pass"]["final_judge"]["review_history"] == history
    text = Path(outcome.materials.tailored_resume.path).read_text()
    assert ("Owned voiced revision" in text) is (voice_verdict == "pass")
    personas = [m for title, _, m in model.calls if title == "ResumeAdversarialReview"]
    assert len(personas) == (2 if voice_verdict == "pass" else 1)
    if voice_verdict == "pass":
        assert json.loads(json.loads(personas[-1][1].content)["context"]["rubric"]["review_history"]) == history
        assert audit["final_review_history"] == history


@pytest.mark.parametrize("final", ["pass", "fail"])
def test_persona_repair_is_recorded_without_overriding_its_next_decision(tmp_path, final):
    class PersonaReviews(ResumeReviews):
        persona_calls = 0

        def chat_json(self, messages, *, response_schema, **kwargs):
            if response_schema["title"] == "ResumeAdversarialReview":
                self.persona_calls += 1
                self.adversarial = "fail" if self.persona_calls == 1 else final
            return super().chat_json(messages, response_schema=response_schema, **kwargs)

    conn, model = connection(), PersonaReviews(failures=0)
    args = request(tmp_path)
    args["job"] = canonical_scored_target(conn, 8)
    outcome = resume_case(conn, model, retries=1).execute(**args)
    assert outcome.materials.is_resume_approved is (final == "pass")
    history = json.loads(quality_inputs(model)[1]["context"]["rubric"]["review_history"])
    assert [r["kind"] for r in history] == ["artifact_quality", "resume_adversarial"]
    persona = history[1]
    receipt = conn.execute(
        "SELECT envelope_json FROM semantic_determinations WHERE determination_id=?",
        (persona["determination_id"],),
    ).fetchone()
    assert persona["decision"] == json.loads(receipt[0])["result"]
    assert persona["decision"]["verdict"] == "fail" and len(persona["decision"]["personas"]) == 6


@pytest.mark.parametrize("kind", ["resume", "cover"])
def test_historical_quote_cannot_become_a_current_finding_citation(tmp_path, kind):
    base = ResumeReviews if kind == "resume" else CoverReviews

    class HistoricalQuote(base):
        def chat_json(self, messages, *, response_schema, **kwargs):
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
            if response_schema["title"] == "ArtifactQuality" and self.quality_calls > 2:
                data = json.loads(messages[1].content)
                history = json.loads(data["context"]["rubric"]["review_history"])
                finding = history[-1]["decision"]["findings"][0]
                result.update(verdict="fail", findings=[finding])
            return result

    conn, model = connection(), HistoricalQuote()
    if kind == "cover":
        seed_resume(conn, tmp_path)
    with pytest.raises(DeterminationFailure, match="non_verbatim_quote"):
        if kind == "resume":
            resume_case(conn, model, retries=2).execute(**request(tmp_path))
        else:
            cover_case(conn, model, retries=2).execute(**cover_request(tmp_path))
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations WHERE kind='artifact_quality'").fetchone()[0] == 2


@pytest.mark.parametrize("kind", ["resume", "cover"])
@pytest.mark.parametrize("fault", ["provider", "budget"])
def test_history_does_not_bypass_provider_spend_or_accepted_artifact_retention(tmp_path, kind, fault):
    conn = connection()
    if kind == "resume":
        accepted = resume_case(conn, ResumeModel()).execute(**request(tmp_path))
        old = accepted.materials.tailored_resume
        model = ResumeReviews(provider_failure=fault == "provider")
    else:
        seed_resume(conn, tmp_path)
        accepted = cover_case(conn, Model(draft_text="Accepted letter")).execute(**cover_request(tmp_path))
        old = accepted.materials.cover_letter
        model = CoverReviews(provider_failure=fault == "provider")
    before = Path(old.path).read_bytes()

    def preflight():
        if fault == "budget" and model.quality_calls >= 2:
            raise RuntimeError("private spend detail")

    with pytest.raises(DeterminationFailure, match="provider_error" if fault == "provider" else "budget_denied"):
        if kind == "resume":
            resume_case(conn, model, retries=2, preflight=preflight).execute(**request(tmp_path, retailor=True))
        else:
            cover_case(conn, model, preflight, retries=2).execute(**cover_request(tmp_path))
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    artifact = current.tailored_resume if kind == "resume" else current.cover_letter
    assert artifact.artifact_id == old.artifact_id and Path(old.path).read_bytes() == before
