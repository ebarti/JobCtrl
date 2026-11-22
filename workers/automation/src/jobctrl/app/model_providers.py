"""Production SDK execution, independent of admission and receipt persistence.

Only this boundary resolves execution credentials. The gateway owns model
selection, lane/spend admission, JSON Schema validation and accepted receipts.
The retained kit adapters own SDK conversations and settled cancellation; none
of the legacy generation spans or business repositories participate here.
"""

from __future__ import annotations

import asyncio
import atexit
import importlib.metadata
import inspect
import json
import math
import os
import shutil
import sys
import tempfile
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from jobctrl.app.errors import AppError

_MAX_RESULT_BYTES = 2 * 1024 * 1024
_MAX_REQUEST_BYTES = 8 * 1024 * 1024
_GOOGLE_WORKER = "--google-provider-worker"
_runtime_lock = threading.Lock()
_runtime: tuple[int, Any] | None = None


@dataclass(frozen=True)
class ProviderResult:
    value: dict
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    cost_source: str | None = None
    cost_provenance: dict[str, str | None] | None = None


def _runtime_service():
    """Reuse the lifecycle class without its legacy configuration singleton."""
    global _runtime
    from jobctrl.app.provider_support.pool import AgentRuntimeService

    with _runtime_lock:
        if _runtime is None or _runtime[0] != os.getpid():
            # Active concurrency remains the gateway's lane policy. This bounds
            # idle clients only and does not add an execution queue.
            _runtime = (os.getpid(), AgentRuntimeService(capacity=4))
        return _runtime[1]


def close_provider_runtimes() -> None:
    """Close only the SDK runtime cache owned by the target application."""
    global _runtime
    with _runtime_lock:
        runtime, _runtime = _runtime, None
    if runtime is not None and runtime[0] == os.getpid():
        runtime[1].close()


atexit.register(close_provider_runtimes)


def _count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _cost(value: Any) -> float | None:
    if type(value) not in {int, float} or value < 0:
        return None
    try:
        return float(value) if math.isfinite(value) else None
    except OverflowError:
        return None


@dataclass
class _Usage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    cost_source: str | None = None
    cost_provenance: dict[str, str | None] | None = None

    def record(self, input_tokens=None, output_tokens=None, *, unresolved_usage=None) -> None:
        # These are cumulative native observations, never additive estimates.
        # An unresolved report must not restore a guessed SDK aggregate.
        self.input_tokens = _count(input_tokens)
        self.output_tokens = _count(output_tokens)

    def claude(self, _output="", *, input_tokens=None, output_tokens=None,
               unresolved_usage=None, **_ignored) -> None:
        self.record(input_tokens, output_tokens, unresolved_usage=unresolved_usage)

    def snapshot(self) -> dict:
        return {key: value for key, value in (
            ("input_tokens", self.input_tokens), ("output_tokens", self.output_tokens), ("cost_usd", self.cost_usd),
            ("cost_source", self.cost_source),
            ("cost_provenance", self.cost_provenance),
        ) if value is not None}

    def result(self, value: dict) -> ProviderResult:
        return ProviderResult(value, self.input_tokens, self.output_tokens, self.cost_usd, self.cost_source,
                              self.cost_provenance)


@dataclass
class _Attempt:
    started: bool = False


def _object(value: Any) -> dict:
    """Decode the native JSON object without fence removal or text fallback."""
    if isinstance(value, str):
        if len(value.encode("utf-8")) > _MAX_RESULT_BYTES:
            raise AppError("model_output_too_large", "The provider output exceeds its limit.", 502)

        def pairs(items):
            result = {}
            for key, item in items:
                if key in result:
                    raise ValueError("Duplicate JSON property.")
                result[key] = item
            return result

        def constant(_value):
            raise ValueError("Nonfinite JSON number.")

        try:
            value = json.loads(value, object_pairs_hook=pairs, parse_constant=constant)
        except (json.JSONDecodeError, ValueError):
            raise AppError("model_schema_violation", "The provider did not return strict JSON.", 502) from None
    if not isinstance(value, dict):
        raise AppError("model_schema_violation", "The provider did not return a JSON object.", 502)
    return value


def _private_directory(path: Path, *, parent: Path) -> Path:
    from jobctrl.app.provider_support.codex_workspace import reject_codex_path_redirection
    from jobctrl.app.provider_support.auth import ensure_private_directory

    reject_codex_path_redirection(parent)
    reject_codex_path_redirection(path)
    return ensure_private_directory(path, parent=parent)


def _activate(provider: str, workspace: Path, environment: Mapping[str, str]) -> None:
    from jobctrl.runtime import activate_provider_pack, is_bundled_runtime

    if is_bundled_runtime(environment):
        activate_provider_pack({
            "codex": "codex-provider-runtime", "claude": "claude-agent-sdk", "google": "antigravity-provider-runtime",
        }[provider], app_dir=workspace)


def _codex_binary(environment: Mapping[str, str]) -> Path:
    from jobctrl.runtime import is_bundled_runtime

    override = environment.get("JOBCTRL_CODEX_BIN")
    if override:
        if is_bundled_runtime(environment):
            raise AppError("model_runtime_override_refused", "The installed provider package owns the Codex executable.")
        return Path(override).expanduser()
    # Activation above already verified this workspace's provider package. The
    # legacy resolver would reactivate the first process-global APP_DIR here.
    from codex_cli_bin import bundled_codex_path

    return Path(bundled_codex_path())


def _claude_binary(environment: Mapping[str, str]) -> str:
    from jobctrl.runtime import is_bundled_runtime
    import claude_agent_sdk

    bundled = is_bundled_runtime(environment)
    override = environment.get("JOBCTRL_CLAUDE_BIN")
    if override:
        if bundled:
            raise AppError("model_runtime_override_refused", "The installed provider package owns the Claude executable.")
        return str(Path(override).expanduser())
    if not bundled:
        source = shutil.which("claude", path=environment.get("PATH", os.defpath))
        if source:
            return source
    return str(Path(claude_agent_sdk.__file__).resolve().parent / "_bundled" / "claude")


def build_codex_factory(workspace: Path, environment: Mapping[str, str], *,
                        require_auth: bool = True) -> Callable[[], Any]:
    """Build an isolated SDK client; never enroll ambient Codex credentials.

    Provider setup owns the explicit enrollment action. Catalog discovery may
    use the same client configuration with ``require_auth=False``.
    """
    from jobctrl.app.provider_support.codex_isolation import (
        _codex_client_context, _codex_config_overrides, _isolated_codex_env,
    )
    from jobctrl.app.provider_support.codex_workspace import ensure_codex_workspace_root
    from jobctrl.app.provider_support.auth import _validate_codex_auth_file

    workspace = workspace.resolve(strict=True)
    _activate("codex", workspace, environment)
    from openai_codex import AsyncCodex, CodexConfig

    home = _private_directory(workspace / "codex_home", parent=workspace)
    if require_auth:
        _validate_codex_auth_file(home / "auth.json")
    workdir = _private_directory(home / "workspace", parent=home)
    process_home = _private_directory(home / "home", parent=home)
    ensure_codex_workspace_root(home, workdir)
    binary = _codex_binary(environment).resolve(strict=True)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise AppError("model_runtime_unavailable", "The Codex runtime executable is unavailable.", 503)
    configuration = {
        "cwd": str(workdir), "env": _isolated_codex_env(home, process_home),
        "config_overrides": _codex_config_overrides(binary), "codex_bin": str(binary),
    }

    def factory():
        return _codex_client_context(AsyncCodex, CodexConfig, configuration=configuration)

    factory.jobctrl_managed_startup = True
    factory.jobctrl_runtime_config = configuration
    return factory


def build_claude_options(workspace: Path, environment: Mapping[str, str], *, model: str,
                         instructions: str, response_schema: dict | None = None) -> Any:
    """Return a fresh tool-free, bare Claude request with explicit auth values."""
    from jobctrl.app.provider_support.auth import (
        _CLAUDE_CONSUMER_AUTH_ENV, probe_claude_auth,
    )

    workspace = workspace.resolve(strict=True)
    _activate("claude", workspace, environment)
    from claude_agent_sdk import ClaudeAgentOptions

    if not probe_claude_auth(environment, workspace=workspace).ok:
        raise AppError("model_credentials_unavailable", "Supported Claude credentials are unavailable.", 503)
    home = _private_directory(workspace / "claude_home", parent=workspace)
    config_dir = _private_directory(home / "config", parent=home)
    workdir = _private_directory(home / "workspace", parent=home)
    # The SDK merges env over its parent. Explicit empty values neutralize both
    # ambient consumer sessions and credentials excluded by the resolver.
    keys = {
        "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_VERTEX_PROJECT_ID",
        "ANTHROPIC_VERTEX_REGION", "ANTHROPIC_AWS_WORKSPACE_ID", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_QUOTA_PROJECT", *_CLAUDE_CONSUMER_AUTH_ENV,
        *(key for key in os.environ if key.startswith(("AWS_", "AZURE_", "ANTHROPIC_FOUNDRY_"))),
        *(key for key in environment if key.startswith(("AWS_", "AZURE_", "ANTHROPIC_FOUNDRY_"))),
    }
    child_env = {key: environment.get(key, "") for key in keys}
    child_env.update({key: "" for key in _CLAUDE_CONSUMER_AUTH_ENV})
    child_env["CLAUDE_CONFIG_DIR"] = str(config_dir)
    values = {
        "model": model, "system_prompt": instructions, "cwd": str(workdir), "env": child_env,
        "cli_path": _claude_binary(environment), "extra_args": {"bare": None},
        "setting_sources": [], "tools": [], "allowed_tools": [], "max_turns": None,
        "permission_mode": "dontAsk", "continue_conversation": False, "resume": None,
        "stderr": lambda _line: None,
    }
    if response_schema is not None:
        values["output_format"] = {"type": "json_schema", "schema": response_schema}
    return ClaudeAgentOptions(**values)


async def _codex(workspace: Path, environment: Mapping[str, str], model: str, instructions: str,
                 payload: dict, schema: dict, usage: _Usage, attempt: _Attempt, *, effort: str = "high") -> dict:
    from agent_runtime_kit import AgentTask, FilesystemAccess, PermissionMode, PermissionProfile
    from jobctrl.app.provider_support.codex_isolation import _CODEX_PERMISSION_PROFILE
    from jobctrl.app.provider_support.strict_schema import strict_json_schema
    from jobctrl.app.provider_support import codex as native
    from jobctrl.app.provider_support.errors import codex_protocol_error

    factory = build_codex_factory(workspace, environment)
    from openai_codex import ApprovalMode

    def approval():
        return ApprovalMode.deny_all

    state = native._Call(model, "determine", effort, usage.record)
    token = native._call.set(state)
    try:
        task = AgentTask(
            goal=json.dumps(payload, ensure_ascii=False, allow_nan=False), system=instructions,
            model=model, reasoning_effort=effort, output_schema=strict_json_schema(schema),
            working_directory=Path(factory.jobctrl_runtime_config["cwd"]),
            permissions=PermissionProfile(mode=PermissionMode.STRICT, filesystem=FilesystemAccess.READ_ONLY,
                                          native_profile=_CODEX_PERMISSION_PROFILE),
        )
        attempt.started = True
        await _runtime_service().run_async(
            native._factory_key(factory, model, effort, approval), lambda: native._runtime(factory, approval), task,
        )
        if state.outcome is None:
            raise codex_protocol_error(model=model, operation="determine", code="runtime_completion_missing", retryable=True)
        # Native success is established by run_codex_turn. The gateway validates
        # the original schema after the SDK's stricter transport adaptation.
        usage.record(state.outcome.input_tokens, state.outcome.output_tokens)
        return _object(state.outcome.final_response)
    finally:
        native._call.reset(token)


async def _claude(workspace: Path, environment: Mapping[str, str], model: str, instructions: str,
                  payload: dict, schema: dict, usage: _Usage, attempt: _Attempt) -> dict:
    from agent_runtime_kit import AgentTask, FilesystemAccess, PermissionMode, PermissionProfile
    from jobctrl.app.provider_support.claude import _record_available_usage
    from jobctrl.app.provider_support import claude as native
    from jobctrl.app.provider_support.errors import raise_on_claude_failure

    options = build_claude_options(workspace, environment, model=model, instructions=instructions,
                                  response_schema=schema)
    from claude_agent_sdk import query

    try:
        sdk_version = importlib.metadata.version("claude-agent-sdk")
    except importlib.metadata.PackageNotFoundError:
        sdk_version = None
    cost_provenance = {"sdk": "claude-agent-sdk", "sdk_version": sdk_version,
                       "cli": "claude-code", "cli_version": None,
                       "pricing_source": "claude-code-bundled-price-table"}

    def terminal_cost(message):
        usage.cost_usd = _cost(getattr(message, "total_cost_usd", None)) if native._terminal_cost_complete(message) else None
        usage.cost_source = "sdk_estimate" if usage.cost_usd is not None else None
        usage.cost_provenance = dict(cost_provenance) if usage.cost_usd is not None else None

    async def observe_query(*, prompt, options):
        stream = query(prompt=prompt, options=options)
        if inspect.isawaitable(stream):
            stream = await stream
        try:
            async for message in stream:
                if type(message).__name__ == "ResultMessage":
                    terminal_cost(message)
                yield message
        finally:
            close = getattr(stream, "aclose", None)
            if close is not None:
                await close()

    state = native._Call(observe_query, options, model, "determine")
    token = native._call.set(state)
    try:
        task = AgentTask(
            goal=json.dumps(payload, ensure_ascii=False, allow_nan=False), system=instructions, model=model,
            output_schema=schema,
            permissions=PermissionProfile(mode=PermissionMode.STRICT, filesystem=FilesystemAccess.READ_ONLY),
        )
        try:
            attempt.started = True
            result = await _runtime_service().run_async(
                ("claude", model),
                lambda: native._ClaudeRuntime(query_func=native._query, options_cls=native._options, reuse_process=False), task,
            )
        finally:
            # run_async joins request/cleanup before returning or propagating
            # cancellation. Available native observations are now stable.
            _record_available_usage(state.messages, usage.claude)
        messages = native._ClaudeMessages(
            state.messages, succeeded=result.is_success, structured=True, post_terminal_failure=state.post_terminal_failure,
        )
    finally:
        native._call.reset(token)
    terminal = next((message for message in reversed(messages) if type(message).__name__ == "ResultMessage"), None)
    if terminal is not None:
        terminal_cost(terminal)
    raise_on_claude_failure(messages, model=model, operation="determine")
    if terminal is None:
        raise AppError("model_provider_failed", "The Claude runtime returned no terminal receipt.", 502)
    if getattr(terminal, "subtype", None) != "success":
        raise AppError("model_provider_failed", "The Claude runtime did not complete successfully.", 502)
    return _object(getattr(terminal, "structured_output", None))


async def _google_native(workspace: Path, environment: Mapping[str, str], model: str, instructions: str,
                         payload: dict, schema: dict, usage: _Usage, attempt: _Attempt) -> dict:
    """Run inside a child whose environment is the selected Google auth chain."""
    from agent_runtime_kit import AgentTask, FilesystemAccess, PermissionMode, PermissionProfile
    from agent_runtime_kit.adapters.antigravity import AntigravityAgentRuntime
    from jobctrl.app.provider_support.gemini_schema import gemini_json_schema
    from jobctrl.app.provider_support import google as native
    from jobctrl.app.provider_support.auth import antigravity_auth_kwargs

    _activate("google", workspace, environment)
    from google.antigravity import types
    from google.antigravity.agent import Agent
    from google.antigravity.connections.local.local_connection_config import LocalAgentConfig

    root = _private_directory(workspace / "google_home", parent=workspace)
    with tempfile.TemporaryDirectory(prefix="execution-", dir=root) as temporary:
        config = LocalAgentConfig(
            model=model, system_instructions=instructions,
            capabilities=types.CapabilitiesConfig(enabled_tools=[types.BuiltinTools.FINISH], enable_subagents=False),
            policies=[], workspaces=[], tools=[], mcp_servers=[], skills_paths=[],
            save_dir=str(Path(temporary) / "sessions"), app_data_dir=str(Path(temporary) / "appdata"),
            response_schema=json.dumps(gemini_json_schema(schema), allow_nan=False),
            **antigravity_auth_kwargs(environment, workspace=workspace),
        )
        state = native._Call(Agent, config, True, native.AntigravityGeneration(), usage.record)
        token = native._call.set(state)
        try:
            task = AgentTask(
                goal=json.dumps(payload, ensure_ascii=False, allow_nan=False), system=instructions,
                model=model, output_schema=schema,
                permissions=PermissionProfile(mode=PermissionMode.STRICT, filesystem=FilesystemAccess.READ_ONLY,
                                              allowed_tools=(str(types.BuiltinTools.FINISH.value),)),
            )
            try:
                attempt.started = True
                result = await _runtime_service().run_async(
                    ("google", model, temporary),
                    lambda: AntigravityAgentRuntime(
                        api_key=config.api_key, vertex=config.vertex, project=config.project, location=config.location,
                        data_dir=Path(temporary), agent_cls=native._Agent, config_cls=native._configuration,
                        types_module=types, policy_module=SimpleNamespace(), reuse_process=True,
                    ), task,
                )
            finally:
                native._record_available_usage(state)
            # The retained legacy convenience function discards this status.
            # A safety/token-limit stop cannot authorize its partial object.
            if not result.is_success:
                raise AppError("model_provider_failed", "The Google runtime did not complete successfully.", 502)
            return _object(state.response.structured)
        finally:
            try:
                await asyncio.to_thread(close_provider_runtimes)
            finally:
                native._call.reset(token)


async def _joined(task: asyncio.Task):
    """Join SDK/process cleanup even when cancellation is repeated."""
    while not task.done():
        try:
            await asyncio.wait({task})
        except asyncio.CancelledError:
            pass
    return task.result()


async def _read_worker(process) -> bytes:
    data = bytearray()
    oversized = False
    while chunk := await process.stdout.read(65536):
        if len(data) + len(chunk) > _MAX_RESULT_BYTES + 65536:
            oversized = True
        elif not oversized:
            data.extend(chunk)
    await process.wait()
    if oversized:
        raise AppError("model_output_too_large", "The provider output exceeds its limit.", 502)
    return bytes(data)


def _worker_result(data: bytes, usage: _Usage, attempt: _Attempt) -> dict:
    result = _object(data.decode("utf-8"))
    if type(result.get("provider_started")) is bool:
        attempt.started = result["provider_started"]
    observed = result.get("usage")
    if isinstance(observed, dict):
        usage.record(observed.get("input_tokens"), observed.get("output_tokens"))
        usage.cost_usd = _cost(observed.get("cost_usd"))
        usage.cost_source = "provider_reported" if usage.cost_usd is not None and observed.get("cost_source") == "provider_reported" else None
    if result.get("status") != "succeeded":
        raise AppError("model_provider_failed", "The Google runtime did not complete successfully.", 502)
    return _object(result.get("value"))


async def _google(workspace: Path, environment: Mapping[str, str], model: str, instructions: str,
                  payload: dict, schema: dict, usage: _Usage, attempt: _Attempt) -> dict:
    # The pinned Google SDK does not expose a child-env parameter. A dedicated
    # Python child supplies the exact ADC/API configuration without mutating the
    # application environment or leaking it into a concurrent provider request.
    request = json.dumps({"workspace": str(workspace), "model": model, "instructions": instructions,
                          "payload": payload, "schema": schema}, ensure_ascii=False, allow_nan=False).encode() + b"\n"
    if len(request) > _MAX_REQUEST_BYTES:
        raise AppError("model_input_too_large", "The provider input exceeds its limit.")
    startup = asyncio.create_task(asyncio.create_subprocess_exec(
        sys.executable, "-m", "jobctrl.app.model_providers", _GOOGLE_WORKER,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env=dict(environment), cwd=workspace,
    ))
    process = None
    reader = None
    sent = False
    try:
        await asyncio.wait({startup})
        process = startup.result()
        # A vanished child may have dispatched before losing its receipt.
        # Only its explicit pre-dispatch outcome may clear this uncertainty.
        attempt.started = True
        reader = asyncio.create_task(_read_worker(process))
        process.stdin.write(request)
        sent = True
        await process.stdin.drain()
        data = await asyncio.shield(reader)
        if process.returncode:
            # Even a failed child can supply observed usage before exiting.
            try:
                _worker_result(data, usage, attempt)
            except Exception:
                pass
            raise AppError("model_provider_failed", "The Google runtime exited without a successful result.", 502)
        return _worker_result(data, usage, attempt)
    except BaseException:
        if process is None:
            process = await _joined(startup)
            attempt.started = True
        if reader is None:
            reader = asyncio.create_task(_read_worker(process))
        try:
            if process.returncode is None:
                if not sent:
                    process.stdin.write(request)
                process.stdin.write(b"cancel\n")
                process.stdin.close()
            data = await _joined(reader)
            try:
                _worker_result(data, usage, attempt)
            except Exception:
                pass
        except Exception:
            # Cleanup must retain the original cancellation/provider failure.
            pass
        raise
    finally:
        if process is not None and process.stdin is not None:
            process.stdin.close()


def _safe_failure(error: BaseException, *, provider: str, model: str) -> BaseException:
    from jobctrl.app.provider_support.codex import _safe_exception_tree
    from jobctrl.app.provider_support.errors import ProviderCallError, provider_exception_error

    def sanitize(item):
        if isinstance(item, AppError):
            return AppError(item.code, item.message, item.status_code)
        if isinstance(item, ProviderCallError):
            return ProviderCallError(item.envelope)
        return provider_exception_error(provider=provider, model=model, operation="determine", error=item)

    return _safe_exception_tree(error, group_message="Model provider execution failed.", failure_factory=sanitize)


async def execute_provider(*, workspace: Path, provider: str, model: str, instructions: str,
                           payload: dict, response_schema: dict, configuration: dict) -> ProviderResult:
    """Execute one selected provider attempt with its native usage, if reported."""
    usage = _Usage()
    attempt = _Attempt()
    try:
        if provider not in {"codex", "claude", "google"}:
            raise AppError("model_provider_unsupported", "Choose a supported model provider.")
        from jobctrl.app.credentials import CredentialService

        workspace = workspace.resolve(strict=True)
        environment = CredentialService(workspace).execution_environment(
            configuration=configuration.get("providerConfiguration", {}), provider=provider,
        )
        kwargs = {}
        if provider == "codex":
            effort = configuration.get("codexReasoningEfforts", {}).get(model, "high")
            if effort not in {"low", "medium", "high", "xhigh", "max"}:
                raise AppError("model_reasoning_effort_invalid", "Choose a supported Codex reasoning effort.")
            kwargs["effort"] = effort
        value = await {"codex": _codex, "claude": _claude, "google": _google}[provider](
            workspace, environment, model, instructions, payload, response_schema, usage, attempt, **kwargs,
        )
        return usage.result(value)
    except BaseException as error:
        failure = _safe_failure(error, provider=provider, model=model)
        failure.usage = usage.snapshot()
        failure.provider_started = attempt.started
        raise failure from None


def _read_request() -> tuple[dict, bytes]:
    # Preserve raw read-ahead explicitly: a following cancel line belongs to the
    # control reader while SDK startup is in progress.
    data = bytearray()
    while len(data) <= _MAX_REQUEST_BYTES:
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            return _object(data.decode("utf-8")), b"cancel\n"
        line, separator, remaining = chunk.partition(b"\n")
        data.extend(line)
        if len(data) > _MAX_REQUEST_BYTES:
            break
        if separator:
            return _object(data.decode("utf-8")), remaining
    raise ValueError("Provider request exceeds its limit.")


async def _google_worker(request: dict, pending_control: bytes) -> dict:
    usage = _Usage()
    attempt = _Attempt()
    task = asyncio.create_task(_google_native(
        Path(request["workspace"]), os.environ, request["model"], request["instructions"],
        request["payload"], request["schema"], usage, attempt,
    ))
    loop = asyncio.get_running_loop()

    def control():
        # A raw descriptor read in a daemon thread is portable and does not hold
        # a buffered-IO lock during Python shutdown. EOF also revokes the call.
        try:
            if b"\n" not in pending_control:
                while chunk := os.read(sys.stdin.fileno(), 64):
                    if b"\n" in chunk:
                        break
        except OSError:
            pass
        if not loop.is_closed():
            loop.call_soon_threadsafe(task.cancel)

    threading.Thread(target=control, name="jobctrl-google-control", daemon=True).start()
    try:
        value = await task
        return {"status": "succeeded", "value": value, "usage": usage.snapshot(), "provider_started": attempt.started}
    except BaseException:
        # Neither the IPC stream nor child stderr carries provider error text,
        # sources, credentials or a rendered SDK exception chain.
        return {"status": "failed", "usage": usage.snapshot(), "provider_started": attempt.started}


def _worker_main() -> None:
    try:
        result = asyncio.run(_google_worker(*_read_request()))
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False).encode()
        if len(encoded) > _MAX_RESULT_BYTES:
            encoded = json.dumps({"status": "failed", "usage": result.get("usage", {}),
                                  "provider_started": result.get("provider_started")}).encode()
    except BaseException:
        encoded = b'{"status":"failed","usage":{}}'
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    if sys.argv[1:] != [_GOOGLE_WORKER]:
        raise SystemExit(2)
    _worker_main()
