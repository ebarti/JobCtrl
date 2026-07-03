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
from jobhunter.domain.apply.aggregate import ApplyRun
from jobhunter.domain.apply.value_objects import (
    ApplyPrompt,
    BrowserWorkerConfig,
    Failed,
    SubmissionResult,
)
from jobhunter.domain.ports.apply import (
    AgentResult,
    ApplyRunRepository,
    AutonomousAgentPort,
    BrowserPort,
    BrowserSession,
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
        timeout_seconds: int | None = None,
    ) -> None:
        self._browser = browser_port
        self._agent = agent_port
        self._repository = repository
        self._timeout_seconds = timeout_seconds

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
            run = run.record_event(
                event_type="AgentResult",
                occurred_at=_utc_now(),
                level="info",
                message=f"agent returned {_describe_result(agent_result.submission_result)}",
                payload={
                    "kind": agent_result.submission_result.kind,
                    "duration_ms": duration_ms,
                    "raw_output": agent_result.raw_output,
                },
            )
            run = run.complete(
                result=agent_result.submission_result,
                finished_at=_utc_now(),
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

def _describe_result(result: SubmissionResult) -> str:
    """Compact human-readable description of a submission result."""
    return result.kind


__all__ = [
    "ApplySaga",
    "SagaOutcome",
]
