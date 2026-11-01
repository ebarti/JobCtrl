"""The selected review route controls actual calls and recorded authority."""

from types import SimpleNamespace

import pytest

from jobctrl.domain.determinations import DeterminationFailure, Source
from jobctrl.domain.materials.use_cases import TailoringLlmPolicy
from jobctrl.domain.ports.claim_verification import ArtifactLine
from jobctrl.domain.ports.llm import LlmFailure
from jobctrl.scoring import tailor
from tests.test_artifact_determinations import Model, connection, ports


@pytest.mark.parametrize("model_spec", ["default", "google:chosen-reviewer"])
def test_selected_judge_controls_verdict_and_receipt(monkeypatch, model_spec):
    conn = connection()
    default = Model(quality="fail")
    default.provider_id, default.model = "codex", "generator-default"
    selected = []

    class SelectedAdapter(Model):
        def __init__(self, *, default_model):
            super().__init__(quality="pass")
            self.provider_id, self.model = default_model.split(":", 1)
            selected.append(self)

    monkeypatch.setattr("jobctrl.infrastructure.llm.LlmAdapter", SelectedAdapter)
    monkeypatch.setattr(tailor, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor, "_build_voice_port", lambda: None)
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda **_: None)
    case = tailor._build_use_case(
        llm_port=default,
        llm_policy=TailoringLlmPolicy(candidate_models=("codex:generator-default",), judge_model=model_spec),
        analyze_use_case=SimpleNamespace(), pdf_renderer=SimpleNamespace(), job_interpreter=SimpleNamespace(),
    )
    line = ArtifactLine(line_id="owned", text="Owned current line", allowed_evidence_ids=["fact"], allowed_requirement_ids=[])
    result, envelope = case._quality_judge.judge(
        artifact_kind="resume", entity_id="owned", lines=[line],
        sources=[Source(source_id="fact", text="Owned fact")], rubric={},
    )
    expected = ("codex", "generator-default", "fail") if model_spec == "default" else ("google", "chosen-reviewer", "pass")
    assert (envelope.provider, envelope.model, result.verdict) == expected
    _, claim = case._claim_verifier.verify(
        artifact_kind="resume", entity_id="owned", lines=[line],
        evidence=[Source(source_id="fact", text="Owned fact")], requirements=[], rubric={},
    )
    assert (claim.provider, claim.model) == expected[:2]
    if model_spec == "default":
        assert not selected
    else:
        assert not default.calls
        assert [call[0] for call in selected[0].calls] == ["ArtifactQuality", "ClaimVerification"]


def test_unavailable_explicit_judge_does_not_call_the_default_model(monkeypatch):
    conn, default = connection(), Model()
    selected = []

    class UnavailableAdapter(Model):
        def __init__(self, *, default_model):
            super().__init__(fault=LlmFailure("provider_unavailable"))
            self.provider_id, self.model = default_model.split(":", 1)
            selected.append(self)

    monkeypatch.setattr("jobctrl.infrastructure.llm.LlmAdapter", UnavailableAdapter)
    monkeypatch.setattr(tailor, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor, "_build_voice_port", lambda: None)
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda **_: None)
    case = tailor._build_use_case(
        llm_port=default,
        llm_policy=TailoringLlmPolicy(candidate_models=("codex:generator-default",), judge_model="google:unavailable"),
        analyze_use_case=SimpleNamespace(), pdf_renderer=SimpleNamespace(), job_interpreter=SimpleNamespace(),
    )
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        case._quality_judge.judge(
            artifact_kind="resume", entity_id="owned", lines=[], sources=[], rubric={},
        )
    assert not default.calls
    assert len(selected[0].calls) == 1


def test_explicitly_injected_review_ports_are_preserved(monkeypatch):
    conn, model = connection(), Model()
    verifier, judge = ports(conn, model)

    def unexpected_adapter(**_):
        raise AssertionError("Injected review ports must not construct another SDK adapter")

    monkeypatch.setattr("jobctrl.infrastructure.llm.LlmAdapter", unexpected_adapter)
    monkeypatch.setattr(tailor, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor, "_build_voice_port", lambda: None)
    case = tailor._build_use_case(
        llm_port=model, claim_verifier=verifier, quality_judge=judge,
        llm_policy=TailoringLlmPolicy(candidate_models=("codex:generator-default",), judge_model="google:chosen-reviewer"),
        analyze_use_case=SimpleNamespace(), pdf_renderer=SimpleNamespace(), job_interpreter=SimpleNamespace(),
    )
    assert case._claim_verifier is verifier
    assert case._quality_judge is judge
