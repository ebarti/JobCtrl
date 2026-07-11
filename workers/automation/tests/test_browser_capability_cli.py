"""CLI contract coverage for explicit browser capability choices."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from jobctrl import config
from jobctrl.browser_capabilities import browser_capability_status
from jobctrl.cli import app


def _browser_executable(tmp_path: Path) -> Path:
    executable = tmp_path / "Chromium"
    executable.write_text("#!/bin/sh\necho 'Chromium 145.0.0.0'\n", encoding="utf-8")
    executable.chmod(0o700)
    return executable


def test_capability_cli_uses_managed_core_probe_not_machine_browser(
    monkeypatch, tmp_path: Path
) -> None:
    from jobctrl.infrastructure import preflight

    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(preflight, "check_playwright_chromium", lambda: (True, "managed test Chromium"))

    result = CliRunner().invoke(app, ["capability", "list"])

    assert result.exit_code == 0, result.output
    assert "managed test Chromium" in result.output


def test_capability_enable_requires_an_explicit_browser_path(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(config, "APP_DIR", tmp_path)

    result = CliRunner().invoke(
        app,
        ["capability", "enable", "auto-apply-browser", "--yes", "--non-interactive"],
    )

    assert result.exit_code == 2
    assert "requires --browser-path" in result.output
    assert browser_capability_status("auto-apply-browser", app_dir=tmp_path).status == "disabled"


def test_capability_enable_and_list_use_the_install_scoped_state(
    tmp_path: Path, monkeypatch
) -> None:
    from jobctrl.infrastructure import preflight

    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(preflight, "check_playwright_chromium", lambda: (True, "managed test Chromium"))
    executable = _browser_executable(tmp_path)

    enabled = CliRunner().invoke(
        app,
        ["capability", "enable", "auto-apply-browser", "--browser-path", str(executable)],
    )
    listed = CliRunner().invoke(app, ["capability", "list"])

    assert enabled.exit_code == 0, enabled.output
    assert "auto-apply-browser ready" in enabled.output
    assert listed.exit_code == 0, listed.output
    assert "auto-apply-browser" in listed.output
    assert "READY" in listed.output


def test_linkedin_profile_copy_is_not_implied_by_yes(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    executable = _browser_executable(tmp_path)
    source = tmp_path / "source-profile"
    source.mkdir()

    result = CliRunner().invoke(
        app,
        [
            "capability",
            "enable",
            "authenticated-linkedin-browser",
            "--browser-path",
            str(executable),
            "--copy-profile-from",
            str(source),
            "--yes",
            "--non-interactive",
        ],
    )

    assert result.exit_code == 2
    assert "--yes cannot grant this consent" in " ".join(result.output.split())
    assert browser_capability_status("authenticated-linkedin-browser", app_dir=tmp_path).status == "disabled"


def test_managed_pack_choice_is_explicitly_unavailable(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(config, "APP_DIR", tmp_path)

    result = CliRunner().invoke(
        app,
        ["capability", "enable", "auto-apply-browser", "--managed-pack"],
    )

    assert result.exit_code == 2
    assert "signed pack supply chain" in " ".join(result.output.split())
    assert browser_capability_status("auto-apply-browser", app_dir=tmp_path).status == "disabled"
