"""Bounded per-job execution shared by selected and cohort material stages."""

from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
import threading
from typing import Any, Callable

from jobctrl.domain.errors import LlmTransientError
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost


def run_material_jobs(
    job_ids: tuple[JobId, ...],
    *,
    workers: int,
    cancel_event: threading.Event | None,
    stage: str,
    run_one: Callable[[JobId], dict[str, Any]],
) -> list[tuple[JobId, dict[str, Any]]]:
    """Run selected material jobs with bounded, deterministic fan-out."""

    if not job_ids:
        return []
    worker_count = min(max(1, int(workers or 1)), len(job_ids))

    def ensure_active() -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise LlmTransientError(f"{stage} activity canceled")

    def run_owned_job(job_id: JobId) -> dict[str, Any]:
        try:
            return run_one(job_id)
        except PreparationReservationLost:
            return {"job_id": str(job_id), "status": "skipped", "reason": "reservation_lost"}

    if worker_count == 1:
        results: list[tuple[JobId, dict[str, Any]]] = []
        for job_id in job_ids:
            ensure_active()
            results.append((job_id, run_owned_job(job_id)))
        return results

    ensure_active()
    # Pool threads lose the activity's run context; re-bind it so per-job
    # stage events emitted inside the material runners keep run ownership.
    from jobctrl.infrastructure.workflow_run_context import carry_workflow_run_context

    run_one_owned = carry_workflow_run_context(run_owned_job)
    executor = ThreadPoolExecutor(
        max_workers=worker_count,
        thread_name_prefix=f"selected-{stage}",
    )
    in_flight: dict[Future[dict[str, Any]], JobId] = {}
    completed: dict[JobId, dict[str, Any]] = {}
    next_index = 0

    def fill_worker_slots() -> None:
        nonlocal next_index
        while next_index < len(job_ids) and len(in_flight) < worker_count:
            ensure_active()
            job_id = job_ids[next_index]
            next_index += 1
            in_flight[executor.submit(run_one_owned, job_id)] = job_id

    try:
        fill_worker_slots()
        while in_flight:
            ensure_active()
            done, _pending = wait(
                tuple(in_flight),
                timeout=0.1,
                return_when=FIRST_COMPLETED,
            )
            for future in done:
                job_id = in_flight.pop(future)
                completed[job_id] = future.result()
            fill_worker_slots()
        return [(job_id, completed[job_id]) for job_id in job_ids]
    finally:
        canceled = cancel_event is not None and cancel_event.is_set()
        if canceled:
            for future in in_flight:
                future.cancel()
        # A cooperative cancellation must release the parent activity thread
        # promptly. Already-running calls may finish in the background, but
        # their per-item commit guard observes the same token and durable owner
        # row before any artifact or terminal-state write.
        executor.shutdown(wait=not canceled, cancel_futures=True)
