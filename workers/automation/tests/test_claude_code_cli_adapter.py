"""Claude apply-runtime adapter subprocess command behavior."""

from __future__ import annotations

import io
import json
import stat
from pathlib import Path
from typing import Any

import pytest

from jobhunter.domain.apply.value_objects import (
    ApplyPrompt,
    BrowserWorkerConfig,
)
from jobhunter.domain.ports.apply import BrowserSession
from jobhunter.infrastructure.apply import claude_code_cli
from jobhunter.infrastructure.apply.claude_code_cli import (
    ClaudeCodeCliAdapter,
    kill_active_claude_processes,
)


class _FakeStdin:
    def __init__(self) -> None:
        self.text = ""
        self.closed = False

    def write(self, value: str) -> int:
        self.text += value
        return len(value)

    def close(self) -> None:
        self.closed = True


class _FakePopen:
    calls: list[list[str]] = []
    kwargs: list[dict[str, Any]] = []
    mcp_config_modes: list[int] = []
    mcp_config_paths: list[Path] = []
    mcp_config_payloads: list[dict[str, Any]] = []
    last: "_FakePopen | None" = None

    def __init__(self, cmd: list[str], **kwargs: Any) -> None:
        self.calls.append(cmd)
        self.kwargs.append(dict(kwargs))
        if "--mcp-config" in cmd:
            path = Path(cmd[cmd.index("--mcp-config") + 1])
            self.mcp_config_paths.append(path)
            self.mcp_config_modes.append(stat.S_IMODE(path.stat().st_mode))
            self.mcp_config_payloads.append(json.loads(path.read_text(encoding="utf-8")))
        type(self).last = self
        self.pid = 12345
        self.returncode = 0
        self.stdin = _FakeStdin()
        self.stdout = io.StringIO(
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "content": [{"type": "text", "text": "RESULT:DRY_RUN"}]
                    },
                }
            )
            + "\n"
            + json.dumps(
                {
                    "type": "result",
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                    "total_cost_usd": 0,
                    "num_turns": 1,
                    "result": "RESULT:DRY_RUN",
                }
            )
            + "\n"
        )

    def poll(self) -> int:
        return self.returncode

    def wait(self, timeout: int | None = None) -> int:
        return self.returncode


class _HangingPopen(_FakePopen):
    def __init__(self, cmd: list[str], **kwargs: Any) -> None:
        super().__init__(cmd, **kwargs)
        self.stdout = io.StringIO("")
        self.returncode = None

    def poll(self) -> int | None:
        return self.returncode


def _session() -> BrowserSession:
    return BrowserSession(
        config=BrowserWorkerConfig(worker_id=0, cdp_port=9222, headless=True),
        pid=111,
        worker_dir="/tmp/jobhunter-worker",
    )


@pytest.fixture(autouse=True)
def _budget_flag_supported(monkeypatch):
    monkeypatch.setattr(claude_code_cli, "_claude_supports_budget_flag", lambda _bin: True)


def test_default_model_uses_local_claude_default(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    _FakePopen.calls.clear()
    _FakePopen.kwargs.clear()
    _FakePopen.mcp_config_paths.clear()

    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    result = adapter.submit_application(
        prompt=ApplyPrompt(
            text="apply",
            mcp_config={
                "mcpServers": {
                    "apply_tools": {"env": {"CAPSOLVER_API_KEY": "capsolver-secret"}}
                }
            },
        ),
        browser=_session(),
        model="default",
        dry_run=True,
    )

    assert result.submission_result.kind == "dry_run_complete"
    assert "--model" not in _FakePopen.calls[0]
    assert _FakePopen.mcp_config_paths
    assert not _FakePopen.mcp_config_paths[0].exists()
    with claude_code_cli._ACTIVE_CLAUDE_LOCK:
        assert claude_code_cli._ACTIVE_CLAUDE_PROCS == {}


def test_explicit_model_is_forwarded_to_claude(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    _FakePopen.calls.clear()
    _FakePopen.kwargs.clear()

    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    result = adapter.submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={}),
        browser=_session(),
        model="opus",
        dry_run=True,
    )

    assert result.submission_result.kind == "dry_run_complete"
    assert _FakePopen.calls[0][1:3] == ["--model", "opus"]


def test_apply_adapter_uses_tool_allowlist_and_filtered_env(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    monkeypatch.setenv("CAPSOLVER_API_KEY", "capsolver-secret")
    monkeypatch.setenv("UNRELATED_SECRET_TOKEN", "do-not-forward")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-key")
    _FakePopen.calls.clear()
    _FakePopen.kwargs.clear()

    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    result = adapter.submit_application(
        prompt=ApplyPrompt(
            text="apply",
            mcp_config={
                "mcpServers": {
                    "apply_tools": {"env": {"CAPSOLVER_API_KEY": "capsolver-secret"}}
                }
            },
        ),
        browser=_session(),
        model="default",
        dry_run=True,
    )

    cmd = _FakePopen.calls[0]
    forwarded_env = _FakePopen.kwargs[0]["env"]
    assert result.submission_result.kind == "dry_run_complete"
    assert "--permission-mode" not in cmd
    assert "bypassPermissions" not in cmd
    assert "--max-budget-usd" in cmd
    assert cmd[cmd.index("--max-budget-usd") + 1] == "5.00"
    assert "--allowedTools" in cmd
    assert "--disallowedTools" in cmd
    allowed_tools = cmd[cmd.index("--allowedTools") + 1]
    disallowed_tools = cmd[cmd.index("--disallowedTools") + 1]
    assert "mcp__playwright__browser_navigate" in allowed_tools
    assert "mcp__gmail__get_verification_code" in allowed_tools
    assert "mcp__apply_tools__solve_captcha" in allowed_tools
    assert "mcp__apply_tools__type_credential" in allowed_tools
    assert "mcp__apply_tools__upload_artifact" in allowed_tools
    assert "browser_evaluate" not in allowed_tools
    assert "browser_file_upload" not in allowed_tools
    assert "mcp__gmail__search_emails" not in allowed_tools
    assert "mcp__gmail__read_email" not in allowed_tools
    assert "Bash" in disallowed_tools
    assert "Write" in disallowed_tools
    assert "ANTHROPIC_API_KEY" not in forwarded_env
    assert "CAPSOLVER_API_KEY" not in forwarded_env
    assert "UNRELATED_SECRET_TOKEN" not in forwarded_env


def test_apply_adapter_omits_captcha_tool_when_solver_key_absent(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    monkeypatch.delenv("CAPSOLVER_API_KEY", raising=False)
    _FakePopen.calls.clear()
    _FakePopen.kwargs.clear()

    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    result = adapter.submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={}),
        browser=_session(),
        model="default",
        dry_run=True,
    )

    allowed_tools = _FakePopen.calls[0][_FakePopen.calls[0].index("--allowedTools") + 1]
    assert result.submission_result.kind == "dry_run_complete"
    assert "mcp__apply_tools__solve_captcha" not in allowed_tools
    assert "mcp__apply_tools__type_credential" in allowed_tools
    assert "mcp__apply_tools__upload_artifact" in allowed_tools


def test_apply_adapter_minimal_env_is_exact(monkeypatch) -> None:
    monkeypatch.setattr(
        claude_code_cli.os,
        "environ",
        {
            "PATH": "/bin",
            "HOME": "/home/test",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TMPDIR": "/tmp",
            "ANTHROPIC_API_KEY": "secret",
            "JOBHUNTER_DB_PATH": "/tmp/db",
        },
    )

    assert claude_code_cli._apply_subprocess_env() == {
        "PATH": "/bin",
        "HOME": "/home/test",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TMPDIR": "/tmp",
    }


def test_mcp_config_is_private_and_removed(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    _FakePopen.calls.clear()
    _FakePopen.kwargs.clear()
    _FakePopen.mcp_config_modes.clear()
    _FakePopen.mcp_config_paths.clear()
    _FakePopen.mcp_config_payloads.clear()

    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    adapter.submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={"mcpServers": {"x": {}}}),
        browser=_session(),
        model="default",
        dry_run=True,
    )

    assert _FakePopen.mcp_config_modes == [0o600]
    assert _FakePopen.mcp_config_payloads == [{"mcpServers": {"x": {}}}]
    assert not _FakePopen.mcp_config_paths[0].exists()


def test_apply_allowlist_matches_pinned_tool_surface() -> None:
    advertised = {
        f"mcp__playwright__{tool}"
        for tool in (
            claude_code_cli.PINNED_PLAYWRIGHT_MCP_TOOLS
            - claude_code_cli.PLAYWRIGHT_TOOL_EXCLUSIONS
        )
    }
    expected = (
        advertised
        | claude_code_cli.GMAIL_APPLY_TOOLS
        | claude_code_cli.BASE_OWNED_APPLY_TOOLS
    )

    assert set(claude_code_cli._ALLOWED_TOOLS.split(",")) == expected
    assert set(claude_code_cli._allowed_tools_for_mcp_config({}).split(",")) == expected
    with_captcha = {
        "mcpServers": {
            "apply_tools": {"env": {"CAPSOLVER_API_KEY": "capsolver-secret"}}
        }
    }
    assert set(claude_code_cli._allowed_tools_for_mcp_config(with_captcha).split(",")) == (
        expected | {claude_code_cli.CAPTCHA_APPLY_TOOL}
    )


def test_adapter_records_llm_spend_from_sdk_usage(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("jobhunter.llm.record_llm_spend", lambda **kwargs: calls.append(kwargs))
    _FakePopen.calls.clear()
    _FakePopen.kwargs.clear()

    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    adapter.submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={}),
        browser=_session(),
        model="opus",
        dry_run=True,
    )

    assert calls == [
        {
            "input_tokens": 1,
            "output_tokens": 1,
            "estimated_usd": 0.0,
            "model": "opus",
        }
    ]


def test_dry_run_applied_result_is_reported_as_violation(tmp_path) -> None:
    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    result = adapter._parse_result("RESULT:APPLIED\nconfirmation: submitted", dry_run=True)

    assert result.kind == "failed"
    assert result.retryable is False
    assert "dry_run_violation" in result.error


def test_missing_profile_data_failure_is_non_retryable(tmp_path) -> None:
    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    result = adapter._parse_result(
        "RESULT:FAILED:missing_profile_data:age_18_plus",
        dry_run=False,
    )

    assert result.kind == "failed"
    assert result.retryable is False
    assert result.error == "missing_profile_data:age_18_plus"


def test_claude_subprocess_starts_in_isolated_unix_session(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    _FakePopen.calls.clear()
    _FakePopen.kwargs.clear()

    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    result = adapter.submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={}),
        browser=_session(),
        model="default",
        dry_run=True,
    )

    assert result.submission_result.kind == "dry_run_complete"
    assert _FakePopen.kwargs[0]["start_new_session"] is True


def test_timeout_kills_only_registered_claude_process_tree(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr("subprocess.Popen", _HangingPopen)
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    _HangingPopen.calls.clear()
    _HangingPopen.kwargs.clear()
    killed: list[int] = []
    times = iter([0.0, 1.0])

    def fake_monotonic() -> float:
        return next(times, 1.0)

    def fake_kill(pid: int) -> None:
        killed.append(pid)
        assert _HangingPopen.last is not None
        _HangingPopen.last.returncode = -9

    monkeypatch.setattr(claude_code_cli.time, "monotonic", fake_monotonic)
    monkeypatch.setattr("jobhunter.apply.chrome._kill_process_tree", fake_kill)

    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    with pytest.raises(TimeoutError):
        adapter.submit_application(
            prompt=ApplyPrompt(text="apply", mcp_config={}),
            browser=_session(),
            model="default",
            dry_run=True,
            timeout_seconds=0,
        )

    assert _HangingPopen.kwargs[0]["start_new_session"] is True
    assert killed == [12345]


def test_adapter_active_process_registry_kills_registered_process(monkeypatch) -> None:
    proc = _HangingPopen(["claude"])
    killed: list[int] = []

    def fake_kill(pid: int) -> None:
        killed.append(pid)
        proc.returncode = -9

    monkeypatch.setattr("jobhunter.apply.chrome._kill_process_tree", fake_kill)

    claude_code_cli._register_active_claude_process(0, proc)
    kill_active_claude_processes()
    kill_active_claude_processes()

    assert killed == [12345]


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("RESULT:APPLIED\nconfirmation: submitted", 1.0),
        ("RESULT:APPLIED", 0.6),
        ("submitted successfully", 0.2),
    ],
)
def test_applied_confidence_matrix(output: str, expected: float) -> None:
    assert claude_code_cli._applied_confidence(output) == expected
