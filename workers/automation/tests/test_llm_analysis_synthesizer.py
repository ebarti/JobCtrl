"""Provider-neutral employer-analysis synthesis."""

from __future__ import annotations

import pytest

from jobctrl.domain.materials.analysis import JobAnalysisDraft
from jobctrl.infrastructure.analysis.llm_analysis_synthesizer import LlmAnalysisSynthesizer

ANALYSIS = {
    "role_framing": "Own the payments platform.",
    "inferred_seniority": "staff",
    "ideal_candidate_narrative": "A distributed-systems owner.",
    "requirements": [
        {
            "id": "r1",
            "text": "Go",
            "tier": "must_have",
            "weight": 1.0,
            "evidence_span": "Go",
        }
    ],
    "keywords": [],
}


class _FakeLlm:
    def __init__(self) -> None:
        self.calls = []

    def chat_json(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        return ANALYSIS


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["codex", "google"])
async def test_non_claude_provider_can_synthesize(provider: str) -> None:
    llm = _FakeLlm()
    draft = JobAnalysisDraft(model_id=f"{provider}:draft", **ANALYSIS)
    synth = LlmAnalysisSynthesizer(llm=llm, provider_id=provider, model="test-model")

    result = await synth.reconcile(
        "reconcile",
        drafts=(draft,),
        jd_snapshot="Staff engineer using Go",
    )

    assert result.requirements[0].text == "Go"
    assert synth.model_id == f"{provider}:test-model"
    assert len(llm.calls) == 1
