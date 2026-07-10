"""ClaudeCodeCliAdapter — local-mode ``AutonomousAgentPort`` adapter.

Spawns the resolved Claude apply runtime as a subprocess, pipes the rendered
prompt in via stdin, streams the JSON output, parses ``RESULT:...`` lines, and
assembles an ``AgentResult``. The logic is lifted out of the legacy
``apply/launcher.run_job`` function — same Popen invocation, same stdout reader
thread pattern, same RESULT parsing — but relocated behind the port so the use
cases never touch ``subprocess`` or ``threading`` directly.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import queue
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

from jobctrl import config
from jobctrl.domain.apply.value_objects import (
    Applied,
    ApplyPrompt,
    Captcha,
    DryRunComplete,
    EmailOnlyApplication,
    Expired,
    Failed,
    LoginIssue,
    Manual,
    SubmissionResult,
    TokenUsage,
)
from jobctrl.domain.ports.apply import AgentResult, BrowserSession
from jobctrl.infrastructure.setup_probes import resolve_claude_apply_binary
from jobctrl.runtime import is_bundled_runtime

log = logging.getLogger(__name__)


# Apply runs get an explicit owned-tool allowlist rather than a broad
# permission bypass. Keep this aligned with the pinned Playwright MCP
# package in ``domain.apply.services``.
PINNED_PLAYWRIGHT_MCP_TOOLS = frozenset(
    {
        "browser_close",
        "browser_resize",
        "browser_console_messages",
        "browser_handle_dialog",
        "browser_evaluate",
        "browser_file_upload",
        "browser_drop",
        "browser_fill_form",
        "browser_press_key",
        "browser_type",
        "browser_navigate",
        "browser_navigate_back",
        "browser_network_requests",
        "browser_network_request",
        "browser_run_code_unsafe",
        "browser_take_screenshot",
        "browser_snapshot",
        "browser_click",
        "browser_drag",
        "browser_hover",
        "browser_select_option",
        "browser_tabs",
        "browser_wait_for",
    }
)
PLAYWRIGHT_TOOL_EXCLUSIONS = frozenset(
    {
        "browser_console_messages",
        "browser_drop",
        "browser_evaluate",
        "browser_file_upload",
        "browser_network_request",
        "browser_network_requests",
        "browser_resize",
        "browser_run_code_unsafe",
    }
)
PLAYWRIGHT_APPLY_TOOLS = frozenset(
    f"mcp__playwright__{tool}"
    for tool in sorted(PINNED_PLAYWRIGHT_MCP_TOOLS - PLAYWRIGHT_TOOL_EXCLUSIONS)
)
GMAIL_APPLY_TOOLS = frozenset({"mcp__gmail__get_verification_code"})
BASE_OWNED_APPLY_TOOLS = frozenset(
    {
        "mcp__apply_tools__type_credential",
        "mcp__apply_tools__upload_artifact",
    }
)
CAPTCHA_APPLY_TOOL = "mcp__apply_tools__solve_captcha"
DISALLOWED_CLAUDE_TOOLS = (
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
)
_ALLOWED_TOOLS = ",".join(
    sorted(PLAYWRIGHT_APPLY_TOOLS | GMAIL_APPLY_TOOLS | BASE_OWNED_APPLY_TOOLS)
)
_DISALLOWED_TOOLS = ",".join(DISALLOWED_CLAUDE_TOOLS)

_ENV_ALLOWLIST = {
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
}

# Result codes the agent emits as ``RESULT:CODE`` lines.
_RESULT_CODES = ("APPLIED", "DRY_RUN", "EXPIRED", "CAPTCHA", "LOGIN_ISSUE")
_EMAIL_ONLY_RE = re.compile(r"RESULT:EMAIL_ONLY:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})")

# Reasons that get promoted from ``RESULT:FAILED:reason`` to a
# dedicated SubmissionResult variant.
_PROMOTED_FAILED_REASONS = {"captcha", "expired", "login_issue"}
_DEFAULT_MODEL_SENTINELS = {"", "default", "local-default"}
_ACTIVE_CLAUDE_PROCS: dict[int, subprocess.Popen] = {}
_ACTIVE_CLAUDE_LOCK = threading.Lock()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _enqueue_stdout_lines(stream: Any, out: "queue.Queue[str | None]") -> None:
    try:
        for line in stream:
            out.put(line)
    finally:
        out.put(None)


def _clean_reason(s: str) -> str:
    return re.sub(r'[*`"]+$', '', s).strip()


def kill_active_claude_processes() -> None:
    """Best-effort cleanup hook for launcher Ctrl-C handling."""
    with _ACTIVE_CLAUDE_LOCK:
        procs = tuple(_ACTIVE_CLAUDE_PROCS.items())

    for worker_id, proc in procs:
        if proc.poll() is None:
            _kill_process_tree_if_alive(proc)
        _unregister_active_claude_process(worker_id, proc)


class ClaudeCodeCliAdapter:
    """``AutonomousAgentPort`` implementation that spawns a Claude runtime.

    The adapter writes the MCP config to a per-worker JSON file, runs
    the resolved binary with ``--model X -p --mcp-config ...
    --output-format stream-json``, pipes the prompt in via stdin, and parses the
    streamed output. Each tool-use / assistant-text / result message is folded
    into a structured event payload that the saga later appends to the
    aggregate's timeline.
    """

    def __init__(
        self,
        *,
        log_dir: Path | None = None,
        app_dir: Path | None = None,
        default_timeout_seconds: int | None = None,
    ) -> None:
        self._log_dir = Path(log_dir) if log_dir else config.LOG_DIR
        self._app_dir = Path(app_dir) if app_dir else config.APP_DIR
        self._default_timeout = (
            int(default_timeout_seconds)
            if default_timeout_seconds is not None
            else config.get_apply_timeout_seconds()
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def submit_application(
        self,
        *,
        prompt: ApplyPrompt,
        browser: BrowserSession,
        model: str,
        dry_run: bool = False,
        timeout_seconds: int | None = None,
    ) -> AgentResult:
        worker_id = browser.worker_id
        worker_dir = browser.worker_dir or str(config.APPLY_WORKER_DIR / f"worker-{worker_id}")
        Path(worker_dir).mkdir(parents=True, exist_ok=True)

        # Render MCP config to disk per-worker (the agent's --mcp-config
        # flag wants a file, not a literal JSON string).
        mcp_config_path = self._app_dir / f".mcp-apply-{worker_id}.json"

        model_label = (model or "").strip() or "default"
        claude_bin = resolve_claude_apply_binary()
        bundled = is_bundled_runtime()
        cmd = [claude_bin]
        if bundled:
            # The pinned runtime's --bare mode disables Keychain/OAuth and all
            # consumer-account credential discovery for the distributed path.
            cmd.append("--bare")
        if model_label not in _DEFAULT_MODEL_SENTINELS:
            cmd.extend(["--model", model_label])
        if _claude_supports_budget_flag(claude_bin, bare=bundled):
            cmd.extend(["--max-budget-usd", f"{config.get_apply_max_budget_usd():.2f}"])
        allowed_tools = _allowed_tools_for_mcp_config(prompt.mcp_config)
        cmd.extend([
            "-p",
            "--mcp-config", str(mcp_config_path),
            "--no-session-persistence",
            "--allowedTools", allowed_tools,
            "--disallowedTools", _DISALLOWED_TOOLS,
            "--output-format", "stream-json",
            "--verbose", "-",
        ])

        env = _apply_subprocess_env()

        worker_log = self._log_dir / f"worker-{worker_id}.log"
        deadline_seconds = (
            int(timeout_seconds)
            if timeout_seconds is not None
            else self._default_timeout
        )

        events: list[dict[str, Any]] = []
        text_parts: list[str] = []
        stats: dict[str, Any] = {}
        proc: subprocess.Popen | None = None
        start = time.time()

        try:
            _write_private_json(mcp_config_path, prompt.mcp_config)
            proc = subprocess.Popen(
                cmd,
                **_popen_kwargs(env=env, cwd=str(worker_dir)),
            )
            _register_active_claude_process(worker_id, proc)
            events.append(
                {
                    "event_type": "ClaudeLaunched",
                    "occurred_at": _utc_now(),
                    "level": "info",
                    "message": f"claude pid={proc.pid}",
                    "payload": {
                        "pid": proc.pid,
                        "model": model_label,
                        "cwd": worker_dir,
                        "binary": claude_bin,
                    },
                }
            )
            assert proc.stdin is not None
            assert proc.stdout is not None
            proc.stdin.write(prompt.text)
            proc.stdin.close()

            stdout_queue: queue.Queue[str | None] = queue.Queue()
            stdout_reader = threading.Thread(
                target=_enqueue_stdout_lines,
                args=(proc.stdout, stdout_queue),
                name=f"claude-stdout-{worker_id}",
                daemon=True,
            )
            stdout_reader.start()
            wall_deadline = time.monotonic() + deadline_seconds

            with open(worker_log, "a", encoding="utf-8") as lf:
                lf.write(
                    f"\n{'=' * 60}\n"
                    f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] worker {worker_id}\n"
                    f"{'=' * 60}\n"
                )
                while True:
                    if proc.poll() is None and time.monotonic() > wall_deadline:
                        raise TimeoutError(
                            f"claude timed out after {deadline_seconds}s"
                        )
                    try:
                        queued_line = stdout_queue.get(timeout=0.25)
                    except queue.Empty:
                        if proc.poll() is not None and not stdout_reader.is_alive():
                            break
                        continue
                    if queued_line is None:
                        break

                    line = queued_line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        text_parts.append(line)
                        lf.write(line + "\n")
                        continue

                    msg_type = msg.get("type")
                    if msg_type == "assistant":
                        for block in msg.get("message", {}).get("content", []):
                            bt = block.get("type")
                            if bt == "text":
                                text = block.get("text", "") or ""
                                text_parts.append(text)
                                lf.write(text + "\n")
                                events.append(
                                    {
                                        "event_type": "AssistantText",
                                        "occurred_at": _utc_now(),
                                        "level": "info",
                                        "message": text[:200],
                                        "payload": {"text_chars": len(text)},
                                    }
                                )
                            elif bt == "tool_use":
                                name = (
                                    block.get("name", "")
                                    .replace("mcp__playwright__", "")
                                    .replace("mcp__gmail__", "gmail:")
                                )
                                inp = block.get("input", {})
                                events.append(
                                    {
                                        "event_type": "ToolUse",
                                        "occurred_at": _utc_now(),
                                        "level": "info",
                                        "message": name,
                                        "payload": {
                                            "tool": name,
                                            "input_preview": _preview(json.dumps(inp, default=str)),
                                        },
                                    }
                                )
                                lf.write(f"  >> {name}\n")
                    elif msg_type == "result":
                        usage = msg.get("usage", {}) or {}
                        stats = {
                            "input": int(usage.get("input_tokens", 0) or 0),
                            "output": int(usage.get("output_tokens", 0) or 0),
                            "cache_read": int(usage.get("cache_read_input_tokens", 0) or 0),
                            "cache_create": int(usage.get("cache_creation_input_tokens", 0) or 0),
                            "cost_usd": float(msg.get("total_cost_usd", 0) or 0),
                            "turns": int(msg.get("num_turns", 0) or 0),
                        }
                        result_text = msg.get("result", "") or ""
                        text_parts.append(result_text)

            proc.wait(timeout=5)
            returncode = proc.returncode
            _unregister_active_claude_process(worker_id, proc)
            proc = None

            output = "\n".join(text_parts)
            duration_ms = int((time.time() - start) * 1000)
            token_usage = (
                TokenUsage(
                    input=stats.get("input", 0),
                    output=stats.get("output", 0),
                    cache_read=stats.get("cache_read", 0),
                    cache_create=stats.get("cache_create", 0),
                    cost_usd=float(stats.get("cost_usd", 0.0)),
                )
                if stats
                else None
            )
            if token_usage is not None:
                from jobctrl.llm import record_llm_spend

                record_llm_spend(
                    input_tokens=token_usage.input + token_usage.cache_read + token_usage.cache_create,
                    output_tokens=token_usage.output,
                    estimated_usd=token_usage.cost_usd,
                    model=model_label,
                )

            # Negative returncode means the process was killed by a
            # signal (Ctrl+C skip from the launcher) — treat as a
            # ``Failed("SKIPPED")`` rather than fabricating a result.
            if returncode is not None and returncode < 0:
                return AgentResult(
                    submission_result=Failed(
                        error="SKIPPED: process killed by signal", retryable=True
                    ),
                    token_usage=token_usage,
                    duration_ms=duration_ms,
                    events=tuple(events),
                    raw_output=output,
                )

            submission = self._parse_result(output, dry_run=dry_run)
            return AgentResult(
                submission_result=submission,
                token_usage=token_usage,
                duration_ms=duration_ms,
                events=tuple(events),
                raw_output=output,
            )

        except TimeoutError:
            duration_ms = int((time.time() - start) * 1000)
            # Re-raise so the saga routes via the timeout compensation
            # branch — but only after we kill the subprocess.
            if proc is not None and proc.poll() is None:
                _kill_process_tree_if_alive(proc)
            raise
        finally:
            if proc is not None:
                _unregister_active_claude_process(worker_id, proc)
                if proc.poll() is None:
                    _kill_process_tree_if_alive(proc)
            try:
                mcp_config_path.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                log.debug("failed to delete apply MCP config %s", mcp_config_path, exc_info=True)

    # ------------------------------------------------------------------
    # RESULT line parsing
    # ------------------------------------------------------------------

    def _parse_result(self, output: str, *, dry_run: bool) -> SubmissionResult:
        """Translate the agent's ``RESULT:CODE[:reason]`` line into a variant.

        Mirrors the legacy launcher's ``run_job`` parser: scan the
        output for the first ``RESULT:CODE`` token, with explicit
        promotion of failed-reasons to dedicated variants for
        captcha / expired / login_issue.
        """
        email_only = _EMAIL_ONLY_RE.search(output)
        if email_only:
            return EmailOnlyApplication(recipient_email=email_only.group(1))

        for code in _RESULT_CODES:
            if f"RESULT:{code}" in output:
                if code == "APPLIED":
                    if dry_run:
                        return Failed(
                            error="dry_run_violation: agent reported applied during dry-run",
                            retryable=False,
                        )
                    return Applied(
                        applied_at=_utc_now(),
                        verification_confidence=_applied_confidence(output),
                    )
                if code == "DRY_RUN":
                    return DryRunComplete(navigated_to="")
                if code == "EXPIRED":
                    return Expired()
                if code == "CAPTCHA":
                    return Captcha(details="agent reported CAPTCHA")
                if code == "LOGIN_ISSUE":
                    return LoginIssue(details="agent reported login issue")

        if "RESULT:FAILED" in output:
            for line in output.split("\n"):
                if "RESULT:FAILED" not in line:
                    continue
                tail = line.split("RESULT:FAILED", 1)[1].strip()
                if tail.startswith(":"):
                    tail = tail[1:].strip()
                reason = _clean_reason(tail or "unknown")
                if reason in _PROMOTED_FAILED_REASONS:
                    if reason == "captcha":
                        return Captcha(details="agent reported CAPTCHA")
                    if reason == "expired":
                        return Expired()
                    return LoginIssue(details="agent reported login issue")
                if reason == "manual" or reason.startswith("manual"):
                    return Manual(reason=reason)
                if reason.startswith("missing_profile_data:"):
                    return Failed(error=reason, retryable=False)
                return Failed(error=reason or "unknown", retryable=True)
            return Failed(error="unknown", retryable=True)

        return Failed(error="no_result_line", retryable=True)


def _allowed_tools_for_mcp_config(mcp_config: Mapping[str, Any]) -> str:
    tools = set(PLAYWRIGHT_APPLY_TOOLS | GMAIL_APPLY_TOOLS | BASE_OWNED_APPLY_TOOLS)
    apply_tools = ((mcp_config.get("mcpServers") or {}).get("apply_tools") or {})
    env = apply_tools.get("env") if isinstance(apply_tools, Mapping) else {}
    if isinstance(env, Mapping) and str(env.get("CAPSOLVER_API_KEY") or "").strip():
        tools.add(CAPTCHA_APPLY_TOOL)
    return ",".join(sorted(tools))


def _apply_subprocess_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for key, value in os.environ.items():
        if key in _ENV_ALLOWLIST:
            env[key] = value
    from jobctrl.infrastructure.setup_probes import bundled_claude_process_auth_env

    env.update(bundled_claude_process_auth_env())
    return env


def _write_private_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(payload)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    handle = None
    try:
        handle = os.fdopen(fd, "w", encoding="utf-8")
        handle.write(data)
    except Exception:
        if handle is None:
            os.close(fd)
        raise
    finally:
        if handle is not None:
            handle.close()


@lru_cache(maxsize=8)
def _claude_supports_budget_flag(claude_bin: str, *, bare: bool = False) -> bool:
    try:
        command = [claude_bin]
        if bare:
            command.append("--bare")
        command.append("--help")
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except Exception:
        return False
    return "--max-budget-usd" in (result.stdout or "") or "--max-budget-usd" in (result.stderr or "")


def _applied_confidence(output: str) -> float:
    if not output:
        return 0.2
    if _has_confirmation_evidence(output):
        return 1.0
    if "RESULT:APPLIED" in output:
        return 0.6
    return 0.2


def _has_confirmation_evidence(output: str) -> bool:
    lowered = output.lower()
    markers = (
        "confirmation:",
        "confirmation artifact",
        "application submitted",
        "thank you for applying",
        "your application has been submitted",
    )
    return any(marker in lowered for marker in markers)


def _preview(text: str, limit: int = 220) -> str:
    if not text:
        return ""
    compact = re.sub(r"\s+", " ", text.strip())
    if len(compact) <= limit:
        return compact
    return compact[: max(0, limit - 3)] + "..."


def _popen_kwargs(*, env: dict[str, str], cwd: str) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "env": env,
        "cwd": cwd,
    }
    if platform.system() == "Windows":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return kwargs


def _register_active_claude_process(worker_id: int, proc: subprocess.Popen) -> None:
    with _ACTIVE_CLAUDE_LOCK:
        _ACTIVE_CLAUDE_PROCS[int(worker_id)] = proc


def _unregister_active_claude_process(worker_id: int, proc: subprocess.Popen) -> None:
    with _ACTIVE_CLAUDE_LOCK:
        active = _ACTIVE_CLAUDE_PROCS.get(int(worker_id))
        if active is proc:
            _ACTIVE_CLAUDE_PROCS.pop(int(worker_id), None)


def _kill_process_tree_if_alive(proc: subprocess.Popen) -> None:
    try:
        from jobctrl.apply.chrome import _kill_process_tree

        _kill_process_tree(proc.pid)
    except Exception:  # noqa: BLE001
        log.exception("_kill_process_tree_if_alive: kill failed (best-effort)")


__all__ = ["ClaudeCodeCliAdapter", "kill_active_claude_processes"]
