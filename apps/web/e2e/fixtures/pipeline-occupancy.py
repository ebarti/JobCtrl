"""Write synthetic registered-Apply occupancy to an owned E2E database."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import socket
import sqlite3
import stat
import sys
from datetime import UTC, datetime


def owned_workspace() -> tuple[Path, Path]:
    capability = json.loads(os.environ.get("JOBCTRL_E2E_WORKSPACE", "null"))
    if not isinstance(capability, dict) or set(capability) != {
        "schemaVersion", "appDir", "temporaryRoot", "token", "device", "inode",
    }:
        raise RuntimeError("Synthetic pipeline fixture requires an owned workspace")
    app = Path(capability["appDir"])
    root = Path(capability["temporaryRoot"])
    conventional_roots = {Path(value).resolve() for value in ("/tmp", "/private/tmp") if Path(value).exists()}
    darwin_temp = root.name == "T" and root.is_relative_to(Path("/private/var/folders"))
    if (
        capability["schemaVersion"] != 1
        or not isinstance(capability["token"], str)
        or re.fullmatch(r"[a-f0-9]{64}", capability["token"]) is None
        or not app.is_absolute() or not root.is_absolute()
        or app.resolve(strict=True) != app or root.resolve(strict=True) != root
        or app.parent != root or (root not in conventional_roots and not darwin_temp)
        or not app.name.startswith("jobctrl-e2e-")
    ):
        raise RuntimeError("Invalid synthetic workspace capability")
    directory = os.open(app, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(directory)
        if (str(metadata.st_dev), str(metadata.st_ino)) != (capability["device"], capability["inode"]):
            raise RuntimeError("Synthetic workspace identity changed")
        marker_fd = os.open(".jobctrl-e2e-owned.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        with os.fdopen(marker_fd, "r", encoding="utf-8") as marker:
            marker_stat = os.fstat(marker.fileno())
            if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_nlink != 1 or json.load(marker) != capability:
                raise RuntimeError("Synthetic workspace ownership marker changed")
        db = app / "jobctrl.db"
        if (
            os.environ.get("JOBCTRL_DIR") != str(app)
            or os.environ.get("JOBCTRL_DB_PATH") != str(db)
            or os.environ.get("JOBCTRL_E2E_DB_PATH") != str(db)
            or os.path.lexists(db)
        ):
            raise RuntimeError("Synthetic database must be a new owned file")
        return app, db
    finally:
        os.close(directory)


def main() -> None:
    app, db_path = owned_workspace()

    def deny_network(*_args, **_kwargs):
        raise AssertionError("Synthetic occupancy fixture must not access the network")

    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network
    socket.getaddrinfo = deny_network
    socket.gethostname = lambda: "synthetic-host"

    import jobctrl
    from jobctrl import database
    from jobctrl.apply.activities import apply_activity
    from jobctrl.infrastructure.runtime_identity import write_worker_heartbeat
    from jobctrl.infrastructure.temporal.activity_runtime_telemetry import ActiveActivityInventory
    from jobctrl.infrastructure.temporal.registry import ACTIVITIES
    from temporalio import activity

    source_root = Path(__file__).resolve().parents[4] / "workers/automation/src"
    if not Path(jobctrl.__file__).resolve().is_relative_to(source_root):
        raise RuntimeError("Synthetic fixture imported a different checkout")
    with (app / "config.json").open("x", encoding="utf-8") as config_file:
        config_file.write('{"daily_budget_usd": 25}')
    conn = database.init_db(db_path)
    now = datetime.now(UTC).isoformat()
    digest = hashlib.sha256(b'{"memberships":[],"steps":[]}').hexdigest()
    conn.execute(
        "INSERT INTO workflow_run_projections (workflow_id,tenant_id,workflow_type,status,input_summary_json,temporal_run_id,started_at,finished_at,error_code) "
        "VALUES ('discover-local','local','DiscoverWorkflow','terminated','{}','00000000-0000-4000-8000-000000001184',?,?, 'reconciled_not_found')",
        (now, now),
    )
    conn.execute(
        "INSERT INTO discovery_execution_recoveries (tenant_id,discover_workflow_id,discover_run_id,state,mode,decoder_version,history_event_id,expected_membership_count,persisted_membership_count,expected_step_count,persisted_step_count,key_digest,last_error_code,updated_at) "
        "VALUES ('local','discover-local','00000000-0000-4000-8000-000000001184','ready','native',3,1,0,0,0,0,?,NULL,?)",
        (digest, now),
    )
    conn.commit()
    database.close_connection(db_path)

    guard = runpy.run_path(str(Path(__file__).with_name("contact-research-acquisition.py")), run_name="fixture_guard")
    verify_db = guard["_owned_database_path"]
    identity = verify_db(str(db_path))
    connect = sqlite3.connect

    def regular_descriptors():
        fd_root = "/proc/self/fd" if os.path.isdir("/proc/self/fd") else "/dev/fd"
        result = {}
        for name in os.listdir(fd_root):
            if not name.isdecimal():
                continue
            try:
                metadata = os.fstat(int(name))
            except OSError:
                continue
            if stat.S_ISREG(metadata.st_mode):
                result[int(name)] = (metadata.st_dev, metadata.st_ino)
        return result

    def owned_connect(database_path, *args, **kwargs):
        if str(database_path) != str(db_path) or verify_db(str(db_path)) != identity:
            raise RuntimeError("Synthetic database identity changed")
        before = regular_descriptors()
        opened = connect(database_path, *args, **kwargs)
        after = regular_descriptors()
        new_files = [value for fd, value in after.items() if fd not in before]
        if new_files != [identity[1]] or verify_db(str(db_path)) != identity:
            opened.close()
            raise RuntimeError("Opened synthetic database identity changed")
        return opened

    sqlite3.connect = owned_connect
    assert apply_activity in ACTIVITIES
    activity_type = activity._Definition.must_from_callable(apply_activity).name
    assert activity_type == "apply"
    inventory = ActiveActivityInventory()
    canary = "synthetic-private-apply-canary"
    token = inventory.start(
        activity_type=activity_type, activity_id=canary, workflow_id=canary,
        workflow_run_id=canary, attempt=1, started_at=datetime.now(UTC),
    )

    def heartbeat(state: str) -> None:
        if verify_db(str(db_path)) != identity:
            raise RuntimeError("Synthetic database identity changed")
        snapshot = inventory.snapshot()
        write_worker_heartbeat(
            task_queue="jobctrl-default", worker_id="synthetic-occupancy-1184",
            max_concurrent_activities=4, activity_snapshot=snapshot,
        )
        if verify_db(str(db_path)) != identity:
            raise RuntimeError("Synthetic database identity changed")
        print(json.dumps({
            "state": state, "activeSlots": snapshot.active_activity_count,
            "detailsTotal": snapshot.active_details_total,
            "details": snapshot.details_json_list(),
        }), flush=True)

    heartbeat("occupied")
    for line in sys.stdin:
        command = line.strip()
        if command == "finish":
            inventory.finish(token)
            heartbeat("idle")
        elif command == "stop":
            break
        else:
            raise ValueError("Unknown synthetic fixture command")


if __name__ == "__main__":
    main()
