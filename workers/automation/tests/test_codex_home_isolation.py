"""Codex SDK ``CODEX_HOME`` isolation — pure-helper regression.

These tests pin the invariant that the Codex analysis leg writes its session
rollouts (and a copied auth token) into an isolated home under the JobCtl
runtime root instead of the user's real ``~/.codex`` chat history. They exercise
ONLY the pure helpers — no ``openai_codex`` import, no app-server, no network —
by pointing both ``jobctl.config.APP_DIR`` and ``Path.home()`` at tmp dirs.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import jobctl.config
from jobctl.infrastructure.analysis import codex_analysis_adapter as adapter


def _isolate_homes(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    """Redirect ``APP_DIR`` and ``Path.home()`` under ``tmp_path``.

    ``APP_DIR`` is read lazily via ``from jobctl.config import APP_DIR`` inside
    the helper, so patching ``jobctl.config.APP_DIR`` is what takes effect.
    Returns ``(app_dir, user_home)``.
    """
    app_dir = tmp_path / "jobctl"
    user_home = tmp_path / "home"
    user_home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(jobctl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: user_home))
    return app_dir, user_home


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_isolated_codex_home_is_under_app_dir(monkeypatch, tmp_path: Path) -> None:
    app_dir, _ = _isolate_homes(monkeypatch, tmp_path)
    home = adapter._isolated_codex_home()
    assert home == app_dir / "codex_home"
    # Patch actually took effect: the path is under our tmp app dir.
    assert tmp_path in home.parents


def test_prepare_creates_home_0700_and_copies_auth_0600(monkeypatch, tmp_path: Path) -> None:
    app_dir, user_home = _isolate_homes(monkeypatch, tmp_path)
    source_auth = user_home / ".codex" / "auth.json"
    source_auth.parent.mkdir(parents=True, exist_ok=True)
    payload = b'{"OPENAI_API_KEY":"sk-isolation-token"}'
    source_auth.write_bytes(payload)

    home = adapter._prepare_isolated_codex_home()

    assert home == app_dir / "codex_home"
    assert home.is_dir()
    assert _mode(home) == 0o700
    target_auth = home / "auth.json"
    assert target_auth.is_file()
    assert target_auth.read_bytes() == payload  # identical bytes
    assert _mode(target_auth) == 0o600


def test_prepare_without_source_auth_still_creates_home(monkeypatch, tmp_path: Path) -> None:
    app_dir, user_home = _isolate_homes(monkeypatch, tmp_path)
    # No ~/.codex/auth.json on disk.
    assert not (user_home / ".codex" / "auth.json").exists()

    home = adapter._prepare_isolated_codex_home()  # must not raise

    assert home == app_dir / "codex_home"
    assert home.is_dir()
    assert _mode(home) == 0o700
    assert not (home / "auth.json").exists()


def test_isolated_codex_env_is_minimal(monkeypatch, tmp_path: Path) -> None:
    _, _ = _isolate_homes(monkeypatch, tmp_path)
    home = tmp_path / "codex_home"
    env = adapter._isolated_codex_env(home)
    # Minimal — the SDK merges this over os.environ, so only CODEX_HOME is set.
    assert env == {"CODEX_HOME": str(home)}


def test_copy_newer_file_copies_when_target_missing(tmp_path: Path) -> None:
    source = tmp_path / "src.json"
    target = tmp_path / "dst" / "auth.json"
    source.write_bytes(b"first")

    copied = adapter._copy_newer_file(source, target, mode=0o600)

    assert copied is True
    assert target.read_bytes() == b"first"
    assert _mode(target) == 0o600
    # Parent dir is locked down to 0700.
    assert _mode(target.parent) == 0o700


def test_copy_newer_file_skips_when_target_is_newer(tmp_path: Path) -> None:
    source = tmp_path / "src.json"
    target = tmp_path / "dst.json"
    source.write_bytes(b"source")
    target.write_bytes(b"existing-newer")
    # Make the target strictly newer than the source.
    os.utime(source, (1_000, 1_000))
    os.utime(target, (2_000, 2_000))

    copied = adapter._copy_newer_file(source, target, mode=0o600)

    assert copied is False
    assert target.read_bytes() == b"existing-newer"  # not overwritten
    assert _mode(target) == 0o600  # still re-chmod'd


def test_copy_newer_file_skips_when_mtimes_equal(tmp_path: Path) -> None:
    source = tmp_path / "src.json"
    target = tmp_path / "dst.json"
    source.write_bytes(b"source")
    target.write_bytes(b"existing-equal")
    os.utime(source, (1_500, 1_500))
    os.utime(target, (1_500, 1_500))  # equal mtime -> skip (>=)

    copied = adapter._copy_newer_file(source, target, mode=0o600)

    assert copied is False
    assert target.read_bytes() == b"existing-equal"


def test_copy_newer_file_overwrites_when_source_is_newer(tmp_path: Path) -> None:
    source = tmp_path / "src.json"
    target = tmp_path / "dst.json"
    target.write_bytes(b"stale")
    source.write_bytes(b"fresh")
    os.utime(target, (1_000, 1_000))
    os.utime(source, (2_000, 2_000))  # source newer -> copy

    copied = adapter._copy_newer_file(source, target, mode=0o600)

    assert copied is True
    assert target.read_bytes() == b"fresh"
    assert _mode(target) == 0o600


def test_copy_newer_file_rechmods_when_source_missing_but_target_exists(tmp_path: Path) -> None:
    source = tmp_path / "missing.json"  # does not exist
    target = tmp_path / "dst.json"
    target.write_bytes(b"existing")
    target.chmod(0o644)

    copied = adapter._copy_newer_file(source, target, mode=0o600)

    assert copied is False
    assert _mode(target) == 0o600  # re-chmod'd despite missing source


def test_copy_newer_file_missing_source_and_target_is_noop(tmp_path: Path) -> None:
    source = tmp_path / "missing-src.json"
    target = tmp_path / "missing-dst.json"

    copied = adapter._copy_newer_file(source, target, mode=0o600)

    assert copied is False
    assert not target.exists()
