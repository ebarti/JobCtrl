"""Shared setup, auth, and vendor-runtime probes.

The installer and ``jobctrl doctor`` both need to answer the same questions:
which analysis legs are enabled, whether their pinned SDK runtimes are present,
and whether the user's local credential stores can authenticate those runtimes.
Keeping that logic here avoids letting setup and doctor drift.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import json
import os
import shutil
import subprocess
import time
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from jobctrl.runtime import (
    RuntimeConfigurationError,
    activate_provider_pack,
    is_bundled_runtime,
    provider_runtime_home,
)

ANALYSIS_LEGS_CONFIG_KEY = "analysis_legs"
CODEX_BIN_ENV = "JOBCTRL_CODEX_BIN"
CLAUDE_BIN_ENV = "JOBCTRL_CLAUDE_BIN"

CODEX_NEUTRALIZED_AUTH_ENV = (
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_AGENT_IDENTITY_AUTH",
    "CODEX_API_KEY",
    "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
    "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
)

ANALYSIS_LEG_ORDER = ("claude", "codex", "antigravity")
_LEG_ALIASES = {
    "claude-code": "claude",
    "openai": "codex",
    "gemini": "antigravity",
    "google": "antigravity",
}

_CLAUDE_CLOUD_FLAGS = (
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
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
_GOOGLE_ADC_TYPES = {
    "authorized_user",
    "service_account",
    "external_account",
    "external_account_authorized_user",
    "impersonated_service_account",
    "gdch_service_account",
}
_EXPLICIT_GOOGLE_ADC_TYPE = "service_account"
_CODEX_AUTH_STATUS_CACHE_TTL_SECONDS = 30.0
_CODEX_AUTH_STATUS_CACHE: dict[
    tuple[object, ...], tuple[float, tuple[bool, str, str]]
] = {}


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
        raise ValueError(f"{ANALYSIS_LEGS_CONFIG_KEY} must name at least one analysis leg")
    return tuple(leg for leg in ANALYSIS_LEG_ORDER if leg in normalized)


def enabled_analysis_legs() -> tuple[str, ...]:
    """Return analysis legs from config.json or the all-legs default."""
    from jobctrl import config

    return config.get_analysis_legs()


def analysis_sdk_set_version(
    legs: tuple[str, ...] | None = None,
    *,
    synthesizer_provider: str = "default",
) -> str:
    """Return the cache-key SDK-set version for the enabled leg set."""

    selected = legs or enabled_analysis_legs()
    safe_provider = "".join(
        char for char in synthesizer_provider.strip().lower() if char.isalnum() or char in {"-", "_"}
    ) or "default"
    return f"{'+'.join(selected)}-v2-synth-{safe_provider}"


def effective_codex_home(env: Mapping[str, str] | None = None) -> Path:
    """Return the user Codex home whose ``auth.json`` authenticates the SDK."""

    raw = _env(env).get("CODEX_HOME")
    return Path(raw).expanduser() if raw else Path.home() / ".codex"


def source_codex_auth_path(env: Mapping[str, str] | None = None) -> Path:
    return effective_codex_home(env) / "auth.json"


def jobctrl_codex_home(env: Mapping[str, str] | None = None) -> Path:
    """Return the stable JobCtrl-owned Codex home used by setup and runtime."""

    from jobctrl.config import APP_DIR

    return APP_DIR / "codex_home"


def codex_auth_path(env: Mapping[str, str] | None = None) -> Path:
    """Return the persisted auth cache consumed by JobCtrl's Codex SDK lane."""

    return jobctrl_codex_home(env) / "auth.json"


def _aws_credentials_present(values: Mapping[str, str]) -> bool:
    if values.get("AWS_PROFILE", "").strip():
        return True
    if values.get("AWS_ACCESS_KEY_ID", "").strip() and values.get("AWS_SECRET_ACCESS_KEY", "").strip():
        return True
    raw = values.get("AWS_SHARED_CREDENTIALS_FILE", "").strip()
    home = Path(values.get("HOME", "")).expanduser() if values.get("HOME") else Path.home()
    path = Path(raw).expanduser() if raw else home / ".aws" / "credentials"
    return path.is_file()


def _google_credentials_present(values: Mapping[str, str]) -> bool:
    return _loadable_google_adc(values)


def _azure_credentials_present(values: Mapping[str, str]) -> bool:
    if values.get("ANTHROPIC_FOUNDRY_API_KEY", "").strip() or values.get("AZURE_API_KEY", "").strip():
        return True
    if all(
        values.get(key, "").strip()
        for key in ("AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET")
    ):
        return True
    if values.get("AZURE_FEDERATED_TOKEN_FILE", "").strip() or values.get("IDENTITY_ENDPOINT", "").strip():
        return True
    home = Path(values.get("HOME", "")).expanduser() if values.get("HOME") else Path.home()
    azure_dir = Path(values.get("AZURE_CONFIG_DIR", "")).expanduser() if values.get("AZURE_CONFIG_DIR") else home / ".azure"
    return any((azure_dir / name).is_file() for name in ("msal_token_cache.json", "azureProfile.json"))


def probe_claude_auth(env: Mapping[str, str] | None = None) -> ProbeResult:
    values = _env(env)
    if values.get("ANTHROPIC_API_KEY"):
        return ProbeResult("Claude analysis auth", True, "ANTHROPIC_API_KEY")
    if _truthy(values.get("CLAUDE_CODE_USE_BEDROCK")):
        if _aws_credentials_present(values):
            return ProbeResult("Claude analysis auth", True, "Amazon Bedrock with AWS credentials")
        return ProbeResult("Claude analysis auth", False, "CLAUDE_CODE_USE_BEDROCK needs AWS credentials")
    if _truthy(values.get("CLAUDE_CODE_USE_ANTHROPIC_AWS")):
        if not values.get("ANTHROPIC_AWS_WORKSPACE_ID", "").strip():
            return ProbeResult(
                "Claude analysis auth",
                False,
                "CLAUDE_CODE_USE_ANTHROPIC_AWS needs ANTHROPIC_AWS_WORKSPACE_ID",
            )
        if _aws_credentials_present(values):
            return ProbeResult(
                "Claude analysis auth",
                True,
                "Claude Platform on AWS with workspace and AWS credentials",
            )
        return ProbeResult(
            "Claude analysis auth",
            False,
            "CLAUDE_CODE_USE_ANTHROPIC_AWS needs AWS credentials",
        )
    if _truthy(values.get("CLAUDE_CODE_USE_VERTEX")):
        project = (
            values.get("ANTHROPIC_VERTEX_PROJECT_ID")
            or values.get("GOOGLE_CLOUD_PROJECT")
            or values.get("GOOGLE_PROJECT_ID")
            or values.get("GCLOUD_PROJECT")
        )
        if not project:
            return ProbeResult(
                "Claude analysis auth",
                False,
                "CLAUDE_CODE_USE_VERTEX needs ANTHROPIC_VERTEX_PROJECT_ID",
            )
        if _google_credentials_present(values):
            return ProbeResult("Claude analysis auth", True, "Google Cloud Agent Platform credentials")
        return ProbeResult(
            "Claude analysis auth",
            False,
            "CLAUDE_CODE_USE_VERTEX needs Google Cloud credentials",
        )
    if _truthy(values.get("CLAUDE_CODE_USE_FOUNDRY")):
        if not values.get("ANTHROPIC_FOUNDRY_RESOURCE", "").strip():
            return ProbeResult(
                "Claude analysis auth",
                False,
                "CLAUDE_CODE_USE_FOUNDRY needs ANTHROPIC_FOUNDRY_RESOURCE",
            )
        if _azure_credentials_present(values):
            return ProbeResult("Claude analysis auth", True, "Microsoft Foundry with Azure credentials")
        return ProbeResult(
            "Claude analysis auth",
            False,
            "CLAUDE_CODE_USE_FOUNDRY needs Azure credentials",
        )
    unsupported = next((key for key in _CLAUDE_CONSUMER_AUTH_ENV if values.get(key)), None)
    note = f"{unsupported} is consumer OAuth and is not supported; " if unsupported else ""
    return ProbeResult(
        "Claude analysis auth",
        False,
        note
        + "set ANTHROPIC_API_KEY or configure Bedrock, Claude Platform on AWS, Vertex, or Foundry",
    )


def probe_claude_synthesis_auth(env: Mapping[str, str] | None = None) -> ProbeResult:
    """Compatibility alias for callers that still label the Claude capability."""

    result = probe_claude_auth(env)
    return ProbeResult("Claude synthesis auth", result.ok, result.note, required=False)


def bundled_claude_sdk_options(env: Mapping[str, str] | None = None) -> dict[str, object]:
    """Return SDK options that prevent consumer credential reuse in every mode."""

    values = _env(env)
    probe = probe_claude_auth(values)
    if not probe.ok:
        raise RuntimeError(probe.note)
    from jobctrl.config import APP_DIR

    provider_home = (
        provider_runtime_home("claude", app_dir=APP_DIR)
        if is_bundled_runtime(values)
        else APP_DIR / "claude_home"
    )
    config_dir = provider_home / "config"
    isolated_env = {
        # Keep HOME unchanged so AWS profiles, gcloud ADC, and Azure CLI
        # credentials remain discoverable through their official chains.
        "CLAUDE_CONFIG_DIR": str(config_dir),
        # The Claude SDK merges overrides over os.environ. Empty values
        # explicitly neutralize ambient consumer OAuth variables while the
        # supported API/cloud settings remain inherited.
        **{key: "" for key in _CLAUDE_CONSUMER_AUTH_ENV},
    }
    config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
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
        "ANTHROPIC_AWS_WORKSPACE_ID",
        "ANTHROPIC_FOUNDRY_RESOURCE",
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
    result.update({"CLAUDE_CONFIG_DIR": str(home / "config")})
    (home / "config").mkdir(mode=0o700, parents=True, exist_ok=True)
    return result


def _codex_auth_file_signature(path: Path) -> tuple[object, ...]:
    """Return a cache key that changes when a candidate auth file changes."""

    try:
        stat = path.lstat()
    except OSError:
        return (str(path), "missing")
    return (str(path), stat.st_mode, stat.st_ino, stat.st_size, stat.st_mtime_ns)


def ensure_private_directory(path: Path, *, parent: Path | None = None) -> Path:
    """Create one JobCtrl-owned directory with best-effort private permissions."""

    if parent is not None and not parent.is_dir():
        raise RuntimeError(f"Codex parent directory is unavailable or unsafe: {parent}")
    try:
        path.mkdir(mode=0o700, parents=parent is None, exist_ok=True)
    except OSError as exc:
        raise RuntimeError(f"Codex path is unavailable or unsafe: {path}") from exc
    if not path.is_dir():
        raise RuntimeError(f"Codex path must be a directory: {path}")
    try:
        path.chmod(0o700)
    except OSError:
        if os.name != "nt":
            raise
    return path


def _validate_codex_auth_file(path: Path) -> None:
    """Reject non-regular, malformed, or empty persisted Codex auth state."""

    if path.is_symlink():
        raise RuntimeError(f"Codex auth cache must not be a symlink: {path}")
    if not path.is_file():
        raise RuntimeError("Codex CLI is not authenticated in the JobCtrl provider home")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Codex auth cache is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Codex auth cache is not a JSON object")
    api_key = payload.get("OPENAI_API_KEY")
    tokens = payload.get("tokens")
    has_api_key = isinstance(api_key, str) and bool(api_key.strip())
    has_access_token = isinstance(tokens, dict) and isinstance(
        tokens.get("access_token"), str
    ) and bool(tokens["access_token"].strip())
    if not has_api_key and not has_access_token:
        raise RuntimeError("Codex auth cache does not contain persisted CLI credentials")


def prepare_jobctrl_codex_home(env: Mapping[str, str] | None = None) -> Path:
    """Create or validate the stable JobCtrl-owned Codex home before login."""

    target_home = jobctrl_codex_home(env)
    ensure_private_directory(target_home.parent)
    return ensure_private_directory(target_home, parent=target_home.parent)


def _run_codex_login_status(
    values: Mapping[str, str],
    *,
    codex_home: Path,
    runner: Callable[..., Any],
) -> Any:
    child_env = dict(values)
    child_env["CODEX_HOME"] = str(codex_home)
    for key in CODEX_NEUTRALIZED_AUTH_ENV:
        child_env.pop(key, None)
    return runner(
        [str(resolve_codex_binary(values)), "login", "status"],
        env=child_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )


def _cached_verify_codex_connection(values: Mapping[str, str]) -> tuple[bool, str, str]:
    """Bound repeated readiness checks while invalidating on auth-state changes."""

    key = (
        _codex_auth_file_signature(codex_auth_path(values)),
        values.get(CODEX_BIN_ENV, ""),
    )
    now = time.monotonic()
    cached = _CODEX_AUTH_STATUS_CACHE.get(key)
    if cached is not None and now - cached[0] < _CODEX_AUTH_STATUS_CACHE_TTL_SECONDS:
        return cached[1]
    result = verify_codex_connection(values)
    refreshed_key = (
        _codex_auth_file_signature(codex_auth_path(values)),
        values.get(CODEX_BIN_ENV, ""),
    )
    _CODEX_AUTH_STATUS_CACHE[refreshed_key] = (now, result)
    return result


def probe_codex_auth(env: Mapping[str, str] | None = None) -> ProbeResult:
    values = _env(env)
    ok, _status, message = _cached_verify_codex_connection(values)
    if ok:
        return ProbeResult("Codex analysis auth", True, message)
    if values.get("OPENAI_API_KEY") or values.get("CODEX_API_KEY"):
        return ProbeResult(
            "Codex analysis auth",
            False,
            "OpenAI key present but not enrolled; complete the JobCtrl provider setup",
        )
    return ProbeResult(
        "Codex analysis auth",
        False,
        message,
    )


def ensure_jobctrl_codex_auth(env: Mapping[str, str] | None = None) -> Path:
    """Copy valid ambient CLI auth once into the stable isolated home."""

    values = _env(env)
    target = codex_auth_path(values)
    if target.is_symlink():
        raise RuntimeError(f"Codex auth cache must not be a symlink: {target}")
    if not target.exists():
        source = source_codex_auth_path(values)
        if source.is_symlink():
            raise RuntimeError(f"Codex auth cache must not be a symlink: {source}")
        if source.is_file() and source != target:
            _validate_codex_auth_file(source)
            ensure_private_directory(target.parent)
            shutil.copy2(source, target)
    _validate_codex_auth_file(target)
    try:
        target.chmod(0o600)
    except OSError:
        if os.name != "nt":
            raise
    return target


def reuse_and_verify_codex_connection(
    env: Mapping[str, str] | None = None,
    *,
    runner: Callable[..., Any] = subprocess.run,
) -> tuple[bool, str, str]:
    """Explicitly reuse valid ambient Codex auth once, then verify the isolated home."""

    values = dict(_env(env))
    try:
        ensure_jobctrl_codex_auth(values)
    except RuntimeError:
        # A missing or invalid reusable source is not an error for this explicit
        # action. The isolated verification below returns the stable, secret-free
        # not-configured result without disclosing source-auth details.
        pass
    return verify_codex_connection(values, runner=runner)


def provider_status_snapshot(
    provider: str,
    env: Mapping[str, str] | None = None,
) -> dict[str, object]:
    """Return secret-free provider status for the settings/API surface."""

    values = _env(env)
    if provider == "claude":
        probe = probe_claude_auth(values)
        configured = bool(
            values.get("ANTHROPIC_API_KEY")
            or any(_truthy(values.get(flag)) for flag in _CLAUDE_CLOUD_FLAGS)
        )
        if values.get("ANTHROPIC_API_KEY"):
            mode = "api_key"
        else:
            mode = next(
                (
                    label
                    for flag, label in (
                        ("CLAUDE_CODE_USE_BEDROCK", "bedrock"),
                        ("CLAUDE_CODE_USE_ANTHROPIC_AWS", "anthropic_aws"),
                        ("CLAUDE_CODE_USE_VERTEX", "vertex"),
                        ("CLAUDE_CODE_USE_FOUNDRY", "foundry"),
                    )
                    if _truthy(values.get(flag))
                ),
                None,
            )
        sdk = probe_claude_sdk() if probe.ok else ProbeResult("Claude analysis SDK", False, "auth required")
        ready = probe.ok and sdk.ok
        message = (
            "Claude provider is ready"
            if ready
            else "Claude auth is configured but the managed SDK runtime is unavailable"
            if probe.ok
            else "Claude configuration is incomplete"
            if configured
            else "Claude is not configured"
        )
    elif provider == "codex":
        probe = probe_codex_auth(values)
        configured = probe.ok or bool(values.get("OPENAI_API_KEY") or values.get("CODEX_API_KEY"))
        mode = "cli_auth" if probe.ok else "key_not_enrolled" if configured else None
        sdk = probe_codex_sdk(values) if probe.ok else ProbeResult("Codex analysis SDK", False, "auth required")
        ready = probe.ok and sdk.ok
        message = (
            "Codex CLI authentication is ready"
            if ready
            else "OpenAI key must be enrolled with codex login --with-api-key"
            if configured and not probe.ok
            else "Codex CLI auth is configured but the managed SDK runtime is unavailable"
            if probe.ok
            else "Codex CLI is not authenticated"
        )
    elif provider == "google":
        probe = probe_antigravity_auth(values)
        vertex = _truthy(values.get("GOOGLE_GENAI_USE_VERTEXAI")) or _truthy(
            values.get("GOOGLE_CLOUD_VERTEXAI")
        )
        configured = bool(values.get("GEMINI_API_KEY") or values.get("GOOGLE_API_KEY") or vertex)
        mode = "api_key" if values.get("GEMINI_API_KEY") or values.get("GOOGLE_API_KEY") else "vertex" if vertex else None
        sdk = probe_antigravity_sdk() if probe.ok else ProbeResult("Antigravity analysis SDK", False, "auth required")
        ready = probe.ok and sdk.ok
        message = (
            "Google provider is ready"
            if ready
            else "Google auth is configured but the managed SDK runtime is unavailable"
            if probe.ok
            else "Google configuration is incomplete"
            if configured
            else "Google is not configured"
        )
    else:
        raise ValueError(f"unsupported provider: {provider}")
    return {
        "provider": provider,
        "configured": configured,
        "ready": ready,
        "mode": mode,
        "message": message,
    }


def verify_codex_connection(
    env: Mapping[str, str] | None = None,
    *,
    runner: Callable[..., Any] = subprocess.run,
) -> tuple[bool, str, str]:
    """Verify persisted Codex CLI auth without generation or account disclosure."""

    values = dict(_env(env))
    try:
        _validate_codex_auth_file(codex_auth_path(values))
    except RuntimeError:
        return False, "not_configured", "Codex CLI is not authenticated"
    try:
        completed = _run_codex_login_status(
            values,
            codex_home=jobctrl_codex_home(values),
            runner=runner,
        )
    except Exception:  # noqa: BLE001 - return a secret-free verification result
        return False, "failed", "Codex authentication verification failed"
    if completed.returncode == 0:
        return True, "connected", "Codex CLI authentication verified"
    return False, "failed", "Codex CLI authentication could not be verified"


def _adc_credentials_path(env: Mapping[str, str] | None = None) -> Path:
    values = _env(env)
    raw = values.get("GOOGLE_APPLICATION_CREDENTIALS")
    if raw:
        return Path(raw).expanduser()
    home = Path(values.get("HOME", "")).expanduser() if values.get("HOME") else Path.home()
    return home / ".config" / "gcloud" / "application_default_credentials.json"


def _loadable_google_adc(env: Mapping[str, str] | None = None) -> bool:
    """Return whether the selected local ADC file is parseable without refresh.

    ``google.auth.default()`` may fall through to a metadata server, which is a
    network operation and is unsuitable for setup/status probes.  JobCtrl's
    supported no-network readiness sources are therefore the explicit
    ``GOOGLE_APPLICATION_CREDENTIALS`` file and gcloud's well-known local ADC
    file. Explicit credential paths are restricted to service-account JSON;
    gcloud's well-known ADC may use any supported local ADC type. The loader
    validates the selected allowed type without refreshing or disclosing it.
    """

    values = _env(env)
    path = _adc_credentials_path(values)
    if not path.is_file():
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        credential_type = payload.get("type") if isinstance(payload, dict) else None
        if values.get("GOOGLE_APPLICATION_CREDENTIALS"):
            if credential_type != _EXPLICIT_GOOGLE_ADC_TYPE:
                return False
        elif credential_type not in _GOOGLE_ADC_TYPES:
            return False
        try:
            google_auth = importlib.import_module("google.auth")
        except ImportError:
            if not is_bundled_runtime(values):
                raise
            from jobctrl.config import APP_DIR

            activate_provider_pack("antigravity-provider-runtime", app_dir=APP_DIR)
            google_auth = importlib.import_module("google.auth")
        # The generic loader warns for untrusted external credential configs.
        # This path is explicitly user-selected (or gcloud-owned), and the ADC
        # type allowlist above prevents an unexpected loader from being chosen.
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="The load_credentials_from_file method is deprecated.*",
                category=DeprecationWarning,
            )
            credentials, _project = google_auth.load_credentials_from_file(str(path))
    except Exception:  # noqa: BLE001 - secret-free, no-network readiness probe
        return False
    return credentials is not None


def antigravity_auth_kwargs(env: Mapping[str, str] | None = None) -> dict[str, object]:
    """Return LocalAgentConfig auth kwargs for Antigravity or raise RuntimeError."""

    values = _env(env)
    api_key = values.get("GEMINI_API_KEY") or values.get("GOOGLE_API_KEY")
    if api_key:
        return {"api_key": api_key}

    vertex_requested = _truthy(values.get("GOOGLE_GENAI_USE_VERTEXAI")) or _truthy(values.get("GOOGLE_CLOUD_VERTEXAI"))
    project = (
        values.get("GOOGLE_CLOUD_PROJECT")
        or values.get("GOOGLE_PROJECT_ID")
        or values.get("GCLOUD_PROJECT")
    )
    if vertex_requested and _loadable_google_adc(values):
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
        "or valid local Vertex AI ADC with GOOGLE_GENAI_USE_VERTEXAI=1"
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
    """Return the one-provider core gate plus optional per-provider diagnostics."""

    values = _env(env)
    try:
        legs = enabled_analysis_legs()
    except ValueError as exc:
        return [ProbeResult("analysis legs enabled", False, str(exc))]
    provider_pairs = (
        ("Claude", probe_claude_sdk(), probe_claude_auth(values)),
        ("Codex", probe_codex_sdk(values), probe_codex_auth(values)),
        ("Google", probe_antigravity_sdk(), probe_antigravity_auth(values)),
    )
    ready = [name.lower() for name, sdk, auth in provider_pairs if sdk.ok and auth.ok]
    aggregate = ProbeResult(
        "core LLM provider",
        bool(ready),
        f"ready: {', '.join(ready)}" if ready else "authenticate Claude, Codex, or Google",
    )
    results = [aggregate, ProbeResult("analysis legs enabled", True, ",".join(legs), required=False)]
    for name, sdk, auth in provider_pairs:
        results.extend(
            [
                ProbeResult(sdk.name, sdk.ok, sdk.note, required=False),
                ProbeResult(auth.name, auth.ok, auth.note, required=False),
            ]
        )
    return results


def ready_llm_providers(env: Mapping[str, str] | None = None) -> tuple[str, ...]:
    """Return providers that can service both free-text and structured core calls."""

    values = _env(env)
    ready: list[str] = []
    claude_auth = probe_claude_auth(values)
    if claude_auth.ok and probe_claude_sdk().ok:
        ready.append("claude")
    codex_auth = probe_codex_auth(values)
    if codex_auth.ok and probe_codex_sdk(values).ok:
        ready.append("codex")
    google_auth = probe_antigravity_auth(values)
    if google_auth.ok and probe_antigravity_sdk().ok:
        ready.append("google")
    return tuple(ready)


def core_llm_ready(env: Mapping[str, str] | None = None) -> bool:
    return bool(ready_llm_providers(env))


__all__ = [
    "ANALYSIS_LEGS_CONFIG_KEY",
    "ANALYSIS_LEG_ORDER",
    "CLAUDE_BIN_ENV",
    "CODEX_BIN_ENV",
    "CODEX_NEUTRALIZED_AUTH_ENV",
    "ProbeResult",
    "analysis_sdk_set_version",
    "antigravity_auth_kwargs",
    "bundled_claude_process_auth_env",
    "bundled_claude_sdk_options",
    "codex_auth_path",
    "core_llm_ready",
    "effective_codex_home",
    "enabled_analysis_legs",
    "ensure_jobctrl_codex_auth",
    "ensure_private_directory",
    "parse_enabled_analysis_legs",
    "probe_analysis_setup",
    "probe_antigravity_auth",
    "probe_antigravity_sdk",
    "probe_claude_auth",
    "probe_claude_sdk",
    "probe_claude_synthesis_auth",
    "probe_codex_auth",
    "probe_codex_sdk",
    "prepare_jobctrl_codex_home",
    "provider_status_snapshot",
    "ready_llm_providers",
    "reuse_and_verify_codex_connection",
    "resolve_bundled_claude_path",
    "resolve_bundled_codex_path",
    "resolve_claude_apply_binary",
    "resolve_codex_binary",
    "source_codex_auth_path",
    "jobctrl_codex_home",
    "verify_codex_connection",
]
