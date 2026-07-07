"""Shared setup/auth probe behavior for doctor and setup."""

from __future__ import annotations

from pathlib import Path

import pytest

from jobctl.infrastructure import setup_probes


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
    assert setup_probes.resolve_codex_binary({"JOBCTL_CODEX_BIN": str(override)}) == override


def test_probe_claude_synthesis_auth_reflects_claude_auth(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Force a deterministic "no local Claude auth" state without touching the
    # real machine: empty config dir + no keychain.
    monkeypatch.setattr(setup_probes, "_macos_claude_keychain_present", lambda: False)
    empty_config = tmp_path / "claude-empty"
    empty_config.mkdir()
    env_no_auth = {"CLAUDE_CONFIG_DIR": str(empty_config)}

    missing = setup_probes.probe_claude_synthesis_auth(env_no_auth)
    assert missing.name == "Claude synthesis auth"
    assert missing.ok is False
    assert "synthesis" in missing.note.lower()

    present = setup_probes.probe_claude_synthesis_auth(
        {**env_no_auth, "ANTHROPIC_API_KEY": "sk-test"}
    )
    assert present.name == "Claude synthesis auth"
    assert present.ok is True


def test_probe_analysis_setup_always_probes_claude_synthesis_auth(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Synthesis auth is required regardless of the enabled leg set. SDK presence
    # is orthogonal to this invariant, so stub the SDK probes to keep the test
    # off any real vendor runtime/network.
    monkeypatch.setattr(
        setup_probes, "probe_claude_sdk",
        lambda: setup_probes.ProbeResult("Claude analysis SDK", True, "stub"),
    )
    monkeypatch.setattr(
        setup_probes, "probe_codex_sdk",
        lambda env=None: setup_probes.ProbeResult("Codex analysis SDK", True, "stub"),
    )
    monkeypatch.setattr(
        setup_probes, "probe_antigravity_sdk",
        lambda: setup_probes.ProbeResult("Antigravity analysis SDK", True, "stub"),
    )
    monkeypatch.setattr(setup_probes, "_macos_claude_keychain_present", lambda: False)
    empty_config = tmp_path / "claude-empty"
    empty_config.mkdir()

    base = {
        "JOBCTL_ANALYSIS_LEGS": "codex,antigravity",
        "CLAUDE_CONFIG_DIR": str(empty_config),
        "CODEX_HOME": str(tmp_path / "codex-empty"),
    }

    def _synthesis_row(results):
        rows = [r for r in results if r.name == "Claude synthesis auth"]
        assert len(rows) == 1, [r.name for r in results]
        return rows[0]

    # (b) Claude-less leg set WITHOUT Claude auth: synthesis row present and red
    # (doctor renders ok=False as MISSING) — no green-paradox.
    without_auth = setup_probes.probe_analysis_setup(base)
    legs_row = next(r for r in without_auth if r.name == "analysis legs enabled")
    assert "claude" not in legs_row.note  # the claude draft leg is genuinely off
    assert _synthesis_row(without_auth).ok is False

    # (a) Same Claude-less leg set WITH Claude auth: synthesis reachable, green.
    with_auth = setup_probes.probe_analysis_setup({**base, "ANTHROPIC_API_KEY": "sk-test"})
    assert _synthesis_row(with_auth).ok is True


def test_resolve_claude_apply_binary_precedence(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # 1. Explicit override wins over PATH and the bundled runtime.
    override = tmp_path / "claude-override"
    assert setup_probes.resolve_claude_apply_binary(
        {"JOBCTL_CLAUDE_BIN": str(override)}
    ) == str(override)

    # 2. No override -> system `claude` on PATH.
    monkeypatch.setattr(
        "shutil.which", lambda name: "/usr/local/bin/claude" if name == "claude" else None
    )
    assert setup_probes.resolve_claude_apply_binary({}) == "/usr/local/bin/claude"

    # 3. No override, no PATH `claude` -> SDK-bundled path when present.
    monkeypatch.setattr("shutil.which", lambda name: None)
    bundled = tmp_path / "_bundled" / "claude"
    bundled.parent.mkdir(parents=True)
    bundled.write_text("", encoding="utf-8")
    monkeypatch.setattr(setup_probes, "resolve_bundled_claude_path", lambda: bundled)
    assert setup_probes.resolve_claude_apply_binary({}) == str(bundled)

    # 4. Nothing resolvable -> literal "claude" sentinel.
    monkeypatch.setattr(
        setup_probes, "resolve_bundled_claude_path", lambda: tmp_path / "absent" / "claude"
    )
    assert setup_probes.resolve_claude_apply_binary({}) == "claude"


def test_resolve_claude_apply_binary_expands_user_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # A `~/...` override must reach Popen expanded, matching resolve_codex_binary
    # and the _has_claude_apply_runtime existence probe.
    monkeypatch.setenv("HOME", str(tmp_path))
    resolved = setup_probes.resolve_claude_apply_binary({"JOBCTL_CLAUDE_BIN": "~/bin/claude"})
    assert "~" not in resolved
    assert resolved == str(tmp_path / "bin" / "claude")
