"""Google Antigravity (Gemini) Agent SDK adapter — the 3rd ensemble leg.

Mirrors the mestre vendor-lane pattern (``mestre/vendor_lane/backends/
antigravity_sdk.py``): drive the official ``google-antigravity`` Python SDK
directly via a local ``Agent`` over a ``LocalAgentConfig``, force
JSON-schema-constrained output through ``response_schema``, drain the streamed
chunks, and read the parsed object off ``response.structured_output()``. This
gives the ensemble a Google-diverse 3rd leg alongside Claude + Codex.

Test-mockability (no live auth in tests — D-04): the ``Agent`` class, the
``LocalAgentConfig`` class, and the ``types`` module are each resolved through
injectable factories/handles that default to a lazy import, so tests pass a
fake agent context-manager whose response yields a canned structured payload.
No live Gemini key / network call is needed in the suite.

Schema nuance (live-probed): Gemini REJECTS ``additionalProperties`` — the
opposite of Codex strict mode — so the schema is passed through
``gemini_json_schema`` (strip ``additionalProperties``/``$schema``, map
``[T, "null"]`` -> ``nullable``) and serialised with ``json.dumps(..., sort_keys=True)``.

No timeout / no turn cap (D-19): the chat is awaited to completion; the only
stop is cooperative cancellation of the wrapping asyncio task. ``save_dir`` /
``app_data_dir`` are per-process runtime directories created ``0700``.
"""

from __future__ import annotations

import json
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from jobctrl.domain.materials.analysis import (
    JobAnalysis,
    JobAnalysisDraft,
)
from jobctrl.infrastructure.analysis.gemini_schema import gemini_json_schema
from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
from jobctrl.infrastructure.setup_probes import antigravity_auth_kwargs

# An ``Agent`` factory: (config) -> async-context-manager agent.
AgentFactory = Callable[[Any], Any]
# A ``LocalAgentConfig`` factory: (**kwargs) -> config object.
ConfigFactory = Callable[..., Any]

# Top current Gemini model behind Antigravity. ``gemini-3.5-flash`` is the
# SDK's ``types.DEFAULT_MODEL`` and the live-probed working id; ``gemini-3-pro``
# 404s on the current key. Swappable via the ``model`` ctor arg if a newer id
# becomes available — re-confirm against the SDK at impl time, model ids drift.
ANTIGRAVITY_ANALYSIS_MODEL = "gemini-3.5-flash"

# OTel instrumentation scope for the Antigravity draft leg's generation span.
_ANTIGRAVITY_SCOPE = "jobctrl.analysis.antigravity"

# Where the local Antigravity agent persists session + app state. Per-process,
# 0700, under the OS temp dir so the suite and live runs never collide with a
# user's real Antigravity IDE state.
_RUNTIME_DIR_NAME = "jobctrl-antigravity"


def _load_agent_factory() -> AgentFactory:
    """Lazy-import ``google.antigravity.agent.Agent`` so the package imports without it."""
    from google.antigravity.agent import Agent  # type: ignore[import-untyped]

    return Agent


def _load_config_factory() -> ConfigFactory:
    """Lazy-import ``LocalAgentConfig`` so the package imports without the SDK."""
    from google.antigravity.connections.local.local_connection_config import (  # type: ignore[import-untyped]
        LocalAgentConfig,
    )

    return LocalAgentConfig


def _load_types_module() -> Any:
    """Lazy-import the ``google.antigravity.types`` module (enums + config types)."""
    from google.antigravity import types  # type: ignore[import-untyped]

    return types


def _runtime_subdir(name: str) -> str:
    """Return a per-process 0700 runtime dir for the local agent's state."""
    base = Path(tempfile.gettempdir()) / _RUNTIME_DIR_NAME
    path = base / name
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    # parents= keeps the existing mode on pre-existing dirs; re-assert 0700.
    base.chmod(0o700)
    path.chmod(0o700)
    return str(path)


class AntigravityAnalysisAdapter:
    """Google Antigravity (Gemini) Agent SDK draft leg (``AnalysisDraftPort``)."""

    def __init__(
        self,
        *,
        model: str = ANTIGRAVITY_ANALYSIS_MODEL,
        agent_factory: AgentFactory | None = None,
        config_factory: ConfigFactory | None = None,
        types_module: Any | None = None,
    ) -> None:
        self._model = model
        self._agent_factory = agent_factory
        self._config_factory = config_factory
        self._types_module = types_module

    @property
    def model_id(self) -> str:
        return self._model

    def _build_config(self, config_factory: ConfigFactory, types_module: Any, *, system_prompt: str) -> Any:
        # Constrain output to the analysis schema. Gemini rejects
        # additionalProperties, so serialise the Gemini-adapted schema.
        response_schema = json.dumps(
            gemini_json_schema(JobAnalysis.model_json_schema()),
            sort_keys=True,
        )
        return config_factory(
            model=self._model,
            system_instructions=system_prompt,
            # Constrained extraction only — the single built-in FINISH tool, no
            # file/shell/workspace tools.
            capabilities=types_module.CapabilitiesConfig(
                enabled_tools=[types_module.BuiltinTools.FINISH]
            ),
            policies=[],
            workspaces=[],
            response_schema=response_schema,
            save_dir=_runtime_subdir("sessions"),
            app_data_dir=_runtime_subdir("appdata"),
            **antigravity_auth_kwargs(),
        )

    async def draft(self, system_prompt: str, jd_snapshot: str) -> JobAnalysisDraft:
        agent_factory = self._agent_factory or _load_agent_factory()
        config_factory = self._config_factory or _load_config_factory()
        types_module = self._types_module or _load_types_module()

        config = self._build_config(config_factory, types_module, system_prompt=system_prompt)

        span_input = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": jd_snapshot},
        ]
        with llm_generation_span(
            model=self._model,
            messages=span_input,
            params={},
            scope_name=_ANTIGRAVITY_SCOPE,
        ) as record:
            async with agent_factory(config) as agent:
                response = await agent.chat(jd_snapshot)
                # The chunk stream MUST be drained before structured_output() resolves.
                async for _chunk in response.chunks:
                    pass
                structured = await response.structured_output()
                usage_metadata = getattr(response, "usage_metadata", None)

            if structured is None:
                raise RuntimeError(
                    "Antigravity (Gemini) returned no structured output for response_schema"
                )
            if not isinstance(structured, dict):
                # Tolerate a JSON string shape; a non-object payload is a hard fail.
                structured = json.loads(structured)
            if not isinstance(structured, dict):
                raise RuntimeError("Antigravity (Gemini) structured output was not a JSON object")

            input_tokens, output_tokens = _usage_from_metadata(usage_metadata)
            record(
                json.dumps(structured, ensure_ascii=False),
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
            analysis = JobAnalysis.model_validate(structured)
            return JobAnalysisDraft(model_id=self._model, **analysis.model_dump())


def _optional_int(value: Any) -> int | None:
    """Coerce an SDK usage field to ``int``, or ``None`` when absent/unparseable."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _usage_from_metadata(usage_metadata: Any) -> tuple[int | None, int | None]:
    """Best-effort ``(input_tokens, output_tokens)`` from Gemini ``usage_metadata``.

    ``prompt_token_count`` is the total input the model processed (cached tokens
    included); output is the visible ``candidates_token_count`` plus the
    ``thoughts_token_count`` reasoning tokens. Returns ``(None, None)`` when the
    SDK surfaced no usage so the span omits token counts rather than fabricating.
    """
    if usage_metadata is None:
        return None, None
    prompt = _optional_int(getattr(usage_metadata, "prompt_token_count", None))
    candidates = _optional_int(getattr(usage_metadata, "candidates_token_count", None)) or 0
    thoughts = _optional_int(getattr(usage_metadata, "thoughts_token_count", None)) or 0
    return prompt, ((candidates + thoughts) or None)


__all__ = [
    "ANTIGRAVITY_ANALYSIS_MODEL",
    "AntigravityAnalysisAdapter",
]
