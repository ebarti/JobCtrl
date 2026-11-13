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

from temporalio.client import Client, WorkflowExecutionStatus
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError

from jobctrl.app.contracts import ActionContext, Feature, Runtime
from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.app.events import now
from jobctrl.app.execution import ExecutionCustody


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
                        os.environ.get("JOBCTRL_TEMPORAL_ADDRESS", "127.0.0.1:7233"),
                        namespace=os.environ.get("JOBCTRL_TEMPORAL_NAMESPACE", "default"),
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
                    request_id: str | None = None, run_id: str | None = None, workflow_id: str | None = None):
        encoded = self._require_action(action, payload)
        identity = {"action": action, "payload": payload}
        version = self.action_versions.get(action)
        if version is not None:
            identity["contract_version"] = version
        digest = hashlib.sha256(encode(identity).encode()).hexdigest()
        if idempotency_key is not None and (not idempotency_key.strip() or len(idempotency_key) > 200):
            raise AppError("invalid_idempotency_key", "Use a nonempty idempotency key of at most 200 characters.")
        run_id = run_id or str(uuid.uuid4())
        workflow_id = workflow_id or f"{task_queue(self.runtime.workspace)}-{run_id}"
        with self.runtime.database.transaction() as connection:
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
        return self.action_run(run_id)

    @staticmethod
    def _run_payload(row) -> dict:
        return {
            "runId": row["run_id"], "action": row["action"], "status": row["status"],
            "workflowId": row["workflow_id"], "temporalRunId": row["temporal_run_id"],
            "result": json.loads(row["result_json"]) if row["result_json"] else None,
            "errorCode": row["error_code"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "cancellationRequested": bool(row["cancellation_requested"]),
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
            cancellations = connection.execute("SELECT COUNT(*) FROM app_action_runs WHERE cancellation_requested=1 AND status NOT IN ('succeeded','failed','cancelled')").fetchone()[0]
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
        if not self.worker_status()["healthy"]:
            raise AppError("worker_unavailable", "The durable worker is not ready.", 503)
        run = self._create_run(action, payload, idempotency_key=idempotency_key, request_id=request_id)
        if run["status"] not in {"pending", "start_failed"}:
            return {key: run[key] for key in ("runId", "workflowId", "status")}
        try:
            client = await self.temporal()
            handle = await client.start_workflow(
                "JobCtrlAction", {"run_id": run["runId"], "action": action, "payload": payload,
                                 "request_id": request_id or run["runId"]},
                id=run["workflowId"], task_queue=task_queue(self.runtime.workspace),
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            )
            temporal_run_id = handle.first_execution_run_id
        except WorkflowAlreadyStartedError as error:
            temporal_run_id = error.run_id
        except Exception:
            with self.runtime.database.transaction() as connection:
                connection.execute("UPDATE app_action_runs SET status='start_failed',error_code='workflow_start_failed',updated_at=? WHERE run_id=? AND status='pending'", (now(), run["runId"]))
            raise AppError("workflow_start_failed", "The durable action was not confirmed as queued; retry with the same idempotency key.", 503,
                           {"runId": run["runId"]}) from None
        with self.runtime.database.transaction() as connection:
            connection.execute(
                "UPDATE app_action_runs SET status=CASE WHEN status IN ('pending','start_failed') THEN 'queued' ELSE status END,"
                "temporal_run_id=COALESCE(temporal_run_id,?),error_code=NULL,updated_at=? WHERE run_id=?",
                (temporal_run_id, now(), run["runId"]),
            )
            self.runtime.events.append(connection, "ActionQueued", {"runId": run["runId"], "action": action}, feature=action.split(".")[0])
        return {"runId": run["runId"], "workflowId": run["workflowId"], "status": "queued"}

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
            if refused:
                connection.execute("UPDATE app_action_runs SET status='cancelled',error_code='action_cancelled',updated_at=? WHERE run_id=?", (now(), run_id))
                self._finalize_feature(action, run_id, "cancelled", "action_cancelled", connection)
            else:
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
        run = self.action_run(run_id)
        if run["status"] in {"succeeded", "failed", "cancelled"}:
            return run
        with self.runtime.database.transaction() as connection:
            changed = connection.execute(
                "UPDATE app_action_runs SET cancellation_requested=1,updated_at=?,"
                "status=CASE WHEN status IN ('pending','start_failed','queued') THEN 'cancelled' ELSE status END "
                "WHERE run_id=? AND status NOT IN ('succeeded','failed','cancelled')", (now(), run_id),
            ).rowcount
            if not changed:
                return self.action_run(run_id, connection)
            self._finalize_feature(run["action"], run_id, "cancelled", "action_cancelled", connection)
            self.runtime.events.append(connection, "ActionCancellationRequested", {"runId": run_id}, feature=run["action"].split(".")[0])
        try:
            client = await self.temporal()
            await client.get_workflow_handle(run["workflowId"]).cancel()
        except Exception:
            raise AppError("cancellation_pending", "Cancellation is recorded locally; the worker will observe it on recovery.", 503,
                           {"runId": run_id}) from None
        return self.action_run(run_id)

    def worker_status(self) -> dict:
        queue = task_queue(self.runtime.workspace)
        with self.runtime.database.connect() as connection:
            rows = connection.execute("SELECT * FROM app_worker_heartbeats WHERE task_queue=? AND status='running' ORDER BY heartbeat_at DESC", (queue,)).fetchall()
        for row in rows:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(row["heartbeat_at"].replace("Z", "+00:00"))).total_seconds()
            if age > 15 or age < -5:
                continue
            try:
                os.kill(row["pid"], 0)
            except (ProcessLookupError, PermissionError):
                continue
            return {"status": "healthy", "healthy": True, "pid": row["pid"], "workerId": row["worker_id"],
                    "heartbeatAt": row["heartbeat_at"], "taskQueue": queue}
        return {"status": "unavailable", "healthy": False, "pid": None, "workerId": None, "heartbeatAt": None, "taskQueue": queue}
