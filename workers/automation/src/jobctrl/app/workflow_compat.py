"""Read-only compatibility check for outstanding DBOS work in a paired workspace."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from sqlalchemy.exc import SQLAlchemyError

from jobctrl.app.errors import AppError
from jobctrl.app.worker_identity import (
    ACTION_WORKFLOW, DBOS_APPLICATION, READY_WORKFLOW, SCHEDULE_ACTIONS, SCHEDULE_WORKFLOW,
    SEARCH_WORKFLOW, WORKFLOW_VERSION, search_workflow,
)

ENGINE_UNFINISHED = "(status IS NULL OR status NOT IN ('SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED'))"
ACTIVE_ACTIONS = "('pending','start_failed','queued','running')"


def inspect_pending(application, connection):
    """All action and engine types must be supported by the selected candidate."""
    engine = connection.execute("SELECT to_regclass('dbos.workflow_status') IS NOT NULL").fetchone()[0]
    workflows = connection.execute(
        f"SELECT workflow_uuid,name,status,application_version,queue_name,application_name,schedule_name FROM dbos.workflow_status "
        f"WHERE {ENGINE_UNFINISHED}"
    ).fetchall() if engine else []
    active_sql = f"SELECT action,input_hash,payload_json,workflow_id FROM app_action_runs WHERE status IN {ACTIVE_ACTIONS}"
    if engine:
        # A worker may die after a product commit but before the DBOS checkpoint.
        active_sql += f" OR workflow_id IN (SELECT workflow_uuid FROM dbos.workflow_status WHERE {ENGINE_UNFINISHED})"
    owned = {}
    bad_actions = 0
    for row in connection.execute(active_sql):
        action = row["action"]
        payload = json.loads(row["payload_json"])
        owned[row["workflow_id"]] = SEARCH_WORKFLOW if search_workflow(action, payload) else ACTION_WORKFLOW
        if action not in application.actions or application._input_digest(action, payload) != row["input_hash"]:
            bad_actions += 1
    queues = {
        ACTION_WORKFLOW: application.identity["taskQueue"], SEARCH_WORKFLOW: application.identity["searchQueue"],
        SCHEDULE_WORKFLOW: application.identity["scheduleQueue"], READY_WORKFLOW: application.identity["scheduleQueue"],
    }
    schedules = {f"{application.identity['taskQueue']}-{kind}" for kind, action in SCHEDULE_ACTIONS.items()
                 if action in application.actions}
    bad_workflows = 0
    for flow in workflows:
        name = flow["name"]
        if (flow["status"] not in {"ENQUEUED", "DELAYED", "PENDING"} or name not in queues or flow["queue_name"] != queues.get(name)
                or flow["application_name"] != DBOS_APPLICATION
                or (flow["application_version"] != WORKFLOW_VERSION
                    and not (name == SCHEDULE_WORKFLOW and flow["application_version"] is None))
                or (name == SCHEDULE_WORKFLOW and flow["schedule_name"] not in schedules)
                or (name in (ACTION_WORKFLOW, SEARCH_WORKFLOW) and owned.get(flow["workflow_uuid"]) != name)):
            bad_workflows += 1
    if owned:
        # Missing history or an engine success without the required domain
        # commit cannot establish a recoverable action.
        missing = connection.execute(
            f"SELECT count(*) FROM app_action_runs a WHERE status IN {ACTIVE_ACTIONS} "
            "AND NOT EXISTS (SELECT 1 FROM dbos.workflow_status w WHERE w.workflow_uuid=a.workflow_id AND w.status<>'SUCCESS')"
        ).fetchone()[0] if engine else len(owned)
        bad_workflows += missing
    compatible = not (bad_actions or bad_workflows)
    return {"compatible": compatible, "workflowVersion": WORKFLOW_VERSION,
            **({} if compatible else {"reason": "workflow_contract_incompatible", "incompatibleActions": bad_actions,
                                      "incompatibleWorkflows": bad_workflows})}


def inspect_offline(workspace, database, *, enabled_features=None):
    """Inspect a quiesced generation through the launcher's read-only PostgreSQL adapter."""
    from jobctrl.app.bootstrap import create_application

    application = create_application(workspace, database=database, enabled_features=enabled_features, inspect_only=True)
    try:
        with database.connect() as connection:
            return inspect_pending(application, connection)
    finally:
        application.close()


def main():
    from jobctrl.app.bootstrap import create_application
    from jobctrl.app.database import Database

    parser = argparse.ArgumentParser(description="Check pending JobCtrl workflow compatibility without starting a worker")
    parser.add_argument("--workspace", type=Path, default=Path(os.environ.get("JOBCTRL_DIR", "~/.jobctrl")).expanduser())
    parser.add_argument("--features", default=os.environ.get("JOBCTRL_FEATURES"))
    args = parser.parse_args()
    try:
        if Database.probe(args.workspace) is None:
            result = {"compatible": True, "workflowVersion": WORKFLOW_VERSION}
        else:
            app = create_application(args.workspace, enabled_features=args.features.split(",") if args.features else None,
                                     inspect_only=True)
            try:
                with app.runtime.database.connect() as connection:
                    result = inspect_pending(app, connection)
            finally:
                app.close()
    except (AppError, SQLAlchemyError) as error:
        result = {"compatible": False, "reason": error.code if isinstance(error, AppError) else "database_unavailable"}
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["compatible"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
