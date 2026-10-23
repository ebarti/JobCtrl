"""Owned filesystem and concurrency checks for the SDK project boundary."""
from __future__ import annotations

import os
import shutil
import subprocess
from types import SimpleNamespace
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pytest

from jobctrl.infrastructure.llm.codex_workspace import ensure_codex_workspace_root


def paths(tmp_path):
    home = tmp_path / "isolated-home"
    workspace = home / "workspace"
    home.mkdir(mode=0o700)
    workspace.mkdir(mode=0o700)
    return home, workspace


def test_generated_root_is_a_real_empty_git_repository_without_running_git_to_create_it(tmp_path):
    home, workspace = paths(tmp_path)
    ensure_codex_workspace_root(home, workspace)
    before = {str(p.relative_to(workspace)): p.read_bytes() for p in workspace.rglob("*") if p.is_file()}
    ensure_codex_workspace_root(home, workspace)
    assert before == {str(p.relative_to(workspace)): p.read_bytes() for p in workspace.rglob("*") if p.is_file()}
    # The runtime helper uses only stdlib. Git independently validates its on-disk
    # representation here; no remote, checkout, hook or commit is involved.
    git = shutil.which("git")
    assert git, "Repository QA requires Git for independent format validation"
    result = subprocess.run(
        [git, "rev-parse", "--is-inside-work-tree"], cwd=workspace,
        env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
             "GIT_CONFIG_NOSYSTEM": "1"}, capture_output=True, text=True, check=True,
    )
    assert result.stdout.strip() == "true"
    assert not list((workspace / ".git/refs/heads").iterdir())


def test_concurrent_processes_publish_and_reuse_one_complete_root(tmp_path):
    home, workspace = paths(tmp_path)
    with ProcessPoolExecutor(max_workers=3) as executor:
        futures = [executor.submit(ensure_codex_workspace_root, home, workspace) for _ in range(9)]
        for future in futures:
            future.result(timeout=20)
    ensure_codex_workspace_root(home, workspace)
    assert (workspace / ".git/HEAD").read_text() == "ref: refs/heads/jobctrl-runtime\n"
    assert not list(workspace.glob(".jobctrl-git-*"))


@pytest.mark.parametrize("shape", ["gitfile", "partial", "foreign_config", "unexpected_hook"])
def test_unfamiliar_or_partial_metadata_is_preserved_and_refused(tmp_path, shape):
    home, workspace = paths(tmp_path)
    root = workspace / ".git"
    if shape == "gitfile":
        root.write_text("gitdir: /foreign/repository\n")
    elif shape == "partial":
        root.mkdir(mode=0o700)
    else:
        ensure_codex_workspace_root(home, workspace)
        if shape == "foreign_config":
            (root / "config").write_text('[remote "foreign"]\nurl = https://example.test/\n')
        else:
            (root / "hooks").mkdir()
    before = root.read_bytes() if root.is_file() else {
        str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()
    }
    with pytest.raises(RuntimeError, match="Codex workspace"):
        ensure_codex_workspace_root(home, workspace)
    after = root.read_bytes() if root.is_file() else {
        str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()
    }
    assert after == before


@pytest.mark.skipif(os.name == "nt", reason="Unix symlink creation is available without extra privileges")
@pytest.mark.parametrize("entry", [".git", ".git/HEAD", ".git/objects", ".jobctrl-git.lock", "workspace"])
def test_symlinks_cannot_redirect_the_boundary_or_its_lock(tmp_path, entry):
    home, workspace = paths(tmp_path)
    ensure_codex_workspace_root(home, workspace)
    outside = tmp_path / "outside"
    if entry in {".git/HEAD", ".jobctrl-git.lock"}:
        outside.write_text("owned sentinel")
    else:
        outside.mkdir(mode=0o700)
        (outside / "sentinel").write_text("owned sentinel")
    target = workspace if entry == "workspace" else workspace / entry
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    target.symlink_to(outside, target_is_directory=outside.is_dir())
    with pytest.raises(RuntimeError, match="Codex workspace"):
        ensure_codex_workspace_root(home, workspace)
    sentinel = outside / "sentinel" if outside.is_dir() else outside
    assert sentinel.read_text() == "owned sentinel"


def test_failed_publication_releases_lock_cleans_staging_and_can_retry(tmp_path, monkeypatch):
    home, workspace = paths(tmp_path)
    original = Path.rename
    with monkeypatch.context() as patch:
        def unavailable(_source, _target):
            raise OSError("owned publication failure")
        patch.setattr(Path, "rename", unavailable)
        with pytest.raises(OSError, match="owned publication failure"):
            ensure_codex_workspace_root(home, workspace)
    assert Path.rename is original
    assert not (workspace / ".git").exists()
    assert not list(workspace.glob(".jobctrl-git-*"))
    ensure_codex_workspace_root(home, workspace)


@pytest.mark.parametrize("entry", [".git", ".git/objects", ".git/HEAD", ".jobctrl-git.lock", "home", "workspace"])
def test_windows_reparse_attributes_are_refused_before_traversal(tmp_path, monkeypatch, entry):
    home, workspace = paths(tmp_path)
    ensure_codex_workspace_root(home, workspace)
    target = home if entry == "home" else workspace if entry == "workspace" else workspace / entry
    before = {str(p.relative_to(home)): p.read_bytes() for p in home.rglob("*") if p.is_file()}
    original = Path.lstat

    def with_reparse(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path != target:
            return info
        # Windows junctions may still have S_IFDIR and are not POSIX symlinks.
        return SimpleNamespace(st_mode=info.st_mode, st_nlink=info.st_nlink,
                               st_file_attributes=0x400, st_reparse_tag=0xA0000003)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "lstat", with_reparse)
        with pytest.raises(RuntimeError, match="Codex"):
            ensure_codex_workspace_root(home, workspace)
    assert before == {str(p.relative_to(home)): p.read_bytes() for p in home.rglob("*") if p.is_file()}


@pytest.mark.skipif(os.name != "nt", reason="Native directory junctions require Windows")
@pytest.mark.parametrize("entry", [".git", ".git/objects"])
def test_native_windows_junction_target_is_preserved_and_refused(tmp_path, entry):
    home, workspace = paths(tmp_path)
    ensure_codex_workspace_root(home, workspace)
    target = workspace / entry
    outside = tmp_path / "outside"
    shutil.copytree(target, outside)
    before = {str(p.relative_to(outside)): p.read_bytes() for p in outside.rglob("*") if p.is_file()}
    shutil.rmtree(target)
    subprocess.run(["cmd", "/c", "mklink", "/J", str(target), str(outside)],
                   check=True, capture_output=True)
    try:
        with pytest.raises(RuntimeError, match="Codex"):
            ensure_codex_workspace_root(home, workspace)
        assert before == {str(p.relative_to(outside)): p.read_bytes() for p in outside.rglob("*") if p.is_file()}
    finally:
        # Remove only the owned junction, preserving its target on all Python versions.
        os.rmdir(target)
