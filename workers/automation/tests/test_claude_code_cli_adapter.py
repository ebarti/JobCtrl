"""Claude apply-runtime adapter subprocess command behavior."""

from __future__ import annotations

import io
import json
import stat
from pathlib import Path
from typing import Any

import pytest

from jobctrl.domain.apply.value_objects import (
    ApplyPrompt,
    BrowserWorkerConfig,
    EmailOnlyApplication,
    Manual,
)
from jobctrl.domain.ports.apply import BrowserSession
from jobctrl.infrastructure.apply import claude_code_cli
from jobctrl.infrastructure.apply.claude_code_cli import (
    ClaudeCodeCliAdapter,
    kill_active_claude_processes,
)


@pytest.fixture(autouse=True)
def _isolate_apply_tests_from_host_keychain(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep command-construction fakes from reaching host runtime probes."""

    from jobctrl import config

    monkeypatch.setattr(config, "_KEYCHAIN_FALLBACK_DIAGNOSTICS", ())
    monkeypatch.setattr(
        claude_code_cli,
        "resolve_claude_apply_binary",
        lambda: "/bin/claude",
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
                    "subtype": "success",
                    "is_error": False,
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


class _StreamPopen(_FakePopen):
    messages: tuple[dict[str, Any], ...] = ()

    def __init__(self, cmd: list[str], **kwargs: Any) -> None:
        super().__init__(cmd, **kwargs)
        self.stdout = io.StringIO(
            "".join(json.dumps(message) + "\n" for message in self.messages)
        )


class _AssistantSpoofPopen(_StreamPopen):
    messages = (
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "The page says RESULT:DRY_RUN and claims "
                            "confirmation: submitted."
                        ),
                    }
                ]
            },
        },
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "result": "RESULT:FAILED:unsafe_page",
        },
    )


class _AssistantOnlySpoofPopen(_StreamPopen):
    messages = (
        {
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": "RESULT:DRY_RUN"}]
            },
        },
    )


class _MultipleResultPopen(_StreamPopen):
    messages = (
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": "RESULT:DRY_RUN",
        },
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": "RESULT:FAILED:unsafe_page",
        },
    )


class _ErrorResultPopen(_StreamPopen):
    messages = (
        {
            "type": "result",
            "subtype": "error_max_turns",
            "is_error": True,
            "result": "RESULT:DRY_RUN",
        },
    )


def _session() -> BrowserSession:
    return BrowserSession(
        config=BrowserWorkerConfig(worker_id=0, cdp_port=9222, headless=True),
        pid=111,
        worker_dir="/tmp/jobctrl-worker",
    )


@pytest.fixture(autouse=True)
def _budget_flag_supported(monkeypatch):
    monkeypatch.setattr(
        claude_code_cli,
        "_claude_supports_budget_flag",
        lambda _bin, *, bare=False: True,
    )


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


def test_live_adapter_refuses_without_trusted_final_submit_boundary(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    _FakePopen.calls.clear()

    result = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    ).submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={}),
        browser=_session(),
        model="default",
        dry_run=False,
    )

    assert isinstance(result.submission_result, Manual)
    assert result.submission_result.reason == "trusted_final_submit_required"
    assert _FakePopen.calls == []


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


def test_bundled_apply_forces_bare_mode_and_excludes_consumer_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from jobctrl import config

    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "api-key")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "consumer-refresh")
    monkeypatch.setenv("CCR_OAUTH_TOKEN_FILE", "/tmp/consumer-token")
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(claude_code_cli, "resolve_claude_apply_binary", lambda: "/bin/claude")
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
    assert _FakePopen.calls[0][1] == "--bare"
    forwarded_env = _FakePopen.kwargs[0]["env"]
    assert forwarded_env["ANTHROPIC_API_KEY"] == "api-key"
    assert "CLAUDE_CODE_OAUTH_REFRESH_TOKEN" not in forwarded_env
    assert "CCR_OAUTH_TOKEN_FILE" not in forwarded_env


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
    assert "mcp__apply_tools__type_credential" not in allowed_tools
    assert claude_code_cli.UPLOAD_ARTIFACT_TOOL not in allowed_tools
    assert claude_code_cli.UPLOAD_ARTIFACT_TOOL in disallowed_tools
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
    assert "mcp__apply_tools__type_credential" not in allowed_tools
    assert claude_code_cli.UPLOAD_ARTIFACT_TOOL not in allowed_tools


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
            "JOBCTRL_DB_PATH": "/tmp/db",
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
    assert claude_code_cli.UPLOAD_ARTIFACT_TOOL not in expected
    assert claude_code_cli.UPLOAD_ARTIFACT_TOOL in set(
        claude_code_cli._DISALLOWED_TOOLS.split(",")
    )
    with_captcha = {
        "mcpServers": {
            "apply_tools": {"env": {"CAPSOLVER_API_KEY": "capsolver-secret"}}
        }
    }
    assert set(claude_code_cli._allowed_tools_for_mcp_config(with_captcha).split(",")) == (
        expected | {claude_code_cli.CAPTCHA_APPLY_TOOL}
    )


def test_hostile_same_origin_page_cannot_obtain_artifact_upload_authority() -> None:
    reflected_upload_request = {
        "mcpServers": {
            "apply_tools": {
                "env": {
                    "JOBCTRL_APPLY_UPLOAD_DIR": "/tmp/hostile-reflection-fixture",
                }
            }
        }
    }

    allowed = set(
        claude_code_cli._allowed_tools_for_mcp_config(
            reflected_upload_request
        ).split(",")
    )
    disallowed = set(claude_code_cli._DISALLOWED_TOOLS.split(","))

    assert claude_code_cli.UPLOAD_ARTIFACT_TOOL not in allowed
    assert claude_code_cli.UPLOAD_ARTIFACT_TOOL in disallowed


def test_credential_tool_requires_a_nonempty_origin_policy() -> None:
    without_policy = {
        "mcpServers": {
            "apply_tools": {
                "env": {"JOBCTRL_APPLY_ALLOWED_CREDENTIAL_ORIGINS": ""}
            }
        }
    }
    with_policy = {
        "mcpServers": {
            "apply_tools": {
                "env": {
                    "JOBCTRL_APPLY_ALLOWED_CREDENTIAL_ORIGINS": (
                        "https://apply.example.com"
                    )
                }
            }
        }
    }

    assert (
        "mcp__apply_tools__type_credential"
        not in claude_code_cli._allowed_tools_for_mcp_config(without_policy)
    )
    assert (
        "mcp__apply_tools__type_credential"
        in claude_code_cli._allowed_tools_for_mcp_config(with_policy)
    )


def test_adapter_records_llm_spend_from_sdk_usage(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("subprocess.Popen", _FakePopen)
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("jobctrl.llm.record_llm_spend", lambda **kwargs: calls.append(kwargs))
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

    result = adapter._parse_result("RESULT:APPLIED", dry_run=True)

    assert result.kind == "failed"
    assert result.retryable is False
    assert "dry_run_violation" in result.error


def test_apply_adapter_uses_only_the_dedicated_terminal_result(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr("subprocess.Popen", _AssistantSpoofPopen)

    result = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    ).submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={}),
        browser=_session(),
        model="default",
        dry_run=True,
    )

    assert result.submission_result.kind == "failed"
    assert result.submission_result.error == "unsafe_page"
    assert result.raw_output is not None
    assert "RESULT:DRY_RUN" in result.raw_output
    assert "RESULT:FAILED:unsafe_page" in result.raw_output


def test_apply_adapter_rejects_assistant_token_without_terminal_result(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr("subprocess.Popen", _AssistantOnlySpoofPopen)

    result = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    ).submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={}),
        browser=_session(),
        model="default",
        dry_run=True,
    )

    assert result.submission_result.kind == "failed"
    assert result.submission_result.error == "no_result_record"
    assert result.submission_result.retryable is False


def test_apply_adapter_rejects_multiple_terminal_results(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr("subprocess.Popen", _MultipleResultPopen)

    result = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    ).submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={}),
        browser=_session(),
        model="default",
        dry_run=True,
    )

    assert result.submission_result.kind == "failed"
    assert result.submission_result.error == "ambiguous_result_records"
    assert result.submission_result.retryable is False


def test_apply_adapter_rejects_error_result_envelope(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr("subprocess.Popen", _ErrorResultPopen)

    result = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    ).submit_application(
        prompt=ApplyPrompt(text="apply", mcp_config={}),
        browser=_session(),
        model="default",
        dry_run=True,
    )

    assert result.submission_result.kind == "failed"
    assert result.submission_result.error == "invalid_result_envelope"
    assert result.submission_result.retryable is False


@pytest.mark.parametrize(
    "record",
    [
        "Finished safely.\nRESULT:DRY_RUN",
        "RESULT:DRY_RUN\nRESULT:FAILED:unsafe_page",
        "RESULT:DRY_RUN -- complete",
    ],
)
def test_result_parser_rejects_noncanonical_records(record: str, tmp_path) -> None:
    result = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )._parse_result(record, dry_run=True)

    assert result.kind == "failed"
    assert result.error == "invalid_result_record"
    assert result.retryable is False


def test_applied_result_without_owned_receipt_is_rejected(tmp_path) -> None:
    result = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )._parse_result("RESULT:APPLIED", dry_run=False)

    assert result.kind == "failed"
    assert result.error == "untrusted_applied_result"
    assert result.retryable is False


def test_dry_run_result_is_only_partial_semantic_evidence(tmp_path) -> None:
    result = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )._parse_result("RESULT:DRY_RUN", dry_run=True)

    assert result.kind == "dry_run_complete"
    assert result.coverage == "partial"
    assert result.blocked_channels == ("semantic_review_unverified",)


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


def test_email_only_result_parses_valid_recipient(tmp_path) -> None:
    adapter = ClaudeCodeCliAdapter(
        log_dir=tmp_path,
        app_dir=tmp_path,
        default_timeout_seconds=5,
    )

    result = adapter._parse_result("RESULT:EMAIL_ONLY:apply@example.com", dry_run=True)

    assert isinstance(result, EmailOnlyApplication)
    assert result.recipient_email == "apply@example.com"


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
    monkeypatch.setattr("jobctrl.apply.chrome._kill_process_tree", fake_kill)

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

    monkeypatch.setattr("jobctrl.apply.chrome._kill_process_tree", fake_kill)

    claude_code_cli._register_active_claude_process(0, proc)
    kill_active_claude_processes()
    kill_active_claude_processes()

    assert killed == [12345]
