"""Explicit-environment auth validation; no enrollment, refresh or global settings."""

from __future__ import annotations

import importlib
import json
import os
import warnings
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from jobctrl.runtime import activate_provider_pack, is_bundled_runtime


CODEX_NEUTRALIZED_AUTH_ENV = (
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_AGENT_IDENTITY_AUTH",
    "CODEX_API_KEY",
    "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
    "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
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


def _aws_credentials_present(values: Mapping[str, str]) -> bool:
    if values.get("AWS_PROFILE", "").strip():
        return True
    if values.get("AWS_ACCESS_KEY_ID", "").strip() and values.get("AWS_SECRET_ACCESS_KEY", "").strip():
        return True
    raw = values.get("AWS_SHARED_CREDENTIALS_FILE", "").strip()
    home = Path(values.get("HOME", "")).expanduser() if values.get("HOME") else Path.home()
    path = Path(raw).expanduser() if raw else home / ".aws" / "credentials"
    return path.is_file()


def _google_credentials_present(values: Mapping[str, str], *, workspace: Path | None = None) -> bool:
    return _loadable_google_adc(values, workspace=workspace)


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


def probe_claude_auth(env: Mapping[str, str] | None = None, *, workspace: Path | None = None) -> ProbeResult:
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
        if _google_credentials_present(values, workspace=workspace):
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


def _adc_credentials_path(env: Mapping[str, str] | None = None) -> Path:
    values = _env(env)
    raw = values.get("GOOGLE_APPLICATION_CREDENTIALS")
    if raw:
        return Path(raw).expanduser()
    home = Path(values.get("HOME", "")).expanduser() if values.get("HOME") else Path.home()
    return home / ".config" / "gcloud" / "application_default_credentials.json"


def _loadable_google_adc(env: Mapping[str, str] | None = None, *, workspace: Path | None = None) -> bool:
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
            if workspace is None or not is_bundled_runtime(values):
                raise
            # Claude Vertex may need the Google auth dependency supplied by its
            # signed provider pack. Never fall back to process-global APP_DIR.
            activate_provider_pack("antigravity-provider-runtime", app_dir=workspace)
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


def antigravity_auth_kwargs(env: Mapping[str, str] | None = None, *, workspace: Path | None = None) -> dict[str, object]:
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
    if vertex_requested and _loadable_google_adc(values, workspace=workspace):
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
