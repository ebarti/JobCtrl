"""Startup identities shared by the API, the worker and the workflow database."""

import hashlib
import os
from functools import cache
from pathlib import Path

from jobctrl.app.errors import AppError

SCHEMA = """
CREATE TABLE app_worker_registrations (
 worker_id TEXT PRIMARY KEY REFERENCES app_worker_heartbeats(worker_id),
 identity_json TEXT NOT NULL, actions_json TEXT NOT NULL
);
CREATE TABLE app_workflow_history (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), history TEXT NOT NULL,
 namespace TEXT NOT NULL, namespace_id TEXT NOT NULL
);
"""


@cache
def loaded_build() -> str:
    root = Path(__file__).resolve().parents[1]
    digest = hashlib.sha256()
    for source in sorted(root.rglob("*.py")):
        digest.update(source.relative_to(root).as_posix().encode() + b"\0")
        digest.update(hashlib.sha256(source.read_bytes()).digest())
    return digest.hexdigest()


def process_identity(runtime, queue: str) -> dict:
    address = os.environ.get("JOBCTRL_TEMPORAL_ADDRESS", "127.0.0.1:7233")
    history = os.environ.get("JOBCTRL_TEMPORAL_DB")
    return {
        "workspace": str(runtime.workspace),
        "databaseInstanceId": runtime.database.instance_id,
        "build": loaded_build(),
        "taskQueue": queue,
        "address": address,
        "namespace": os.environ.get("JOBCTRL_TEMPORAL_NAMESPACE", "default"),
        "history": str(Path(history).expanduser().resolve()) if history else address,
    }


def bind_workflow_history(database, identity: dict, namespace_id: str) -> None:
    if not namespace_id:
        raise AppError("workflow_history_unknown", "The workflow namespace identity could not be verified.", 503)
    expected = (identity["history"], identity["namespace"], namespace_id)
    with database.transaction() as connection:
        connection.execute("INSERT OR IGNORE INTO app_workflow_history VALUES(1,?,?,?)", expected)
        recorded = connection.execute("SELECT history,namespace,namespace_id FROM app_workflow_history WHERE singleton=1").fetchone()
        if tuple(recorded) != expected:
            raise AppError("workflow_history_mismatch",
                           "This workspace is paired with a different workflow history. Restart with its original workflow service.", 409)
