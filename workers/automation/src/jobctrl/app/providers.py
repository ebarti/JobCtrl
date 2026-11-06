"""Secret-free readiness, SDK catalogs and explicit isolated Codex enrollment."""

from __future__ import annotations

import asyncio
import importlib.metadata
import importlib.util
import json
import os
import stat
import shutil
import sys
import tempfile
from collections.abc import Mapping
from itertools import islice
from pathlib import Path

import httpx
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.credentials import CredentialService, MutationGuard, _regular_file, _sync_directory
from jobctrl.app.errors import AppError
from jobctrl.app.synthetic import synthetic_boundary

PROVIDERS = ("codex", "claude", "google")
_CATALOG_FAILURE = "Live model catalog is temporarily unavailable."
_CATALOG_LIMIT = 1024 * 1024


def _truth(value) -> bool:
    return isinstance(value, str) and value.strip().lower() in {"1", "true", "yes", "on"}


def _field(item, key, default=None):
    return item.get(key, default) if isinstance(item, Mapping) else getattr(item, key, default)


def _identifier(value, maximum=160) -> str | None:
    if (not isinstance(value, str) or not 1 <= len(value.strip()) <= maximum
            or any(ord(character) < 32 or ord(character) == 127 for character in value)):
        return None
    return value.strip()


def _present(path: Path) -> bool:
    try:
        info = path.lstat()
        return stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size > 0
    except OSError:
        return False


def _auth_bytes(path: Path) -> bytes:
    info = _regular_file(path, max_bytes=1024 * 1024)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (
                info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
            raise ValueError("auth changed")
        data = handle.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError("auth bound")
    metadata = json.loads(data)
    if (not isinstance(metadata, dict) or not (isinstance(metadata.get("OPENAI_API_KEY"), str)
            and metadata["OPENAI_API_KEY"].strip()) and not (isinstance(metadata.get("tokens"), dict)
            and isinstance(metadata["tokens"].get("access_token"), str)
            and metadata["tokens"]["access_token"].strip())):
        raise ValueError("auth incomplete")
    return data


def _auth_identity(path: Path):
    try:
        info = _regular_file(path, max_bytes=1024 * 1024)
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    except FileNotFoundError:
        return None


def _home(values: Mapping[str, str]) -> Path:
    return Path(values.get("HOME") or values.get("USERPROFILE") or Path.home()).expanduser()


def _adc_path(values: Mapping[str, str]) -> Path:
    selected = values.get("GOOGLE_APPLICATION_CREDENTIALS")
    if selected:
        return Path(selected).expanduser()
    if os.name == "nt":
        return Path(values.get("APPDATA") or (_home(values) / "AppData" / "Roaming")) / "gcloud" / "application_default_credentials.json"
    return _home(values) / ".config" / "gcloud" / "application_default_credentials.json"


def _runtime_available(provider: str, workspace: Path, values: Mapping[str, str]) -> bool:
    try:
        # Activation validates the installed signed provider closure; it neither
        # authenticates nor imports a user's provider configuration.
        from jobctrl.runtime import activate_provider_pack, is_bundled_runtime
        if is_bundled_runtime(values):
            activate_provider_pack({"codex": "codex-provider-runtime", "claude": "claude-agent-sdk",
                                    "google": "antigravity-provider-runtime"}[provider], app_dir=workspace)
        importlib.metadata.version({"codex": "openai-codex", "claude": "claude-agent-sdk", "google": "google-genai"}[provider])
        bundled = is_bundled_runtime(values)
        if provider == "codex":
            override = values.get("JOBCTRL_CODEX_BIN")
            if override and bundled:
                return False
            if override:
                binary = Path(override).expanduser()
            else:
                from codex_cli_bin import bundled_codex_path
                binary = Path(bundled_codex_path())
        elif provider == "claude":
            override = values.get("JOBCTRL_CLAUDE_BIN")
            if override and bundled:
                return False
            selected = override or (shutil.which("claude", path=values.get("PATH")) if not bundled else None)
            module = importlib.util.find_spec("claude_agent_sdk")
            binary = Path(selected).expanduser() if selected else Path(module.origin).parent / "_bundled" / "claude"
        else:
            importlib.metadata.version("google-antigravity")
            module = importlib.util.find_spec("google.antigravity")
            binary = Path(module.origin).parent / "bin" / "localharness"
        return binary.is_file() and os.access(binary, os.X_OK)
    except Exception:
        return False


def _normalize_models(provider: str, items) -> list[dict]:
    """Project only literal public SDK catalog fields, never account metadata."""
    if not isinstance(items, (list, tuple)):
        items = list(islice(items, 4097))
    if len(items) > 4096:
        raise ValueError("catalog bound")
    result = []
    seen = set()
    for item in items:
        if _field(item, "hidden", False):
            continue
        if provider == "codex":
            identifier = _identifier(_field(item, "model") or _field(item, "id"))
        elif provider == "claude":
            identifier = _identifier(_field(item, "value") or _field(item, "model") or _field(item, "id"))
        else:
            identifier = _identifier(_field(item, "name") or _field(item, "id"))
            if identifier and identifier.startswith("models/"):
                identifier = identifier.removeprefix("models/")
            elif identifier and "/publishers/google/models/" in identifier:
                identifier = identifier.split("/publishers/google/models/", 1)[1]
            actions = _field(item, "supported_actions") or _field(item, "supported_generation_methods")
            if actions is not None and not any(
                    str(action).replace("_", "").lower() == "generatecontent" for action in actions):
                continue
        if not identifier or identifier == "default" or identifier in seen:
            continue
        seen.add(identifier)
        model = {"id": identifier,
                 "displayName": _identifier(_field(item, "display_name") or _field(item, "displayName")) or identifier,
                 # The sanctioned adapters supply JSON Schema through each
                 # runtime's structured-output API. No name-based inference.
                 "capabilities": ["structured_json"]}
        if _field(item, "is_default", _field(item, "isDefault", False)) is True:
            model["isDefault"] = True
        efforts = _field(item, "supported_reasoning_efforts") or _field(item, "supportedReasoningEfforts") or ()
        normalized = []
        for effort in efforts:
            name = _identifier(_field(effort, "reasoning_effort") or _field(effort, "reasoningEffort"), 40)
            if name and name not in {value["reasoningEffort"] for value in normalized}:
                option = {"reasoningEffort": name}
                description = _identifier(_field(effort, "description"), 240)
                if description:
                    option["description"] = description
                normalized.append(option)
            if len(normalized) >= 32:
                break
        if normalized:
            model["supportedReasoningEfforts"] = normalized
            default = _identifier(_field(item, "default_reasoning_effort") or _field(item, "defaultReasoningEffort"), 40)
            if default in {value["reasoningEffort"] for value in normalized}:
                model["defaultReasoningEffort"] = default
        result.append(model)
        if len(result) >= 512:
            break
    return result


class ProviderService:
    def __init__(self, runtime, *, credentials: CredentialService | None = None):
        self.runtime = runtime
        self.workspace = Path(runtime.workspace)
        self.credentials = credentials or CredentialService(runtime)
        self.synthetic = synthetic_boundary(self.workspace, os.environ.get("JOBCTRL_E2E_PROVIDER_URL"))

    def _metadata(self) -> list[dict]:
        values = self.credentials.metadata_environment()
        credentials = {item["key"]: item for item in self.credentials.list()["credentials"]}

        def key_present(key):
            return bool(values.get(key, "").strip()) or (
                self.credentials.native_fallback_allowed(key) and credentials[key]["configured"] is True)

        output = []
        for provider in PROVIDERS:
            complete = False
            if provider == "codex":
                enrolled = _present(self.workspace / "codex_home" / "auth.json")
                configured = enrolled or key_present("OPENAI_API_KEY") or bool(values.get("CODEX_API_KEY"))
                mode = "cli_auth" if enrolled else "key_not_enrolled" if configured else None
                complete = enrolled
                unknown = credentials["OPENAI_API_KEY"]["configured"] is None and not configured
            elif provider == "claude":
                secret = key_present("ANTHROPIC_API_KEY")
                modes = (("CLAUDE_CODE_USE_BEDROCK", "bedrock"),
                         ("CLAUDE_CODE_USE_ANTHROPIC_AWS", "anthropic_aws"),
                         ("CLAUDE_CODE_USE_VERTEX", "vertex"), ("CLAUDE_CODE_USE_FOUNDRY", "foundry"))
                mode = "api_key" if secret else next((name for flag, name in modes if _truth(values.get(flag))), None)
                configured = mode is not None
                if secret:
                    complete = True
                elif mode in {"bedrock", "anthropic_aws"}:
                    chain = bool(values.get("AWS_ACCESS_KEY_ID") and values.get("AWS_SECRET_ACCESS_KEY")) or _present(
                        Path(values.get("AWS_SHARED_CREDENTIALS_FILE") or _home(values) / ".aws" / "credentials"))
                    complete = chain and (mode == "bedrock" or bool(values.get("ANTHROPIC_AWS_WORKSPACE_ID")))
                elif mode == "vertex":
                    complete = bool(values.get("ANTHROPIC_VERTEX_PROJECT_ID") or values.get("GOOGLE_CLOUD_PROJECT")) and _present(_adc_path(values))
                elif mode == "foundry":
                    chain = bool(values.get("AZURE_CLIENT_ID") and values.get("AZURE_TENANT_ID")
                                 and (values.get("AZURE_CLIENT_SECRET") or values.get("AZURE_FEDERATED_TOKEN_FILE"))) or _present(
                        _home(values) / ".azure" / "msal_token_cache.json")
                    complete = bool(values.get("ANTHROPIC_FOUNDRY_RESOURCE")) and chain
                unknown = credentials["ANTHROPIC_API_KEY"]["configured"] is None and not configured
            else:
                secret = key_present("GEMINI_API_KEY") or bool(values.get("GOOGLE_API_KEY"))
                vertex = _truth(values.get("GOOGLE_GENAI_USE_VERTEXAI")) or _truth(values.get("GOOGLE_CLOUD_VERTEXAI"))
                configured = secret or vertex
                mode = "api_key" if secret else "vertex" if vertex else None
                complete = secret or (vertex and bool(values.get("GOOGLE_CLOUD_PROJECT") or values.get("GCLOUD_PROJECT"))
                                      and _present(_adc_path(values)))
                unknown = credentials["GEMINI_API_KEY"]["configured"] is None and not configured
            available = _runtime_available(provider, self.workspace, values) if complete else False
            ready = bool(complete and available)
            message = ("Configuration and runtime are available; the live catalog verifies model access." if ready else
                       "Credential inspection failed; configuration status is unknown." if unknown else
                       "Provider configuration is incomplete." if configured and not complete else
                       "The managed provider runtime is unavailable." if complete else "Provider is not configured.")
            output.append({"provider": provider, "configured": bool(configured), "ready": ready,
                           "mode": mode, "message": message})
        return output

    async def _synthetic_catalog(self) -> dict:
        base = os.environ.get("JOBCTRL_E2E_PROVIDER_URL", "")
        base = base.removesuffix("/model").rstrip("/")
        url = base + "/catalog"
        owned = synthetic_boundary(self.workspace, url)
        try:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=10) as client:
                async with client.stream("POST", url, json={"operation": "providers.catalog", "providers": list(PROVIDERS)},
                                         headers={"Authorization": f"Bearer {owned['token']}"}) as response:
                    response.raise_for_status()
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > _CATALOG_LIMIT:
                            raise ValueError("catalog bound")
            source = json.loads(data)
            items = source["providers"]
            if not isinstance(items, list) or len(items) != len(PROVIDERS):
                raise ValueError("catalog providers")
            output = []
            for provider, item in zip(PROVIDERS, items, strict=True):
                if (not isinstance(item, dict) or item.get("provider") != provider
                        or type(item.get("configured")) is not bool or type(item.get("ready")) is not bool
                        or not isinstance(item.get("models"), list) or len(item["models"]) > 512
                        or (item["ready"] and not item["configured"]) or (not item["ready"] and item["models"])):
                    raise ValueError("catalog provider")
                models = []
                ids = set()
                for model in item["models"]:
                    identifier = _identifier(model.get("id")) if isinstance(model, dict) else None
                    capabilities = model.get("capabilities") if isinstance(model, dict) else None
                    if (not identifier or identifier in ids or not isinstance(capabilities, list)
                            or len(capabilities) > 32 or any(not _identifier(value, 80) for value in capabilities)):
                        raise ValueError("catalog model")
                    ids.add(identifier)
                    value = {"id": identifier, "displayName": _identifier(model.get("displayName")) or identifier,
                             "capabilities": list(capabilities)}
                    # Reuse the public reasoning-effort projection without
                    # inventing provider capabilities for controlled metadata.
                    normalized = _normalize_models("codex", [{**model, "model": identifier}])[0]
                    for field in ("isDefault", "supportedReasoningEfforts", "defaultReasoningEffort"):
                        if field in normalized:
                            value[field] = normalized[field]
                    models.append(value)
                output.append({"provider": provider, "configured": item["configured"], "ready": item["ready"],
                               "source": "live", "models": models})
            return {"ok": True, "providers": output}
        except (httpx.HTTPError, OSError, ValueError, TypeError, KeyError, IndexError):
            raise AppError("provider_models_failed", _CATALOG_FAILURE, 503) from None

    async def status(self) -> dict:
        if self.synthetic:
            result = await self._synthetic_catalog()
            return {"ok": True, "providers": [{"provider": item["provider"], "configured": item["configured"],
                    "ready": item["ready"], "mode": "controlled_external" if item["configured"] else None,
                    "message": "Controlled external provider runtime."} for item in result["providers"]]}
        return {"ok": True, "providers": await run_in_threadpool(self._metadata)}

    async def _models(self, provider: str) -> list[dict]:
        values = await run_in_threadpool(self.credentials.execution_environment, provider=provider)
        from jobctrl.app.model_providers import build_claude_options, build_codex_factory
        if provider == "codex":
            factory = await run_in_threadpool(build_codex_factory, self.workspace, values)
            async with factory() as client:
                response = await client.models(include_hidden=False)
            return _normalize_models(provider, _field(response, "data", ()))
        if provider == "claude":
            options = await run_in_threadpool(build_claude_options, self.workspace, values,
                                             model=self.runtime.settings.get("providerModels", {}).get(provider, "default"),
                                             instructions="Return only runtime initialization metadata.")
            from claude_agent_sdk import ClaudeSDKClient
            async with ClaudeSDKClient(options=options) as client:
                information = await client.get_server_info()
            models = information.get("models") if isinstance(information, dict) else None
            if not isinstance(models, list):
                raise ValueError("missing catalog")
            return _normalize_models(provider, models)
        return await run_in_threadpool(self._google_models, values)

    def _google_models(self, values: Mapping[str, str]) -> list[dict]:
        from google import genai
        key = values.get("GEMINI_API_KEY") or values.get("GOOGLE_API_KEY")
        options = {"api_key": key, "vertexai": False} if key else self._google_cloud_options(values)
        with genai.Client(**options, http_options={"timeout": 15000}) as client:
            return _normalize_models("google", client.models.list(config={"query_base": True}))

    @staticmethod
    def _google_cloud_options(values: Mapping[str, str]) -> dict:
        import google.auth
        path = _adc_path(values)
        _regular_file(path, max_bytes=1024 * 1024)
        with path.open("r", encoding="utf-8") as handle:
            metadata = json.load(handle)
        allowed = {"service_account"} if values.get("GOOGLE_APPLICATION_CREDENTIALS") else {
            "service_account", "authorized_user", "impersonated_service_account"}
        if not isinstance(metadata, dict) or metadata.get("type") not in allowed:
            raise ValueError("unsupported ADC type")
        credentials, project = google.auth.load_credentials_from_file(
            str(path), scopes=["https://www.googleapis.com/auth/cloud-platform"])
        return {"vertexai": True, "credentials": credentials,
                "project": values.get("GOOGLE_CLOUD_PROJECT") or values.get("GCLOUD_PROJECT") or project,
                "location": values.get("GOOGLE_CLOUD_LOCATION") or "global"}

    async def catalog(self) -> dict:
        if self.synthetic:
            return await self._synthetic_catalog()
        statuses = await run_in_threadpool(self._metadata)
        items = []
        for status in statuses:
            item = {"provider": status["provider"], "configured": status["configured"], "ready": status["ready"],
                    "source": "live", "models": []}
            if not status["ready"]:
                item["message"] = status["message"]
            else:
                try:
                    async with asyncio.timeout(25):
                        item["models"] = await self._models(status["provider"])
                    if not item["models"]:
                        item["ready"] = False
                        item["message"] = _CATALOG_FAILURE
                except Exception:
                    item["ready"] = False
                    item["message"] = _CATALOG_FAILURE
            items.append(item)
        return {"ok": True, "providers": items}

    async def validate_selection(self, provider: str, model: str, capability: str = "structured_json") -> dict:
        if provider not in PROVIDERS or not _identifier(model):
            raise AppError("invalid_model", "Choose an explicit supported provider and model.")
        if capability != "structured_json":
            raise AppError("model_capability_unsupported", "The requested model capability is unavailable.", 409)
        catalog = await self.catalog()
        item = next(value for value in catalog["providers"] if value["provider"] == provider)
        if item.get("message") == _CATALOG_FAILURE:
            raise AppError("provider_models_failed", _CATALOG_FAILURE, 503)
        if not item["ready"]:
            raise AppError("provider_not_ready", "The selected provider is not ready.", 409)
        selected = next((value for value in item["models"] if value["id"] == model), None)
        if selected is None:
            raise AppError("invalid_model", "The selected model is absent from the provider's live catalog.")
        if capability not in selected["capabilities"]:
            raise AppError("model_capability_unsupported", "The selected model does not support structured JSON.", 409)
        return selected

    async def validate_reasoning_effort(self, model: str, effort: str | None) -> None:
        # Clearing is always permitted, including while a provider is offline.
        if effort is None:
            return
        if not _identifier(effort, 40):
            raise AppError("invalid_reasoning_effort", "Choose a supported reasoning effort.")
        selected = await self.validate_selection("codex", model)
        if effort not in {item["reasoningEffort"] for item in selected.get("supportedReasoningEfforts", [])}:
            raise AppError("invalid_reasoning_effort", "The selected model does not offer this reasoning effort.")

    def _reuse_codex(self) -> None:
        values = self.credentials.metadata_environment()
        source = Path(values.get("CODEX_HOME") or _home(values) / ".codex") / "auth.json"
        target_home = self.workspace / "codex_home"
        target = target_home / "auth.json"
        if target_home.is_symlink() or target.is_symlink():
            raise ValueError("unsafe auth target")
        try:
            data = _auth_bytes(source)
        except (OSError, ValueError, TypeError, AppError):
            # An unusable ambient cache never overwrites an accepted login.
            if _present(target):
                return
            raise ValueError("no reusable auth") from None
        if source.resolve() == target.resolve(strict=False):
            target.chmod(0o600)
            return
        target_home.mkdir(mode=0o700, exist_ok=True)
        target_home.chmod(0o700)
        stage = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".auth-", dir=target_home, delete=False) as handle:
                stage = Path(handle.name)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            stage.chmod(0o600)
            os.replace(stage, target)
            _sync_directory(target_home)
        finally:
            if stage is not None:
                stage.unlink(missing_ok=True)

    async def login_codex(self) -> dict:
        """Explicit enrollment. Never replace accepted auth before verification."""
        try:
            return await run_in_threadpool(self._login_codex)
        except AppError:
            raise
        except Exception:
            raise AppError("provider_login_failed", "Codex login could not be completed. Check the managed provider runtime and credential status before retrying.", 503) from None

    def _login_codex(self) -> dict:
        from jobctrl.app.provider_support.codex_workspace import ensure_codex_workspace_root, reject_codex_path_redirection

        values = self.credentials.metadata_environment()
        helper = values.get("JOBCTRL_E2E_CODEX_LOGIN_HELPER")
        if self.synthetic:
            if not helper:
                raise AppError("provider_login_unavailable", "The controlled Codex login runtime is unavailable.", 503)
            binary = Path(helper)
            if (not binary.is_absolute() or binary.resolve() != binary
                    or not binary.is_relative_to(self.workspace.resolve()) or not os.access(binary, os.X_OK)):
                raise AppError("synthetic_boundary_unowned", "The Codex login helper must belong to this E2E workspace.", 503)
            _regular_file(binary, max_bytes=1024 * 1024)
            from jobctrl.app.provider_support.codex_isolation import _isolated_codex_env
            configuration = {"codex_bin": str(binary), "env": _isolated_codex_env(
                self.workspace / "codex_home", self.workspace / "codex_home" / "home")}
        else:
            from jobctrl.app.model_providers import build_codex_factory
            configuration = build_codex_factory(self.workspace, values, require_auth=False).jobctrl_runtime_config
        home = self.workspace / "codex_home"
        target = home / "auth.json"
        reject_codex_path_redirection(home)
        home.mkdir(mode=0o700, exist_ok=True)
        home.chmod(0o700)
        with self.credentials.mutation_guard():
            previous = _auth_identity(target)
            key = values.get("CODEX_API_KEY") or values.get("OPENAI_API_KEY")
            if not key and self.credentials.store is not None and self.credentials.store.kind is not None:
                try:
                    key = self.credentials.store.read("OPENAI_API_KEY")
                except Exception:
                    raise AppError("provider_login_credentials_unavailable",
                                   "The stored Codex API key could not be inspected. Unlock the credential store or use an explicit launch-environment key.", 503) from None
            with tempfile.TemporaryDirectory(prefix=".codex-login-", dir=self.workspace) as temporary:
                candidate = Path(temporary)
                candidate_home = candidate / "codex_home"
                process_home = candidate_home / "home"
                workdir = candidate_home / "workspace"
                candidate_home.mkdir(mode=0o700)
                process_home.mkdir(mode=0o700)
                workdir.mkdir(mode=0o700)
                ensure_codex_workspace_root(candidate_home, workdir)
                # A complete child environment, rather than overrides merged
                # over the API's provider credentials and user configuration.
                plumbing = {"PATH", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY",
                            "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"}
                environment = {name: value for name, value in values.items() if name in plumbing}
                environment.update(configuration["env"])
                environment.update(CODEX_HOME=str(candidate_home), HOME=str(process_home),
                                   USERPROFILE=str(process_home), TMPDIR=str(candidate), TMP=str(candidate), TEMP=str(candidate))
                binary = Path(configuration["codex_bin"])
                command = ([sys.executable, "-I", "-B", str(binary)] if self.synthetic and binary.suffix == ".py"
                           else [str(binary)])
                # The CLI uses only the new candidate home. Credentials and
                # login URLs stay out of arguments, responses and application logs.
                login = [*command, "login", *(["--with-api-key"] if key else [])]
                try:
                    result = self.credentials.run_provider_enrollment(login, input=key + "\n" if key else None,
                                                                       environment=environment, working_directory=workdir)
                    if result.returncode:
                        raise AppError("provider_login_failed", "Codex login did not complete. The previous login is retained.", 503)
                    data = _auth_bytes(candidate_home / "auth.json")
                    verified = self.credentials.run_provider_enrollment([*command, "login", "status"],
                                                                        environment=environment, working_directory=workdir, timeout=20)
                    if verified.returncode:
                        raise AppError("provider_login_failed", "Codex login could not be verified. The previous login is retained.", 503)
                    reject_codex_path_redirection(home)
                    if _auth_identity(target) != previous:
                        raise AppError("provider_login_conflict", "Codex login changed elsewhere. The newer login is retained.", 409)
                    staged = None
                    try:
                        with tempfile.NamedTemporaryFile(prefix=".auth-", dir=home, delete=False) as handle:
                            staged = Path(handle.name)
                            handle.write(data)
                            handle.flush()
                            os.fsync(handle.fileno())
                        staged.chmod(0o600)
                        os.replace(staged, target)
                        _sync_directory(home)
                    finally:
                        if staged is not None:
                            staged.unlink(missing_ok=True)
                except AppError:
                    raise
                except Exception:
                    raise AppError("provider_login_failed", "Codex login could not be completed. Check provider status before retrying.", 503) from None
        if self.runtime:
            with self.runtime.database.transaction() as connection:
                self.runtime.events.append(connection, "CredentialsUpdated", {"providers": ["codex"]}, feature="credentials")
        return {"ok": True, "provider": "codex", "status": "connected", "message": "Codex CLI login completed and was verified."}

    async def verify_codex(self) -> dict:
        if self.synthetic:
            # Synthetic provider metadata replaces only the external auth
            # runtime. Never inspect/copy a host login in an owned E2E run.
            catalog = await self._synthetic_catalog()
            connected = catalog["providers"][0]["ready"]
            return {"provider": "codex", "ok": connected, "status": "connected" if connected else "not_configured",
                    "message": "Codex CLI authentication verified." if connected else "Codex CLI is not authenticated."}
        try:
            def enroll():
                with MutationGuard(self.credentials.lock_path).acquire():
                    self._reuse_codex()

            await run_in_threadpool(enroll)
            values = self.credentials.metadata_environment()
            from jobctrl.app.model_providers import build_codex_factory
            factory = await run_in_threadpool(build_codex_factory, self.workspace, values)
            async with asyncio.timeout(20):
                async with factory() as client:
                    response = await client.account(refresh_token=False)
            connected = _field(response, "account") is not None
            return {"provider": "codex", "ok": connected, "status": "connected" if connected else "not_configured",
                    "message": "Codex CLI authentication verified." if connected else "Codex CLI is not authenticated."}
        except Exception:
            return {"provider": "codex", "ok": False, "status": "failed",
                    "message": "Codex authentication reuse or verification failed."}


def build_provider_routes(runtime, *, credential_service: CredentialService | None = None) -> tuple[Route, ...]:
    service = ProviderService(runtime, credentials=credential_service)

    async def status(request):
        return JSONResponse(await service.status())

    async def catalog(request):
        return JSONResponse(await service.catalog())

    async def verify(request):
        body = await request.body()
        if body:
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                raise AppError("invalid_json", "The request must contain valid JSON.") from None
            if payload != {}:
                raise AppError("invalid_provider_verification", "Codex verification accepts an empty object.")
        return JSONResponse(await service.verify_codex())

    async def login(request):
        body = await request.body()
        if body:
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                raise AppError("invalid_json", "The request must contain valid JSON.") from None
            if payload != {}:
                raise AppError("invalid_provider_login", "Codex login accepts an empty object.")
        return JSONResponse(await service.login_codex())

    return (Route("/v1/providers/status", status, methods=["GET"]),
            Route("/v1/providers/models", catalog, methods=["GET"]),
            Route("/v1/providers/codex/verify", verify, methods=["POST"]),
            Route("/v1/providers/codex/login", login, methods=["POST"]))
