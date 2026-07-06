"""Shared setup/auth probe behavior for doctor and setup."""

from __future__ import annotations

from pathlib import Path

import pytest

from jobhunter.infrastructure import setup_probes


def test_enabled_analysis_legs_default_and_aliases() -> None:
    assert setup_probes.parse_enabled_analysis_legs(None) == ("claude", "codex", "antigravity")
    assert setup_probes.parse_enabled_analysis_legs("gemini, openai") == ("codex", "antigravity")


def test_enabled_analysis_legs_rejects_unknown() -> None:
    with pytest.raises(ValueError, match="unknown analysis leg"):
        setup_probes.parse_enabled_analysis_legs("claude,llama")


def test_analysis_sdk_set_version_reflects_enabled_legs() -> None:
    assert setup_probes.analysis_sdk_set_version(("claude", "antigravity")) == "claude+antigravity-v1"


def test_codex_auth_requires_persisted_auth_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    env = {"OPENAI_API_KEY": "sk-test"}

    probe = setup_probes.probe_codex_auth(env)

    assert probe.ok is False
    assert "not enrolled" in probe.note

    auth = tmp_path / ".codex" / "auth.json"
    auth.parent.mkdir(parents=True)
    auth.write_text("{}", encoding="utf-8")

    probe = setup_probes.probe_codex_auth({})
    assert probe.ok is True
    assert str(auth) in probe.note


def test_codex_home_is_honored(tmp_path: Path) -> None:
    custom_home = tmp_path / "codex"
    assert setup_probes.codex_auth_path({"CODEX_HOME": str(custom_home)}) == custom_home / "auth.json"


def test_claude_auth_accepts_config_dir_credentials(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(setup_probes, "_macos_claude_keychain_present", lambda: False)
    config_dir = tmp_path / "claude"
    config_dir.mkdir()
    (config_dir / ".credentials.json").write_text("{}", encoding="utf-8")

    probe = setup_probes.probe_claude_auth({"CLAUDE_CONFIG_DIR": str(config_dir)})

    assert probe.ok is True
    assert "local Claude credentials" in probe.note


def test_antigravity_auth_accepts_keys_and_vertex_adc() -> None:
    assert setup_probes.antigravity_auth_kwargs({"GEMINI_API_KEY": "g-key"}) == {"api_key": "g-key"}

    kwargs = setup_probes.antigravity_auth_kwargs({
        "GOOGLE_GENAI_USE_VERTEXAI": "1",
        "GOOGLE_CLOUD_PROJECT": "project-a",
        "GOOGLE_CLOUD_LOCATION": "europe-west4",
    })

    assert kwargs == {"vertex": True, "project": "project-a", "location": "europe-west4"}


def test_antigravity_auth_requires_key_or_vertex() -> None:
    with pytest.raises(RuntimeError, match="Antigravity analysis auth requires"):
        setup_probes.antigravity_auth_kwargs({})


def test_resolve_codex_binary_uses_explicit_override(tmp_path: Path) -> None:
    override = tmp_path / "codex"
    assert setup_probes.resolve_codex_binary({"JOBHUNTER_CODEX_BIN": str(override)}) == override
