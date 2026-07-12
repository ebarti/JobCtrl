"""Provider-neutral employer-analysis synthesis via ``LlmPort``."""

from __future__ import annotations

import asyncio
import json

from jobctrl.domain.materials.analysis import JobAnalysis, JobAnalysisDraft
from jobctrl.domain.ports.llm import LlmMessage, LlmPort
from jobctrl.infrastructure.analysis.prompts import build_synthesizer_user_prompt


class LlmAnalysisSynthesizer:
    """Reconcile surviving ensemble drafts with the selected core provider."""

    def __init__(self, *, llm: LlmPort, provider_id: str, model: str) -> None:
        self._llm = llm
        self._provider_id = provider_id
        self._model = model

    @property
    def model_id(self) -> str:
        return f"{self._provider_id}:{self._model}"

    async def reconcile(
        self,
        system_prompt: str,
        *,
        drafts: tuple[JobAnalysisDraft, ...],
        jd_snapshot: str,
    ) -> JobAnalysis:
        drafts_json = json.dumps(
            [draft.model_dump() for draft in drafts],
            ensure_ascii=False,
        )
        prompt = build_synthesizer_user_prompt(
            drafts_json=drafts_json,
            jd_snapshot=jd_snapshot,
        )
        payload = await asyncio.to_thread(
            self._llm.chat_json,
            [
                LlmMessage(role="system", content=system_prompt),
                LlmMessage(role="user", content=prompt),
            ],
            response_schema=JobAnalysis.model_json_schema(),
        )
        return JobAnalysis.model_validate(payload)


__all__ = ["LlmAnalysisSynthesizer"]
