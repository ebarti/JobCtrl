"""Claude apply-runtime adapter subprocess command behavior."""

from __future__ import annotations

import io
import json
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
    last: "_FakePopen | None" = None

    def __init__(self, cmd: list[str], **kwargs: Any) -> None:
        self.calls.append(cmd)
        self.kwargs.append(dict(kwargs))
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


def test_default_model_uses_local_claude_default(monkeypatch, tmp_path) -> None:
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
        model="default",
        dry_run=True,
    )

    assert result.submission_result.kind == "dry_run_complete"
    assert "--model" not in _FakePopen.calls[0]
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
