"""Durable dispatch to the same explicit Python application actions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from collections.abc import Collection
from datetime import datetime, timedelta, timezone
from pathlib import Path

from temporalio.api.common.v1 import WorkflowExecution
from temporalio.api.enums.v1 import TaskQueueType
from temporalio.api.taskqueue.v1 import TaskQueue
from temporalio.api.workflowservice.v1 import DescribeNamespaceRequest, DescribeTaskQueueRequest, RequestCancelWorkflowExecutionRequest
from temporalio.client import Client, WorkflowExecutionStatus
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from jobctrl.app.contracts import ActionContext, Feature, Runtime
from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.app.events import now
from jobctrl.app.execution import ExecutionCustody
from jobctrl.app.worker_identity import SCHEMA as WORKER_IDENTITY_SCHEMA, process_identity


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}
# Existing true values record a request with no separate delivery evidence.
STOP_REQUESTED = 1
STOP_ACKNOWLEDGED = 2


def encode(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def task_queue(workspace: Path) -> str:
    return os.environ.get("JOBCTRL_TEMPORAL_TASK_QUEUE") or "jobctrl-python-" + hashlib.sha256(str(workspace).encode()).hexdigest()[:16]


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
        self.identity = process_identity(runtime, task_queue(runtime.workspace))
        self._temporal = None
        self._temporal_lock = asyncio.Lock()

    def _finalize_feature(self, action, run_id, status, error_code, connection):
        finalizer = self.action_finalizers.get(action)
        if finalizer is not None:
            finalizer(run_id, status, error_code, connection)

    async def temporal(self):
        if self._temporal is None:
            async with self._temporal_lock:
                if self._temporal is None:
                    self._temporal = await Client.connect(
                        self.identity["address"], namespace=self.identity["namespace"],
                    )
        return self._temporal

    def _require_action(self, action: str, payload: dict) -> str:
        if action not in self.actions:
            raise NotFoundError("The application action is not registered.")
        if not isinstance(payload, dict):
            raise AppError("invalid_action_payload", "Action input must be a JSON object.")
        encoded = encode(payload)
        if len(encoded.encode()) > 1024 * 1024:
            raise AppError("action_payload_too_large", "The action input exceeds its limit.", 413)
        return encoded

    def _create_run(self, action: str, payload: dict, *, idempotency_key: str | None = None,
                    request_id: str | None = None, run_id: str | None = None, workflow_id: str | None = None,
                    existing_only: bool = False):
        encoded = self._require_action(action, payload)
        identity = {"action": action, "payload": payload}
        version = self.action_versions.get(action)
        if version is not None:
            identity["contract_version"] = version
        digest = hashlib.sha256(encode(identity).encode()).hexdigest()
        if idempotency_key is not None and (not idempotency_key.strip() or len(idempotency_key) > 200):
            raise AppError("invalid_idempotency_key", "Use a nonempty idempotency key of at most 200 characters.")
        run_id = run_id or str(uuid.uuid4())
        workflow_id = workflow_id or f"{self.identity['taskQueue']}-{run_id}"
        access = self.runtime.database.connect if existing_only else self.runtime.database.transaction
        with access() as connection:
            existing = connection.execute(
                "SELECT * FROM app_action_runs WHERE run_id=? OR (? IS NOT NULL AND idempotency_key=?)",
                (run_id, idempotency_key, idempotency_key),
            ).fetchone()
            if existing:
                if existing["input_hash"] != digest or existing["action"] != action:
                    if version is not None and existing["action"] == action and existing["payload_json"] == encoded:
                        raise AppError("action_contract_changed", "This action belongs to an earlier processing contract. Start a new action; the earlier result remains in history.", 409)
                    raise ConflictError("This action identity already belongs to different input.")
                return self._run_payload(existing)
            if existing_only:
                return None
            scope = self.action_scopes.get(action)
            if scope is not None:
                requested_scope = scope(payload)
                active = connection.execute(
                    "SELECT run_id,payload_json FROM app_action_runs WHERE action=? "
                    "AND status IN ('pending','start_failed','queued','running')",
                    (action,),
                ).fetchall()
                for candidate in active:
                    if scope(json.loads(candidate["payload_json"])) == requested_scope:
                        raise AppError(
                            "action_scope_busy", "An action for this scope is already pending or running.", 409,
                            {"runId": candidate["run_id"], "action": action},
                        )
            created = now()
            connection.execute(
                "INSERT INTO app_action_runs(run_id,action,request_id,idempotency_key,input_hash,payload_json,status,workflow_id,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (run_id, action, request_id or uuid.uuid4().hex, idempotency_key, digest, encoded, "pending", workflow_id, created, created),
            )
            admission = self.action_admissions.get(action)
            if admission is not None:
                admission(run_id, payload, connection)
        return self.action_run(run_id)

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
            "AND json_extract(payload_json,'$.jobId')=? "
            "AND (json_extract(payload_json,'$.payloadId') IS NULL OR json_extract(payload_json,'$.payloadId')=?) "
            "ORDER BY (status IN ('pending','queued','running')) DESC, created_at DESC, run_id DESC LIMIT 1",
            (*action_names, job_id, payload_id),
        ).fetchone()
        return row["run_id"] if row else None

    def run_page(self, *, before: str | None = None, limit: int = 100, status: str | None = None,
                 action: str | None = None, since: str | None = None, until: str | None = None) -> dict:
        conditions = ["(? IS NULL OR status=?)", "(? IS NULL OR action=?)",
                      "(? IS NULL OR created_at>=?)", "(? IS NULL OR created_at<=?)"]
        parameters = [status, status, action, action, since, since, until, until]
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

    async def reconcile_runs(self, *, after: str = "") -> str:
        """Recover terminal transport receipts when no activity can settle them.

        An interrupted activity may never run again after workflow cancellation
        or exhausted retries. Only an exact Temporal terminal result closes its
        local receipt; feature acceptance and provider accounting stay owned by
        their original transactions.
        """
        with self.runtime.database.connect() as connection:
            rows = connection.execute(
                "SELECT run_id,action,workflow_id,temporal_run_id FROM app_action_runs "
                "WHERE status IN ('pending','queued','running','start_failed') AND run_id>? "
                "ORDER BY run_id LIMIT 50", (after,),
            ).fetchall()
        if not rows:
            return ""
        client = await self.temporal()
        capacity = asyncio.Semaphore(5)

        async def settle(row):
            async with capacity:
                custody = ExecutionCustody(self.runtime.workspace, row["run_id"])
                try:
                    if not custody.try_acquire():
                        return
                    handle = client.get_workflow_handle(row["workflow_id"], run_id=row["temporal_run_id"])
                    description = await handle.describe(rpc_timeout=timedelta(seconds=2))
                    terminal = {
                        WorkflowExecutionStatus.COMPLETED: ("succeeded", None),
                        WorkflowExecutionStatus.CANCELED: ("cancelled", "action_cancelled"),
                        WorkflowExecutionStatus.FAILED: ("failed", "workflow_failed"),
                        WorkflowExecutionStatus.TIMED_OUT: ("failed", "workflow_timed_out"),
                        WorkflowExecutionStatus.TERMINATED: ("failed", "workflow_terminated"),
                    }.get(description.status)
                    if terminal is None:
                        return
                    result = encode(await handle.result(follow_runs=False, rpc_timeout=timedelta(seconds=2))) if terminal[0] == "succeeded" else None
                    with self.runtime.database.transaction() as connection:
                        changed = connection.execute(
                            "UPDATE app_action_runs SET status=?,error_code=?,result_json=?,updated_at=?,"
                            "temporal_run_id=COALESCE(temporal_run_id,?) WHERE run_id=? "
                            "AND status IN ('pending','queued','running','start_failed')",
                            (*terminal, result, now(), description.run_id, row["run_id"]),
                        ).rowcount
                        if changed:
                            self._finalize_feature(row["action"], row["run_id"], *terminal, connection)
                            self.runtime.events.append(
                                connection, "ActionCompleted" if terminal[0] == "succeeded" else "ActionFailed",
                                {"runId": row["run_id"], "action": row["action"], "code": terminal[1], "source": "workflow_recovery"},
                                feature=row["action"].split(".")[0],
                                level="info" if terminal[0] == "succeeded" else "warn" if terminal[0] == "cancelled" else "error",
                            )
                except Exception:
                    # Missing or unreachable history is not a terminal outcome.
                    return
                finally:
                    custody.close()

        await asyncio.gather(*(settle(row) for row in rows))
        return rows[-1]["run_id"] if len(rows) == 50 else ""

    async def submit(self, action: str, payload: dict, *, idempotency_key: str | None = None, request_id: str | None = None) -> dict:
        self._require_action(action, payload)
        if idempotency_key is not None:
            saved = self._create_run(action, payload, idempotency_key=idempotency_key, existing_only=True)
            if saved and saved["status"] not in {"pending", "start_failed"}:
                return {key: saved[key] for key in ("runId", "workflowId", "status")}
        readiness = await self.dispatch_readiness(action)
        if not readiness["healthy"]:
            raise AppError(readiness["reason"], readiness["message"], 503)
        idempotency_key = idempotency_key or uuid.uuid4().hex
        run = self._create_run(action, payload, idempotency_key=idempotency_key, request_id=request_id)
        if run["status"] not in {"pending", "start_failed"}:
            return {key: run[key] for key in ("runId", "workflowId", "status")}
        if run["cancellationRequested"]:
            raise AppError("action_stop_requested", "A Stop is already recorded for this run. Check it in Runs.", 409,
                           {"runId": run["runId"]})
        try:
            client = await self.temporal()
            handle = await client.start_workflow(
                "JobCtrlAction", {"run_id": run["runId"], "action": action, "payload": payload,
                                 "request_id": request_id or run["runId"]},
                id=run["workflowId"], task_queue=self.identity["taskQueue"],
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                rpc_timeout=timedelta(seconds=5),
            )
            temporal_run_id = handle.first_execution_run_id
        except WorkflowAlreadyStartedError as error:
            temporal_run_id = error.run_id
        except Exception:
            with self.runtime.database.transaction() as connection:
                connection.execute("UPDATE app_action_runs SET status='start_failed',error_code='workflow_start_failed',updated_at=? WHERE run_id=? AND status='pending'", (now(), run["runId"]))
            raise AppError("workflow_start_failed", "The durable action was not confirmed as queued; retry with the same idempotency key.", 503,
                           {"runId": run["runId"], "idempotencyKey": idempotency_key}) from None
        with self.runtime.database.transaction() as connection:
            queued = connection.execute(
                "UPDATE app_action_runs SET status='queued',temporal_run_id=COALESCE(temporal_run_id,?),"
                "error_code=NULL,updated_at=? WHERE run_id=? AND status IN ('pending','start_failed')",
                (temporal_run_id, now(), run["runId"]),
            )
            if queued.rowcount:
                self.runtime.events.append(connection, "ActionQueued", {"runId": run["runId"], "action": action}, feature=action.split(".")[0])
            receipt = self.action_run(run["runId"], connection)
        return {key: receipt[key] for key in ("runId", "workflowId", "status")}

    async def execute(self, action: str, payload: dict, *, run_id: str | None = None, request_id: str | None = None,
                      context: ActionContext | None = None, workflow_id: str | None = None,
                      temporal_run_id: str | None = None):
        run = self._create_run(action, payload, run_id=run_id, request_id=request_id, workflow_id=workflow_id)
        run_id = run["runId"]
        source = context or ActionContext(run_id, request_id or run_id,
                                         cancelled=lambda: self.action_run(run_id)["cancellationRequested"])
        custody = ExecutionCustody(self.runtime.workspace, run_id)
        try:
            await custody.acquire(source.cancelled)
            owned = ActionContext(run_id, source.request_id,
                                  lambda: source.cancelled() or not custody.owned, source.heartbeat)
            return await self._execute_owned(action, payload, run_id=run_id, request_id=request_id,
                                             context=owned, workflow_id=workflow_id, temporal_run_id=temporal_run_id)
        finally:
            custody.close()

    async def _execute_owned(self, action: str, payload: dict, *, run_id: str, request_id: str | None,
                             context: ActionContext, workflow_id: str | None, temporal_run_id: str | None):
        run = self._create_run(action, payload, run_id=run_id, request_id=request_id, workflow_id=workflow_id)
        run_id = run["runId"]
        if run["status"] == "succeeded":
            return run["result"]
        if run["status"] in {"failed", "cancelled"}:
            raise AppError(run["errorCode"] or "action_terminal", "This action already reached a terminal outcome.", 409)
        with self.runtime.database.transaction() as connection:
            current = connection.execute("SELECT cancellation_requested,status FROM app_action_runs WHERE run_id=?", (run_id,)).fetchone()
            refused = bool(current[0]) or current[1] == "cancelled"
            if refused and current["status"] != "cancelled":
                self._cancel_before_execution(action, run_id, temporal_run_id, connection)
            elif not refused:
                connection.execute("UPDATE app_action_runs SET status='running',temporal_run_id=COALESCE(?,temporal_run_id),updated_at=? WHERE run_id=?", (temporal_run_id, now(), run_id))
                self.runtime.events.append(connection, "ActionStarted", {"runId": run_id, "action": action}, feature=action.split(".")[0])
        if refused:
            raise AppError("action_cancelled", "The action was cancelled before execution.", 409)
        try:
            result = await self.actions[action](context, payload)
            encoded = encode(result)
        except BaseException as error:
            cancelled = isinstance(error, asyncio.CancelledError) or context.cancelled()
            # Worker shutdown leaves a running action recoverable by Temporal.
            # Explicit user cancellation becomes terminal and is never replayed.
            if cancelled and not self.action_run(run_id)["cancellationRequested"]:
                # A feature may surface its cancellation guard as AppError.
                # Transport interruption still must not become a user-cancelled
                # terminal receipt that would prevent the waiting retry.
                raise asyncio.CancelledError from None
            code = error.code if isinstance(error, AppError) else "action_cancelled" if cancelled else "action_failed"
            with self.runtime.database.transaction() as connection:
                connection.execute("UPDATE app_action_runs SET status=?,error_code=?,updated_at=? WHERE run_id=? AND status='running'", ("cancelled" if cancelled else "failed", code, now(), run_id))
                self._finalize_feature(action, run_id, "cancelled" if cancelled else "failed", code, connection)
                self.runtime.events.append(connection, "ActionFailed", {"runId": run_id, "action": action, "code": code},
                                           feature=action.split(".")[0], level="warn" if cancelled else "error")
            raise
        with self.runtime.database.transaction() as connection:
            connection.execute("UPDATE app_action_runs SET status='succeeded',result_json=?,error_code=NULL,updated_at=? WHERE run_id=? AND status='running'", (encoded, now(), run_id))
            self._finalize_feature(action, run_id, "succeeded", None, connection)
            self.runtime.events.append(connection, "ActionCompleted", {"runId": run_id, "action": action}, feature=action.split(".")[0])
        return result

    async def cancel(self, run_id: str) -> dict:
        with self.runtime.database.transaction() as connection:
            run = self.action_run(run_id, connection)
            if run["status"] in TERMINAL_STATUSES or run.get("cancellationDelivery") == "acknowledged":
                return run
            action = run["action"]
            event = {"runId": run_id, "action": action}
            feature = action.split(".")[0]
            if not run["cancellationRequested"]:
                connection.execute("UPDATE app_action_runs SET cancellation_requested=?,updated_at=? WHERE run_id=?",
                                   (STOP_REQUESTED, now(), run_id))
                self.runtime.events.append(connection, "ActionCancellationRequested", event, feature=feature, aggregate_id=run_id)
        try:
            async with asyncio.timeout(2):
                client = await self.temporal()
                await client.workflow_service.request_cancel_workflow_execution(
                    RequestCancelWorkflowExecutionRequest(
                        namespace=client.namespace, identity=client.identity, request_id=run_id,
                        workflow_execution=WorkflowExecution(
                            workflow_id=run["workflowId"], run_id=run["temporalRunId"] or "",
                        ),
                    ),
                    retry=True,
                )
        except RPCError as error:
            if error.status == RPCStatusCode.NOT_FOUND:
                with self.runtime.database.transaction() as connection:
                    current = self.action_run(run_id, connection)
                    # Withdraw an unconfirmed start after Temporal reports it absent.
                    # The recorded Stop prevents even a late start from executing.
                    if current["status"] in {"pending", "start_failed"} and current.get("cancellationDelivery") == "pending" and not current["temporalRunId"]:
                        self._cancel_before_execution(action, run_id, None, connection)
                    return self.action_run(run_id, connection)
            return self.action_run(run_id)
        except (TimeoutError, OSError, RuntimeError):
            return self.action_run(run_id)
        with self.runtime.database.transaction() as connection:
            changed = connection.execute(
                "UPDATE app_action_runs SET cancellation_requested=?,updated_at=? WHERE run_id=? AND cancellation_requested=?",
                (STOP_ACKNOWLEDGED, now(), run_id, STOP_REQUESTED),
            ).rowcount
            if changed:
                self.runtime.events.append(connection, "ActionCancellationAcknowledged", event, feature=feature, aggregate_id=run_id)
            return self.action_run(run_id, connection)

    def _cancel_before_execution(self, action, run_id, temporal_run_id, connection):
        connection.execute("UPDATE app_action_runs SET status='cancelled',error_code='action_cancelled',updated_at=?,"
                           "temporal_run_id=COALESCE(temporal_run_id,?) WHERE run_id=?", (now(), temporal_run_id, run_id))
        self._finalize_feature(action, run_id, "cancelled", "action_cancelled", connection)
        self.runtime.events.append(connection, "ActionFailed", {"runId": run_id, "action": action, "code": "action_cancelled"},
                                   feature=action.split(".")[0], level="warn")

    def worker_status(self, action: str | None = None) -> dict:
        queue = self.identity["taskQueue"]
        unavailable = {"status": "unavailable", "healthy": False, "pid": None, "workerId": None,
                       "heartbeatAt": None, "taskQueue": queue}
        with self.runtime.database.connect() as connection:
            binding = connection.execute("SELECT history,namespace,namespace_id FROM app_workflow_history WHERE singleton=1").fetchone()
            unavailable["namespaceId"] = binding["namespace_id"] if binding else None
            if binding and (binding["history"], binding["namespace"]) != (self.identity["history"], self.identity["namespace"]):
                return {**unavailable, "reason": "workflow_history_mismatch",
                        "message": "Restart JobCtrl with this workspace’s original workflow service."}
            rows = connection.execute(
                """SELECT h.*,r.identity_json,r.actions_json FROM app_worker_heartbeats h
                   LEFT JOIN app_worker_registrations r ON r.worker_id=h.worker_id
                   WHERE h.status='running' ORDER BY h.heartbeat_at DESC""",
            ).fetchall()
        ready = None
        for row in rows:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(row["heartbeat_at"])).total_seconds()
            if age > 15 or age < -5:
                continue
            try:
                os.kill(row["pid"], 0)
            except (ProcessLookupError, PermissionError):
                continue
            if not row["identity_json"] or json.loads(row["identity_json"]) != self.identity:
                return {**unavailable, "reason": "worker_incompatible",
                        "message": "Stop and restart JobCtrl so the API and worker use the same workspace and build."}
            if action is not None and action not in json.loads(row["actions_json"]):
                return {**unavailable, "reason": "worker_action_unavailable",
                        "message": "Restart the worker with the requested feature enabled, then retry."}
            if ready is None:
                ready = {"status": "healthy", "healthy": True, "pid": row["pid"], "workerId": row["worker_id"],
                         "heartbeatAt": row["heartbeat_at"], "taskQueue": queue, "build": self.identity["build"],
                         "namespaceId": binding["namespace_id"] if binding else None}
        return ready or {**unavailable, "reason": "worker_unavailable", "message": "Start the JobCtrl worker and retry."}

    async def require_write_identity(self):
        status = self.worker_status()
        if status.get("reason") in {"workflow_history_mismatch", "worker_incompatible"}:
            raise AppError(status["reason"], status["message"], 409)
        if not status.get("namespaceId"):
            return
        try:
            async with asyncio.timeout(2):
                client = await self.temporal()
                namespace = await client.workflow_service.describe_namespace(DescribeNamespaceRequest(namespace=client.namespace))
                if namespace.namespace_info.id == status["namespaceId"]:
                    return
        except RPCError as error:
            if error.status != RPCStatusCode.NOT_FOUND:
                return  # Local edits remain available when the workflow service is offline.
        except (TimeoutError, OSError, RuntimeError):
            return
        raise AppError("workflow_history_mismatch", "Restart JobCtrl with this workspace’s original workflow service.", 409)

    async def dispatch_readiness(self, action: str | None = None) -> dict:
        worker = self.worker_status(action)
        if not worker["healthy"]:
            return worker
        unavailable = {**worker, "healthy": False, "status": "unavailable"}
        try:
            async with asyncio.timeout(2):
                client = await self.temporal()
                service = client.workflow_service
                namespace, workflows, activities = await asyncio.gather(
                    service.describe_namespace(DescribeNamespaceRequest(namespace=client.namespace)),
                    *(service.describe_task_queue(DescribeTaskQueueRequest(
                        namespace=client.namespace, task_queue=TaskQueue(name=worker["taskQueue"]), task_queue_type=kind,
                    )) for kind in (TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW, TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY)),
                )
        except Exception:
            return {**unavailable, "reason": "workflow_service_unavailable",
                    "message": "The workflow service is unavailable. Start it, then retry."}
        if namespace.namespace_info.id != worker["namespaceId"]:
            return {**unavailable, "reason": "workflow_history_mismatch",
                    "message": "Restart JobCtrl with this workspace’s original workflow service."}
        # A healthy idle worker can spend a minute in a single long poll.
        recent = datetime.now(timezone.utc).timestamp() - 120
        if not all(any(p.identity == worker["workerId"] and p.last_access_time.seconds >= recent for p in queue.pollers)
                   for queue in (workflows, activities)):
            return {**unavailable, "reason": "worker_not_polling",
                    "message": "The worker is connecting to its queue. Retry once it is ready."}
        return worker
