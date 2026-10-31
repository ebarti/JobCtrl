"""Temporal orchestration for importing one queued manual capture."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from temporalio import activity, workflow
from temporalio.workflow import ActivityCancellationType
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

with workflow.unsafe.imports_passed_through():
    from jobctrl.infrastructure.temporal.finalize import (
        emit_workflow_outcome,
        emit_workflow_started,
    )


@dataclass(frozen=True)
class ManualCaptureImportWorkflowInput:
    tenant_id: str
    item_id: str
    capture_mode: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
    content_text: str | None = None
    content_html_base64: str | None = None
    captured_url: str | None = None
    note: str | None = None
    future_manual_action_required: bool = False
    capture_generation: str | None = None


@dataclass(frozen=True)
class ManualCaptureImportActivityOutput:
    status: str
    item_id: str
    job_id: str
    imported_at: str
    retry_context: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ManualCaptureImportWorkflowResult:
    status: str
    item_id: str | None = None
    job_id: str | None = None
    imported_at: str | None = None
    retry_context: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    error_code: str | None = None


_MANUAL_CAPTURE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=2),
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=2,
    non_retryable_error_types=[
        "invalid_capture_input",
        "not_found",
        "capture_replay_mismatch",
        "manual_capture_extraction_failed",
        "manual_capture_state_changed",
        "RuntimeIdentityMismatch",
    ],
)
_DEFAULT_TIMEOUT = timedelta(minutes=10)


@activity.defn(name="manual_capture_import")
async def manual_capture_import_activity(
    payload: ManualCaptureImportWorkflowInput,
) -> ManualCaptureImportActivityOutput:
    """Run the canonical importer and recover exactly from post-commit retries."""
    from jobctrl.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobctrl.infrastructure.temporal.runtime_guard import assert_activity_runtime

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )
    cancel_event = threading.Event()
    cancel_lock = threading.Lock()
    info = activity.info()
    if not info.workflow_run_id:
        raise ApplicationError("Manual capture attempt identity is unavailable", type="manual_capture_state_changed", non_retryable=True)
    scheduled = info.current_attempt_scheduled_time.astimezone(timezone.utc)
    attempt_authority = {
        "scheduled_us": (scheduled - datetime(1970, 1, 1, tzinfo=timezone.utc)) // timedelta(microseconds=1),
        "run_id": info.workflow_run_id,
        "activity_id": info.activity_id,
        "attempt": info.attempt,
    }

    def cancel() -> None:
        with cancel_lock:
            cancel_event.set()

    try:
        return await run_blocking_with_heartbeat(
            lambda: execute_manual_capture_import(
                payload, cancel_event=cancel_event, cancel_lock=cancel_lock, attempt_authority=attempt_authority,
            ),
            starting_message="manual-capture import starting",
            progress_message="manual-capture import still running",
            activity_name="manual_capture_import",
            on_cancel=cancel,
            poll_interval=1.0,
        )
    except sqlite3.Error:
        raise ApplicationError("Manual capture could not be saved.", type="manual_capture_database_error") from None


def execute_manual_capture_import(
    payload: ManualCaptureImportWorkflowInput,
    *,
    conn: sqlite3.Connection | None = None,
    cancel_event: threading.Event | None = None,
    cancel_lock: threading.Lock | None = None,
    attempt_authority: dict[str, Any] | None = None,
) -> ManualCaptureImportActivityOutput:
    """Import or reconstruct one stable manual-capture result.

    A Temporal activity may lose its completion after SQLite commits. On the
    retry, only the same tenant/item identity with identical canonical content
    and capture metadata may reuse the imported row. The returned values all
    come from persisted columns, so the first result and retry result are equal.
    """
    from jobctrl.database import get_connection
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.domain.tenant import TenantId
    from jobctrl.infrastructure.discovery.production_wiring import (
        ManualCaptureImport,
        ManualCaptureExtractionFailure,
        ManualCaptureStateChanged,
        import_manual_capture_item,
        manual_capture_content,
        reopen_unverified_manual_capture,
    )

    connection = conn or get_connection()
    capture = ManualCaptureImport(
        item_id=payload.item_id,
        capture_mode=payload.capture_mode,
        content_text=payload.content_text,
        content_html_base64=payload.content_html_base64,
        captured_url=payload.captured_url,
        note=payload.note,
        future_manual_action_required=payload.future_manual_action_required,
    )
    try:
        content = manual_capture_content(capture)
    except (UnicodeError, ValueError) as exc:
        raise _non_retryable(
            "Manual capture content could not be decoded",
            error_type="invalid_capture_input",
        ) from exc
    row = _capture_row(connection, payload.tenant_id, payload.item_id)
    if row is None:
        raise _non_retryable(
            "Manual capture item was not found.",
            error_type="not_found",
        )

    # Only an explicit submission containing actual page bytes can reopen an
    # unverified historical receipt. A URL alone cannot recover content.
    generation = payload.capture_generation
    if str(row["status"]) == "imported" and (payload.content_text or payload.content_html_base64):
        reopened = reopen_unverified_manual_capture(
            connection, TenantId(payload.tenant_id), payload.item_id, expected_generation=generation,
            attempt_authority=attempt_authority,
        )
        if reopened:
            generation = reopened
            row = _capture_row(connection, payload.tenant_id, payload.item_id)
    if str(row["status"]) == "pending" and attempt_authority is not None:
        context = _retry_context(row["retry_context_json"])
        reopened = context.get("manual_capture_reopen_authority")
        if (isinstance(reopened, dict) and reopened.get("run_id") == attempt_authority.get("run_id")
            and reopened.get("previous_generation") == generation
            and reopened.get("generation") == context.get("manual_capture_generation")):
            generation = reopened["generation"]

    if str(row["status"]) == "pending":
        try:
            import_manual_capture_item(
                connection,
                capture,
                tenant_id=TenantId(payload.tenant_id),
                cancel_event=cancel_event,
                cancel_lock=cancel_lock,
                expected_queue_state=(row["originating_url"], row["source_id"], row["retry_context_json"]),
                attempt_authority=attempt_authority,
                expected_generation=generation,
            )
        except ManualCaptureExtractionFailure as exc:
            raise _non_retryable(
                "The captured page could not be extracted. Review the retained capture and try again.",
                error_type="manual_capture_extraction_failed",
            ) from exc
        except ManualCaptureStateChanged as exc:
            raise _non_retryable(
                "The capture or its Job changed while importing. Review the retained capture and try again.",
                error_type="manual_capture_state_changed",
            ) from exc
        except DeterminationFailure as exc:
            raise ApplicationError(
                "The captured page could not be interpreted. Review the retained capture and try again.",
                type=f"semantic_determination_{exc.code}", non_retryable=not exc.retryable,
            ) from None
        except ValueError:
            # A concurrent attempt may have committed after our read. Only an
            # imported row that passes the full replay check can recover it.
            row = _capture_row(connection, payload.tenant_id, payload.item_id)
            if row is None or str(row["status"]) != "imported":
                raise
    elif str(row["status"]) != "imported":
        raise _non_retryable(
            f"Manual capture item is {row['status']!r}, not pending.",
            error_type="not_found",
        )

    imported = _capture_row(connection, payload.tenant_id, payload.item_id)
    if imported is None or str(imported["status"]) != "imported":
        raise RuntimeError("Manual capture importer returned without an imported queue row")
    return _validated_imported_result(payload, capture, imported, content, connection)


def _capture_row(
    conn: sqlite3.Connection,
    tenant_id: str,
    item_id: str,
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT tenant_id, item_id, originating_url, source_id, status,
               imported_at, capture_mode, captured_url, content_sha256,
               content_length, note, future_manual_action_required,
               retry_context_json, job_id
        FROM manual_capture_queue
        WHERE tenant_id = ? AND item_id = ?
        LIMIT 1
        """,
        (tenant_id, item_id),
    ).fetchone()


def _validated_imported_result(
    payload: ManualCaptureImportWorkflowInput,
    capture: Any,
    row: sqlite3.Row,
    content: str,
    conn: sqlite3.Connection,
) -> ManualCaptureImportActivityOutput:
    from jobctrl.domain.identifiers import canonical_job_id

    imported_at = _non_empty(row["imported_at"])
    originating_url = _non_empty(row["originating_url"])
    expected_url = payload.captured_url or originating_url
    expected_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    retry_context = _retry_context(row["retry_context_json"])
    provenance = retry_context.get("manual_capture_provenance")
    expected_source_id = _non_empty(row["source_id"]) or f"manual_capture:{payload.item_id}"

    mismatches: list[str] = []
    _compare(mismatches, "tenant_id", row["tenant_id"], payload.tenant_id)
    _compare(mismatches, "item_id", row["item_id"], payload.item_id)
    _compare(mismatches, "captured_url", row["captured_url"], expected_url)
    _compare(mismatches, "content_sha256", row["content_sha256"], expected_hash)
    _compare(mismatches, "content_length", row["content_length"], len(content))
    _compare(mismatches, "capture_mode", row["capture_mode"], capture.capture_mode)
    _compare(mismatches, "note", row["note"], capture.note)
    _compare(
        mismatches,
        "future_manual_action_required",
        bool(row["future_manual_action_required"]),
        capture.future_manual_action_required,
    )
    if not imported_at:
        mismatches.append("imported_at")
    job_id = _non_empty(row["job_id"])
    try:
        canonical_job_id(job_id)
    except ValueError:
        mismatches.append("job_id")
    if not isinstance(provenance, dict):
        mismatches.append("manual_capture_provenance")
    else:
        _compare(mismatches, "provenance.source_kind", provenance.get("source_kind"), "user_mediated_capture")
        _compare(mismatches, "provenance.originating_url", provenance.get("originating_url"), originating_url)
        _compare(mismatches, "provenance.source_id", provenance.get("source_id"), expected_source_id)
        _compare(mismatches, "provenance.capture_mode", provenance.get("capture_mode"), capture.capture_mode)
        _compare(mismatches, "provenance.captured_at", provenance.get("captured_at"), imported_at)
        _compare(
            mismatches,
            "provenance.future_manual_action_required",
            provenance.get("future_manual_action_required"),
            capture.future_manual_action_required,
        )

    if mismatches:
        fields = ", ".join(sorted(set(mismatches)))
        raise _non_retryable(
            f"Manual capture replay does not match the imported row ({fields})",
            error_type="capture_replay_mismatch",
        )

    owner = conn.execute(
        """SELECT 1 FROM jobs j WHERE j.tenant_id=? AND j.job_id=? AND NOT EXISTS
           (SELECT 1 FROM jobctrl_deleted_jobs d WHERE d.tenant_id=j.tenant_id AND d.job_id=j.job_id
            AND (d.restored_at IS NULL OR julianday(d.restored_at)<=julianday(d.deleted_at)))""",
        (payload.tenant_id, job_id),
    ).fetchone()
    if owner is None:
        raise _non_retryable(
            "The original Job no longer permits this capture to be imported.",
            error_type="manual_capture_state_changed",
        )
    snapshot = conn.execute(
        "SELECT snapshot_set_json FROM posting_snapshot_sets WHERE tenant_id=? AND job_id=?",
        (payload.tenant_id, job_id),
    ).fetchone()
    snapshot_set = _retry_context(snapshot[0]) if snapshot else {}
    snapshots = snapshot_set.get("snapshots")
    if not isinstance(snapshots, list) or not any(
        isinstance(item, dict) and item.get("source_id") == expected_source_id
        and item.get("raw_text_hash") == expected_hash
        and type(item.get("snapshot_version")) is int and item["snapshot_version"] > 0 for item in snapshots
    ):
        raise _non_retryable(
            "The original capture has no matching successful snapshot. Submit the captured page again.",
            error_type="manual_capture_extraction_failed",
        )

    return ManualCaptureImportActivityOutput(
        status="succeeded",
        item_id=_non_empty(row["item_id"]),
        job_id=job_id,
        imported_at=imported_at,
        retry_context=retry_context,
    )


def _retry_context(value: Any) -> dict[str, Any]:
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _compare(mismatches: list[str], name: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        mismatches.append(name)


def _non_empty(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _non_retryable(message: str, *, error_type: str) -> ApplicationError:
    return ApplicationError(message, type=error_type, non_retryable=True)


@workflow.defn(name="ManualCaptureImportWorkflow")
class ManualCaptureImportWorkflow:
    """Import a queued manual capture on the long-lived JobCtrl worker."""

    @workflow.run
    async def run(
        self,
        payload: ManualCaptureImportWorkflowInput,
    ) -> ManualCaptureImportWorkflowResult:
        started_at = workflow.now()
        await emit_workflow_started(
            tenant_id=payload.tenant_id,
            workflow_type="ManualCaptureImportWorkflow",
            input_summary={
                "itemId": payload.item_id,
                "captureMode": payload.capture_mode,
                "hasCapturedUrl": bool(payload.captured_url),
                "hasContent": bool(payload.content_text or payload.content_html_base64),
            },
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        try:
            activity_options = {}
            if workflow.patched("manual-capture-cancellation-v1"):
                activity_options = {
                    "heartbeat_timeout": timedelta(seconds=10),
                    "cancellation_type": ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
                }
            output = await workflow.execute_activity(
                manual_capture_import_activity,
                payload,
                start_to_close_timeout=_DEFAULT_TIMEOUT,
                retry_policy=_MANUAL_CAPTURE_RETRY,
                **activity_options,
            )
        except CancelledError:
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ManualCaptureImportWorkflow",
                status="canceled",
                started_at=started_at,
                error_code="workflow_canceled",
                error_message="Workflow canceled by request.",
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise
        except ActivityError as exc:
            if isinstance(exc.cause, CancelledError):
                await emit_workflow_outcome(
                    tenant_id=payload.tenant_id,
                    workflow_type="ManualCaptureImportWorkflow",
                    status="canceled",
                    started_at=started_at,
                    error_code="workflow_canceled",
                    error_message="Workflow canceled by request.",
                    expected_app_dir=payload.expected_app_dir,
                    expected_db_path=payload.expected_db_path,
                )
                raise CancelledError("Workflow canceled by request.") from exc
            error_code = _activity_error_code(exc) or "manual_capture_import_failed"
            error_message = _activity_error_message(exc, error_code)
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ManualCaptureImportWorkflow",
                status="failed",
                started_at=started_at,
                error_code=error_code,
                error_message=error_message,
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            return ManualCaptureImportWorkflowResult(
                status="failed",
                error=error_message,
                error_code=error_code,
            )
        except Exception as exc:  # noqa: BLE001
            await emit_workflow_outcome(
                tenant_id=payload.tenant_id,
                workflow_type="ManualCaptureImportWorkflow",
                status="failed",
                started_at=started_at,
                error_code=_exception_error_code(exc) or "workflow_error",
                error_message=str(exc),
                expected_app_dir=payload.expected_app_dir,
                expected_db_path=payload.expected_db_path,
            )
            raise

        await emit_workflow_outcome(
            tenant_id=payload.tenant_id,
            workflow_type="ManualCaptureImportWorkflow",
            status="succeeded",
            started_at=started_at,
            expected_app_dir=payload.expected_app_dir,
            expected_db_path=payload.expected_db_path,
        )
        return ManualCaptureImportWorkflowResult(
            status=output.status,
            item_id=output.item_id,
            job_id=output.job_id,
            imported_at=output.imported_at,
            retry_context=dict(output.retry_context),
        )


def manual_capture_import_workflow_id(tenant_id: str, item_id: str) -> str:
    """Stable identity: one active import workflow per tenant queue item."""
    tenant_hash = hashlib.sha256(tenant_id.encode("utf-8")).hexdigest()
    item_hash = hashlib.sha256(item_id.encode("utf-8")).hexdigest()
    return f"manual-capture-import-{tenant_hash}-{item_hash}"


def _activity_error_code(exc: ActivityError) -> str | None:
    cause = exc.cause
    if isinstance(cause, ApplicationError):
        code = cause.type or ""
        if code.startswith("semantic_determination_"):
            return code
        if code in {
            "not_found",
            "capture_replay_mismatch",
            "invalid_capture_input",
            "manual_capture_extraction_failed",
            "manual_capture_state_changed",
            "manual_capture_database_error",
            "RuntimeIdentityMismatch",
        }:
            return code
    return None


def _activity_error_message(exc: ActivityError, error_code: str) -> str:
    if error_code == "manual_capture_import_failed":
        return "Manual capture import failed on the worker."
    return str(exc.cause if exc.cause else exc)


def _exception_error_code(exc: Exception) -> str | None:
    if isinstance(exc, ActivityError):
        return _activity_error_code(exc)
    if isinstance(exc, ApplicationError):
        return exc.type or None
    return None


__all__ = [
    "ManualCaptureImportActivityOutput",
    "ManualCaptureImportWorkflow",
    "ManualCaptureImportWorkflowInput",
    "ManualCaptureImportWorkflowResult",
    "execute_manual_capture_import",
    "manual_capture_import_activity",
    "manual_capture_import_workflow_id",
]
