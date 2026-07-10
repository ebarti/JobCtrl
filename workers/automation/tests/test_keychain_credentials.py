"""macOS Keychain fallback regressions for Python runtime credentials."""

from __future__ import annotations

import logging
import os
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from jobctrl import config, llm


_SECRET = "test-secret-must-not-appear"


def _which_security(name: str) -> str | None:
    return "/usr/bin/security" if name == "security" else None


def _success_runner(
    calls: list[tuple[list[str], dict[str, object]]],
) -> Callable[..., subprocess.CompletedProcess[str]]:
    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, stdout=f"{_SECRET}\n", stderr="")

    return run


def test_darwin_keychain_fallback_reaches_provider_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], dict[str, object]]] = []
    for key in config.KEYCHAIN_PROVIDER_KEYS:
        monkeypatch.delenv(key, raising=False)

    diagnostics = config.load_macos_keychain_fallbacks(
        env=os.environ,
        system_name="Darwin",
        find_executable=_which_security,
        run=_success_runner(calls),
    )

    assert all(diagnostic.status == "loaded" for diagnostic in diagnostics)
    assert len(calls) == len(config.KEYCHAIN_PROVIDER_KEYS)
    for key, (command, kwargs) in zip(config.KEYCHAIN_PROVIDER_KEYS, calls, strict=True):
        assert command == [
            "/usr/bin/security",
            "find-generic-password",
            "-s",
            "JobCtrl",
            "-a",
            key,
            "-w",
        ]
        assert kwargs["check"] is False
        assert kwargs["capture_output"] is True
        assert kwargs["text"] is True
        assert kwargs["timeout"] == config.KEYCHAIN_LOOKUP_TIMEOUT_SECONDS
        assert kwargs["stdin"] is subprocess.DEVNULL

    _base_url, _model, api_key = llm._provider_config("gemini")
    assert api_key == _SECRET
    assert _SECRET not in repr(diagnostics)


def test_explicit_environment_wins_without_keychain_lookup() -> None:
    env = {key: f"explicit-{key}" for key in config.KEYCHAIN_PROVIDER_KEYS}
    calls: list[tuple[list[str], dict[str, object]]] = []

    diagnostics = config.load_macos_keychain_fallbacks(
        env=env,
        system_name="Darwin",
        find_executable=_which_security,
        run=_success_runner(calls),
    )

    assert calls == []
    assert all(diagnostic.status == "explicit" for diagnostic in diagnostics)
    assert env == {key: f"explicit-{key}" for key in config.KEYCHAIN_PROVIDER_KEYS}


def test_empty_environment_value_uses_keychain_fallback() -> None:
    calls: list[tuple[list[str], dict[str, object]]] = []
    env = {key: "" for key in config.KEYCHAIN_PROVIDER_KEYS}

    diagnostics = config.load_macos_keychain_fallbacks(
        env=env,
        system_name="Darwin",
        find_executable=_which_security,
        run=_success_runner(calls),
    )

    assert all(diagnostic.status == "loaded" for diagnostic in diagnostics)
    assert all(env[key] == _SECRET for key in config.KEYCHAIN_PROVIDER_KEYS)


def test_missing_keychain_items_fail_closed_without_secret_output(caplog: pytest.LogCaptureFixture) -> None:
    def missing(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 44, stdout="", stderr="The specified item could not be found.")

    with caplog.at_level(logging.DEBUG):
        diagnostics = config.load_macos_keychain_fallbacks(
            env={},
            system_name="Darwin",
            find_executable=_which_security,
            run=missing,
        )

    assert all(diagnostic.status == "missing" for diagnostic in diagnostics)
    assert _SECRET not in caplog.text
    assert _SECRET not in repr(diagnostics)


@pytest.mark.parametrize(
    ("returncode", "stderr"),
    [
        (44, "untrusted output is ignored for Apple's documented exit"),
        (1, "The specified item could not be found."),
        (
            1,
            "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
        ),
    ],
)
def test_only_confirmed_keychain_misses_count_as_missing(returncode: int, stderr: str) -> None:
    def missing(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, returncode, stdout="", stderr=stderr)

    diagnostics = config.load_macos_keychain_fallbacks(
        env={},
        system_name="Darwin",
        find_executable=_which_security,
        run=missing,
    )

    assert all(diagnostic.status == "missing" for diagnostic in diagnostics)
    assert all(diagnostic.reason == "item_not_found" for diagnostic in diagnostics)


@pytest.mark.parametrize(
    "stderr",
    [
        "User interaction is not allowed.",
        "The user name or passphrase you entered is not correct.",
        "prefix could not be found but this is not the confirmed Keychain message",
    ],
)
def test_locked_permission_and_unexpected_failures_stay_unavailable(stderr: str) -> None:
    def failed(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 1, stdout=_SECRET, stderr=stderr)

    diagnostics = config.load_macos_keychain_fallbacks(
        env={},
        system_name="Darwin",
        find_executable=_which_security,
        run=failed,
    )

    assert all(diagnostic.status == "unavailable" for diagnostic in diagnostics)
    assert all(diagnostic.reason == "command_failed" for diagnostic in diagnostics)
    assert _SECRET not in repr(diagnostics)


def test_success_without_a_value_is_malformed_not_absent() -> None:
    def empty(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 0, stdout="\n", stderr="")

    diagnostics = config.load_macos_keychain_fallbacks(
        env={},
        system_name="Darwin",
        find_executable=_which_security,
        run=empty,
    )

    assert all(diagnostic.status == "unavailable" for diagnostic in diagnostics)
    assert all(diagnostic.reason == "empty_value" for diagnostic in diagnostics)


def test_keychain_command_failure_and_timeout_fail_closed(caplog: pytest.LogCaptureFixture) -> None:
    def failed(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 1, stdout=_SECRET, stderr=_SECRET)

    with caplog.at_level(logging.DEBUG):
        failed_diagnostics = config.load_macos_keychain_fallbacks(
            env={},
            system_name="Darwin",
            find_executable=_which_security,
            run=failed,
        )

    def timed_out(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(command, config.KEYCHAIN_LOOKUP_TIMEOUT_SECONDS, output=_SECRET)

    timeout_diagnostics = config.load_macos_keychain_fallbacks(
        env={},
        system_name="Darwin",
        find_executable=_which_security,
        run=timed_out,
    )

    assert all(diagnostic.status == "unavailable" for diagnostic in failed_diagnostics)
    assert all(diagnostic.reason == "command_failed" for diagnostic in failed_diagnostics)
    assert all(diagnostic.status == "unavailable" for diagnostic in timeout_diagnostics)
    assert all(diagnostic.reason == "timeout" for diagnostic in timeout_diagnostics)
    assert _SECRET not in caplog.text
    assert _SECRET not in repr(failed_diagnostics)
    assert _SECRET not in repr(timeout_diagnostics)


def test_missing_security_binary_fails_closed_without_runner_call() -> None:
    calls: list[list[str]] = []

    def should_not_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        raise AssertionError("security command must not run when the binary is absent")

    diagnostics = config.load_macos_keychain_fallbacks(
        env={},
        system_name="Darwin",
        find_executable=lambda _name: None,
        run=should_not_run,
    )

    assert calls == []
    assert all(diagnostic.status == "unavailable" for diagnostic in diagnostics)
    assert all(diagnostic.reason == "binary_missing" for diagnostic in diagnostics)


def test_non_system_security_binary_is_rejected_without_runner_call() -> None:
    calls: list[list[str]] = []

    def should_not_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        raise AssertionError("a PATH-resolved or injected security binary must never run")

    diagnostics = config.load_macos_keychain_fallbacks(
        env={},
        system_name="Darwin",
        find_executable=lambda _name: "/tmp/security",
        run=should_not_run,
    )

    assert calls == []
    assert all(diagnostic.status == "unavailable" for diagnostic in diagnostics)
    assert all(diagnostic.reason == "binary_missing" for diagnostic in diagnostics)


@pytest.mark.parametrize("system_name", ["Linux", "Windows"])
def test_non_darwin_never_probes_keychain(system_name: str) -> None:
    probes: list[str] = []

    def should_not_find(name: str) -> str | None:
        probes.append(name)
        raise AssertionError("non-Darwin platforms must not probe the macOS security binary")

    diagnostics = config.load_macos_keychain_fallbacks(
        env={},
        system_name=system_name,
        find_executable=should_not_find,
        run=lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not run")),
    )

    assert probes == []
    assert all(diagnostic.status == "unsupported" for diagnostic in diagnostics)
    assert all(diagnostic.reason == "non_darwin" for diagnostic in diagnostics)


def test_load_env_probes_keychain_only_once_per_process(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls = 0
    diagnostic = config.KeychainFallbackDiagnostic("OPENAI_API_KEY", "missing", "item_not_found")

    def load_once() -> tuple[config.KeychainFallbackDiagnostic, ...]:
        nonlocal calls
        calls += 1
        return (diagnostic,)

    monkeypatch.setattr(config, "ENV_PATH", tmp_path / ".env")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(config, "_KEYCHAIN_FALLBACK_DIAGNOSTICS", None)
    monkeypatch.setattr(config, "load_macos_keychain_fallbacks", load_once)

    first = config.load_env()
    second = config.load_env()

    assert first == second == (diagnostic,)
    assert calls == 1
