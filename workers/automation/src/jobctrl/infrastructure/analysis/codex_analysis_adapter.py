"""Codex SDK adapter for employer analysis — one ensemble draft leg.

Mirrors the mestre vendor-lane pattern (``mestre/vendor_lane/backends/
codex_sdk.py``): drive the official ``openai_codex`` Python SDK directly (no
Node sidecar, no CLI-subprocess wrapper), forcing JSON-schema-constrained
output via ``output_schema`` on ``thread.run`` and parsing the structured
result off ``TurnResult.final_response``.

Codex isolation + permissions: the live factory redirects the SDK to a
JobCtrl-owned ``CODEX_HOME`` so Codex app-server state does not pollute the
user's normal Codex app history. Prompt-driven commands run from the dedicated
``CODEX_HOME/workspace`` directory under a Codex permissions profile that denies
root filesystem reads and grants only that workspace plus Codex's minimal
runtime paths.

Test-mockability (no live auth in tests — D-04): the ``AsyncCodex`` class is
resolved through an injectable factory that defaults to a lazy import, so tests
pass a fake context-manager whose thread returns a canned ``final_response``.
No live Codex login / app-server is needed in the suite.

No timeout (D-19): ``thread.run`` is awaited to completion; effort is pinned to
``high`` (D-18). Cancellation = cancel the wrapping asyncio task.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jobctrl.domain.materials.analysis import (
    JobAnalysis,
    JobAnalysisDraft,
)
from jobctrl.infrastructure.analysis.strict_schema import strict_json_schema
from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
from jobctrl.infrastructure.setup_probes import codex_auth_path, resolve_codex_binary
from jobctrl.runtime import is_bundled_runtime, provider_runtime_home

AsyncCodexFactory = Callable[[], Any]

# Top current Codex model (gpt-5.5) + max reasoning effort (D-18). Matches
# mestre's vendor-lane default for the Codex leg.
CODEX_ANALYSIS_MODEL = "gpt-5.5"

# OTel instrumentation scope for the Codex draft leg's generation span.
_CODEX_SCOPE = "jobctrl.analysis.codex"

# Disable Codex plugins/apps and force prompt-driven commands into a minimal
# read-only permissions profile. The profile is supplied as a TOML CLI override
# because openai-codex==0.1.0b3 exposes only legacy Sandbox presets in its
# public Python wrapper, while the pinned app-server runtime supports
# default_permissions profiles.
_CODEX_PERMISSION_PROFILE = "jobctrl-analysis-readonly"
_CODEX_PERMISSION_PROFILE_OVERRIDE = (
    f"permissions.{_CODEX_PERMISSION_PROFILE}="
    '{filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}},'
    "network={enabled=false}}"
)
_CODEX_CONFIG_OVERRIDES = (
    "features.plugins=false",
    "features.apps=false",
    # Employer analysis is a pure structured-generation call. Do not expose a
    # shell to the model, and keep command children empty even if a future SDK
    # or model accidentally contributes one. The app-server itself still
    # receives provider auth through CodexConfig.env.
    "features.shell_tool=false",
    "allow_login_shell=false",
    'shell_environment_policy={inherit="none"}',
    f'default_permissions="{_CODEX_PERMISSION_PROFILE}"',
    _CODEX_PERMISSION_PROFILE_OVERRIDE,
)
_CODEX_BUNDLED_AUTH_OVERRIDES = (
    'forced_login_method="api"',
    'cli_auth_credentials_store="ephemeral"',
)
_CODEX_BUNDLED_NEUTRALIZED_AUTH_ENV = (
    "CODEX_ACCESS_TOKEN",
    "CODEX_AGENT_IDENTITY_AUTH",
    "CODEX_API_KEY",
    "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
    "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
)
_CODEX_HOME_DIRNAME = "codex_home"
_CODEX_WORKSPACE_DIRNAME = "workspace"
_CODEX_PROCESS_HOME_DIRNAME = "home"


@dataclass(frozen=True)
class _CodexHomeDirs:
    codex_home: Path
    workdir: Path
    process_home: Path


def _isolated_codex_home() -> Path:
    """Return the JobCtrl-owned Codex home used by analysis app-server sessions."""
    from jobctrl.config import APP_DIR

    if is_bundled_runtime():
        return provider_runtime_home("codex", app_dir=APP_DIR)
    return APP_DIR / _CODEX_HOME_DIRNAME


def _copy_codex_auth(source: Path, target: Path) -> None:
    """Copy Codex auth into the JobCtrl-owned SDK home when a source auth exists."""

    if not source.exists():
        return
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.parent.chmod(0o700)
    if source.resolve() == target.resolve():
        target.chmod(0o600)
        return
    shutil.copy2(source, target)
    target.chmod(0o600)


def _prepare_isolated_codex_home() -> _CodexHomeDirs:
    """Create an isolated Codex home under the source or bundled auth policy."""

    codex_home = _isolated_codex_home()
    codex_home.mkdir(mode=0o700, parents=True, exist_ok=True)
    codex_home.chmod(0o700)
    workdir = codex_home / _CODEX_WORKSPACE_DIRNAME
    process_home = codex_home / _CODEX_PROCESS_HOME_DIRNAME
    for directory in (workdir, process_home):
        directory.mkdir(mode=0o700, exist_ok=True)
        directory.chmod(0o700)
    auth_target = codex_home / "auth.json"
    if is_bundled_runtime():
        if not os.environ.get("OPENAI_API_KEY", "").strip():
            raise RuntimeError(
                "bundled Codex analysis requires OPENAI_API_KEY and does not reuse auth.json"
            )
        # Never allow a stale copy or consumer login to become a bundled
        # credential source. Fail closed instead of reading or silently reusing
        # any auth.json placed in this separate provider-runtime home.
        if auth_target.exists() or auth_target.is_symlink():
            raise RuntimeError(f"bundled Codex refuses auth.json credentials: {auth_target}")
    else:
        _copy_codex_auth(codex_auth_path(), auth_target)
    return _CodexHomeDirs(
        codex_home=codex_home,
        workdir=workdir,
        process_home=process_home,
    )


def _isolated_codex_env(codex_home: Path, process_home: Path) -> dict[str, str]:
    """Return the minimal env override; the SDK merges this over ``os.environ``."""

    env = {"CODEX_HOME": str(codex_home), "HOME": str(process_home)}
    if is_bundled_runtime():
        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                "bundled Codex analysis requires OPENAI_API_KEY and does not reuse auth.json"
            )
        env["OPENAI_API_KEY"] = api_key
        env.update({key: "" for key in _CODEX_BUNDLED_NEUTRALIZED_AUTH_ENV})
    if os.name == "nt":
        env["USERPROFILE"] = str(process_home)
    return env


def _load_async_codex_factory() -> AsyncCodexFactory:
    """Build an ``AsyncCodex`` CM with a locked-down command permissions profile.

    Lazy-imports ``openai_codex`` so the package imports without it installed.
    """
    from jobctrl.runtime import activate_provider_pack

    if is_bundled_runtime():
        from jobctrl.config import APP_DIR

        activate_provider_pack("codex-provider-runtime", app_dir=APP_DIR)
    from openai_codex import AsyncCodex, CodexConfig  # type: ignore[import-untyped]

    def _make() -> Any:
        dirs = _prepare_isolated_codex_home()
        config_kwargs: dict[str, Any] = {
            "cwd": str(dirs.workdir),
            "env": _isolated_codex_env(dirs.codex_home, dirs.process_home),
            "config_overrides": _CODEX_CONFIG_OVERRIDES
            + (_CODEX_BUNDLED_AUTH_OVERRIDES if is_bundled_runtime() else ()),
        }
        # Prefer the SDK-pinned bundled runtime. A system ``codex`` on PATH may
        # speak a different app-server protocol; JOBCTRL_CODEX_BIN is the
        # explicit escape hatch for setup-managed platform fallbacks.
        config_kwargs["codex_bin"] = str(resolve_codex_binary())
        return AsyncCodex(config=CodexConfig(**config_kwargs))

    return _make


def _deny_all_approval_mode() -> Any:
    """Resolve the SDK enum lazily after the bundled provider pack is active."""

    from openai_codex import ApprovalMode  # type: ignore[import-untyped]

    return ApprovalMode.deny_all


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
                    # Analysis has no local-tool use case. Never auto-review or
                    # approve an escalation even if a future runtime exposes a
                    # tool despite the locked-down feature configuration.
                    approval_mode=_deny_all_approval_mode(),
                    model=self._model,
                    # Max reasoning effort (D-18). Command filesystem access is
                    # governed by the configured Codex permissions profile.
                    config={"model_reasoning_effort": "high"},
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
