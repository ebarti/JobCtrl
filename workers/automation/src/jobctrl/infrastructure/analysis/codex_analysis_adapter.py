"""Codex SDK adapter for employer analysis — one ensemble draft leg.

Mirrors the mestre vendor-lane pattern (``mestre/vendor_lane/backends/
codex_sdk.py``): drive the official ``openai_codex`` Python SDK directly (no
Node sidecar, no CLI-subprocess wrapper), forcing JSON-schema-constrained
output via ``output_schema`` and consuming the public turn stream. This keeps
the SDK's structured ``TurnError`` available without serializing provider text.

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

No timeout (D-19): the public turn stream is awaited to completion; effort is
pinned to ``high`` (D-18). Cancellation = cancel the wrapping asyncio task.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jobctrl.domain.materials.analysis import (
    JobAnalysis,
    JobAnalysisDraft,
)
from jobctrl.infrastructure.analysis.strict_schema import strict_json_schema
from jobctrl.infrastructure.llm.codex_turn import run_codex_turn
from jobctrl.infrastructure.llm.provider_errors import ProviderCallError, provider_exception_error
from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
from jobctrl.infrastructure.setup_probes import (
    CODEX_NEUTRALIZED_AUTH_ENV,
    ensure_jobctrl_codex_auth,
    ensure_private_directory,
    jobctrl_codex_home,
    resolve_codex_binary,
)
from jobctrl.runtime import is_bundled_runtime

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
_CODEX_STATIC_CONFIG_OVERRIDES = (
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
)
_CODEX_WORKSPACE_DIRNAME = "workspace"
_CODEX_PROCESS_HOME_DIRNAME = "home"


@dataclass(frozen=True)
class _CodexHomeDirs:
    codex_home: Path
    workdir: Path
    process_home: Path


def _isolated_codex_home() -> Path:
    """Return the JobCtrl-owned Codex home used by analysis app-server sessions."""
    return jobctrl_codex_home()


def _prepare_isolated_codex_home(*, ensure_auth: bool = True) -> _CodexHomeDirs:
    """Create the stable isolated home and optionally enroll persisted auth.

    Generation keeps the historical one-time enrollment behavior. Read-only
    catalog discovery passes ``ensure_auth=False`` so listing models can use an
    already-ready JobCtrl-owned session without copying ambient credentials.
    """

    codex_home = _isolated_codex_home()
    if ensure_auth:
        ensure_jobctrl_codex_auth()
    ensure_private_directory(codex_home.parent)
    ensure_private_directory(codex_home, parent=codex_home.parent)
    workdir = codex_home / _CODEX_WORKSPACE_DIRNAME
    process_home = codex_home / _CODEX_PROCESS_HOME_DIRNAME
    for directory in (workdir, process_home):
        ensure_private_directory(directory, parent=codex_home)
    return _CodexHomeDirs(
        codex_home=codex_home,
        workdir=workdir,
        process_home=process_home,
    )


def _isolated_codex_env(codex_home: Path, process_home: Path) -> dict[str, str]:
    """Return the minimal env override; the SDK merges this over ``os.environ``."""

    env = {
        "CODEX_HOME": str(codex_home),
        "HOME": str(process_home),
        **{key: "" for key in CODEX_NEUTRALIZED_AUTH_ENV},
    }
    if os.name == "nt":
        env["USERPROFILE"] = str(process_home)
    return env


def _canonical_codex_binary() -> Path:
    """Resolve one executable file trusted by the selected Codex runtime.

    ``resolve_codex_binary`` owns provider-pack verification in bundled mode and
    the explicit source-install override policy. The sandbox must receive its
    exact canonical executable path, rather than a directory that could expose
    sibling package files or be retargeted through a symlink.
    """

    configured = Path(resolve_codex_binary())
    try:
        binary = configured.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise RuntimeError(f"Codex binary could not be canonicalized: {configured}") from exc
    if not binary.is_file():
        raise RuntimeError(f"Codex binary is not a regular file: {binary}")
    if not os.access(binary, os.X_OK):
        raise RuntimeError(f"Codex binary is not executable: {binary}")
    return binary


def _codex_permission_profile_override(codex_binary: Path) -> str:
    """Grant the sandbox read access to only the canonical Codex executable.

    The value is a TOML command-line override. JSON string encoding is valid for
    TOML basic strings and prevents a quote or backslash in an operator-provided
    source-install path from changing the surrounding permissions structure.
    """

    quoted_binary = json.dumps(str(codex_binary))
    return (
        f"permissions.{_CODEX_PERMISSION_PROFILE}="
        '{filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"},'
        f"{quoted_binary}=\"read\"}},"
        "network={enabled=false}}"
    )


def _codex_config_overrides(codex_binary: Path) -> tuple[str, ...]:
    """Build the immutable Codex configuration for one canonical executable."""

    return (*_CODEX_STATIC_CONFIG_OVERRIDES, _codex_permission_profile_override(codex_binary))


def _codex_config_kwargs(dirs: _CodexHomeDirs) -> dict[str, Any]:
    """Build one SDK configuration bound to the exact sandbox-permitted binary."""

    codex_binary = _canonical_codex_binary()
    return {
        "cwd": str(dirs.workdir),
        "env": _isolated_codex_env(dirs.codex_home, dirs.process_home),
        "config_overrides": _codex_config_overrides(codex_binary),
        "codex_bin": str(codex_binary),
    }


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
        return AsyncCodex(config=CodexConfig(**_codex_config_kwargs(dirs)))

    return _make


def _load_catalog_async_codex_factory() -> AsyncCodexFactory:
    """Build the isolated SDK client for secret-free live model discovery.

    Provider readiness already proves that the JobCtrl-owned auth file exists.
    This read path deliberately does not call ``ensure_jobctrl_codex_auth`` and
    therefore cannot import ambient user auth as a side effect.
    """

    from jobctrl.runtime import activate_provider_pack

    if is_bundled_runtime():
        from jobctrl.config import APP_DIR

        activate_provider_pack("codex-provider-runtime", app_dir=APP_DIR)
    from openai_codex import AsyncCodex, CodexConfig  # type: ignore[import-untyped]

    def _make() -> Any:
        dirs = _prepare_isolated_codex_home(ensure_auth=False)
        return AsyncCodex(config=CodexConfig(**_codex_config_kwargs(dirs)))

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
            params={"structured": True},
            scope_name=_CODEX_SCOPE,
        ) as record:
            try:
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
                    outcome = await run_codex_turn(
                        thread,
                        prompt,
                        model=self._model,
                        operation="chat_json",
                        run_kwargs={
                            # Codex/OpenAI strict structured output requires every object
                            # to set additionalProperties:false and list all props in
                            # required; Pydantic's model_json_schema() emits neither.
                            "output_schema": strict_json_schema(JobAnalysis.model_json_schema()),
                            "effort": "high",
                        },
                    )
            except ProviderCallError:
                raise
            except Exception as exc:  # noqa: BLE001 - preserve only safe provider fields
                raise provider_exception_error(
                    provider="openai",
                    model=self._model,
                    operation="chat_json",
                    error=exc,
                ) from exc
            record(
                outcome.final_response,
                input_tokens=outcome.input_tokens,
                output_tokens=outcome.output_tokens,
            )
            analysis = JobAnalysis.model_validate_json(outcome.final_response)
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
