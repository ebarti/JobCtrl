from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from jobctrl.config import (
    CONFIG_LOCK_DIRECTORY,
    ConfigFileError,
    load_config_file,
    update_config_file,
    write_config_file,
)


def test_config_updates_preserve_unrelated_settings(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    write_config_file({"daily_budget_usd": 25}, path=config_path)

    update_config_file({"analysis_legs": ["codex"]}, path=config_path)

    assert load_config_file(path=config_path, strict=True) == {
        "analysis_legs": ["codex"],
        "daily_budget_usd": 25,
    }
    assert not (tmp_path / CONFIG_LOCK_DIRECTORY).exists()


def test_concurrent_config_updates_do_not_lose_keys(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    write_config_file({"seed": True}, path=config_path)

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(
            executor.map(
                lambda index: update_config_file({f"setting_{index}": index}, path=config_path),
                range(24),
            )
        )

    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted["seed"] is True
    assert {persisted[f"setting_{index}"] for index in range(24)} == set(range(24))


def test_config_lock_rejects_an_untrusted_non_directory_path(tmp_path: Path) -> None:
    (tmp_path / CONFIG_LOCK_DIRECTORY).write_text("not a lock directory", encoding="utf-8")

    with pytest.raises(ConfigFileError, match="lock path is not a directory"):
        update_config_file({"daily_budget_usd": 10}, path=tmp_path / "config.json")


def test_config_lock_rejects_a_symlink(tmp_path: Path) -> None:
    lock_target = tmp_path / "real-lock"
    lock_target.mkdir()
    (tmp_path / CONFIG_LOCK_DIRECTORY).symlink_to(lock_target, target_is_directory=True)

    with pytest.raises(ConfigFileError, match="lock path is not a directory"):
        update_config_file({"daily_budget_usd": 10}, path=tmp_path / "config.json")


def test_config_lock_retries_when_owner_releases_after_lstat(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config_path = tmp_path / "config.json"
    lock_path = tmp_path / CONFIG_LOCK_DIRECTORY
    lock_path.mkdir()
    original_lstat = Path.lstat
    released = False

    def release_lock_after_lstat(path: Path):
        nonlocal released
        lock_stat = original_lstat(path)
        if path == lock_path and not released:
            released = True
            lock_path.rmdir()
        return lock_stat

    monkeypatch.setattr(Path, "lstat", release_lock_after_lstat)

    update_config_file({"daily_budget_usd": 10}, path=config_path)

    assert released
    assert load_config_file(path=config_path, strict=True) == {"daily_budget_usd": 10}


def test_config_preserves_existing_custom_parent_permissions(tmp_path: Path) -> None:
    shared_directory = tmp_path / "shared"
    shared_directory.mkdir(mode=0o750)
    shared_directory.chmod(0o750)
    config_path = shared_directory / "config.json"

    write_config_file({"daily_budget_usd": 25}, path=config_path)

    assert shared_directory.stat().st_mode & 0o777 == 0o750
    assert config_path.stat().st_mode & 0o777 == 0o600


def test_config_makes_new_parent_directories_private(tmp_path: Path) -> None:
    parent = tmp_path / "jobctrl" / "settings"
    config_path = parent / "config.json"

    write_config_file({"daily_budget_usd": 25}, path=config_path)

    assert parent.parent.stat().st_mode & 0o777 == 0o700
    assert parent.stat().st_mode & 0o777 == 0o700
    assert config_path.stat().st_mode & 0o777 == 0o600
