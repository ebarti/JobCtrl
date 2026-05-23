"""Claude Code CLI adapter subprocess command behavior."""

from __future__ import annotations

import io
import json
from typing import Any

from jobhunter.domain.apply.value_objects import (
    ApplyPrompt,
    BrowserWorkerConfig,
)
from jobhunter.domain.ports.apply import BrowserSession
from jobhunter.infrastructure.apply.claude_code_cli import ClaudeCodeCliAdapter


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

    def __init__(self, cmd: list[str], **_kwargs: Any) -> None:
        self.calls.append(cmd)
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


def _session() -> BrowserSession:
    return BrowserSession(
        config=BrowserWorkerConfig(worker_id=0, cdp_port=9222, headless=True),
        pid=111,
        worker_dir="/tmp/jobhunter-worker",
    )


def test_default_model_uses_local_claude_default(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    _FakePopen.calls.clear()

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


def test_explicit_model_is_forwarded_to_claude(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    _FakePopen.calls.clear()

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
