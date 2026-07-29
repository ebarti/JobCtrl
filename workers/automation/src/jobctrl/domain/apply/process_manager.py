"""Apply submission saga / process manager.

See ddd-target.md §8.3. The apply flow spans multiple external
interactions (Chrome launch, Claude Code subprocess, parse-result,
cleanup) and is modelled here as an explicit process manager —
``ApplySaga`` — so the orchestration shape is testable in isolation
from the heavyweight adapters.

Saga states (mapped onto the ``ApplyRun`` aggregate's lifecycle from
§4.6):

    AcquireJob   → ``ApplyRun.start`` (status: starting)
    LaunchBrowser→ launch via ``BrowserPort``; on failure → Failed +
                   compensation (no Chrome cleanup needed since
                   nothing launched).
    StartAgent   → ``ApplyRun.transition_to_in_progress``; spawn
                   Claude Code via ``AutonomousAgentPort``; on
                   timeout → Failed + compensation.
    ParseResult  → fold the ``AgentResult`` into the aggregate via
                   ``ApplyRun.complete`` with the right
                   ``SubmissionResult`` variant.
    CleanupBrowser → always invoked from the saga's ``finally`` block;
                   adapter-side ``cleanup`` is idempotent.
    ReportResult → repository.save + event publishing.

Compensation actions per §8.3:
    * Chrome failed → no cleanup needed (nothing launched); record
      ``Failed("BROWSER_LAUNCH", retryable=True)``.
    * Agent timeout → kill subprocess (handled inside the adapter);
      record ``Failed("TIMEOUT", retryable=True)``; cleanup browser.
    * Agent crash → kill subprocess; record ``Failed(error_msg,
      retryable=True)``; cleanup browser.
    * Process crash mid-run → launcher recovery inspects the durable
      ``ApplySubmitIntended`` checkpoint before deciding whether the
      job can be retried or must be manually verified.

The saga itself is **pure orchestration** — the adapters do all the
I/O. ``ApplySaga`` takes ports as constructor arguments so tests can
swap fakes.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from jobctrl.domain.apply.aggregate import ApplyRun
from jobctrl.domain.apply.value_objects import (
    Applied,
    ApplyPrompt,
    BrowserWorkerConfig,
    DryRunComplete,
    EmailOnlyApplication,
    Failed,
    Manual,
    SubmissionResult,
)
from jobctrl.domain.ports.apply import (
    AgentResult,
    ApplyRunRepository,
    AutonomousAgentPort,
    BrowserPort,
    BrowserSession,
    EmailApplicationCandidate,
    EmailApplicationSenderPort,
)

log = logging.getLogger(__name__)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# SagaOutcome
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SagaOutcome:
    """Result of one ``ApplySaga.run`` invocation.

    The aggregate is always saved (either in a terminal state on
    success or with a ``Failed`` result on a compensation path) so
    callers can rely on ``run`` always producing a persisted
    ``ApplyRun``.
    """

    apply_run: ApplyRun
    browser_launched: bool
    agent_invoked: bool


@dataclass(frozen=True)
class EmailApplicationContext:
    """Owned context used to turn email-only detection into an approval-bound candidate."""

    job_title: str
    company: str
    posting_text: str
    applicant_name: str
    attachment_artifact_id: str
    attachment_name: str
    attachment_path: str
    approved_recipient_email: str = ""
    approved_attachment_artifact_id: str = ""


# ---------------------------------------------------------------------------
# ApplySaga
# ---------------------------------------------------------------------------


class ApplySaga:
    """Process manager for one autonomous apply run.

    The saga owns the lifecycle ordering described in §8.3:

        ``run = ApplyRun.start(...)``
        ``run = run.record_event("SagaStarted", ...)``
        ``session = browser.launch(config)``     # may raise → compensation
        ``run = run.transition_to_in_progress()``
        ``result = agent.submit_application(...)`` # may raise → compensation
        ``run = run.record_event("AgentResult", ...)``
        ``run = run.complete(result.submission_result, ...)``
        ``finally``:
            ``browser.cleanup(session)``
        ``repository.save(run)``

    Tests inject fake ports; the saga's pure logic stays observable
    through the returned ``SagaOutcome``.
    """

    def __init__(
        self,
        *,
        browser_port: BrowserPort,
        agent_port: AutonomousAgentPort,
        repository: ApplyRunRepository,
        email_sender: EmailApplicationSenderPort | None = None,
        timeout_seconds: int | None = None,
        submission_authorizer: Callable[[], None] | None = None,
    ) -> None:
        self._browser = browser_port
        self._agent = agent_port
        self._repository = repository
        self._email_sender = email_sender
        self._timeout_seconds = timeout_seconds
        # This is deliberately a port-shaped callback rather than an
        # infrastructure import: immediately before a live agent can use the
        # browser, the composition root must re-authorize the capability.
        self._submission_authorizer = submission_authorizer or (lambda: None)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(
        self,
        *,
        apply_run: ApplyRun,
        browser_config: BrowserWorkerConfig,
        prompt: ApplyPrompt,
        model: str,
        material_version: str = "",
        materials_generation: int | str | None = None,
        application_url: str | None = None,
        profile_version: int | str | None = None,
        email_application_context: EmailApplicationContext | None = None,
    ) -> SagaOutcome:
        """Run the saga end-to-end.

        ``apply_run`` is the aggregate the use case constructed via
        ``ApplyRun.start``. The saga drives it through the lifecycle
        transitions, persists each terminal step, and returns the
        final aggregate.
        """
        run = apply_run
        session: BrowserSession | None = None
        agent_invoked = False
        browser_launched = False
        start = time.time()

        # Persist the starting state so dashboards see the run before
        # Chrome boots.
        run = run.record_event(
            event_type="SagaStarted",
            occurred_at=_utc_now(),
            level="info",
            message="apply saga started",
            payload={"job_id": str(run.job_id), "model": model},
        )
        self._repository.save(run)

        try:
            # 1. Launch browser
            try:
                session = self._browser.launch(browser_config)
                browser_launched = True
                run = run.record_event(
                    event_type="BrowserLaunched",
                    occurred_at=_utc_now(),
                    level="info",
                    message=f"browser launched on port {browser_config.cdp_port}",
                    payload={
                        "cdp_port": browser_config.cdp_port,
                        "headless": browser_config.headless,
                        "pid": session.pid,
                    },
                )
            except Exception as exc:  # noqa: BLE001 — translate to compensation
                log.warning("ApplySaga: browser launch failed: %s", exc)
                run = run.record_event(
                    event_type="BrowserLaunchFailed",
                    occurred_at=_utc_now(),
                    level="error",
                    message=str(exc)[:500],
                    payload={"error": str(exc)[:500]},
                )
                run = self._compensate_failure(
                    run,
                    error_code="BROWSER_LAUNCH",
                    message=str(exc)[:500],
                    retryable=True,
                    duration_ms=int((time.time() - start) * 1000),
                )
                self._repository.save(run)
                return SagaOutcome(
                    apply_run=run,
                    browser_launched=False,
                    agent_invoked=False,
                )

            # 2. Transition starting → in_progress
            run = run.transition_to_in_progress(worker_id=browser_config.worker_id)
            run = run.record_event(
                event_type="AgentStarted",
                occurred_at=_utc_now(),
                level="info",
                message="autonomous agent started",
                payload={"model": model, "dry_run": run.dry_run},
            )
            self._repository.save(run)

            # 3. Drive the agent
            try:
                if not run.dry_run:
                    # The initial launch gate is not enough for a long-running
                    # saga. Re-check at the durable intent + agent boundary so
                    # revocation after Chrome starts cannot create an intent or
                    # start an autonomous submission process.
                    try:
                        self._submission_authorizer()
                    except Exception as exc:  # noqa: BLE001 - external authorization port
                        log.info("ApplySaga: submission authorization was revoked: %s", exc)
                        run = run.record_event(
                            event_type="ApplySubmissionBlocked",
                            occurred_at=_utc_now(),
                            level="warn",
                            message="live apply submission was blocked by the active capability policy",
                            payload={"reason": "submission_authorization_revoked"},
                        )
                        run = self._compensate_failure(
                            run,
                            error_code="SUBMISSION_AUTHORIZATION_REVOKED",
                            message="live browser capability is no longer enabled",
                            retryable=True,
                            duration_ms=int((time.time() - start) * 1000),
                        )
                        self._repository.save(run)
                        return SagaOutcome(
                            apply_run=run,
                            browser_launched=browser_launched,
                            agent_invoked=False,
                        )
                    intended_at = _utc_now()
                    run = run.record_event(
                        event_type="ApplySubmitIntended",
                        occurred_at=intended_at,
                        level="info",
                        message="apply submission intent recorded",
                        payload={
                            "tenant_id": str(run.tenant_id),
                            "job_key": str(run.job_id),
                            "run_id": str(run.run_id),
                            "material_version": str(material_version or ""),
                            "intended_at": intended_at,
                        },
                    )
                    self._repository.save(run)
                agent_invoked = True
                agent_result: AgentResult = self._agent.submit_application(
                    prompt=prompt,
                    browser=session,
                    model=model,
                    dry_run=run.dry_run,
                    timeout_seconds=self._timeout_seconds,
                )
            except TimeoutError as exc:
                log.warning("ApplySaga: agent timed out: %s", exc)
                run = run.record_event(
                    event_type="AgentTimedOut",
                    occurred_at=_utc_now(),
                    level="error",
                    message=str(exc)[:500],
                    payload={"timeout_seconds": self._timeout_seconds},
                )
                run = self._compensate_failure(
                    run,
                    error_code="TIMEOUT",
                    message=str(exc)[:500] or "agent timed out",
                    retryable=True,
                    duration_ms=int((time.time() - start) * 1000),
                )
                self._repository.save(run)
                return SagaOutcome(
                    apply_run=run,
                    browser_launched=browser_launched,
                    agent_invoked=agent_invoked,
                )
            except Exception as exc:  # noqa: BLE001
                log.exception("ApplySaga: agent crashed")
                run = run.record_event(
                    event_type="AgentCrashed",
                    occurred_at=_utc_now(),
                    level="error",
                    message=str(exc)[:500],
                    payload={"error": str(exc)[:500]},
                )
                run = self._compensate_failure(
                    run,
                    error_code="AGENT_CRASH",
                    message=str(exc)[:500] or "agent crashed",
                    retryable=True,
                    duration_ms=int((time.time() - start) * 1000),
                )
                self._repository.save(run)
                return SagaOutcome(
                    apply_run=run,
                    browser_launched=browser_launched,
                    agent_invoked=agent_invoked,
                )

            # 4. Fold agent events into the aggregate timeline
            for raw_event in agent_result.events:
                run = run.record_event(
                    event_type=str(raw_event.get("event_type", "AgentEvent")),
                    occurred_at=str(raw_event.get("occurred_at") or _utc_now()),
                    level=str(raw_event.get("level", "info")),
                    message=raw_event.get("message"),
                    payload=raw_event.get("payload") or {},
                )

            # 5. Parse result + transition to terminal state
            duration_ms = (
                int(agent_result.duration_ms)
                if agent_result.duration_ms is not None
                else int((time.time() - start) * 1000)
            )
            submission_result = agent_result.submission_result
            if isinstance(submission_result, EmailOnlyApplication):
                run, submission_result = self._handle_email_only_result(
                    run,
                    submission_result,
                    email_application_context,
                    duration_ms=duration_ms,
                )
            dry_run_evidence = _empty_dry_run_evidence()
            if run.dry_run and isinstance(submission_result, DryRunComplete):
                dry_run_evidence = _collect_dry_run_evidence(session)
                if (
                    not dry_run_evidence["blocked_channels"]
                    and submission_result.blocked_channels
                ):
                    dry_run_evidence = {
                        "coverage": "partial",
                        "blocked_channels": submission_result.blocked_channels,
                        "blocked_requests": (),
                        "allowed_navigations": dry_run_evidence[
                            "allowed_navigations"
                        ],
                    }
                submission_result = DryRunComplete(
                    navigated_to=submission_result.navigated_to,
                    coverage=str(dry_run_evidence["coverage"]),
                    blocked_channels=tuple(dry_run_evidence["blocked_channels"]),
                )
            run = run.record_event(
                event_type="AgentResult",
                occurred_at=_utc_now(),
                level="info",
                message=f"agent returned {_describe_result(submission_result)}",
                payload={
                    "kind": submission_result.kind,
                    "duration_ms": duration_ms,
                    "raw_output": agent_result.raw_output,
                },
            )
            if run.dry_run and isinstance(submission_result, DryRunComplete):
                blocked_requests = tuple(dry_run_evidence["blocked_requests"])
                if blocked_requests:
                    run = run.record_event(
                        event_type="DryRunBlockedChannels",
                        occurred_at=_utc_now(),
                        level="warn",
                        message="dry-run guard blocked browser submission channels",
                        payload={
                            "coverage": submission_result.coverage,
                            "blocked_channels": list(submission_result.blocked_channels),
                            "blocked_requests": list(blocked_requests),
                        },
                    )
                finished_at = _utc_now()
                run = run.record_event(
                    event_type="DryRunCompleted",
                    occurred_at=finished_at,
                    level="info",
                    message="Dry run completed without submitting",
                    payload={
                        "run_id": str(run.run_id),
                        "result": "dry_run_complete",
                        "finished_at": finished_at,
                        "duration_ms": duration_ms,
                        "worker_id": run.worker_id,
                        "model": model,
                        "dry_run": True,
                        "coverage": submission_result.coverage,
                        "blocked_channels": list(submission_result.blocked_channels),
                        "allowed_navigations": list(
                            dry_run_evidence["allowed_navigations"]
                        ),
                        "materials_generation": _coerce_optional_int(
                            materials_generation
                            if materials_generation is not None
                            else material_version
                        ),
                        "application_url": application_url or str(run.job_id),
                        "profile_version": _coerce_optional_int(profile_version),
                    },
                )
            else:
                finished_at = _utc_now()
            run = run.complete(
                result=submission_result,
                finished_at=finished_at,
                token_usage=agent_result.token_usage,
                duration_ms=duration_ms,
            )
            self._repository.save(run)

            return SagaOutcome(
                apply_run=run,
                browser_launched=browser_launched,
                agent_invoked=agent_invoked,
            )
        finally:
            # Cleanup is idempotent on the adapter side.
            if session is not None:
                try:
                    self._browser.cleanup(session)
                except Exception:  # noqa: BLE001
                    log.exception("ApplySaga: browser cleanup failed")

    # ------------------------------------------------------------------
    # Compensation helpers
    # ------------------------------------------------------------------

    def _handle_email_only_result(
        self,
        run: ApplyRun,
        result: EmailOnlyApplication,
        context: EmailApplicationContext | None,
        *,
        duration_ms: int,
    ) -> tuple[ApplyRun, SubmissionResult]:
        if context is None:
            run = run.record_event(
                event_type="EmailApplicationCandidateRejected",
                occurred_at=_utc_now(),
                level="warn",
                message="email application context is unavailable",
                payload={"recipient": result.recipient_email, "reason": "email_context_unavailable"},
            )
            return run, Manual(reason="email_context_unavailable")

        if not _recipient_in_posting(result.recipient_email, context.posting_text):
            run = run.record_event(
                event_type="EmailApplicationCandidateRejected",
                occurred_at=_utc_now(),
                level="warn",
                message="email recipient was not found in stored posting text",
                payload={"recipient": result.recipient_email, "reason": "email_recipient_unverified"},
            )
            return run, Manual(reason="email_recipient_unverified")

        candidate = _build_email_application_candidate(result.recipient_email, context)
        candidate_payload = _candidate_payload(candidate, run_id=str(run.run_id), duration_ms=duration_ms)
        run = run.record_event(
            event_type="EmailApplicationCandidateRecorded",
            occurred_at=_utc_now(),
            level="info",
            message="email application candidate recorded for review",
            payload=candidate_payload,
        )

        if run.dry_run:
            return run, DryRunComplete(
                navigated_to="",
                coverage="full",
                blocked_channels=("email_application",),
            )

        if not _candidate_matches_approval(candidate, context):
            run = run.record_event(
                event_type="EmailApplicationApprovalMissing",
                occurred_at=_utc_now(),
                level="warn",
                message="email application candidate is not bound to the approval decision",
                payload={
                    "recipient": candidate.recipient_email,
                    "attachment_artifact_id": candidate.attachment_artifact_id,
                },
            )
            return run, Manual(reason="email_application_approval_required")

        if self._email_sender is None:
            run = run.record_event(
                event_type="EmailApplicationSendFailed",
                occurred_at=_utc_now(),
                level="error",
                message="email application sender is unavailable",
                payload={"reason": "email_sender_unavailable"},
            )
            return run, Failed(error="email_sender_unavailable", retryable=False)

        try:
            send_result = self._email_sender.send_email_application(candidate)
        except Exception as exc:  # noqa: BLE001 - translate provider failures into terminal apply state
            run = run.record_event(
                event_type="EmailApplicationSendFailed",
                occurred_at=_utc_now(),
                level="error",
                message=str(exc)[:500],
                payload={"reason": "email_send_failed"},
            )
            return run, Failed(error=f"email_send_failed:{str(exc)[:120]}", retryable=False)

        run = run.record_event(
            event_type="EmailApplicationSent",
            occurred_at=_utc_now(),
            level="info",
            message="email application sent by owned adapter",
            payload={
                "recipient": candidate.recipient_email,
                "attachment_artifact_id": candidate.attachment_artifact_id,
                "provider": send_result.provider,
                "message_id": send_result.message_id,
                "thread_id": send_result.thread_id,
            },
        )
        return run, Applied(applied_at=_utc_now(), verification_confidence=0.9)

    def _compensate_failure(
        self,
        run: ApplyRun,
        *,
        error_code: str,
        message: str,
        retryable: bool,
        duration_ms: int,
    ) -> ApplyRun:
        """Build a failed terminal aggregate for a compensation branch.

        The aggregate may be in ``starting`` or ``in_progress`` state
        depending on which step failed; we route both to ``Failed``.
        """
        if run.is_terminal:
            return run
        # Make sure ``complete`` is callable: we may be in ``starting``
        # if the browser failed before in-progress; that's fine — the
        # state machine allows ``starting → failed`` via ``complete``
        # because the ``Failed`` variant is a terminal state.
        return run.complete(
            result=Failed(
                error=f"{error_code}: {message}" if message else error_code,
                retryable=retryable,
            ),
            finished_at=_utc_now(),
            duration_ms=duration_ms,
        )

def _recipient_in_posting(recipient: str, posting_text: str) -> bool:
    return recipient.strip().lower() in (posting_text or "").lower()


def _build_email_application_candidate(
    recipient: str,
    context: EmailApplicationContext,
) -> EmailApplicationCandidate:
    title = context.job_title.strip() or "the role"
    company = context.company.strip() or "your team"
    applicant = context.applicant_name.strip() or "the candidate"
    subject = f"Application for {title}"
    body = (
        f"Hello,\n\n"
        f"Please find attached my resume for {title} at {company}.\n\n"
        f"Best,\n{applicant}"
    )
    return EmailApplicationCandidate(
        recipient_email=recipient.strip(),
        subject=subject,
        body=body,
        attachment_artifact_id=context.attachment_artifact_id,
        attachment_name=context.attachment_name,
        attachment_path=context.attachment_path,
    )


def _candidate_payload(
    candidate: EmailApplicationCandidate,
    *,
    run_id: str,
    duration_ms: int,
) -> dict[str, object]:
    return {
        "run_id": run_id,
        "recipient": candidate.recipient_email,
        "subject": candidate.subject,
        "body": candidate.body,
        "attachment_artifact_id": candidate.attachment_artifact_id,
        "attachment_name": candidate.attachment_name,
        "duration_ms": duration_ms,
    }


def _candidate_matches_approval(
    candidate: EmailApplicationCandidate,
    context: EmailApplicationContext,
) -> bool:
    return (
        context.approved_recipient_email.strip().lower() == candidate.recipient_email.lower()
        and context.approved_attachment_artifact_id == candidate.attachment_artifact_id
    )


def _describe_result(result: SubmissionResult) -> str:
    """Compact human-readable description of a submission result."""
    return result.kind


def _empty_dry_run_evidence() -> dict[str, object]:
    return {
        "coverage": "partial",
        "blocked_channels": (),
        "blocked_requests": (),
        "allowed_navigations": (),
    }


def _collect_dry_run_evidence(session: BrowserSession | None) -> dict[str, object]:
    if session is None or session.dry_run_evidence is None:
        return _empty_dry_run_evidence()
    try:
        raw = dict(session.dry_run_evidence() or {})
    except Exception:  # noqa: BLE001 — evidence must not turn a completed dry run into a crash
        log.exception("ApplySaga: failed to collect dry-run guard evidence")
        return _empty_dry_run_evidence()
    return _normalise_dry_run_evidence(raw)


def _normalise_dry_run_evidence(raw: Mapping[str, Any]) -> dict[str, object]:
    raw_channels = raw.get("blocked_channels") or ()
    if isinstance(raw_channels, str):
        raw_channels = (raw_channels,)
    blocked_channels = tuple(str(channel) for channel in raw_channels if str(channel).strip())
    blocked_requests = tuple(
        dict(item)
        for item in (raw.get("blocked_requests") or ())
        if isinstance(item, Mapping)
    )
    allowed_navigations = tuple(
        dict(item)
        for item in (raw.get("allowed_navigations") or ())
        if isinstance(item, Mapping)
    )
    coverage = str(raw.get("coverage") or "partial")
    if coverage not in {"full", "partial"} or not allowed_navigations:
        coverage = "partial"
    return {
        "coverage": coverage,
        "blocked_channels": blocked_channels,
        "blocked_requests": blocked_requests,
        "allowed_navigations": allowed_navigations,
    }


def _coerce_optional_int(value: int | str | None) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


__all__ = [
    "ApplySaga",
    "EmailApplicationContext",
    "SagaOutcome",
]
