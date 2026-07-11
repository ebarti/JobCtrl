"""Shared setup, auth, and vendor-runtime probes.

The installer and ``jobctrl doctor`` both need to answer the same questions:
which analysis legs are enabled, whether their pinned SDK runtimes are present,
and whether the user's local credential stores can authenticate those runtimes.
Keeping that logic here avoids letting setup and doctor drift.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from jobctrl.runtime import (
    RuntimeConfigurationError,
    activate_provider_pack,
    is_bundled_runtime,
    provider_runtime_home,
)

ANALYSIS_LEGS_ENV = "JOBCTRL_ANALYSIS_LEGS"
CODEX_BIN_ENV = "JOBCTRL_CODEX_BIN"
CLAUDE_BIN_ENV = "JOBCTRL_CLAUDE_BIN"

ANALYSIS_LEG_ORDER = ("claude", "codex", "antigravity")
_LEG_ALIASES = {
    "claude-code": "claude",
    "openai": "codex",
    "gemini": "antigravity",
    "google": "antigravity",
}

_CLAUDE_CLOUD_FLAGS = (
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
)
_CLAUDE_CONSUMER_AUTH_ENV = (
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "CCR_OAUTH_TOKEN_FILE",
    "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
    "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    "CLAUDE_TRUSTED_DEVICE_TOKEN",
)
_ANTIGRAVITY_CONSUMER_AUTH_ENV = (
    "ANTIGRAVITY_OAUTH_TOKEN",
    "GOOGLE_ANTIGRAVITY_OAUTH_TOKEN",
    "GOOGLE_ANTIGRAVITY_SESSION",
)


@dataclass(frozen=True)
class ProbeResult:
    """One setup/doctor check result."""

    name: str
    ok: bool
    note: str
    required: bool = True


def _env(env: Mapping[str, str] | None = None) -> Mapping[str, str]:
    return env if env is not None else os.environ


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def parse_enabled_analysis_legs(raw: str | None) -> tuple[str, ...]:
    """Parse the enabled ensemble-leg list into a stable canonical order."""

    if raw is None or not raw.strip():
        return ANALYSIS_LEG_ORDER
    normalized: list[str] = []
    for part in raw.replace(";", ",").replace(" ", ",").split(","):
        value = part.strip().lower()
        if not value:
            continue
        value = _LEG_ALIASES.get(value, value)
        if value not in ANALYSIS_LEG_ORDER:
            valid = ", ".join(ANALYSIS_LEG_ORDER)
            raise ValueError(f"unknown analysis leg {part!r}; expected one of: {valid}")
        if value not in normalized:
            normalized.append(value)
    if not normalized:
        raise ValueError(f"{ANALYSIS_LEGS_ENV} must name at least one analysis leg")
    return tuple(leg for leg in ANALYSIS_LEG_ORDER if leg in normalized)


def enabled_analysis_legs(env: Mapping[str, str] | None = None) -> tuple[str, ...]:
    """Return the enabled employer-analysis legs from env, defaulting to all."""

    return parse_enabled_analysis_legs(_env(env).get(ANALYSIS_LEGS_ENV))


def analysis_sdk_set_version(legs: tuple[str, ...] | None = None) -> str:
    """Return the cache-key SDK-set version for the enabled leg set."""

    selected = legs or enabled_analysis_legs()
    return f"{'+'.join(selected)}-v1"


def effective_codex_home(env: Mapping[str, str] | None = None) -> Path:
    """Return the user Codex home whose ``auth.json`` authenticates the SDK."""

    raw = _env(env).get("CODEX_HOME")
    return Path(raw).expanduser() if raw else Path.home() / ".codex"


def codex_auth_path(env: Mapping[str, str] | None = None) -> Path:
    return effective_codex_home(env) / "auth.json"


def claude_config_dir(env: Mapping[str, str] | None = None) -> Path:
    raw = _env(env).get("CLAUDE_CONFIG_DIR")
    return Path(raw).expanduser() if raw else Path.home() / ".claude"


def claude_credentials_path(env: Mapping[str, str] | None = None) -> Path:
    return claude_config_dir(env) / ".credentials.json"


def _macos_claude_keychain_present() -> bool:
    if platform.system() != "Darwin" or shutil.which("security") is None:
        return False
    try:
        completed = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def probe_claude_auth(env: Mapping[str, str] | None = None) -> ProbeResult:
    values = _env(env)
    if values.get("ANTHROPIC_API_KEY"):
        return ProbeResult("Claude analysis auth", True, "ANTHROPIC_API_KEY")
    for key in _CLAUDE_CLOUD_FLAGS:
        if _truthy(values.get(key)):
            return ProbeResult("Claude analysis auth", True, key)
    if is_bundled_runtime(values):
        unsupported = next((key for key in _CLAUDE_CONSUMER_AUTH_ENV if values.get(key)), None)
        note = (
            f"{unsupported} is consumer OAuth and is not supported by bundled JobCtrl; "
            if unsupported
            else ""
        )
        return ProbeResult(
            "Claude analysis auth",
            False,
            note
            + "set ANTHROPIC_API_KEY or configure Claude Code for Bedrock, Vertex, or Foundry",
        )
    if values.get("ANTHROPIC_AUTH_TOKEN"):
        return ProbeResult("Claude analysis auth", True, "ANTHROPIC_AUTH_TOKEN")
    if values.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return ProbeResult("Claude analysis auth", True, "CLAUDE_CODE_OAUTH_TOKEN")
    credentials = claude_credentials_path(values)
    if credentials.exists():
        return ProbeResult("Claude analysis auth", True, f"local Claude credentials at {credentials}")
    if _macos_claude_keychain_present():
        return ProbeResult("Claude analysis auth", True, 'macOS Keychain "Claude Code-credentials"')
    return ProbeResult(
        "Claude analysis auth",
        False,
        "set ANTHROPIC_API_KEY or enroll local Claude credentials",
    )


def probe_claude_synthesis_auth(env: Mapping[str, str] | None = None) -> ProbeResult:
    """Claude auth for the always-on ensemble synthesizer (D-07).

    ``ClaudeAnalysisSynthesizer`` reconciles every employer-analysis run with the
    Claude Agent SDK regardless of ``JOBCTRL_ANALYSIS_LEGS``, so its auth is
    required even when the ``claude`` draft leg is disabled. Reuses the Claude
    credential resolution and only relabels the row + not-ready guidance.
    """

    result = probe_claude_auth(env)
    if result.ok:
        return ProbeResult("Claude synthesis auth", True, result.note)
    return ProbeResult(
        "Claude synthesis auth",
        False,
        "required for ensemble synthesis even when the claude leg is disabled; "
        + (
            "set ANTHROPIC_API_KEY or configure Bedrock, Vertex, or Foundry"
            if is_bundled_runtime(_env(env))
            else "set ANTHROPIC_API_KEY or enroll local Claude credentials"
        ),
    )


def bundled_claude_sdk_options(env: Mapping[str, str] | None = None) -> dict[str, object]:
    """Return SDK options that prevent consumer credential reuse in bundled mode."""

    values = _env(env)
    if not is_bundled_runtime(values):
        return {}
    probe = probe_claude_auth(values)
    if not probe.ok:
        raise RuntimeError(probe.note)
    from jobctrl.config import APP_DIR

    home = provider_runtime_home("claude", app_dir=APP_DIR)
    isolated_env = {
        "HOME": str(home),
        "CLAUDE_CONFIG_DIR": str(home / "config"),
        # The Claude SDK merges overrides over os.environ. Empty values
        # explicitly neutralize ambient consumer OAuth variables while the
        # supported API/cloud settings remain inherited.
        **{key: "" for key in _CLAUDE_CONSUMER_AUTH_ENV},
    }
    (home / "config").mkdir(mode=0o700, parents=True, exist_ok=True)
    return {
        "cwd": str(APP_DIR),
        "env": isolated_env,
        # `--bare` is the pinned Claude binary's explicit contract for no
        # Keychain, OAuth, settings, or consumer-account credential discovery.
        "extra_args": {"bare": None},
        "setting_sources": [],
    }


def bundled_claude_process_auth_env(
    env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return only supported Claude API/cloud auth for a direct child process."""

    values = _env(env)
    if not is_bundled_runtime(values):
        return {}
    probe = probe_claude_auth(values)
    if not probe.ok:
        raise RuntimeError(probe.note)
    prefixes = ("AWS_", "AZURE_", "ANTHROPIC_FOUNDRY_")
    explicit = {
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "ANTHROPIC_VERTEX_REGION",
        "CLOUD_ML_REGION",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_QUOTA_PROJECT",
        *_CLAUDE_CLOUD_FLAGS,
    }
    result = {
        key: value
        for key, value in values.items()
        if value and (key in explicit or key.startswith(prefixes))
    }
    from jobctrl.config import APP_DIR

    home = provider_runtime_home("claude", app_dir=APP_DIR)
    result.update({"HOME": str(home), "CLAUDE_CONFIG_DIR": str(home / "config")})
    (home / "config").mkdir(mode=0o700, parents=True, exist_ok=True)
    return result


def probe_codex_auth(env: Mapping[str, str] | None = None) -> ProbeResult:
    values = _env(env)
    if is_bundled_runtime(values):
        if values.get("OPENAI_API_KEY", "").strip():
            return ProbeResult("Codex analysis auth", True, "OPENAI_API_KEY")
        unsupported = "CODEX_API_KEY is not supported; " if values.get("CODEX_API_KEY") else ""
        return ProbeResult(
            "Codex analysis auth",
            False,
            unsupported
            + "set OPENAI_API_KEY; bundled JobCtrl does not read or copy CODEX_HOME/auth.json",
        )
    auth_path = codex_auth_path(values)
    if auth_path.exists():
        return ProbeResult("Codex analysis auth", True, f"auth.json at {auth_path}")
    if values.get("OPENAI_API_KEY") or values.get("CODEX_API_KEY"):
        return ProbeResult(
            "Codex analysis auth",
            False,
            "OpenAI key present but not enrolled; run setup to create CODEX_HOME/auth.json",
        )
    return ProbeResult(
        "Codex analysis auth",
        False,
        "run codex login or enroll an OpenAI key into CODEX_HOME/auth.json",
    )


def _adc_credentials_path(env: Mapping[str, str] | None = None) -> Path:
    values = _env(env)
    raw = values.get("GOOGLE_APPLICATION_CREDENTIALS")
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".config" / "gcloud" / "application_default_credentials.json"


def antigravity_auth_kwargs(env: Mapping[str, str] | None = None) -> dict[str, object]:
    """Return LocalAgentConfig auth kwargs for Antigravity or raise RuntimeError."""

    values = _env(env)
    api_key = values.get("GEMINI_API_KEY") or values.get("GOOGLE_API_KEY")
    if api_key:
        return {"api_key": api_key}

    vertex_requested = _truthy(values.get("GOOGLE_GENAI_USE_VERTEXAI")) or _truthy(values.get("GOOGLE_CLOUD_VERTEXAI"))
    adc_path = _adc_credentials_path(values)
    project = (
        values.get("GOOGLE_CLOUD_PROJECT")
        or values.get("GOOGLE_PROJECT_ID")
        or values.get("GCLOUD_PROJECT")
    )
    if vertex_requested and (project or adc_path.exists()):
        kwargs: dict[str, object] = {"vertex": True}
        if project:
            kwargs["project"] = project
        location = values.get("GOOGLE_CLOUD_LOCATION") or values.get("GOOGLE_VERTEX_LOCATION")
        if location:
            kwargs["location"] = location
        return kwargs

    unsupported = next(
        (key for key in _ANTIGRAVITY_CONSUMER_AUTH_ENV if values.get(key)),
        None,
    )
    unsupported_note = (
        f"; {unsupported} consumer/session credentials are not reused"
        if is_bundled_runtime(values) and unsupported
        else ""
    )
    raise RuntimeError(
        "Antigravity analysis auth requires GEMINI_API_KEY/GOOGLE_API_KEY, "
        "or Vertex AI ADC with GOOGLE_GENAI_USE_VERTEXAI=1"
        f"{unsupported_note}."
    )


def probe_antigravity_auth(env: Mapping[str, str] | None = None) -> ProbeResult:
    values = _env(env)
    if values.get("GEMINI_API_KEY"):
        return ProbeResult("Antigravity analysis auth", True, "GEMINI_API_KEY")
    if values.get("GOOGLE_API_KEY"):
        return ProbeResult("Antigravity analysis auth", True, "GOOGLE_API_KEY")
    try:
        kwargs = antigravity_auth_kwargs(values)
    except RuntimeError as exc:
        return ProbeResult("Antigravity analysis auth", False, str(exc))
    project = kwargs.get("project")
    location = kwargs.get("location")
    suffix = f" project={project}" if project else ""
    if location:
        suffix += f" location={location}"
    return ProbeResult("Antigravity analysis auth", True, f"Vertex AI ADC{suffix}")


def resolve_bundled_claude_path() -> Path:
    if is_bundled_runtime():
        from jobctrl.config import APP_DIR

        activate_provider_pack("claude-agent-sdk", app_dir=APP_DIR)
    module = importlib.import_module("claude_agent_sdk")
    return Path(module.__file__).resolve().parent / "_bundled" / "claude"


def resolve_claude_apply_binary(env: Mapping[str, str] | None = None) -> str:
    values = _env(env)
    override = values.get(CLAUDE_BIN_ENV)
    if override:
        # Expand ~ so a `~/...` override reaches Popen as a spawnable path, for
        # parity with resolve_codex_binary and the _has_claude_apply_runtime
        # existence probe (which both expanduser()).
        if is_bundled_runtime(values):
            raise RuntimeConfigurationError(
                f"{CLAUDE_BIN_ENV} overrides are disabled in bundled mode; "
                "the active hash-verified provider pack owns the Claude binary"
            )
        path = Path(override).expanduser()
        return str(path)
    if is_bundled_runtime(values):
        return str(resolve_bundled_claude_path())
    path_cli = shutil.which("claude")
    if path_cli:
        return path_cli
    bundled = resolve_bundled_claude_path()
    if bundled.exists():
        return str(bundled)
    return "claude"


def resolve_bundled_codex_path() -> Path:
    if is_bundled_runtime():
        from jobctrl.config import APP_DIR

        activate_provider_pack("codex-provider-runtime", app_dir=APP_DIR)
    from codex_cli_bin import bundled_codex_path  # type: ignore[import-untyped]

    return Path(bundled_codex_path())


def resolve_codex_binary(env: Mapping[str, str] | None = None) -> Path:
    values = _env(env)
    override = values.get(CODEX_BIN_ENV)
    if override:
        if is_bundled_runtime(values):
            raise RuntimeConfigurationError(
                f"{CODEX_BIN_ENV} overrides are disabled in bundled mode; "
                "the active hash-verified provider pack owns the Codex binary"
            )
        path = Path(override).expanduser()
        return path
    return resolve_bundled_codex_path()


def probe_claude_sdk() -> ProbeResult:
    try:
        # In bundled mode the provider SDK is intentionally absent from the
        # core payload. Resolving its managed binary activates and verifies the
        # installed provider pack before either Claude module is imported.
        bundled = resolve_bundled_claude_path()
        version_module = importlib.import_module("claude_agent_sdk._cli_version")
        version = str(getattr(version_module, "__cli_version__", "unknown"))
    except Exception as exc:  # noqa: BLE001 - diagnostic surface
        return ProbeResult("Claude analysis SDK", False, f"unavailable: {exc}")
    if not bundled.exists():
        return ProbeResult("Claude analysis SDK", False, f"bundled Claude binary missing at {bundled}")
    return ProbeResult("Claude analysis SDK", True, f"bundled Claude Code {version} at {bundled}")


def _binary_version(binary: Path, args: tuple[str, ...]) -> str:
    completed = subprocess.run(
        [str(binary), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=5,
        check=False,
    )
    return " ".join(completed.stdout.strip().split()) or f"exit {completed.returncode}"


def probe_codex_sdk(env: Mapping[str, str] | None = None) -> ProbeResult:
    try:
        # resolve_codex_binary activates and verifies the managed provider pack
        # before importing codex_cli_bin in bundled mode. Only then is it safe
        # to probe the separately packaged openai_codex module.
        binary = resolve_codex_binary(env)
        importlib.import_module("openai_codex")
    except Exception as exc:  # noqa: BLE001 - diagnostic surface
        return ProbeResult("Codex analysis SDK", False, f"unavailable: {exc}")
    if not binary.exists():
        return ProbeResult("Codex analysis SDK", False, f"codex binary missing at {binary}")
    try:
        version = _binary_version(binary, ("--version",))
    except Exception as exc:  # noqa: BLE001 - diagnostic surface
        return ProbeResult("Codex analysis SDK", False, f"codex version probe failed: {exc}")
    source = CODEX_BIN_ENV if _env(env).get(CODEX_BIN_ENV) else "bundled"
    return ProbeResult("Codex analysis SDK", True, f"{source} codex runtime: {version}")


def _antigravity_harness_path() -> Path:
    module = importlib.import_module("google.antigravity")
    return Path(module.__file__).resolve().parent / "bin" / "localharness"


def probe_antigravity_sdk() -> ProbeResult:
    try:
        if is_bundled_runtime():
            from jobctrl.config import APP_DIR

            activate_provider_pack("antigravity-provider-runtime", app_dir=APP_DIR)
        version = importlib.metadata.version("google-antigravity")
        harness = _antigravity_harness_path()
    except Exception as exc:  # noqa: BLE001 - diagnostic surface
        return ProbeResult("Antigravity analysis SDK", False, f"unavailable: {exc}")
    if not harness.exists():
        return ProbeResult("Antigravity analysis SDK", False, f"localharness missing at {harness}")
    return ProbeResult("Antigravity analysis SDK", True, f"google-antigravity {version} at {harness}")


def probe_analysis_setup(env: Mapping[str, str] | None = None) -> list[ProbeResult]:
    """Return SDK/auth probes for the currently enabled employer-analysis legs."""

    values = _env(env)
    try:
        legs = enabled_analysis_legs(values)
    except ValueError as exc:
        return [ProbeResult("analysis legs enabled", False, str(exc))]
    results = [
        ProbeResult("analysis legs enabled", True, ",".join(legs)),
    ]
    # Synthesis reconciles EVERY ensemble run with the Claude Agent SDK
    # (ClaudeAnalysisSynthesizer, ensemble.py) regardless of the enabled legs, so
    # its SDK + auth are always required — probe them independently of `legs`. The
    # claude draft leg reuses the same runtime + credentials, so it needs no
    # extra row when enabled.
    results.extend([probe_claude_sdk(), probe_claude_synthesis_auth(values)])
    if "codex" in legs:
        results.extend([probe_codex_sdk(values), probe_codex_auth(values)])
    if "antigravity" in legs:
        results.extend([probe_antigravity_sdk(), probe_antigravity_auth(values)])
    return results


__all__ = [
    "ANALYSIS_LEGS_ENV",
    "ANALYSIS_LEG_ORDER",
    "CLAUDE_BIN_ENV",
    "CODEX_BIN_ENV",
    "ProbeResult",
    "analysis_sdk_set_version",
    "antigravity_auth_kwargs",
    "bundled_claude_process_auth_env",
    "bundled_claude_sdk_options",
    "claude_credentials_path",
    "codex_auth_path",
    "effective_codex_home",
    "enabled_analysis_legs",
    "parse_enabled_analysis_legs",
    "probe_analysis_setup",
    "probe_antigravity_auth",
    "probe_antigravity_sdk",
    "probe_claude_auth",
    "probe_claude_sdk",
    "probe_claude_synthesis_auth",
    "probe_codex_auth",
    "probe_codex_sdk",
    "resolve_bundled_claude_path",
    "resolve_bundled_codex_path",
    "resolve_claude_apply_binary",
    "resolve_codex_binary",
]
