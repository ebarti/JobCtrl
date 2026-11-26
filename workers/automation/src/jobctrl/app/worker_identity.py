"""Startup identities shared by the API, the DBOS worker and its queues."""

import hashlib
from functools import cache
from importlib.metadata import version
from pathlib import Path

# Keep the predecessor's history and registrations available to the importer.
# New workflow history lives in the dbos schema of the bound database.
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

DBOS_SCHEMA = "dbos"
DBOS_APPLICATION = "jobctrl-local"
# Change only for an incompatible durable instruction sequence. Source and feature
# fingerprints fence live processes separately; they must not strand compatible work.
WORKFLOW_VERSION = "jobctrl-workflows-v1"
READY_WORKFLOW = "jobctrl.ready.v1"
ACTION_WORKFLOW = "jobctrl.action.v1"
SEARCH_WORKFLOW = "jobctrl.search.v1"
SCHEDULE_WORKFLOW = "jobctrl.schedule.v1"
STOP_TOPIC = "jobctrl.stop.v1"
ASSESSMENT_ACTION = "preparation.assess_discovered"
WORKER_QUEUES = ("taskQueue", "assessmentQueue", "searchQueue", "scheduleQueue")
SCHEDULE_ACTIONS = {"discovery": "discovery.search", "compensation": "compensation.refresh_stale",
                    "approved-applications": "applications.run_approved"}


@cache
def loaded_build() -> str:
    root = Path(__file__).resolve().parents[1]
    digest = hashlib.sha256(version("dbos").encode())
    for source in sorted(root.rglob("*.py")):
        digest.update(source.relative_to(root).as_posix().encode() + b"\0")
        digest.update(hashlib.sha256(source.read_bytes()).digest())
    return digest.hexdigest()


def process_identity(runtime) -> dict:
    instance = runtime.database.instance_id
    queue = f"jobctrl-{runtime.database.workspace_id}"
    return {
        "workspace": str(runtime.workspace),
        "workspaceId": runtime.database.workspace_id,
        "databaseInstanceId": instance,
        "build": loaded_build(),
        "engine": "dbos",
        "systemSchema": DBOS_SCHEMA,
        "taskQueue": queue,
        "assessmentQueue": queue + "-assessments",
        "searchQueue": queue + "-search",
        "scheduleQueue": queue + "-schedules",
    }


def search_workflow(action, payload):
    if action == "discovery.search":
        return True
    return (action == "preparation.run" and payload.get("recipe") == "search"
            and not payload.get("force", False)
            and payload.get("scope", "selected" if payload.get("job_ids") else "pending") == "pending")


def action_route(action, payload):
    if action == ASSESSMENT_ACTION:
        return ACTION_WORKFLOW, "assessmentQueue"
    if search_workflow(action, payload):
        return SEARCH_WORKFLOW, "searchQueue"
    return ACTION_WORKFLOW, "taskQueue"
