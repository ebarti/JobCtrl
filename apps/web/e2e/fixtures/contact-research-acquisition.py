"""Run a synthetic oversized-page attempt through the real research activity."""

from __future__ import annotations

import json
import os
import re
import socket
import sqlite3
import stat
import sys
from pathlib import Path

TASK_ID = "contact-research-e2e-oversize"
JOB_ID = "abaf847c-43cd-40ad-8dc3-76685694ff29"
SOURCE_URL = "https://contact-research-e2e.example/team"


def _owned_database_path(argument: str) -> tuple[Path, tuple[int, int]]:
    """Require the independently allocated E2E capability before any runtime I/O."""
    try:
        capability = json.loads(os.environ.get("JOBCTRL_E2E_WORKSPACE", "null"))
        if not isinstance(capability, dict) or set(capability) != {
            "schemaVersion", "appDir", "temporaryRoot", "token", "device", "inode",
        }:
            raise ValueError("Missing E2E ownership capability")
        if (
            type(capability["schemaVersion"]) is not int
            or capability["schemaVersion"] != 1
            or not all(isinstance(capability[key], str) for key in ("appDir", "temporaryRoot", "token", "device", "inode"))
            or re.fullmatch(r"[a-f0-9]{64}", capability["token"]) is None
            or re.fullmatch(r"[0-9]+", capability["device"]) is None
            or re.fullmatch(r"[0-9]+", capability["inode"]) is None
        ):
            raise ValueError("Invalid E2E ownership capability")

        root_text, app_text = capability["temporaryRoot"], capability["appDir"]
        if (
            not os.path.isabs(root_text) or os.path.normpath(root_text) != root_text
            or not os.path.isabs(app_text) or os.path.normpath(app_text) != app_text
        ):
            raise ValueError("Invalid E2E workspace paths")
        root, app_dir = Path(root_text), Path(app_text)
        if root.resolve(strict=True) != root or not root.is_dir() or not app_dir.name.startswith("jobctrl-e2e-"):
            raise ValueError("Invalid E2E workspace root")
        relative = app_dir.relative_to(root)
        if not relative.parts:
            raise ValueError("E2E workspace must be a child of its temporary root")
        current = root
        for part in relative.parts:
            current /= part
            if stat.S_ISLNK(os.lstat(current).st_mode):
                raise ValueError("E2E workspace path follows a symlink")

        if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
            raise ValueError("E2E ownership verification is unavailable")
        directory_fd = os.open(app_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            metadata = os.fstat(directory_fd)
            identity = (str(metadata.st_dev), str(metadata.st_ino))
            if not stat.S_ISDIR(metadata.st_mode) or identity != (capability["device"], capability["inode"]):
                raise ValueError("E2E workspace identity changed")
            marker_fd = os.open(".jobctrl-e2e-owned.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
            with os.fdopen(marker_fd, "r", encoding="utf-8") as marker_file:
                marker_stat = os.fstat(marker_file.fileno())
                marker = json.load(marker_file)
            if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_nlink != 1 or marker != capability:
                raise ValueError("E2E ownership marker does not match the capability")

            db_path = app_dir / "jobctrl.db"
            if (
                argument != str(db_path)
                or os.environ.get("JOBCTRL_E2E_APP_DIR") != str(app_dir)
                or os.environ.get("JOBCTRL_DIR") != str(app_dir)
                or os.environ.get("JOBCTRL_E2E_DB_PATH") != str(db_path)
            ):
                raise ValueError("E2E workspace environment does not match the capability")
            db_metadata = os.stat("jobctrl.db", dir_fd=directory_fd, follow_symlinks=False)
            if not stat.S_ISREG(db_metadata.st_mode) or db_metadata.st_nlink != 1:
                raise ValueError("E2E database must be a single-link regular file")
            current_metadata = os.lstat(app_dir)
            if (str(current_metadata.st_dev), str(current_metadata.st_ino)) != identity:
                raise ValueError("E2E workspace was replaced")
            return db_path, (db_metadata.st_dev, db_metadata.st_ino)
        finally:
            os.close(directory_fd)
    except (KeyError, OSError, TypeError, ValueError) as exc:
        raise RuntimeError("Contact research fixture requires its owned E2E capability") from exc


def main() -> None:
    db_path, db_identity = _owned_database_path(sys.argv[1])

    def deny_network(*_args, **_kwargs):
        raise AssertionError("Synthetic contact research must not access the network")

    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network
    socket.getaddrinfo = deny_network

    # Import runtime modules only after validating the owned workspace.
    from jobctrl import config, database
    from jobctrl.contact import activities
    from jobctrl.contact.activities import ResearchSourceInput, RunContactResearchActivityInput
    from jobctrl.infrastructure import events as events_infra
    from jobctrl.infrastructure import llm as llm_infra
    from jobctrl.infrastructure.contact import research_fetcher
    from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
    from jobctrl.infrastructure.migrations.schema_v15 import create_exact_v15_schema

    # Imports can take time; refuse a workspace replaced before SQLite opens.
    if _owned_database_path(sys.argv[1]) != (db_path, db_identity):
        raise RuntimeError("Contact research fixture requires its owned E2E capability")

    class Response:
        status = 200
        headers = {"Content-Length": "2000001"}
        closed = False
        read_called = False

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

        def geturl(self):
            return SOURCE_URL

        def read1(self, _size):
            self.read_called = True
            raise AssertionError("Declared oversized body must not be read")

        def close(self):
            self.closed = True

    class Opener:
        calls = 0

        def open(self, request, timeout):
            assert request.full_url == SOURCE_URL
            assert 0 < timeout <= 20
            self.calls += 1
            return response

    class NoModel:
        calls = 0

        def chat_json(self, *_args, **_kwargs):
            self.calls += 1
            raise AssertionError("An oversized response must not reach the model")

    response, opener, model = Response(), Opener(), NoModel()
    # Never open the browser workspace database from this process. The exact
    # task row produced in memory is handed to its guarded test seeder.
    conn = sqlite3.connect(":memory:")
    try:
        if _owned_database_path(sys.argv[1]) != (db_path, db_identity):
            raise RuntimeError("Contact research fixture requires its owned E2E capability")
        conn.row_factory = sqlite3.Row
        create_exact_v15_schema(conn)
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title, company) VALUES (?, ?, ?, ?, ?)",
            ("local", JOB_ID, "https://example.test/synthetic", "Synthetic job", "GitLab"),
        )
        conn.commit()

        database.get_connection = lambda: conn
        config.load_saved_search_settings = lambda: {}
        events_infra.get_default_publisher = lambda: InProcessEventBus()
        llm_infra.LlmAdapter = lambda **_kwargs: model
        llm_infra.get_llm_adapter = lambda: model
        activities.activity.heartbeat = lambda *_args: None
        research_fetcher._resolve_target_addresses = lambda *_args: ("93.184.216.34",)
        research_fetcher.build_public_http_opener = lambda **_kwargs: opener

        result = activities._run_contact_research(RunContactResearchActivityInput(
            tenant_id="local", task_id=TASK_ID, employer="GitLab", job_id=JOB_ID,
            sources=(ResearchSourceInput(category="public_web_page", url=SOURCE_URL),),
        ))
        task = conn.execute(
            "SELECT * FROM contact_research_tasks WHERE tenant_id = 'local' AND task_id = ?", (TASK_ID,)
        ).fetchone()
        if task is None:
            raise RuntimeError("Synthetic activity did not persist its task")
        print(json.dumps({
            "output": result.to_dict(), "responseClosed": response.closed,
            "responseRead": response.read_called, "requests": opener.calls, "modelCalls": model.calls,
            "persistedTask": dict(task),
        }))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
