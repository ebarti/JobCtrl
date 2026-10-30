"""Ownership checks for the synthetic contact-research browser fixture."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "apps/web/e2e/fixtures/contact-research-acquisition.py"
JOB_ID = "abaf847c-43cd-40ad-8dc3-76685694ff29"


def _workspace(tmp_path: Path):
    root = tmp_path.resolve()
    app_dir = root / "jobctrl-e2e-synthetic"
    app_dir.mkdir()
    db_path = app_dir / "jobctrl.db"
    db_path.write_bytes(b"owned synthetic database sentinel")
    metadata = app_dir.stat()
    capability = {
        "schemaVersion": 1,
        "appDir": str(app_dir),
        "temporaryRoot": str(root),
        "token": secrets.token_hex(32),
        "device": str(metadata.st_dev),
        "inode": str(metadata.st_ino),
    }
    marker = app_dir / ".jobctrl-e2e-owned.json"
    marker.write_text(json.dumps(capability), encoding="utf-8")
    canary_root = root / "import-canary"
    package = canary_root / "jobctrl"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        "import os\nfrom pathlib import Path\nPath(os.environ['TEST_IMPORT_CANARY']).write_text('imported')\n"
        "raise RuntimeError('synthetic runtime import canary')\n",
        encoding="utf-8",
    )
    canary = root / "runtime-imported"
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(root),
        "JOBCTRL_DIR": str(app_dir),
        "JOBCTRL_E2E_APP_DIR": str(app_dir),
        "JOBCTRL_E2E_DB_PATH": str(db_path),
        "JOBCTRL_E2E_WORKSPACE": json.dumps(capability),
        "PYTHONPATH": str(canary_root),
        "PYTHONDONTWRITEBYTECODE": "1",
        "TEST_IMPORT_CANARY": str(canary),
    }
    return app_dir, db_path, marker, capability, canary, env


def _run(db_path: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(db_path)],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True, timeout=20, check=False,
    )


@pytest.mark.parametrize(
    "case",
    [
        "missing", "malformed", "token", "device", "inode", "marker_token", "marker_device", "marker_inode",
        "environment", "replaced", "marker_symlink", "marker_hardlink", "db_symlink", "db_hardlink",
    ],
)
def test_unowned_workspace_is_refused_before_runtime_import_or_database_open(tmp_path: Path, case: str) -> None:
    app_dir, db_path, marker, capability, canary, env = _workspace(tmp_path)
    if case == "missing":
        env.pop("JOBCTRL_E2E_WORKSPACE")
    elif case == "malformed":
        env["JOBCTRL_E2E_WORKSPACE"] = "not JSON"
    elif case in {"token", "device", "inode"}:
        changed = dict(capability)
        changed[case] = "0" * 64 if case == "token" else "0"
        env["JOBCTRL_E2E_WORKSPACE"] = json.dumps(changed)
    elif case.startswith("marker_") and case not in {"marker_symlink", "marker_hardlink"}:
        field = case.removeprefix("marker_")
        marker.write_text(json.dumps({**capability, field: "0" * 64 if field == "token" else "0"}), encoding="utf-8")
    elif case == "environment":
        env["JOBCTRL_DIR"] = str(tmp_path)
    elif case == "replaced":
        app_dir.rename(app_dir.with_name(app_dir.name + "-retained"))
        app_dir.mkdir()
        marker.write_text(json.dumps(capability), encoding="utf-8")
        db_path.write_bytes(b"replacement database sentinel")
    elif case == "marker_symlink":
        retained = marker.with_name("retained-marker.json")
        marker.rename(retained)
        marker.symlink_to(retained)
    elif case == "marker_hardlink":
        os.link(marker, marker.with_name("retained-marker.json"))
    elif case == "db_symlink":
        retained = db_path.with_name("retained-database")
        db_path.rename(retained)
        db_path.symlink_to(retained)
    else:
        os.link(db_path, db_path.with_name("retained-database"))
    expected = db_path.read_bytes()

    result = _run(db_path, env)

    assert result.returncode != 0
    assert not canary.exists(), "Runtime was imported before ownership refusal"
    assert db_path.read_bytes() == expected
    if case == "replaced":
        assert (app_dir.with_name(app_dir.name + "-retained") / "jobctrl.db").read_bytes() == b"owned synthetic database sentinel"


def test_valid_capability_reaches_runtime_only_after_validation(tmp_path: Path) -> None:
    _app_dir, db_path, _marker, _capability, canary, env = _workspace(tmp_path)
    result = _run(db_path, env)
    assert result.returncode != 0
    assert canary.read_text(encoding="utf-8") == "imported"
    assert "synthetic runtime import canary" in result.stderr
    assert db_path.read_bytes() == b"owned synthetic database sentinel"


@pytest.mark.parametrize("replacement", ["marker", "database"])
def test_replacement_during_runtime_import_is_refused_before_database_open(
    tmp_path: Path, replacement: str,
) -> None:
    app_dir, db_path, marker, _capability, _canary, env = _workspace(tmp_path)
    hook_dir = tmp_path / "import-hook"
    hook_dir.mkdir()
    (hook_dir / "sitecustomize.py").write_text(
        "import builtins, os, sqlite3\nfrom pathlib import Path\n"
        "original_import = builtins.__import__\nchanged = False\n"
        "def checked_import(name, *args, **kwargs):\n"
        "    global changed\n"
        "    result = original_import(name, *args, **kwargs)\n"
        "    if name == 'jobctrl.infrastructure.events.in_process_bus' and not changed:\n"
        "        changed = True\n"
        "        if os.environ['TEST_REPLACEMENT'] == 'marker':\n"
        "            Path(os.environ['TEST_MARKER']).write_text('{}')\n"
        "        else:\n"
        "            database = Path(os.environ['TEST_DATABASE'])\n"
        "            database.rename(database.with_name('original-database'))\n"
        "            database.write_bytes(b'replacement database sentinel')\n"
        "    return result\n"
        "def denied_connection(*args, **kwargs):\n"
        "    Path(os.environ['TEST_DB_OPEN_CANARY']).write_text('opened')\n"
        "    raise AssertionError('database must not be opened')\n"
        "builtins.__import__ = checked_import\nsqlite3.connect = denied_connection\n",
        encoding="utf-8",
    )
    db_open_canary = tmp_path / "database-opened"
    env.update(
        PYTHONPATH=os.pathsep.join((str(hook_dir), str(REPO_ROOT / "workers/automation/src"))),
        TEST_MARKER=str(marker), TEST_DATABASE=str(db_path), TEST_REPLACEMENT=replacement,
        TEST_DB_OPEN_CANARY=str(db_open_canary),
    )

    result = _run(db_path, env)

    assert result.returncode != 0
    assert "requires its owned E2E capability" in result.stderr
    assert not db_open_canary.exists()
    if replacement == "marker":
        assert marker.read_text(encoding="utf-8") == "{}"
        assert db_path.read_bytes() == b"owned synthetic database sentinel"
    else:
        assert db_path.read_bytes() == b"replacement database sentinel"
        assert db_path.with_name("original-database").read_bytes() == b"owned synthetic database sentinel"
    assert app_dir.is_dir()


def _real_workspace(tmp_path: Path):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required to allocate the actual browser E2E capability")
    allocator = REPO_ROOT / "apps/web/e2e/fixtures/owned-workspace.cjs"
    command = (
        "const owned=require(process.argv[1]); "
        "const workspace=owned.createOwnedE2eWorkspace(process.argv[2]); "
        "process.stdout.write(JSON.stringify(owned.workspaceEnvironment(workspace)));"
    )
    allocation = subprocess.run(
        [node, "-e", command, str(allocator), str(tmp_path)],
        env={"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "TMPDIR": str(tmp_path.parent)},
        capture_output=True, text=True, timeout=10, check=True,
    )
    env = json.loads(allocation.stdout)
    app_dir, db_path = Path(env["JOBCTRL_E2E_APP_DIR"]), Path(env["JOBCTRL_E2E_DB_PATH"])
    Path(env["TMPDIR"]).mkdir()
    from jobctrl.database import init_db

    conn = init_db(db_path)
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, company) VALUES (?, ?, ?, ?, ?)",
        ("local", JOB_ID, "https://example.test/synthetic", "Synthetic job", "GitLab"),
    )
    conn.commit()
    conn.close()
    env.update(
        PATH=os.environ.get("PATH", ""), HOME=str(app_dir), LANGFUSE_DISABLE="1", JOBCTRL_RUNTIME_MODE="source",
        PYTHONPATH=str(REPO_ROOT / "workers/automation/src"), PYTHONDONTWRITEBYTECODE="1",
    )
    return env, app_dir, db_path


def test_real_node_allocated_capability_runs_the_synthetic_activity(tmp_path: Path) -> None:
    env, _app_dir, db_path = _real_workspace(tmp_path)
    before = db_path.read_bytes()

    result = _run(db_path, env)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    task = payload.pop("persistedTask")
    assert payload == {
        "output": {"taskId": "contact-research-e2e-oversize", "status": "needs_review", "candidateCount": 0, "attemptCount": 1},
        "responseClosed": True, "responseRead": False, "requests": 1, "modelCalls": 0,
    }
    assert task["task_id"] == "contact-research-e2e-oversize"
    assert json.loads(task["source_attempts_json"])[0]["outcome"] == "response_too_large"
    assert db_path.read_bytes() == before
    with sqlite3.connect(db_path) as saved:
        count = saved.execute(
            "SELECT COUNT(*) FROM contact_research_tasks WHERE tenant_id = 'local' AND task_id = ?",
            ("contact-research-e2e-oversize",),
        ).fetchone()
    assert count[0] == 0


def test_workspace_database_swap_at_sqlite_connect_is_refused_without_writes(tmp_path: Path) -> None:
    env, _app_dir, db_path = _real_workspace(tmp_path)
    replacement = tmp_path / "replacement.db"
    shutil.copyfile(db_path, replacement)
    with sqlite3.connect(replacement) as conn:
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title) VALUES (?, ?, ?, ?)",
            ("local", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "https://example.test/replacement", "Replacement"),
        )
    original_bytes, replacement_bytes = db_path.read_bytes(), replacement.read_bytes()
    hook_dir = tmp_path / "connect-hook"
    hook_dir.mkdir()
    (hook_dir / "sitecustomize.py").write_text(
        "import os, shutil, sqlite3\nfrom pathlib import Path\n"
        "connect = sqlite3.connect\ncalled = False\n"
        "def swap_at_connect(database, *args, **kwargs):\n"
        "    global called\n"
        "    if not called:\n"
        "        called = True\n"
        "        Path(os.environ['TEST_DB']).rename(os.environ['TEST_RETAINED'])\n"
        "        shutil.copyfile(os.environ['TEST_REPLACEMENT'], os.environ['TEST_DB'])\n"
        "        Path(os.environ['TEST_CONNECT_CANARY']).write_text(str(database))\n"
        "    return connect(database, *args, **kwargs)\n"
        "sqlite3.connect = swap_at_connect\n",
        encoding="utf-8",
    )
    retained = tmp_path / "retained-original.db"
    connect_canary = tmp_path / "connect-called"
    env.update(
        PYTHONPATH=os.pathsep.join((str(hook_dir), str(REPO_ROOT / "workers/automation/src"))),
        TEST_DB=str(db_path), TEST_RETAINED=str(retained), TEST_REPLACEMENT=str(replacement),
        TEST_CONNECT_CANARY=str(connect_canary),
    )

    result = _run(db_path, env)

    assert result.returncode != 0
    assert "requires its owned E2E capability" in result.stderr
    assert connect_canary.read_text(encoding="utf-8") == ":memory:"
    assert retained.read_bytes() == original_bytes
    assert replacement.read_bytes() == replacement_bytes
    assert db_path.read_bytes() == replacement_bytes
