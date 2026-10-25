"""Owned structural tests for shared state and crash-safe storage reclamation."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from jobctrl.infrastructure.llm import codex_runtime_storage as storage


@pytest.fixture(autouse=True)
def owned_temporary_parent(monkeypatch, tmp_path):
    parent = tmp_path / "runtime-temporary-parent"
    parent.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(parent))
    yield parent


def test_overlapping_clients_share_state_until_last_release(tmp_path):
    home = tmp_path / "provider"
    home.mkdir()
    with storage.shared_codex_storage(home) as first:
        first.joinpath("owned.sqlite").write_bytes(b"owned metadata")
        with storage.shared_codex_storage(home) as second:
            assert second == first
            assert second.joinpath("owned.sqlite").read_bytes() == b"owned metadata"
        assert first.exists()
    assert not first.parent.exists()
    assert home.exists()


def test_separate_provider_homes_keep_independent_stores(tmp_path):
    one, two = tmp_path / "one", tmp_path / "two"
    one.mkdir()
    two.mkdir()
    with storage.shared_codex_storage(one) as first, storage.shared_codex_storage(two) as second:
        assert first != second
        assert first.exists() and second.exists()
        storage._reap_stale_storage(one.resolve())
        assert first.exists() and second.exists()
    assert not first.parent.exists() and not second.parent.exists()


def test_exception_releases_and_removes_last_client_store(tmp_path):
    home = tmp_path / "provider"
    home.mkdir()
    with pytest.raises(RuntimeError, match="owned failure"):
        with storage.shared_codex_storage(home) as state:
            raise RuntimeError("owned failure")
    assert not state.parent.exists()


def _abandoned_store(home: Path, temporary_parent: Path) -> Path:
    script = """
import os, sys
from pathlib import Path
from jobctrl.infrastructure.llm.codex_runtime_storage import shared_codex_storage
with shared_codex_storage(Path(sys.argv[1])) as state:
    (state / 'owned.sqlite').write_bytes(b'owned crash metadata')
    print(state, flush=True)
    os._exit(0)
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(home)], check=True, capture_output=True,
        text=True, env={**os.environ, "TMPDIR": str(temporary_parent), "TEMP": str(temporary_parent),
                        "TMP": str(temporary_parent)},
    )
    state = Path(result.stdout.strip())
    assert state.parent.parent == temporary_parent.resolve()
    assert state.joinpath("owned.sqlite").is_file()
    return state


def test_new_process_reclaims_only_unleased_store_for_same_home(tmp_path, owned_temporary_parent):
    home, other = tmp_path / "provider", tmp_path / "other"
    home.mkdir()
    other.mkdir()
    abandoned = _abandoned_store(home, owned_temporary_parent)
    unrelated = _abandoned_store(other, owned_temporary_parent)
    with storage.shared_codex_storage(home) as current:
        assert not abandoned.parent.exists()
        assert unrelated.exists()
        assert current.exists()
    assert not current.parent.exists()
    storage._reap_stale_storage(other.resolve())
    assert not unrelated.parent.exists()


@pytest.mark.parametrize("mutation", ["marker", "unknown_file", "lease_link", "root_link", "sqlite_link"])
def test_reclamation_preserves_unfamiliar_or_redirected_paths(
    tmp_path, owned_temporary_parent, mutation
):
    if os.name == "nt" and mutation in {"root_link", "sqlite_link"}:
        pytest.skip("Windows symlink creation requires a separate capability")
    home = tmp_path / "provider"
    home.mkdir()
    abandoned = _abandoned_store(home, owned_temporary_parent)
    root = abandoned.parent
    target = tmp_path / "must-remain"
    target.mkdir()
    target.joinpath("sentinel").write_bytes(b"unrelated data")
    if mutation == "marker":
        marker = root / storage._MARKER
        marker.write_text(json.dumps({"schemaVersion": 99, "providerHome": str(home)}))
    elif mutation == "unknown_file":
        root.joinpath("foreign-material.txt").write_bytes(b"must remain")
    elif mutation == "lease_link":
        os.link(root / storage._LEASE, target / "lease")
    elif mutation == "root_link":
        root.rename(target / "saved-runtime")
        root.symlink_to(target, target_is_directory=True)
    else:
        abandoned.rename(target / "saved-state")
        abandoned.symlink_to(target, target_is_directory=True)
    storage._reap_stale_storage(home.resolve())
    assert root.exists()
    assert target.joinpath("sentinel").read_bytes() == b"unrelated data"


def test_clients_on_different_threads_share_the_same_storage(tmp_path):
    home = tmp_path / "provider"
    home.mkdir()
    ready = threading.Barrier(3)
    release = threading.Event()
    paths = []

    def client():
        with storage.shared_codex_storage(home) as state:
            paths.append(state)
            ready.wait(timeout=5)
            assert release.wait(timeout=5)
            return state

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client) for _ in range(2)]
        try:
            ready.wait(timeout=5)
            assert paths[0] == paths[1]
            assert paths[0].exists()
        finally:
            release.set()
        assert futures[0].result(timeout=5) == futures[1].result(timeout=5)
    assert not paths[0].parent.exists()
