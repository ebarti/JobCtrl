"""Codex SDK adapter for employer analysis — one ensemble draft leg.

Mirrors the mestre vendor-lane pattern (``mestre/vendor_lane/backends/
codex_sdk.py``): drive the official ``openai_codex`` Python SDK directly (no
Node sidecar, no CLI-subprocess wrapper), forcing JSON-schema-constrained
output via ``output_schema`` on ``thread.run`` and parsing the structured
result off ``TurnResult.final_response``.

CODEX_HOME isolation: the live factory redirects the Codex SDK's ``CODEX_HOME``
to an isolated dir under the JobHunter runtime root (``~/.jobhunter/codex_home``)
seeded with a copy of the user's effective ``CODEX_HOME/auth.json`` (default
``~/.codex/auth.json``), so Codex session rollouts never land in — and pollute
— the user's real Codex chat history. The SDK merges ``CodexConfig.env`` over
the parent environment, so only ``CODEX_HOME`` is overridden; PATH/HOME/etc.
are preserved.

Test-mockability (no live auth in tests — D-04): the ``AsyncCodex`` class is
resolved through an injectable factory that defaults to a lazy import, so tests
pass a fake context-manager whose thread returns a canned ``final_response``.
No live Codex login / app-server is needed in the suite.

No timeout (D-19): ``thread.run`` is awaited to completion; effort is pinned to
``high`` (D-18). Cancellation = cancel the wrapping asyncio task.
"""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from jobhunter.domain.materials.analysis import (
    JobAnalysis,
    JobAnalysisDraft,
)
from jobhunter.infrastructure.analysis.strict_schema import strict_json_schema
from jobhunter.infrastructure.observability.llm_spans import llm_generation_span
from jobhunter.infrastructure.setup_probes import codex_auth_path, resolve_codex_binary

AsyncCodexFactory = Callable[[], Any]

# Top current Codex model (gpt-5.5) + max reasoning effort (D-18). Matches
# mestre's vendor-lane default for the Codex leg.
CODEX_ANALYSIS_MODEL = "gpt-5.5"

# OTel instrumentation scope for the Codex draft leg's generation span.
_CODEX_SCOPE = "jobhunter.analysis.codex"

# Disable Codex plugins/apps so the isolated home only ever holds JobHunter's
# analysis rollouts + the copied auth token (mirrors mestre's vendor lane).
_CODEX_CONFIG_OVERRIDES = ("features.plugins=false", "features.apps=false")
# Isolated Codex home lives under the JobHunter runtime root, NOT ``~/.codex``.
_CODEX_HOME_DIRNAME = "codex_home"


def _isolated_codex_home() -> Path:
    """Return ``<JOBHUNTER_DIR>/codex_home`` (config imported lazily to avoid cycles)."""
    from jobhunter.config import APP_DIR

    return APP_DIR / _CODEX_HOME_DIRNAME


def _copy_newer_file(source: Path, target: Path, *, mode: int | None = None) -> bool:
    """Copy ``source`` to ``target`` when it is newer or ``target`` is missing.

    Returns ``True`` when a copy happened, ``False`` otherwise. When ``source``
    is missing but ``target`` exists, the target is still re-chmod'd (if ``mode``
    is given) so a stale copy keeps its locked-down permissions.
    """
    if not source.exists():
        if target.exists() and mode is not None:
            target.chmod(mode)
        return False
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.parent.chmod(0o700)
    if target.exists() and target.stat().st_mtime >= source.stat().st_mtime:
        if mode is not None:
            target.chmod(mode)
        return False
    shutil.copy2(source, target)
    if mode is not None:
        target.chmod(mode)
    return True


def _prepare_isolated_codex_home() -> Path:
    """Create the isolated Codex home and refresh auth from the user's real login."""
    home = _isolated_codex_home()
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    home.chmod(0o700)
    # The copied auth token is sensitive; lock it to 0600. Honor CODEX_HOME
    # for users who enrolled Codex outside the default ~/.codex directory.
    _copy_newer_file(codex_auth_path(), home / "auth.json", mode=0o600)
    return home


def _isolated_codex_env(codex_home: Path) -> dict[str, str]:
    """Return the minimal env override; the SDK merges this over ``os.environ``."""
    return {"CODEX_HOME": str(codex_home)}


def _load_async_codex_factory() -> AsyncCodexFactory:
    """Build an isolated ``AsyncCodex`` CM: redirect ``CODEX_HOME`` so Codex
    session rollouts never land in the user's real ``~/.codex``.

    Lazy-imports ``openai_codex`` so the package imports without it installed.
    """
    from openai_codex import AsyncCodex, CodexConfig  # type: ignore[import-untyped]

    def _make() -> Any:
        codex_home = _prepare_isolated_codex_home()
        config_kwargs: dict[str, Any] = {
            "env": _isolated_codex_env(codex_home),
            "config_overrides": _CODEX_CONFIG_OVERRIDES,
        }
        # Prefer the SDK-pinned bundled runtime. A system ``codex`` on PATH may
        # speak a different app-server protocol; JOBHUNTER_CODEX_BIN is the
        # explicit escape hatch for setup-managed platform fallbacks.
        config_kwargs["codex_bin"] = str(resolve_codex_binary())
        return AsyncCodex(config=CodexConfig(**config_kwargs))

    return _make


def _load_sandbox_read_only() -> Any:
    """Return the read-only sandbox enum value, tolerating SDK shape drift."""
    try:
        from openai_codex import Sandbox  # type: ignore[import-untyped]
    except ImportError:
        return "read-only"
    try:
        return Sandbox.read_only
    except AttributeError:
        return Sandbox("read-only")


class CodexAnalysisAdapter:
    """Codex SDK draft leg (``AnalysisDraftPort``)."""

    def __init__(
        self,
        *,
        model: str = CODEX_ANALYSIS_MODEL,
        async_codex_factory: AsyncCodexFactory | None = None,
    ) -> None:
        self._model = model
        self._async_codex_factory = async_codex_factory

    @property
    def model_id(self) -> str:
        return self._model

    async def draft(self, system_prompt: str, jd_snapshot: str) -> JobAnalysisDraft:
        factory = self._async_codex_factory or _load_async_codex_factory()
        prompt = f"{system_prompt}\n\nJOB DESCRIPTION:\n{jd_snapshot}"
        span_input = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": jd_snapshot},
        ]
        with llm_generation_span(
            model=self._model,
            messages=span_input,
            params={},
            scope_name=_CODEX_SCOPE,
        ) as record:
            async with factory() as codex:  # reuses existing Codex login (D-04)
                thread = await codex.thread_start(
                    model=self._model,
                    # Max reasoning effort (D-18); analysis reads the JD, no FS writes.
                    config={"model_reasoning_effort": "high"},
                    sandbox=_load_sandbox_read_only(),
                )
                result = await thread.run(
                    prompt,
                    # Codex/OpenAI strict structured output requires every object to
                    # set additionalProperties:false and list all props in required;
                    # Pydantic's model_json_schema() emits neither (live 400 otherwise).
                    output_schema=strict_json_schema(JobAnalysis.model_json_schema()),
                    effort="high",
                )
            # ``status`` is a ``TurnStatus`` enum whose ``str()`` is
            # "TurnStatus.completed" — compare its ``.value`` ("completed"), not the
            # enum repr, or a successful turn is wrongly rejected (live-caught bug).
            status_obj = getattr(result, "status", None)
            status = str(getattr(status_obj, "value", status_obj) or "")
            final_response = getattr(result, "final_response", None)
            if (status and status != "completed") or not final_response:
                error = getattr(result, "error", None)
                raise RuntimeError(f"Codex turn failed: status={status!r} err={error!r}")
            input_tokens, output_tokens = _usage_from_result(result)
            record(final_response, input_tokens=input_tokens, output_tokens=output_tokens)
            analysis = JobAnalysis.model_validate_json(final_response)
            return JobAnalysisDraft(model_id=self._model, **analysis.model_dump())


def _optional_int(value: Any) -> int | None:
    """Coerce an SDK usage field to ``int``, or ``None`` when absent/unparseable."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _usage_from_result(result: Any) -> tuple[int | None, int | None]:
    """Best-effort ``(input_tokens, output_tokens)`` from a Codex ``TurnResult``.

    Codex reports cumulative token usage on ``result.usage.total``. Returns
    ``(None, None)`` when the SDK surfaced no usage so the span omits token
    counts rather than fabricating them.
    """
    total = getattr(getattr(result, "usage", None), "total", None)
    if total is None:
        return None, None
    return (
        _optional_int(getattr(total, "input_tokens", None)),
        _optional_int(getattr(total, "output_tokens", None)),
    )


__all__ = [
    "CODEX_ANALYSIS_MODEL",
    "CodexAnalysisAdapter",
]
