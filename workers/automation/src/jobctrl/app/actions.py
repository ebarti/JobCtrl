"""Durable dispatch to the same explicit Python application actions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from collections.abc import Collection
from datetime import datetime, timezone

from dbos import DBOSClient, DBOSPortableJSONSerializer
from dbos import error as dbos_error
from sqlalchemy.exc import SQLAlchemyError

from jobctrl.app.contracts import ActionContext, Feature, Runtime
from jobctrl.app.credentials import read_process_identity
from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.app.events import now
from jobctrl.app.execution import ExecutionCustody
from jobctrl.app.worker_identity import (
    ASSESSMENT_ACTION, DBOS_APPLICATION, DBOS_SCHEMA, SEARCH_WORKFLOW, STOP_TOPIC, WORKER_QUEUES, WORKFLOW_VERSION,
    SCHEMA as WORKER_IDENTITY_SCHEMA, action_route, process_identity, search_workflow,
)


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}
# Existing true values record a request with no separate delivery evidence.
STOP_REQUESTED = 1
STOP_ACKNOWLEDGED = 2


def encode(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


class Application:
    def __init__(self, runtime: Runtime, features: Collection[Feature]):
        self.runtime = runtime
        self.features = {feature.name: feature for feature in features}
        self.services = {feature.name: feature.service for feature in features}
        self.actions = {}
        self.action_scopes = {}
        self.action_finalizers = {}
        self.action_versions = {}
        self.action_admissions = {}
        for feature in features:
            for name, handler in feature.actions.items():
                if name in self.actions or not name.startswith(feature.name + "."):
                    raise ValueError(f"Invalid or duplicate action: {name}")
                self.actions[name] = handler
            for name, scope in feature.action_scopes.items():
                if name not in feature.actions or not callable(scope):
                    raise ValueError(f"Invalid action scope: {name}")
                self.action_scopes[name] = scope
            for name, finalizer in feature.action_finalizers.items():
                if name not in feature.actions or not callable(finalizer):
                    raise ValueError(f"Invalid action finalizer: {name}")
                self.action_finalizers[name] = finalizer
            for name, version in feature.action_versions.items():
                if name not in feature.actions or not isinstance(version, str) or not version.strip():
                    raise ValueError(f"Invalid action contract version: {name}")
                self.action_versions[name] = version
            for name, admission in feature.action_admissions.items():
                if name not in feature.actions or not callable(admission):
                    raise ValueError(f"Invalid action admission: {name}")
                self.action_admissions[name] = admission
        self.runtime.database.initialize_feature("worker_identity", WORKER_IDENTITY_SCHEMA)
        self.identity = process_identity(runtime)
        configuration = (sorted(self.actions), sorted(self.features), self.action_versions)
        self.identity["composition"] = hashlib.sha256(encode(configuration).encode()).hexdigest()
        self.identity["workflowVersion"] = WORKFLOW_VERSION
        self.dbos = None if runtime.database.read_only else DBOSClient(
            system_database_engine=runtime.database.engine, dbos_system_schema=DBOS_SCHEMA,
            application_name=DBOS_APPLICATION, serializer=DBOSPortableJSONSerializer(),
            lazy=True, retry_connection_errors=False,
        )

    def close(self):
        if self.dbos is not None:
            self.dbos.destroy()
        self.runtime.database.close()

    def _finalize_feature(self, action, run_id, status, error_code, connection):
        finalizer = self.action_finalizers.get(action)
        if finalizer is not None:
            finalizer(run_id, status, error_code, connection)

    def _require_action(self, action: str, payload: dict) -> str:
        if action not in self.actions:
            raise NotFoundError("The application action is not registered.")
        if not isinstance(payload, dict):
            raise AppError("invalid_action_payload", "Action input must be a JSON object.")
        encoded = encode(payload)
        if len(encoded.encode()) > 1024 * 1024:
            raise AppError("action_payload_too_large", "The action input exceeds its limit.", 413)
        return encoded

    def _input_digest(self, action, payload):
        identity = {"action": action, "payload": payload}
        if version := self.action_versions.get(action):
            identity["contract_version"] = version
        return hashlib.sha256(encode(identity).encode()).hexdigest()

    def _existing(self, connection, action, payload, encoded, key):
        row = connection.execute(
            "SELECT * FROM app_action_runs WHERE idempotency_key=?", (key,),
        ).fetchone()
        if row is None:
            return None
        if row["action"] != action or row["input_hash"] != self._input_digest(action, payload):
            if action in self.action_versions and row["action"] == action and row["payload_json"] == encoded:
                raise AppError("action_contract_changed", "This action belongs to an earlier processing contract. Start a new action. The earlier result remains in history.", 409)
            raise ConflictError("This action identity already belongs to different input.")
        return self._run_payload(row)

    @staticmethod
    def _check_key(key):
        if not isinstance(key, str) or not key.strip() or len(key) > 200:
            raise AppError("invalid_idempotency_key", "Use a nonempty idempotency key of at most 200 characters.")

    def admit(self, action: str, payload: dict, *, connection, idempotency_key: str,
              request_id: str | None = None) -> dict:
        """Commit the feature receipt, queue entry and event in the caller's transaction."""
        encoded = self._require_action(action, payload)
        self._check_key(idempotency_key)
        # Serialize same-key retries even across independent API and worker processes.
        connection.execute("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ("action-key:" + idempotency_key,))
        saved = self._existing(connection, action, payload, encoded, idempotency_key)
        if saved is not None:
            return saved
        scope = self.action_scopes.get(action)
        if scope is not None:
            requested_scope = scope(payload)
            lock = encode(["action-scope", action, requested_scope])
            connection.execute("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", (lock,))
            for candidate in connection.execute(
                "SELECT run_id,payload_json FROM app_action_runs WHERE action=? "
                "AND status IN ('pending','start_failed','queued','running')", (action,),
            ):
                if scope(json.loads(candidate["payload_json"])) == requested_scope:
                    raise AppError("action_scope_busy", "An action for this scope is already pending or running.", 409,
                                   {"runId": candidate["run_id"], "action": action})
        run_id = str(uuid.uuid4())
        workflow_id = f"{self.identity['taskQueue']}-{run_id}"
        created = now()
        connection.execute(
            "INSERT INTO app_action_runs(run_id,action,request_id,idempotency_key,input_hash,payload_json,status,workflow_id,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,'queued',?,?,?)",
            (run_id, action, request_id or run_id, idempotency_key, self._input_digest(action, payload),
             encoded, workflow_id, created, created),
        )
        if admission := self.action_admissions.get(action):
            admission(run_id, payload, connection)
        workflow_name, queue = action_route(action, payload)
        self.dbos.enqueue_in_transaction(
            connection.sa_connection, {
                "workflow_name": workflow_name,
                "workflow_id": workflow_id, "workflow_id_reuse_policy": "reject",
                "queue_name": self.identity[queue],
                "app_version": self.identity["workflowVersion"],
            }, run_id,
        )
        self.runtime.events.append(connection, "ActionQueued", {"runId": run_id, "action": action}, feature=action.split(".")[0])
        return self.action_run(run_id, connection)

    @staticmethod
    def _run_payload(row) -> dict:
        stop = row["cancellation_requested"]
        delivery = "acknowledged" if stop == STOP_ACKNOWLEDGED else None
        if stop == STOP_REQUESTED and row["status"] not in TERMINAL_STATUSES:
            delivery = "pending"
        return {
            "runId": row["run_id"], "action": row["action"], "status": row["status"],
            "workflowId": row["workflow_id"], "temporalRunId": row["temporal_run_id"],
            "result": json.loads(row["result_json"]) if row["result_json"] else None,
            "errorCode": row["error_code"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "cancellationRequested": bool(stop),
            **({"cancellationDelivery": delivery} if delivery is not None else {}),
        }

    def action_run(self, run_id: str, connection=None) -> dict:
        if connection is None:
            with self.runtime.database.connect() as owned:
                return self.action_run(run_id, owned)
        row = connection.execute("SELECT * FROM app_action_runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise NotFoundError("The action run does not exist.")
        return self._run_payload(row)

    def workflow_run(self, workflow_id: str, temporal_run_id: str | None = None) -> dict | None:
        with self.runtime.database.connect() as connection:
            row = connection.execute("SELECT * FROM app_action_runs WHERE workflow_id=?", (workflow_id,)).fetchone()
        if row is None or (temporal_run_id is not None and row["temporal_run_id"] != temporal_run_id):
            return None
        return self._run_payload(row)

    def run_for_idempotency_key(self, action: str, key: str) -> dict:
        if not isinstance(key, str) or not key.strip() or len(key) > 200 or not isinstance(action, str) or not action or len(action) > 160:
            raise AppError("invalid_idempotency_lookup", "Supply the exact action and saved idempotency key.")
        with self.runtime.database.connect() as connection:
            row = connection.execute("SELECT * FROM app_action_runs WHERE idempotency_key=? AND action=?", (key, action)).fetchone()
        if row is None:
            raise NotFoundError("No admission is recorded for this action and key at this time.")
        return self._run_payload(row)

    def list_runs(self, *, limit: int = 100) -> list[dict]:
        with self.runtime.database.connect() as connection:
            return [self._run_payload(row) for row in connection.execute(
                "SELECT * FROM app_action_runs ORDER BY created_at DESC,run_id DESC LIMIT ?", (min(limit, 1000),)
            )]

    def job_action_run_id(self, job_id: str, payload_id: str | None, action_names: tuple[str, ...], *, connection) -> str | None:
        """Read the job's active action first, then its latest settled action."""
        names = ",".join("?" for _ in action_names)
        row = connection.execute(
            f"SELECT run_id FROM app_action_runs WHERE action IN ({names}) "
            "AND (payload_json::jsonb ->> 'jobId')=? "
            "AND ((payload_json::jsonb ->> 'payloadId') IS NULL OR (payload_json::jsonb ->> 'payloadId')=?) "
            "ORDER BY (status IN ('pending','queued','running')) DESC, created_at DESC, run_id DESC LIMIT 1",
            (*action_names, job_id, payload_id),
        ).fetchone()
        return row["run_id"] if row else None

    def run_page(self, *, before: str | None = None, limit: int = 100, status: str | None = None,
                 action: str | None = None, since: str | None = None, until: str | None = None) -> dict:
        conditions = ["TRUE"]
        parameters = []
        for condition, value in (("status=?", status), ("action=?", action), ("created_at>=?", since), ("created_at<=?", until)):
            if value is not None:
                conditions.append(condition)
                parameters.append(value)
        with self.runtime.database.connect() as connection:
            if before:
                cursor = connection.execute("SELECT created_at FROM app_action_runs WHERE run_id=?", (before,)).fetchone()
                if cursor is None:
                    raise AppError("invalid_action_cursor", "The action cursor is unavailable.")
                conditions.append("(created_at<? OR (created_at=? AND run_id<?))")
                parameters.extend((cursor[0], cursor[0], before))
            rows = connection.execute(
                "SELECT * FROM app_action_runs WHERE " + " AND ".join(conditions)
                + " ORDER BY created_at DESC,run_id DESC LIMIT ?", (*parameters, limit + 1),
            ).fetchall()
        more = len(rows) > limit
        runs = [self._run_payload(row) for row in rows[:limit]]
        return {"runs": runs, "nextCursor": runs[-1]["runId"] if more else None, "hasMore": more}

    def run_summary(self) -> dict:
        with self.runtime.database.connect() as connection:
            counts = dict(connection.execute("SELECT status,COUNT(*) FROM app_action_runs GROUP BY status"))
            cancellations = connection.execute("SELECT COUNT(*) FROM app_action_runs WHERE cancellation_requested<>0 AND status NOT IN ('succeeded','failed','cancelled')").fetchone()[0]
        return {"counts": counts, "total": sum(counts.values()), "active": sum(counts.get(status, 0) for status in ("queued", "running")),
                "pendingCancellation": cancellations}

    async def submit(self, action: str, payload: dict, *, idempotency_key: str | None = None,
                     request_id: str | None = None) -> dict:
        if action == ASSESSMENT_ACTION:
            raise NotFoundError("This action requires an admitted Discovery handoff.")
        encoded = self._require_action(action, payload)
        key = uuid.uuid4().hex if idempotency_key is None else idempotency_key
        self._check_key(key)

        def submit_transaction():
            if idempotency_key is not None:
                with self.runtime.database.connect() as connection:
                    saved = self._existing(connection, action, payload, encoded, key)
                if saved:
                    return saved
            readiness = self._readiness(action)
            if not readiness["healthy"]:
                raise AppError(readiness["reason"], readiness["message"], 503)
            with self.runtime.database.transaction() as connection:
                # A worker replacement invalidates the earlier readiness probe. Its
                # startup fence and this final admission serialize in PostgreSQL.
                confirmed = self.worker_status(action, connection=connection)
                if not confirmed["healthy"]:
                    raise AppError(confirmed["reason"], confirmed["message"], 503)
                return self.admit(action, payload, connection=connection, idempotency_key=key, request_id=request_id)

        try:
            receipt = await asyncio.to_thread(submit_transaction)
        except (SQLAlchemyError, dbos_error.DBOSException):
            # A dropped commit acknowledgement leaves a single idempotent question.
            # The domain receipt and DBOS work are either both present or both absent.
            raise AppError("workflow_start_failed", "Queue admission could not be confirmed. Retry with the same idempotency key.",
                           503, {"idempotencyKey": key}) from None
        return {field: receipt[field] for field in ("runId", "workflowId", "status")}

    def _pending_children(self, row, connection):
        preparation = self.services.get("preparation")
        if preparation is None or row["action"] not in {"discovery.search", "preparation.run"}:
            return []
        return preparation.pending_child_actions(row["run_id"], connection)

    def _finish(self, row, status, code, connection, *, result=None):
        run_id, action = row["run_id"], row["action"]
        if action in {"discovery.search", "preparation.run"}:
            # A Stop can arrive while a page or its assessments are executing.
            # Only the child's feature finalizer settles its handoff, after its
            # provider call has returned or unwound and its receipts are saved.
            current = connection.execute("SELECT cancellation_requested,payload_json FROM app_action_runs WHERE run_id=?",
                                         (run_id,)).fetchone()
            if current["cancellation_requested"] and search_workflow(action, json.loads(current["payload_json"])):
                if self._pending_children(row, connection):
                    return
                status, code = "cancelled", "action_cancelled"
        changed = connection.execute(
            "UPDATE app_action_runs SET status=?,error_code=?,result_json=?,updated_at=? WHERE run_id=? "
            "AND status IN ('pending','start_failed','queued','running')",
            (status, code, encode(result) if status == "succeeded" else None, now(), run_id),
        ).rowcount
        if changed:
            self._finalize_feature(action, run_id, status, code, connection)
            event = {"runId": run_id, "action": action}
            if code:
                event["code"] = code
            self.runtime.events.append(connection, "ActionCompleted" if status == "succeeded" else "ActionFailed", event,
                                       feature=action.split(".")[0],
                                       level="info" if status == "succeeded" else "warn" if status == "cancelled" else "error")

    async def execute_turn(self, run_id: str, workflow_id: str, *, search: bool, stopping) -> dict:
        """Run one checkpointed turn. Only the DBOS worker invokes a feature."""
        if workflow_id != f"{self.identity['taskQueue']}-{run_id}":
            raise AppError("worker_workspace_mismatch", "This workspace does not own this workflow.", 409)
        custody = ExecutionCustody(self.runtime.workspace, run_id)
        try:
            await custody.acquire(stopping)
            with self.runtime.database.transaction() as connection:
                row = connection.execute(
                    "SELECT * FROM app_action_runs WHERE run_id=? AND workflow_id=? FOR UPDATE", (run_id, workflow_id),
                ).fetchone()
                if row is None:
                    raise AppError("worker_workspace_mismatch", "The workflow has no matching admission.", 409)
                action = row["action"]
                payload = json.loads(row["payload_json"])
                if search != search_workflow(action, payload) or row["input_hash"] != self._input_digest(action, payload):
                    raise AppError("action_contract_changed", "This action belongs to an incompatible processing contract.", 409)
                if row["status"] == "succeeded":
                    return {"done": True}
                if row["status"] in {"failed", "cancelled"}:
                    raise AppError(row["error_code"] or "action_terminal", "The action already reached a terminal outcome.", 409)
                if row["cancellation_requested"]:
                    self._finish(row, "cancelled", "action_cancelled", connection)
                    refused = True
                else:
                    refused = False
                    if row["status"] != "running":
                        connection.execute("UPDATE app_action_runs SET status='running',updated_at=? WHERE run_id=?", (now(), run_id))
                        self.runtime.events.append(connection, "ActionStarted", {"runId": run_id, "action": action},
                                                   feature=action.split(".")[0])
            if refused:
                raise AppError("action_cancelled", "The action was stopped before execution.", 409)

            def user_cancelled():
                return self.action_run(run_id)["cancellationRequested"]

            def cancelled():
                return stopping() or not custody.owned or user_cancelled()

            context = ActionContext(run_id, row["request_id"], cancelled, user_cancelled=user_cancelled)
            try:
                if stopping():
                    raise asyncio.CancelledError()
                if search:
                    if action == "preparation.run":
                        turn = await self.services["preparation"].search_turn(context, payload, preparation_recipe=True)
                    else:
                        owner = self.services.get("preparation") or self.services["discovery"]
                        turn = await owner.search_turn(context, payload)
                    if not turn["done"]:
                        return {"done": False, "waitSeconds": turn["waitSeconds"]}
                    result = turn["result"]
                else:
                    result = await self.actions[action](context, payload)
                with self.runtime.database.transaction() as connection:
                    self._finish(row, "succeeded", None, connection, result=result)
                # Product output stays in the owning transaction. DBOS needs only a receipt.
                return {"done": True}
            except (asyncio.CancelledError, Exception) as error:
                explicitly_stopped = self.action_run(run_id)["cancellationRequested"]
                if (isinstance(error, asyncio.CancelledError) or stopping() or not custody.owned) and not explicitly_stopped:
                    # Process shutdown preserves pending work and its external fences.
                    raise asyncio.CancelledError() from None
                code = error.code if isinstance(error, AppError) else "action_cancelled" if explicitly_stopped else "action_failed"
                if not explicitly_stopped and not isinstance(error, AppError):
                    frame = error.__traceback__
                    while frame is not None and frame.tb_next is not None:
                        frame = frame.tb_next
                    if frame is not None:
                        location = frame.tb_frame
                        logging.getLogger(__name__).error("Action failed action=%s error_type=%s at=%s.%s:%s",
                            action, type(error).__name__, location.f_globals.get("__name__", ""), location.f_code.co_name, frame.tb_lineno)
                with self.runtime.database.transaction() as connection:
                    self._finish(row, "cancelled" if explicitly_stopped else "failed", code, connection)
                # Never persist a provider's exception or input in workflow logs.
                raise RuntimeError(code) from None
        finally:
            custody.close()

    def _deliver_stop(self, run_id, workflow_id):
        if workflow_id != f"{self.identity['taskQueue']}-{run_id}":
            return
        try:
            handle = self.dbos.retrieve_workflow(workflow_id)
            before = handle.get_status()
            if before.status not in {"CANCELLED", "ERROR", "SUCCESS", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"}:
                self.dbos.cancel_workflow(workflow_id)
            confirmed = handle.get_status().status == "CANCELLED"
            if confirmed and before.name == SEARCH_WORKFLOW:
                self.dbos.send(workflow_id, True, topic=STOP_TOPIC, idempotency_key=run_id)
        except (dbos_error.DBOSException, SQLAlchemyError):
            # The local stop survives. Missing history is not delivery evidence.
            return
        if not confirmed:
            return
        with self.runtime.database.transaction() as connection:
            changed = connection.execute(
                "UPDATE app_action_runs SET cancellation_requested=?,updated_at=? "
                "WHERE run_id=? AND workflow_id=? AND cancellation_requested=?",
                (STOP_ACKNOWLEDGED, now(), run_id, workflow_id, STOP_REQUESTED),
            ).rowcount
            if changed:
                run = self.action_run(run_id, connection)
                self.runtime.events.append(connection, "ActionCancellationAcknowledged",
                                           {"runId": run_id, "action": run["action"]},
                                           feature=run["action"].split(".")[0], aggregate_id=run_id)

    def _request_stop(self, row, connection):
        if row["cancellation_requested"] or row["status"] in TERMINAL_STATUSES:
            return
        connection.execute("UPDATE app_action_runs SET cancellation_requested=?,updated_at=? WHERE run_id=?",
                           (STOP_REQUESTED, now(), row["run_id"]))
        self.runtime.events.append(connection, "ActionCancellationRequested",
                                   {"runId": row["run_id"], "action": row["action"]},
                                   feature=row["action"].split(".")[0], aggregate_id=row["run_id"])

    async def cancel(self, run_id: str) -> dict:
        def stop():
            with self.runtime.database.transaction() as connection:
                row = connection.execute("SELECT * FROM app_action_runs WHERE run_id=? FOR UPDATE", (run_id,)).fetchone()
                if row is None:
                    raise NotFoundError("The action run does not exist.")
                if row["status"] in TERMINAL_STATUSES and (row["status"] != "cancelled" or not row["cancellation_requested"]):
                    return self._run_payload(row)
                pending = self._pending_children(row, connection)
                if row["status"] in TERMINAL_STATUSES and not pending:
                    return self._run_payload(row)
                if (row["action"] not in self.actions
                        or self._input_digest(row["action"], json.loads(row["payload_json"])) != row["input_hash"]):
                    raise AppError("action_contract_changed", "Use the compatible action version to stop and settle this pending run.", 409)
                self._request_stop(row, connection)
                # The handoff owner guards admission using the parent's Stop in this
                # same writer transaction. No new child can appear after this snapshot.
                children = connection.execute(
                    "SELECT run_id,action,workflow_id,cancellation_requested,status FROM app_action_runs "
                    "WHERE run_id=ANY(?) ORDER BY run_id FOR UPDATE", (pending,),
                ).fetchall() if pending else []
                for child in children:
                    self._request_stop(child, connection)
            for target in [*children, row]:
                self._deliver_stop(target["run_id"], target["workflow_id"])
                self._reconcile(target)
            return self.action_run(run_id)
        return await asyncio.to_thread(stop)

    def _reconcile(self, row):
        run_id, workflow_id = row["run_id"], row["workflow_id"]
        if workflow_id != f"{self.identity['taskQueue']}-{run_id}":
            return  # Imported predecessor receipts are never dispatched or settled by DBOS.
        custody = ExecutionCustody(self.runtime.workspace, run_id)
        try:
            if not custody.try_acquire():
                return  # An in-flight feature still owns its external effect and result.
            try:
                state = self.dbos.retrieve_workflow(workflow_id).get_status().status
            except (dbos_error.DBOSException, SQLAlchemyError):
                return
            terminal = {
                "CANCELLED": ("cancelled", "action_cancelled"),
                "ERROR": ("failed", "workflow_failed"),
                "MAX_RECOVERY_ATTEMPTS_EXCEEDED": ("failed", "workflow_recovery_exhausted"),
            }.get(state)
            if terminal:
                with self.runtime.database.transaction() as connection:
                    self._finish(row, *terminal, connection)
            # DBOS success follows the committed canonical result. It cannot
            # reconstruct a missing feature receipt or authorize another effect.
        finally:
            custody.close()

    async def reconcile_runs(self, *, after: str = "") -> str:
        def reconcile():
            with self.runtime.database.connect() as connection:
                rows = connection.execute(
                    "SELECT run_id,action,workflow_id,cancellation_requested FROM app_action_runs "
                    "WHERE status IN ('queued','running','pending','start_failed') AND run_id>? ORDER BY run_id LIMIT 50", (after,),
                ).fetchall()
            for row in rows:
                if row["cancellation_requested"] == STOP_REQUESTED:
                    self._deliver_stop(row["run_id"], row["workflow_id"])
                self._reconcile(row)
            return rows[-1]["run_id"] if len(rows) == 50 else ""
        return await asyncio.to_thread(reconcile)

    def dbos_status(self) -> dict:
        try:
            with self.runtime.database.connect() as connection:
                available = connection.execute("SELECT to_regclass('dbos.workflow_status') IS NOT NULL").fetchone()[0]
        except (SQLAlchemyError, AppError):
            available = False
        return {"available": bool(available), "engine": "dbos", "systemSchema": DBOS_SCHEMA}

    def worker_status(self, action: str | None = None, *, connection=None) -> dict:
        if connection is None:
            with self.runtime.database.connect() as owned:
                return self.worker_status(action, connection=owned)
        queue = self.identity["taskQueue"]
        unavailable = {"status": "unavailable", "healthy": False, "pid": None, "workerId": None,
                       "heartbeatAt": None, "taskQueue": queue, "engine": "dbos",
                       "namespaceId": self.identity["databaseInstanceId"]}
        rows = connection.execute(
            "SELECT h.*,r.identity_json,r.actions_json FROM app_worker_heartbeats h "
            "JOIN app_worker_registrations r ON r.worker_id=h.worker_id "
            "WHERE h.status='running' AND h.task_queue=? ORDER BY h.heartbeat_at DESC", (queue,),
        ).fetchall()
        for row in rows:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(row["heartbeat_at"])).total_seconds()
            if age > 15 or age < -5:
                continue
            registration = json.loads(row["identity_json"])
            birth = registration.pop("processBirth", None)
            process = read_process_identity(row["pid"])
            if process.get("state") != "alive" or (birth and process.get("identity") != birth):
                continue
            if not birth or registration != self.identity:
                return {**unavailable, "reason": "worker_incompatible",
                        "message": "Restart JobCtrl so the API and worker use the same workspace and build."}
            if action is not None and action not in json.loads(row["actions_json"]):
                return {**unavailable, "reason": "worker_action_unavailable",
                        "message": "Restart the worker with the requested feature enabled."}
            return {**unavailable, "status": "healthy", "healthy": True, "pid": row["pid"], "workerId": row["worker_id"],
                    "heartbeatAt": row["heartbeat_at"], "build": self.identity["build"]}
        return {**unavailable, "reason": "worker_unavailable", "message": "Start the JobCtrl worker and retry."}

    async def require_write_identity(self):
        status = await asyncio.to_thread(self.worker_status)
        if status.get("reason") == "worker_incompatible":
            raise AppError(status["reason"], status["message"], 409)

    def _readiness(self, action=None):
        worker = self.worker_status(action)
        if not worker["healthy"]:
            return worker
        try:
            # Confirm each queue and the executor version against the same system
            # database that the transactional enqueue will use.
            queues = {queue.name for queue in self.dbos.list_queues(application_name=DBOS_APPLICATION)}
            expected = {self.identity[name] for name in WORKER_QUEUES}
            latest = self.dbos.get_latest_application_version()
            if expected.issubset(queues) and latest["version_name"] == self.identity["workflowVersion"]:
                return worker
        except (dbos_error.DBOSException, SQLAlchemyError):
            pass
        return {**worker, "healthy": False, "status": "unavailable", "reason": "workflow_service_unavailable",
                "message": "The DBOS queues are unavailable. Start the workspace worker and retry."}

    async def dispatch_readiness(self, action: str | None = None) -> dict:
        return await asyncio.to_thread(self._readiness, action)
