"""Apply Automation use cases — application-layer orchestration.

See ddd-target.md §5.6. Two driving use cases live here:

  ``SubmitApplicationUseCase`` — runs one apply lifecycle for one
                                  ``(TenantId, JobId)`` pair via the
                                  ``ApplySaga`` process manager.
                                  Publishes ``ApplyRunStarted``,
                                  ``ApplyRunEventRecorded``,
                                  ``ApplicationSubmitted`` /
                                  ``ApplicationFailed`` per §6.7.
  ``SubmitBatchUseCase``       — wraps the single-job use case over a
                                  job-acquirer collaborator (the
                                  legacy launcher's ``acquire_job``
                                  is the local-mode acquirer).

Both use cases accept their dependencies (browser port, agent port,
repository, publisher, eligibility checker, prompt builder, saga,
acquirer) as constructor arguments so tests can swap fakes without
monkey-patching.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from jobhunter.domain.apply.aggregate import ApplyRun
from jobhunter.domain.apply.process_manager import ApplySaga, EmailApplicationContext, SagaOutcome
from jobhunter.domain.apply.services import (
    ApplyEligibilityChecker,
    ApplyPromptBuilder,
)
from jobhunter.domain.apply.value_objects import (
    Applied,
    ApplyRunId,
    BrowserWorkerConfig,
    Failed,
    SubmissionResult,
    new_apply_run_id,
)
from jobhunter.domain.events import (
    ApplicationFailedPayload,
    ApplicationSubmittedPayload,
    ApplyRunEventRecordedPayload,
    ApplyRunStartedPayload,
    create_application_failed,
    create_application_submitted,
    create_apply_run_event_recorded,
    create_apply_run_started,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.ports.apply import (
    ApplyRunRepository,
    AutonomousAgentPort,
    BrowserPort,
)
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId

log = logging.getLogger(__name__)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# SubmitApplicationOutcome
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SubmitApplicationOutcome:
    """The result of one ``SubmitApplicationUseCase.execute`` call.

    ``ok=True`` when the saga reached a terminal state of any kind
    (including the non-applied terminal variants like
    ``Captcha`` / ``Manual`` — they aren't successes for the
    candidate but they are successful exits for the saga). The
    use case considers a run "ok" when it didn't raise unhandled.
    ``submission_result`` carries the §4.6 variant.
    """

    apply_run: ApplyRun
    ok: bool
    submission_result: SubmissionResult | None
    skipped: bool = False
    skip_reason: str = ""


# ---------------------------------------------------------------------------
# SubmitApplicationUseCase
# ---------------------------------------------------------------------------


class SubmitApplicationUseCase:
    """Run one autonomous apply lifecycle for one job.

    The use case is the single transactional boundary: load the job,
    check eligibility, render the prompt, drive the saga, and
    publish events. Repository writes happen inside the saga (each
    state transition persists the aggregate); the use case only owns
    the orchestration.
    """

    def __init__(
        self,
        *,
        repository: ApplyRunRepository,
        browser_port: BrowserPort,
        agent_port: AutonomousAgentPort,
        eligibility_checker: ApplyEligibilityChecker,
        prompt_builder: ApplyPromptBuilder,
        publisher: EventPublisher | None = None,
        saga: ApplySaga | None = None,
        timeout_seconds: int | None = None,
    ) -> None:
        self._repository = repository
        self._browser = browser_port
        self._agent = agent_port
        self._eligibility = eligibility_checker
        self._prompt_builder = prompt_builder
        self._publisher = publisher
        self._timeout_seconds = timeout_seconds
        self._saga = saga or ApplySaga(
            browser_port=browser_port,
            agent_port=agent_port,
            repository=repository,
            timeout_seconds=timeout_seconds,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def execute(
        self,
        *,
        tenant_id: TenantId = LOCAL_TENANT,
        job: Mapping[str, Any],
        snapshot: ProfileSnapshot,
        worker_id: int,
        cdp_port: int,
        model: str = "default",
        dry_run: bool = False,
        headless: bool = False,
        run_id: ApplyRunId | None = None,
        attempts: int = 1,
        worker_dir: str | None = None,
        search_config: Mapping[str, Any] | None = None,
    ) -> SubmitApplicationOutcome:
        """Run the apply lifecycle for one job.

        ``job`` is the dict shape returned by
        ``database.get_jobs_by_stage`` (with the §7 effective-column
        joins applied). ``snapshot`` is the ``ProfileSnapshot`` the
        launcher loads once per process. ``worker_id`` / ``cdp_port``
        identify the browser slot.
        """
        # 1. Eligibility check — pure data inspection, never raises
        attempt_count = int(job.get("apply_attempts") or 0)
        eligibility = self._eligibility.check(job=job, attempts=attempt_count)
        if not eligibility.ok:
            log.info(
                "SubmitApplicationUseCase: skipping job %s (%s)",
                job.get("url"),
                eligibility.reason,
            )
            return SubmitApplicationOutcome(
                apply_run=_skipped_aggregate(
                    tenant_id=tenant_id,
                    job_id=JobId(str(job.get("url") or "")),
                    run_id=run_id or new_apply_run_id(),
                    reason=eligibility.reason,
                    started_at=_utc_now(),
                    dry_run=dry_run,
                    headless=headless,
                    attempts=max(attempts, 1),
                    model=model,
                    worker_id=worker_id,
                ),
                ok=False,
                submission_result=None,
                skipped=True,
                skip_reason=eligibility.reason,
            )

        # 2. Construct the aggregate in the starting state
        run_id = run_id or new_apply_run_id()
        job_id = JobId(str(job.get("url") or ""))
        apply_run = ApplyRun.start(
            tenant_id=tenant_id,
            run_id=run_id,
            job_id=job_id,
            started_at=_utc_now(),
            worker_id=worker_id,
            model=model,
            dry_run=dry_run,
            headless=headless,
            attempts=max(attempts, 1),
        )

        # 3. Publish ApplyRunStarted (per §6.7)
        self._publish_started(apply_run)

        # 4. Render prompt + browser config
        tailored_resume = _read_tailored_resume_text(job)
        prompt = self._prompt_builder.build(
            job=job,
            tailored_resume=tailored_resume,
            snapshot=snapshot,
            cdp_port=cdp_port,
            dry_run=dry_run,
            search_config=search_config,
            upload_dir=worker_dir,
        )
        browser_config = BrowserWorkerConfig(
            worker_id=worker_id,
            cdp_port=cdp_port,
            headless=headless,
            user_data_dir=worker_dir,
            dry_run=dry_run,
        )

        # 5. Drive the saga — it persists the aggregate at every step
        outcome: SagaOutcome = self._saga.run(
            apply_run=apply_run,
            browser_config=browser_config,
            prompt=prompt,
            model=model,
            material_version=str(job.get("materials_generation") or ""),
            materials_generation=job.get("materials_generation"),
            application_url=str(job.get("application_url") or job.get("url") or ""),
            profile_version=getattr(snapshot, "version", None),
            email_application_context=_email_application_context(job, snapshot),
        )

        # 6. Publish per-event records + final result
        self._publish_event_records(outcome.apply_run)
        if (
            outcome.apply_run.is_succeeded
            and isinstance(outcome.apply_run.submission_result, Applied)
        ):
            self._publish_submitted(outcome.apply_run, outcome.apply_run.submission_result)
        elif outcome.apply_run.submission_result is not None:
            self._publish_failed(
                outcome.apply_run,
                outcome.apply_run.submission_result,
            )

        return SubmitApplicationOutcome(
            apply_run=outcome.apply_run,
            ok=True,
            submission_result=outcome.apply_run.submission_result,
        )

    # ------------------------------------------------------------------
    # Event publishing helpers
    # ------------------------------------------------------------------

    def _publish_started(self, run: ApplyRun) -> None:
        if self._publisher is None:
            return
        try:
            event = create_apply_run_started(
                run.tenant_id,
                ApplyRunStartedPayload(
                    job_id=str(run.job_id),
                    run_id=str(run.run_id),
                    worker_id=str(run.worker_id) if run.worker_id is not None else "",
                    model=run.model or "",
                    dry_run=run.dry_run,
                    started_at=run.started_at,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001 — events never block the use case
            log.exception("publish ApplyRunStarted failed for %s", run.run_id)

    def _publish_event_records(self, run: ApplyRun) -> None:
        """Publish ``ApplyRunEventRecorded`` for every event in the run.

        Operations subscribes to these to drive the live dashboard
        feed (§6.7). We publish them in chronological order; any
        single publish failure is logged and the loop continues.
        """
        if self._publisher is None:
            return
        for event in run.events:
            try:
                payload = ApplyRunEventRecordedPayload(
                    run_id=str(run.run_id),
                    event=event.to_dict(),
                )
                self._publisher.publish(
                    create_apply_run_event_recorded(run.tenant_id, payload)
                )
            except Exception:  # noqa: BLE001
                log.exception(
                    "publish ApplyRunEventRecorded failed for run=%s event=%s",
                    run.run_id,
                    event.event_id,
                )

    def _publish_submitted(self, run: ApplyRun, result: Applied) -> None:
        if self._publisher is None:
            return
        try:
            event = create_application_submitted(
                run.tenant_id,
                ApplicationSubmittedPayload(
                    job_id=str(run.job_id),
                    run_id=str(run.run_id),
                    applied_at=result.applied_at,
                    verification_confidence=result.verification_confidence,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("publish ApplicationSubmitted failed for %s", run.run_id)

    def _publish_failed(self, run: ApplyRun, result: SubmissionResult) -> None:
        if self._publisher is None:
            return
        try:
            event = create_application_failed(
                run.tenant_id,
                ApplicationFailedPayload(
                    job_id=str(run.job_id),
                    run_id=str(run.run_id),
                    result={"kind": result.kind, **_result_payload(result)},
                    attempt_number=run.attempts,
                ),
            )
            self._publisher.publish(event)
        except Exception:  # noqa: BLE001
            log.exception("publish ApplicationFailed failed for %s", run.run_id)


def _result_payload(result: SubmissionResult) -> dict[str, Any]:
    """Flatten a SubmissionResult into a JSON-friendly payload (no kind field)."""
    if isinstance(result, Failed):
        return {"error": result.error, "retryable": result.retryable}
    payload: dict[str, Any] = {}
    for attr in (
        "details",
        "reason",
        "navigated_to",
        "coverage",
        "blocked_channels",
        "applied_at",
        "verification_confidence",
    ):
        if hasattr(result, attr):
            value = getattr(result, attr)
            payload[attr] = list(value) if isinstance(value, tuple) else value
    return payload


def _skipped_aggregate(
    *,
    tenant_id: TenantId,
    job_id: JobId,
    run_id: ApplyRunId,
    reason: str,
    started_at: str,
    dry_run: bool,
    headless: bool,
    attempts: int,
    model: str,
    worker_id: int,
) -> ApplyRun:
    """Build a placeholder ``ApplyRun`` for a skipped job.

    The aggregate is returned for symmetry with the happy path
    (callers always get an ``ApplyRun`` back) but is NOT persisted —
    the eligibility skip happens before the saga starts so there's
    nothing to write.
    """
    placeholder = ApplyRun.start(
        tenant_id=tenant_id,
        run_id=run_id,
        job_id=job_id,
        started_at=started_at,
        worker_id=worker_id,
        model=model,
        dry_run=dry_run,
        headless=headless,
        attempts=attempts,
    )
    return placeholder.complete(
        result=Failed(error=f"INELIGIBLE: {reason}", retryable=False),
        finished_at=started_at,
        duration_ms=0,
    )


def _read_tailored_resume_text(job: Mapping[str, Any]) -> str:
    """Read the .txt sibling of the tailored resume PDF, if present."""
    resume_path = job.get("tailored_resume_path")
    if not resume_path:
        return ""
    try:
        txt_path = Path(str(resume_path)).with_suffix(".txt")
    except Exception:  # noqa: BLE001
        return ""
    if not txt_path.exists():
        return ""
    try:
        return txt_path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _email_application_context(
    job: Mapping[str, Any],
    snapshot: ProfileSnapshot,
) -> EmailApplicationContext:
    profile = snapshot.as_dict()
    personal = profile.get("personal", {}) if isinstance(profile, Mapping) else {}
    resume_path = str(job.get("resume_pdf_path") or "")
    attachment_name = Path(resume_path).name if resume_path else "resume.pdf"
    return EmailApplicationContext(
        job_title=str(job.get("title") or ""),
        company=str(job.get("site") or ""),
        posting_text="\n".join(
            str(job.get(key) or "")
            for key in ("full_description", "description")
        ),
        applicant_name=str(personal.get("full_name") or ""),
        attachment_artifact_id=str(job.get("resume_pdf_artifact_id") or resume_path),
        attachment_name=attachment_name,
        attachment_path=resume_path,
        approved_recipient_email=str(job.get("approved_email_recipient") or ""),
        approved_attachment_artifact_id=str(job.get("approved_email_attachment_artifact_id") or ""),
    )


# ---------------------------------------------------------------------------
# SubmitBatchUseCase
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BatchApplySummary:
    """Aggregate result of one batch apply run."""

    processed: int
    applied: int
    failed: int
    skipped: int


# Job acquirer collaborator: returns the next eligible job dict (with
# the side-effects of marking it ``in_progress`` so peer workers don't
# acquire it again) or ``None`` when the queue is empty.
JobAcquirer = Callable[[int], "Mapping[str, Any] | None"]


class SubmitBatchUseCase:
    """Run multiple apply lifecycles in sequence (or in parallel
    via the launcher's ``ThreadPoolExecutor`` shell).

    The batch use case keeps job acquisition pluggable so the legacy
    launcher's database-backed acquirer (which marks the row
    ``in_progress`` to prevent peer workers from picking it up) can
    be substituted with a fake in tests.
    """

    def __init__(
        self,
        *,
        single_job_use_case: SubmitApplicationUseCase,
        acquirer: JobAcquirer,
        snapshot_provider: Callable[[], ProfileSnapshot],
    ) -> None:
        self._single = single_job_use_case
        self._acquirer = acquirer
        self._snapshot_provider = snapshot_provider

    def execute(
        self,
        *,
        tenant_id: TenantId = LOCAL_TENANT,
        worker_id: int,
        cdp_port: int,
        limit: int = 1,
        model: str = "default",
        dry_run: bool = False,
        headless: bool = False,
        worker_dir: str | None = None,
    ) -> BatchApplySummary:
        applied = failed = skipped = processed = 0
        snapshot = self._snapshot_provider()
        while limit == 0 or processed < limit:
            job = self._acquirer(worker_id)
            if job is None:
                break
            outcome = self._single.execute(
                tenant_id=tenant_id,
                job=job,
                snapshot=snapshot,
                worker_id=worker_id,
                cdp_port=cdp_port,
                model=model,
                dry_run=dry_run,
                headless=headless,
                worker_dir=worker_dir,
            )
            processed += 1
            if outcome.skipped:
                skipped += 1
            elif outcome.apply_run.is_succeeded:
                applied += 1
            else:
                failed += 1
        return BatchApplySummary(
            processed=processed,
            applied=applied,
            failed=failed,
            skipped=skipped,
        )


__all__ = [
    "BatchApplySummary",
    "JobAcquirer",
    "SubmitApplicationOutcome",
    "SubmitApplicationUseCase",
    "SubmitBatchUseCase",
]
