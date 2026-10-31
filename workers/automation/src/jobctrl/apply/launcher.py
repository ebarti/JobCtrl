"""Apply orchestration — thin shell over the Apply Automation domain.

PR 4 of the Temporal stack collapsed the bespoke ``apply_runs`` table
into the workflow run history. The launcher now drives apply lifecycle
state via:

  * ``job_stage_states.apply`` — the canonical "is this job locked /
    succeeded / failed" row (already maintained by ``state.set_stage_state``).
  * ``record_job_event(stage='apply', payload={"run_id": ...})`` — the
    durable event stream the projection builder consumes to materialise
    ``apply_run_projections``.

The legacy public surface (``main``, ``run_job``, ``worker_loop``,
``acquire_job``, ``mark_result``, ``release_lock``, ``gen_prompt``,
``mark_job``, ``reset_failed``) is preserved so callers (``cli.py``,
``actions.py``, ``pipeline.py``, regression tests) keep working.

The Rich dashboard from ``apply/dashboard.py`` continues to drive the
CLI display. The launcher refreshes it directly from the saga events
so we don't need a brand-new presentation adapter just yet.
"""

from __future__ import annotations

import atexit
from contextlib import contextmanager
from dataclasses import dataclass
import html
import json
import logging
import signal
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable

from rich.console import Console
from rich.live import Live

from jobctrl import config
from jobctrl.infrastructure.apply_controls import (
    APPLY_ADMISSIBLE_SQL, APPLY_ADMISSIBLE_FOR_OWNER_RECOVERY_SQL, APPLY_MANUAL_STOP_SQL,
    APPLY_SUBMIT_INTENT_SQL, APPLY_UNRESOLVED_SKIP_SQL, APPLY_RECORDED_APPLIED_SQL,
    APPLY_RETAINED_POLICY_SKIP_SQL, APPLY_SKIPPED_QUEUED_SQL, apply_dispatch_allows,
    capture_apply_dispatch_frontier, valid_email_confirmation, valid_email_operation,
)
from jobctrl.domain.apply.value_objects import Applied, DryRunComplete, EMAIL_AUTHORITY_REFUSAL_EVENT, Failed, Manual, SubmissionResult
from jobctrl.domain.ports.apply import ApplyRunWriteConflict
from jobctrl.apply import prompt as prompt_mod  # noqa: F401  -- kept for back-compat imports
from jobctrl.apply.batch_outcome import ApplyBatchCleanupIncomplete, ApplyBatchCounts, ApplyBatchWorkersCrashed
from jobctrl.apply.chrome import (
    BASE_CDP_PORT,
    cleanup_on_exit,
)
from jobctrl.apply.dashboard import (
    add_event,
    get_totals,
    init_worker,
    render_full,
    reset_dashboard,
    update_state,
)
from jobctrl.apply.origins import canonical_http_url
from jobctrl.apply.ownership import ApplyLauncherCleanupIncomplete, ApplyLauncherRun
from jobctrl.database import (
    _ACTIVE_STATE_JOIN,
    _EFFECTIVE_APPLICATION_URL,
    _EFFECTIVE_APPLIED_AT,
    _EFFECTIVE_APPLY_TARGET_URL,
    _EFFECTIVE_APPLY_STATUS,
    _EFFECTIVE_COVER_PATH,
    _EFFECTIVE_FIT_SCORE,
    _EFFECTIVE_FULL_DESCRIPTION,
    _EFFECTIVE_TAILOR_PATH,
    _ENRICHMENT_JOIN,
    _ENRICHMENT_NOT_QUARANTINED,
    _LATEST_APPLY_RUN_JOIN,
    _LATEST_MATERIALS_JOIN,
    _LATEST_SCORE_JOIN,
    _NOT_CLOSED_ACTIVE_STATE,
    _READY_TAILORED_RESUME_WITH_PDF,
    _SCORE_DOWNSTREAM_STATE_JOIN,
    _SCORE_CURRENT_FOR_DOWNSTREAM,
    _SCORE_ELIGIBLE_FOR_DOWNSTREAM,
    get_connection,
)
from jobctrl.domain.apply.services import ApplyPromptBuilder
from jobctrl.domain.apply.repeat_application import (
    consume_repeat_application_override,
    evaluate_repeat_application,
)
from jobctrl.domain.apply.value_objects import (
    APPROVAL_GATE_REFUSAL_REASONS,
    ApplyPrompt,
    ApplyRunId,
    new_apply_run_id,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import TenantId
from jobctrl.operational_metrics import record_operational_attempt_metric
from jobctrl.state import (
    ensure_job_stage_rows,
    record_job_event,
    set_stage_state,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# The standalone worker_loop compatibility entry uses this event. Launcher
# invocations and Temporal activities always receive their own cancellation.
# ---------------------------------------------------------------------------

POLL_INTERVAL = config.DEFAULTS["poll_interval"]
_stop_event = threading.Event()

atexit.register(cleanup_on_exit)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Stage-state-driven acquire / release / mark helpers
# ---------------------------------------------------------------------------


def _has_active_apply(conn, *, tenant_id: str, job_id: str) -> bool:
    """True when ``job_stage_states.apply.state == 'running'`` for one JobId.

    The §4.6 invariant — at most one in-progress apply per JobId —
    is enforced by checking the canonical stage state row.
    """
    row = conn.execute(
        "SELECT 1 FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'apply' AND state = 'running' LIMIT 1",
        (tenant_id, job_id),
    ).fetchone()
    return row is not None


def _has_succeeded_apply(conn, *, tenant_id: str, job_id: str) -> bool:
    """True when the canonical apply stage row is succeeded for one JobId."""
    row = conn.execute(
        "SELECT 1 FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'apply' AND state = 'succeeded' LIMIT 1",
        (tenant_id, job_id),
    ).fetchone()
    return row is not None


def _has_needs_verification_apply(conn, *, tenant_id: str, job_id: str) -> bool:
    """True when one JobId is parked for manual verification."""
    row = conn.execute(
        "SELECT 1 FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'apply' AND state = 'needs_verification' LIMIT 1",
        (tenant_id, job_id),
    ).fetchone()
    return row is not None


def _attempt_count_for(conn, *, tenant_id: str, job_id: str) -> int:
    """Return the canonical attempt count from ``job_stage_states.apply``."""
    row = conn.execute(
        "SELECT attempt_count FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply' LIMIT 1",
        (tenant_id, job_id),
    ).fetchone()
    return int(row[0] or 0) if row else 0


def _latest_apply_review_decision(conn, *, tenant_id: str, job_id: str) -> dict[str, Any] | None:
    # Equal clocks cannot establish chronology: any non-submit decision wins
    # that tie, regardless of random ID order. API and digest readers agree.
    row = conn.execute(
        """
        SELECT decision, materials_generation, profile_version, application_url,
               partial_override_run_id, email_recipient, email_attachment_artifact_id, decided_at, decision_id
        FROM application_review_decisions
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY decided_at DESC, CASE WHEN decision = 'approve_submit' THEN 0 ELSE 1 END DESC, decision_id DESC
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return None
    return (
        dict(row)
        if hasattr(row, "keys")
        else {
            "decision": row[0],
            "materials_generation": row[1],
            "profile_version": row[2],
            "application_url": row[3],
            "partial_override_run_id": row[4],
            "email_recipient": row[5],
            "email_attachment_artifact_id": row[6],
            "decided_at": row[7],
            "decision_id": row[8],
        }
    )


def _latest_email_application_candidate(
    conn,
    *,
    tenant_id: str,
    job_id: str,
) -> dict[str, Any] | None:
    try:
        row = conn.execute(
            """
            SELECT payload_json
            FROM job_events
            WHERE tenant_id = ? AND job_id = ?
              AND stage = 'apply'
              AND event_type = 'EmailApplicationCandidateRecorded'
            ORDER BY occurred_at DESC, event_id DESC
            LIMIT 1
            """,
            (tenant_id, job_id),
        ).fetchone()
    except Exception:  # noqa: BLE001
        return None
    if row is None:
        return None
    raw = row["payload_json"] if hasattr(row, "keys") else row[0]
    try:
        payload = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _current_profile_version(conn, *, tenant_id: str = "local") -> int | None:
    columns = {row[1] for row in conn.execute("PRAGMA table_info(candidate_profiles)").fetchall()}
    if "version" not in columns:
        return None
    row = conn.execute(
        "SELECT version FROM candidate_profiles WHERE tenant_id = ? AND profile_id = 'default'",
        (tenant_id,),
    ).fetchone()
    if row is None:
        return None
    value = row["version"] if hasattr(row, "keys") else row[0]
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _payload_from_row(row) -> dict[str, Any]:
    payload_json = row["payload_json"] if hasattr(row, "keys") else row[0]
    if not payload_json:
        return {}
    try:
        payload = json.loads(payload_json)
    except (TypeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _payload_value(payload: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in payload:
            return payload[name]
    return None


def _payload_int(payload: dict[str, Any], *names: str) -> int | None:
    value = _payload_value(payload, *names)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _allowed_navigation_evidence(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = _payload_value(payload, "allowed_navigations", "allowedNavigations")
    if not isinstance(raw, list):
        return []
    return [dict(item) for item in raw if isinstance(item, dict)]


def _has_run_bound_initial_navigation(
    payload: dict[str, Any],
    *,
    application_url: str,
) -> bool:
    allowed = _allowed_navigation_evidence(payload)
    if len(allowed) != 1:
        return False
    try:
        expected_fingerprint = sha256(canonical_http_url(application_url).encode("utf-8")).hexdigest()
    except ValueError:
        return False
    navigation = allowed[0]
    return (
        str(_payload_value(navigation, "decision") or "") == "run_bound_initial_url"
        and str(_payload_value(navigation, "grant_id", "grantId") or "") == "initial_application_url"
        and str(_payload_value(navigation, "method") or "").upper() == "GET"
        and str(
            _payload_value(
                navigation,
                "url_fingerprint",
                "urlFingerprint",
            )
            or ""
        )
        == expected_fingerprint
    )


def _dry_run_evidence_exists(
    conn,
    *,
    tenant_id: str,
    job_id: str,
    materials_generation: int,
    profile_version: int,
    application_url: str,
    coverage: str,
    run_id: str | None = None,
) -> bool:
    rows = conn.execute(
        """
        SELECT payload_json FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND stage = 'apply' AND event_type = 'DryRunCompleted'
        ORDER BY event_id DESC
        LIMIT 24
        """,
        (tenant_id, job_id),
    ).fetchall()
    for row in rows:
        payload = _payload_from_row(row)
        payload_run_id = str(_payload_value(payload, "run_id", "runId") or "")
        if not payload_run_id:
            continue
        if run_id and payload_run_id != run_id:
            continue
        if str(_payload_value(payload, "coverage", "dry_run_coverage") or "") != coverage:
            continue
        if not _has_run_bound_initial_navigation(
            payload,
            application_url=application_url,
        ):
            continue
        payload_generation = _payload_int(payload, "materials_generation", "materialsGeneration")
        payload_profile_version = _payload_int(payload, "profile_version", "profileVersion")
        payload_url = str(_payload_value(payload, "application_url", "applicationUrl") or "")
        started_rows = conn.execute(
            """
            SELECT payload_json FROM job_events
            WHERE tenant_id = ? AND job_id = ?
              AND stage = 'apply' AND event_type = 'ApplyRunStarted'
            ORDER BY event_id DESC
            LIMIT 48
            """,
            (tenant_id, job_id),
        ).fetchall()
        for started_row in started_rows:
            started_payload = _payload_from_row(started_row)
            if str(_payload_value(started_payload, "run_id", "runId") or "") != payload_run_id:
                continue
            if (
                (
                    payload_generation
                    if payload_generation is not None
                    else _payload_int(
                        started_payload,
                        "materials_generation",
                        "materialsGeneration",
                    )
                )
                == materials_generation
                and (
                    payload_profile_version
                    if payload_profile_version is not None
                    else _payload_int(
                        started_payload,
                        "profile_version",
                        "profileVersion",
                    )
                )
                == profile_version
                and (
                    payload_url
                    or str(
                        _payload_value(
                            started_payload,
                            "application_url",
                            "applicationUrl",
                        )
                        or ""
                    )
                )
                == application_url
            ):
                return True
    return False


def _apply_run_started_payload(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    run_id: str,
) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT payload_json FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND stage = 'apply' AND event_type = 'ApplyRunStarted'
        ORDER BY event_id DESC
        LIMIT 48
        """,
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchall()
    for row in rows:
        payload = _payload_from_row(row)
        if str(_payload_value(payload, "run_id", "runId") or "") == run_id:
            return payload
    return {}


def _latest_dry_run_completion_payload(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    run_id: str,
) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT payload_json FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND stage = 'apply' AND event_type = 'DryRunCompleted'
        ORDER BY event_id DESC
        LIMIT 24
        """,
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchall()
    for row in rows:
        payload = _payload_from_row(row)
        if str(_payload_value(payload, "run_id", "runId") or "") == run_id:
            return payload
    return {}


def _dry_run_completion_binding(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    run_id: str,
    run_ctx: dict | None,
) -> dict[str, Any]:
    ctx = run_ctx or {}
    started_payload = _apply_run_started_payload(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        run_id=run_id,
    )
    completion_payload = _latest_dry_run_completion_payload(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        run_id=run_id,
    )
    materials_generation = _payload_int(ctx, "materials_generation", "materialsGeneration")
    if materials_generation is None:
        materials_generation = _payload_int(
            completion_payload,
            "materials_generation",
            "materialsGeneration",
        )
    if materials_generation is None:
        materials_generation = _payload_int(
            started_payload,
            "materials_generation",
            "materialsGeneration",
        )
    application_url = str(
        _payload_value(ctx, "application_url", "applicationUrl")
        or _payload_value(completion_payload, "application_url", "applicationUrl")
        or _payload_value(started_payload, "application_url", "applicationUrl")
        or ""
    )
    profile_version = _payload_int(ctx, "profile_version", "profileVersion")
    if profile_version is None:
        profile_version = _payload_int(
            completion_payload,
            "profile_version",
            "profileVersion",
        )
    if profile_version is None:
        profile_version = _payload_int(started_payload, "profile_version", "profileVersion")
    coverage = str(
        _payload_value(completion_payload, "coverage", "dry_run_coverage")
        or _payload_value(ctx, "coverage", "dry_run_coverage")
        or "partial"
    )
    if coverage not in {"full", "partial"}:
        coverage = "partial"
    blocked_channels = (
        _payload_value(completion_payload, "blocked_channels", "blockedChannels")
        or _payload_value(ctx, "blocked_channels", "blockedChannels")
        or []
    )
    if not isinstance(blocked_channels, list):
        blocked_channels = [str(blocked_channels)]
    allowed_navigations = _allowed_navigation_evidence(completion_payload) or _allowed_navigation_evidence(ctx)
    if not _has_run_bound_initial_navigation(
        {"allowed_navigations": allowed_navigations},
        application_url=application_url,
    ):
        coverage = "partial"
    return {
        "materials_generation": materials_generation,
        "application_url": application_url or None,
        "profile_version": profile_version,
        "coverage": coverage,
        "blocked_channels": [str(channel) for channel in blocked_channels if channel is not None and str(channel)],
        "allowed_navigations": allowed_navigations,
    }


def _approval_refusal_reason_unchecked(
    conn,
    *,
    tenant_id: str,
    job_id: str,
    materials_generation: Any,
    profile_version: int | None,
    application_url: str,
    check_email_binding: bool = True,
    email_source_row=None,
) -> str | None:
    decision = _latest_apply_review_decision(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
    )
    if not decision or decision.get("decision") != "approve_submit":
        return "awaiting_approval"
    try:
        current_materials_generation = int(materials_generation)
    except (TypeError, ValueError):
        return "approval_stale_materials"
    try:
        decision_materials_generation = int(decision.get("materials_generation"))
    except (TypeError, ValueError):
        return "approval_stale_materials"
    if decision_materials_generation != current_materials_generation:
        return "approval_stale_materials"
    from jobctrl.apply.cover_letter_binding import cover_letter_approval_current

    if not cover_letter_approval_current(conn, tenant_id, job_id, str(decision.get("decision_id") or ""), app_dir=config.APP_DIR):
        return "approval_stale_materials"
    try:
        decision_profile_version = int(decision.get("profile_version"))
    except (TypeError, ValueError):
        return "approval_stale_profile"
    if profile_version is None or decision_profile_version != profile_version:
        return "approval_stale_profile"
    if str(decision.get("application_url") or "") != application_url:
        return "approval_stale_url"
    email_candidate = _latest_email_application_candidate(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
    )
    if email_candidate or decision.get("email_recipient") or decision.get("email_attachment_artifact_id"):
        if check_email_binding:
            reason = _email_approval_binding_refusal(conn, tenant_id, job_id, decision, email_candidate, source_row=email_source_row)
            if reason:
                return reason
        elif (not email_candidate or
              str(decision.get("email_recipient") or "").lower() != str(email_candidate.get("recipient") or "").lower() or
              str(decision.get("email_attachment_artifact_id") or "") != str(email_candidate.get("attachment_artifact_id") or "")):
            return "approval_stale_email_candidate"
    if _dry_run_evidence_exists(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        materials_generation=current_materials_generation,
        profile_version=decision_profile_version,
        application_url=application_url,
        coverage="full",
    ):
        return None
    partial_override_run_id = str(decision.get("partial_override_run_id") or "")
    if partial_override_run_id:
        if _dry_run_evidence_exists(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
            materials_generation=current_materials_generation,
            profile_version=decision_profile_version,
            application_url=application_url,
            coverage="partial",
            run_id=partial_override_run_id,
        ):
            return None
        return "override_evidence_invalid"
    return "awaiting_dry_run"


def _approval_refusal_reason(
    conn,
    *,
    tenant_id: str,
    job_id: str,
    materials_generation: Any,
    profile_version: int | None,
    application_url: str,
    check_email_binding: bool = True,
    email_source_row=None,
) -> str | None:
    reason = _approval_refusal_reason_unchecked(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        materials_generation=materials_generation,
        profile_version=profile_version,
        application_url=application_url,
        check_email_binding=check_email_binding,
        email_source_row=email_source_row,
    )
    if reason is not None and reason not in APPROVAL_GATE_REFUSAL_REASONS:
        raise RuntimeError("apply approval gate produced an unsupported refusal reason")
    return reason


def _load_blocked():
    from jobctrl.config import load_blocked_sites

    return load_blocked_sites()


def _row_to_job_dict(row, *, run_id: ApplyRunId | None = None) -> dict[str, Any]:
    job = dict(row)
    if run_id is not None:
        job["apply_run_id"] = str(run_id)
    return job


def _apply_candidate_select_parts() -> tuple[str, str]:
    attempts_subquery = (
        "(SELECT COALESCE(jss_a.attempt_count, 0) "
        "FROM job_stage_states jss_a "
        "WHERE jss_a.tenant_id = jobs.tenant_id "
        "AND jss_a.job_id = jobs.job_id "
        "AND jss_a.stage = 'apply' LIMIT 1) AS apply_attempts"
    )
    columns = (
        f"jobs.tenant_id AS tenant_id, jobs.job_id AS job_id, "
        f"jobs.url AS url, jobs.title AS title, jobs.site AS site, "
        f"{_EFFECTIVE_APPLICATION_URL} AS application_url, "
        f"{_EFFECTIVE_TAILOR_PATH} AS tailored_resume_path, "
        f"jm.jm_resume_pdf_path AS resume_pdf_path, "
        f"jm.jm_resume_pdf_artifact_id AS resume_pdf_artifact_id, "
        f"jm.jm_generation AS materials_generation, "
        f"{_EFFECTIVE_FIT_SCORE} AS fit_score, "
        f"jobs.location AS location, jobs.description AS description, "
        f"{_EFFECTIVE_FULL_DESCRIPTION} AS full_description, "
        f"{_EFFECTIVE_COVER_PATH} AS cover_letter_path, "
        f"{_EFFECTIVE_APPLIED_AT} AS applied_at, "
        f"{_EFFECTIVE_APPLY_STATUS} AS apply_status, "
        f"{attempts_subquery}"
    )
    joins = (
        f"{_LATEST_SCORE_JOIN} {_LATEST_MATERIALS_JOIN} "
        f"{_SCORE_DOWNSTREAM_STATE_JOIN} {_ENRICHMENT_JOIN} "
        f"{_LATEST_APPLY_RUN_JOIN} {_ACTIVE_STATE_JOIN}"
    )
    return columns, joins


def _select_apply_candidates(conn, tenant_id, target_job_id, min_score, *, check_controls=True, include_running=False):
    common_columns, common_joins = _apply_candidate_select_parts()
    controls = (APPLY_ADMISSIBLE_FOR_OWNER_RECOVERY_SQL if include_running else APPLY_ADMISSIBLE_SQL) if check_controls else '1=1'

    if target_job_id is not None:
        target_row = conn.execute(
            f"""
            SELECT {common_columns}
            FROM jobs {common_joins}
            WHERE jobs.tenant_id = ?
              AND jobs.job_id = ?
              AND {_READY_TAILORED_RESUME_WITH_PDF}
              AND {controls}
              AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM}
              AND {_SCORE_CURRENT_FOR_DOWNSTREAM}
              AND {_NOT_CLOSED_ACTIVE_STATE}
            LIMIT 1
            """,
            (tenant_id, str(canonical_job_id(str(target_job_id)))),
        ).fetchone()
        candidate_rows = [target_row] if target_row is not None else []
    else:
        blocked_sites, blocked_patterns = _load_blocked()
        params: list[Any] = [
            tenant_id,
            config.DEFAULTS["max_apply_attempts"],
            min_score,
        ]
        site_clause = ""
        if blocked_sites:
            placeholders = ",".join("?" * len(blocked_sites))
            site_clause = f"AND jobs.site NOT IN ({placeholders})"
            params.extend(blocked_sites)
        url_clauses = ""
        if blocked_patterns:
            url_clauses = " ".join("AND jobs.url NOT LIKE ?" for _ in blocked_patterns)
            params.extend(blocked_patterns)
        excluded_states = "'succeeded', 'needs_verification'" if include_running else "'running', 'succeeded', 'needs_verification'"
        rows = conn.execute(
            f"""
            SELECT {common_columns}
            FROM jobs {common_joins}
            WHERE jobs.tenant_id = ?
              AND {_READY_TAILORED_RESUME_WITH_PDF}
              AND {controls}
              AND {_EFFECTIVE_APPLY_TARGET_URL} IS NOT NULL
              AND {_EFFECTIVE_APPLY_TARGET_URL} != ''
              AND NOT EXISTS (
                  SELECT 1 FROM job_stage_states jss_active
                  WHERE jss_active.tenant_id = jobs.tenant_id
                    AND jss_active.job_id = jobs.job_id
                    AND jss_active.stage = 'apply'
                    AND jss_active.state IN ({excluded_states})
              )
              AND COALESCE(
                  (SELECT jss_a.attempt_count FROM job_stage_states jss_a
                   WHERE jss_a.tenant_id = jobs.tenant_id
                     AND jss_a.job_id = jobs.job_id
                     AND jss_a.stage = 'apply'
                   LIMIT 1), 0
              ) < ?
              AND {_EFFECTIVE_FIT_SCORE} >= ?
              AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM}
              AND {_SCORE_CURRENT_FOR_DOWNSTREAM}
              AND {_NOT_CLOSED_ACTIVE_STATE}
              AND {_ENRICHMENT_NOT_QUARANTINED}
              {site_clause}
              {url_clauses}
            ORDER BY {_EFFECTIVE_FIT_SCORE} DESC, jobs.url
            """,
            params,
        ).fetchall()
        candidate_rows = rows
    return candidate_rows


def _select_owned_apply_candidate(conn, tenant_id, job_id, run_id):
    """Read source binding for this already-claimed run under its writer fence.

    This is never a new-claim selector: the exact latest claim and started run
    must still own a running row, and every durable no-send control still holds.
    """
    if not conn.in_transaction:
        raise RuntimeError("Owned Apply source reads require the writer transaction")
    if not run_id or not _owns_apply(conn, tenant_id, job_id, run_id):
        return None
    claim = _canonical_apply_claim(conn, tenant_id, job_id)
    if not claim or claim.get("run_id") != str(run_id):
        return None
    allowed = conn.execute(
        f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_ADMISSIBLE_FOR_OWNER_RECOVERY_SQL})",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if not allowed:
        return None
    rows = _select_apply_candidates(conn, tenant_id, canonical_job_id(str(job_id)), 0, check_controls=False)
    return rows[0] if rows else None


def _read_owned_refusal_source(conn, tenant_id, job_id, run_id, *, stopped=False):
    """Read exact claimed sources for refusal settlement, never admission."""
    if not conn.in_transaction:
        raise RuntimeError("Owned Apply refusal reads require the writer transaction")
    claim = _canonical_apply_claim(conn, tenant_id, job_id)
    if (not run_id or not claim or claim.get("run_id") != str(run_id)
            or _latest_apply_run_started_run_id(conn, tenant_id=tenant_id, job_id=job_id) != str(run_id)):
        return None
    if stopped:
        allowed = conn.execute(
            f"SELECT 1 FROM jobs JOIN job_stage_states state ON state.tenant_id=jobs.tenant_id "
            f"AND state.job_id=jobs.job_id AND state.stage='apply' AND state.state='skipped' "
            f"WHERE jobs.tenant_id=? AND jobs.job_id=? AND ({APPLY_MANUAL_STOP_SQL})",
            (str(tenant_id), str(job_id)),
        ).fetchone()
        if not allowed:
            return None
    elif not _owns_apply(conn, tenant_id, job_id, run_id):
        return None
    if conn.execute(
        f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_SUBMIT_INTENT_SQL})",
        (str(tenant_id), str(job_id)),
    ).fetchone():
        return None
    columns, joins = _apply_candidate_select_parts()
    return conn.execute(
        f"SELECT {columns} FROM jobs {joins} WHERE jobs.tenant_id=? AND jobs.job_id=? LIMIT 1",
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchone()


def _record_repeat_check_blocked(conn, *, tenant_id, job_id, failure_code):
    """Record a changed block state once, including concurrent acquisition passes."""
    owns_transaction = not conn.in_transaction
    if owns_transaction:
        conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? "
            "AND stage='apply' AND event_type='RepeatApplicationCheckBlocked' ORDER BY event_id DESC LIMIT 1",
            (str(tenant_id), str(job_id)),
        ).fetchone()
        if row is None or _payload_from_row(row).get("failureCode") != failure_code:
            record_job_event(
                conn, job_id, "apply", "RepeatApplicationCheckBlocked",
                tenant_id=TenantId(str(tenant_id)), payload={"failureCode": failure_code},
            )
        if owns_transaction:
            conn.commit()
    except BaseException:
        if owns_transaction:
            conn.rollback()
        raise


_DIRECT_DISPATCH = object()


def acquire_job(
    target_job_id: JobId | None = None,
    min_score: int = 7,
    worker_id: int = 0,
    run_ctx: dict | None = None,
    approval_required: bool = True,
    tenant_id: str | None = None,
    retry_refused_email: bool = False,
) -> dict | None:
    """Claim the first locally eligible candidate that passes availability.

    A refused candidate is visited once per poll; another candidate can still
    proceed. Each network check follows that candidate's cheap local gates.
    """
    if run_ctx is None:
        run_ctx = {}
    if 'dispatch_frontier' not in run_ctx:
        tenant = str(tenant_id or run_ctx.get('tenant_id') or LOCAL_TENANT)
        run_ctx['dispatch_frontier'] = capture_apply_dispatch_frontier(get_connection(), tenant_id=tenant)[0]
    excluded: set[str] = set()
    refreshed: set[str] = set()
    retry_refused_email = bool(retry_refused_email and target_job_id is not None)
    while True:
        result = _acquire_job_candidate(
            target_job_id, min_score, worker_id, run_ctx, approval_required, tenant_id, excluded,
            refreshed=refreshed, retry_refused_email=retry_refused_email,
        )
        if isinstance(result, str):
            excluded.add(result)
            continue
        return result


def _acquire_job_candidate(
    target_job_id: JobId | None = None,
    min_score: int = 7,
    worker_id: int = 0,
    run_ctx: dict | None = None,
    approval_required: bool = True,
    tenant_id: str | None = None,
    excluded: set[str] | None = None,
    *,
    refreshed: set[str],
    retry_refused_email: bool = False,
) -> dict | str | None:
    """Atomically acquire the next job to apply to.

    The lock is taken on ``job_stage_states.apply.state == 'running'`` —
    PR 4 of the Temporal stack made the canonical stage row the only
    apply lock; the bespoke ``apply_runs`` table is gone. The
    ``ApplyRunStarted`` event is published on the same transaction so
    the projection builder materialises the corresponding
    ``apply_run_projections`` row on the next refresh.
    """
    conn = get_connection()
    from datetime import timedelta
    from jobctrl.enrichment.availability import (
        require_fresh_active,
        assert_fresh_candidate,
        read_availability,
        fresh_active,
    )

    tenant_id = str(tenant_id or (run_ctx.get("tenant_id") if run_ctx else None) or LOCAL_TENANT)
    if target_job_id is not None:
        target_job_id = canonical_job_id(str(target_job_id))
    from jobctrl.domain.apply.repeat_application import prepare_repeat_application
    from jobctrl.domain.determinations import DeterminationFailure

    from jobctrl.runtime import is_bundled_runtime
    repeat_blocked_ids: set[str] = set()
    # This discovery pass only recovers the existing exact owner; it cannot
    # admit a claim. Targeted native recovery also needs the running row.
    # Normal admission below still applies every Stop and intent control.
    recovery_running = target_job_id is not None or not is_bundled_runtime()
    for candidate in _select_apply_candidates(conn, tenant_id, target_job_id, min_score,
                                               check_controls=not recovery_running, include_running=recovery_running):
        if not apply_dispatch_allows(conn, tenant_id=tenant_id, job_id=candidate['job_id'], frontier=run_ctx['dispatch_frontier']):
            continue
        if str(candidate["job_id"]) in (excluded or set()):
            continue
        if _has_unsettled_apply_owner(conn, tenant_id=tenant_id, job_id=str(candidate["job_id"])):
            repeat_blocked_ids.add(str(candidate["job_id"]))
        else:
            break
    if not (run_ctx or {}).get("dry_run"):
        for candidate in _select_apply_candidates(conn, tenant_id, target_job_id, min_score):
            if not apply_dispatch_allows(conn, tenant_id=tenant_id, job_id=candidate['job_id'], frontier=run_ctx['dispatch_frontier']):
                continue
            if str(candidate["job_id"]) not in (excluded or set()):
                if not retry_refused_email and _email_refusal_is_parked(
                    conn, tenant_id, str(candidate["job_id"]), candidate,
                ):
                    continue
                if _has_unsettled_apply_owner(conn, tenant_id=tenant_id, job_id=str(candidate["job_id"])):
                    repeat_blocked_ids.add(str(candidate["job_id"]))
                    continue
                try:
                    prepare_repeat_application(conn, target_job_id=candidate["job_id"], tenant_id=TenantId(tenant_id))
                except DeterminationFailure as exc:
                    repeat_blocked_ids.add(str(candidate["job_id"]))
                    _record_repeat_check_blocked(
                        conn, job_id=candidate["job_id"], tenant_id=tenant_id, failure_code=exc.code,
                    )
        conn.commit()
    dry_run = bool(run_ctx.get("dry_run")) if run_ctx else False
    try:
        conn.execute("BEGIN IMMEDIATE")
        candidate_rows = [
            row
            for row in _select_apply_candidates(conn, tenant_id, target_job_id, min_score)
            if str(row["job_id"]) not in (excluded or set()) | repeat_blocked_ids
            and apply_dispatch_allows(conn, tenant_id=tenant_id, job_id=row['job_id'], frontier=run_ctx['dispatch_frontier'])
            and not _has_unsettled_apply_owner(conn, tenant_id=tenant_id, job_id=str(row["job_id"]))
            and (dry_run or retry_refused_email or not _email_refusal_is_parked(conn, tenant_id, str(row["job_id"]), row))
        ]
        if not candidate_rows:
            conn.rollback()
            return None

        repeat_assessment: dict[str, Any] | None = None
        row = candidate_rows[0]
        if not dry_run:
            row = None
            for candidate in candidate_rows:
                try:
                    candidate_assessment = evaluate_repeat_application(
                        conn,
                        tenant_id=tenant_id,
                        target_job_id=candidate["job_id"],
                    )
                except DeterminationFailure as exc:
                    _record_repeat_check_blocked(
                        conn, job_id=candidate["job_id"], tenant_id=tenant_id, failure_code=exc.code,
                    )
                    continue
                if candidate_assessment["status"] in {"clear", "override_ready"}:
                    row = candidate
                    repeat_assessment = candidate_assessment
                    break
                add_event(
                    f"[W{worker_id}] Repeat application protection "
                    f"({candidate_assessment['status']}) for "
                    f"{(candidate['title'] or candidate['url'])[:40]}"
                , worker_id=worker_id)
                logger.warning(
                    "Repeat application protection refused %s; status=%s fingerprint=%s",
                    candidate["url"],
                    candidate_assessment["status"],
                    candidate_assessment.get("evidenceFingerprint"),
                )
            if row is None:
                conn.commit()
                return None

        # Skip manual ATS sites (the agent cannot solve them).
        from jobctrl.config import is_manual_ats

        job_id = str(row["job_id"])
        url = row["url"]
        apply_url = row["application_url"] or url
        if is_manual_ats(apply_url):
            now = _utc_now()
            ensure_job_stage_rows(conn, job_id, tenant_id=tenant_id)
            set_stage_state(
                conn,
                job_id,
                "apply",
                "skipped",
                tenant_id=tenant_id,
                finished_at=now,
                error_code="MANUAL_ATS",
                error_message="manual ATS",
                retryable=False,
            )
            run_id = new_apply_run_id()
            record_job_event(
                conn,
                job_id,
                "apply",
                "ApplyManualSkip",
                tenant_id=tenant_id,
                level="info",
                message="manual ATS",
                payload={
                    "run_id": str(run_id),
                    "result": "manual",
                    "started_at": now,
                    "finished_at": now,
                    "duration_ms": 0,
                    "worker_id": worker_id,
                },
            )
            conn.commit()
            logger.info("Skipping manual ATS: %s", url[:80])
            return job_id

        # Targeted-mode also enforces the no-active + max-attempts invariants.
        if _has_active_apply(conn, tenant_id=tenant_id, job_id=job_id):
            conn.rollback()
            return job_id
        if _has_succeeded_apply(conn, tenant_id=tenant_id, job_id=job_id):
            conn.rollback()
            return job_id
        if _has_needs_verification_apply(conn, tenant_id=tenant_id, job_id=job_id):
            conn.rollback()
            return job_id
        attempts = _attempt_count_for(conn, tenant_id=tenant_id, job_id=job_id)
        if attempts >= int(config.DEFAULTS["max_apply_attempts"]):
            conn.rollback()
            return job_id
        if approval_required and not dry_run:
            refusal_reason = _approval_refusal_reason(
                conn,
                tenant_id=tenant_id,
                job_id=job_id,
                materials_generation=row["materials_generation"],
                profile_version=_current_profile_version(conn, tenant_id=tenant_id),
                application_url=apply_url,
            )
            if refusal_reason:
                # The only writes before approval are immutable protection
                # assessments for higher-ranked candidates that were skipped.
                # Keep those audit facts even though this candidate cannot be
                # claimed yet.
                conn.commit()
                add_event(f"[W{worker_id}] Awaiting apply approval ({refusal_reason}) for {(row['title'] or url)[:40]}", worker_id=worker_id)
                logger.info(
                    "Apply approval required for %s; refusal_reason=%s",
                    url,
                    refusal_reason,
                )
                return job_id

        # Release the local-selection writer before any employer request. Only
        # this eligible candidate is checked; an approval poll never acquires.
        allow_unknown = dry_run or _has_current_apply_review(conn, tenant_id, job_id)
        cached = read_availability(conn, job_id, tenant_id=tenant_id)
        if (
            not allow_unknown
            and cached.get("verdict") == "unknown"
            and cached.get("postingUrl") == url
            and not cached["overdue"]
        ):
            conn.commit()
            return job_id
        needs_refresh = not fresh_active(conn, job_id, tenant_id=tenant_id, max_age=timedelta(minutes=15))
        if needs_refresh and refreshed:
            conn.commit()
            return job_id
        conn.commit()
        if needs_refresh:
            # One poll may refresh one posting. Later peers can still claim
            # fresh evidence; its final writer fence handles concurrent changes.
            refreshed.add(job_id)
            try:
                require_fresh_active(
                    job_id,
                    tenant_id=tenant_id,
                    conn=conn,
                    max_age=timedelta(minutes=15),
                    expected_posting_url=url,
                    allow_unknown=allow_unknown,
                )
            except Exception:
                logger.info("Apply deferred for %s: check availability or use supervised Apply", job_id)
                return job_id
        conn.execute("BEGIN IMMEDIATE")
        current_rows = _select_apply_candidates(conn, tenant_id, canonical_job_id(job_id), min_score)
        current = current_rows[0] if current_rows else None
        if (
            current is None
            or not apply_dispatch_allows(conn, tenant_id=tenant_id, job_id=job_id, frontier=run_ctx['dispatch_frontier'])
            or current["url"] != url
            or current["materials_generation"] != row["materials_generation"]
            or (current["application_url"] or current["url"]) != apply_url
            or _has_unsettled_apply_owner(conn, tenant_id=tenant_id, job_id=job_id)
            or _has_active_apply(conn, tenant_id=tenant_id, job_id=job_id)
            or _has_succeeded_apply(conn, tenant_id=tenant_id, job_id=job_id)
            or _has_needs_verification_apply(conn, tenant_id=tenant_id, job_id=job_id)
            or _attempt_count_for(conn, tenant_id=tenant_id, job_id=job_id)
            >= int(config.DEFAULTS["max_apply_attempts"])
        ):
            conn.rollback()
            return job_id
        if not dry_run:
            if not retry_refused_email and _email_refusal_is_parked(conn, tenant_id, job_id, current):
                conn.commit()
                return job_id
            repeat_assessment = evaluate_repeat_application(conn, tenant_id=tenant_id, target_job_id=job_id)
            if repeat_assessment["status"] not in {"clear", "override_ready"}:
                conn.commit()
                return job_id
            if approval_required and _approval_refusal_reason(
                conn,
                tenant_id=tenant_id,
                job_id=job_id,
                materials_generation=current["materials_generation"],
                profile_version=_current_profile_version(conn, tenant_id=tenant_id),
                application_url=apply_url,
            ):
                conn.commit()
                return job_id
        assert_fresh_candidate(
            conn,
            job_id,
            url,
            tenant_id=tenant_id,
            max_age=timedelta(minutes=15),
            allow_unknown=dry_run or _has_current_apply_review(conn, tenant_id, job_id),
        )
        row = current
        attempts = _attempt_count_for(conn, tenant_id=tenant_id, job_id=job_id)

        now = _utc_now()
        run_id = ApplyRunId((run_ctx.get("run_id") if run_ctx else None) or new_apply_run_id())
        decision = _latest_apply_review_decision(conn, tenant_id=tenant_id, job_id=job_id)
        # The channel can first be discovered during this run. Bind the
        # current authority even when no email candidate or approval exists.
        email_authority = None if dry_run else _email_refusal_authority(conn, tenant_id, job_id, row)
        launcher_owner = (run_ctx or {}).get("launcher_run")
        if launcher_owner is not None:
            launcher_owner.claim(tenant_id, job_id, str(run_id), worker_id)
        record_job_event(conn, job_id, "apply", "ApplyClaimAcquired", tenant_id=tenant_id,
                         payload={"run_id": str(run_id), "launcher_id": launcher_owner.identity if launcher_owner else None})
        repeat_override_id = None
        if repeat_assessment and repeat_assessment["status"] == "override_ready":
            repeat_override_id = consume_repeat_application_override(
                conn,
                repeat_assessment,
                tenant_id=tenant_id,
                target_job_id=job_id,
                run_id=str(run_id),
                consumed_at=now,
            )
        ensure_job_stage_rows(conn, job_id, tenant_id=tenant_id)
        # Reset prior retryable terminal state (failed / exhausted /
        # canceled / skipped) back to pending so the §8.5 state machine accepts
        # the pending → running transition.
        prior_row = conn.execute(
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply' LIMIT 1",
            (tenant_id, job_id),
        ).fetchone()
        if prior_row is not None and prior_row[0] not in {
            "pending",
            "running",
            "succeeded",
            "needs_verification",
        }:
            set_stage_state(
                conn,
                job_id,
                "apply",
                "pending",
                tenant_id=tenant_id,
                validate_transition=False,
            )
        set_stage_state(
            conn,
            job_id,
            "apply",
            "running",
            tenant_id=tenant_id,
            started_at=now,
            attempt_count=attempts + 1,
        )
        record_job_event(
            conn,
            job_id,
            "apply",
            "ApplyRunStarted",
            tenant_id=tenant_id,
            message="Apply agent acquired job",
            payload={
                "run_id": str(run_id),
                "model": (run_ctx.get("model") if run_ctx else None),
                "dry_run": bool(run_ctx.get("dry_run")) if run_ctx else False,
                "worker_id": worker_id,
                "started_at": now,
                "headless": bool(run_ctx.get("headless")) if run_ctx else False,
                "attempts": attempts + 1,
                "email_authority": email_authority,
                "workflow_id": run_ctx.get("workflow_id") if run_ctx else None,
                "dispatch_frontier": run_ctx['dispatch_frontier'],
                "materials_generation": row["materials_generation"],
                "application_url": apply_url,
                "profile_version": _current_profile_version(conn, tenant_id=tenant_id),
                "repeat_application_override_id": repeat_override_id,
                "repeat_application_evidence_fingerprint": (
                    repeat_assessment.get("evidenceFingerprint") if repeat_assessment else None
                ),
            },
        )
        # Capture canonical sources before releasing claim admission. A writer
        # must not replace accepted material in the claim-to-capture gap.
        job_dict = _row_to_job_dict(row, run_id=run_id)
        job_dict["email_source_binding"] = _email_source_binding(conn, tenant_id, job_id, job_dict)
        if decision:
            job_dict["approved_email_recipient"] = str(decision.get("email_recipient") or "")
            job_dict["approved_email_attachment_artifact_id"] = str(decision.get("email_attachment_artifact_id") or "")
        conn.commit()

        if run_ctx is not None:
            run_ctx["run_id"] = str(run_id)
            run_ctx.setdefault("worker_id", worker_id)
            run_ctx["materials_generation"] = row["materials_generation"]
            run_ctx["application_url"] = apply_url
            run_ctx["tenant_id"] = tenant_id
            run_ctx["job_id"] = job_id
            run_ctx["profile_version"] = job_dict["email_source_binding"]["profile_version"]
            run_ctx["repeat_application_override_id"] = repeat_override_id
            run_ctx["repeat_application_evidence_fingerprint"] = (
                repeat_assessment.get("evidenceFingerprint") if repeat_assessment else None
            )

        return job_dict
    except Exception:
        conn.rollback()
        raise


def _register_apply_log_artifact(
    conn,
    job_id: JobId,
    *,
    tenant_id: TenantId,
    worker_id: int | None,
    run_id: str,
    occurred_at: str,
) -> None:
    """Record the per-worker apply log (``LOG_DIR/worker-{worker_id}.log``,
    written by :class:`ClaudeCodeCliAdapter`) as a ``job_artifacts`` row;
    no-op when ``worker_id`` is ``None`` (manual ``mark_result`` calls)."""
    if worker_id is None:
        return
    log_path = config.LOG_DIR / f"worker-{int(worker_id)}.log"
    _record_apply_artifact(
        conn,
        job_id,
        tenant_id=tenant_id,
        artifact_type="apply_log",
        path=log_path,
        status="active",
        created_at=occurred_at,
        metadata={"run_id": str(run_id), "worker_id": int(worker_id)},
    )


def _record_apply_artifact(
    conn,
    job_id: JobId,
    *,
    tenant_id: TenantId,
    artifact_type: str,
    path: Path,
    status: str = "active",
    created_at: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Persist an Apply artifact against the exact tenant/job aggregate."""

    stable_job_id = canonical_job_id(str(job_id))
    try:
        size_bytes = path.stat().st_size
    except OSError:
        size_bytes = None
    conn.execute(
        """
        INSERT INTO job_artifacts (
            tenant_id, job_id, stage, artifact_type, status, path,
            created_at, size_bytes, metadata_json
        ) VALUES (?, ?, 'apply', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, job_id, stage, artifact_type, path) DO UPDATE SET
            status = excluded.status,
            created_at = excluded.created_at,
            size_bytes = excluded.size_bytes,
            metadata_json = excluded.metadata_json
        """,
        (
            str(tenant_id),
            str(stable_job_id),
            artifact_type,
            status,
            str(path),
            created_at or _utc_now(),
            size_bytes,
            json.dumps(metadata or {}, separators=(",", ":"), sort_keys=True),
        ),
    )


def _posting_url_for_job_id(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> str | None:
    row = conn.execute(
        """
        SELECT locator_value
        FROM job_locators
        WHERE tenant_id = ? AND job_id = ?
          AND locator_kind = 'posting_url' AND is_current = 1
        ORDER BY last_seen_at DESC
        LIMIT 1
        """,
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT url FROM jobs WHERE tenant_id = ? AND job_id = ? LIMIT 1",
            (str(tenant_id), str(job_id)),
        ).fetchone()
    if row is None:
        return None
    return str(row[0] or "") or None


def _record_apply_terminal_event_once(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    run_id: str,
    event_type: str,
    level: str = "info",
    message: str,
    payload: dict[str, Any],
) -> None:
    if _has_apply_event(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        run_id=run_id,
        event_types={event_type},
    ):
        return
    record_job_event(
        conn,
        job_id,
        "apply",
        event_type,
        tenant_id=tenant_id,
        level=level,
        message=message,
        payload=payload,
        defer_publication=(
            event_type == "ApplicationSubmitted"
            and bool((_email_intent(conn, tenant_id, job_id, run_id) or {}).get("operation"))
        ),
    )


class ApplyOwnershipLost(RuntimeError):
    """This attempt no longer owns canonical Apply publication."""


def _begin_apply_write(conn, tenant_id, job_id) -> None:
    if conn.in_transaction:
        conn.execute("UPDATE job_stage_states SET state = state WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
                     (str(tenant_id), str(job_id)))
    else:
        conn.execute("BEGIN IMMEDIATE")


def _owns_apply(conn, tenant_id, job_id, run_id) -> bool:
    owner = _latest_apply_run_started_run_id(conn, tenant_id=tenant_id, job_id=job_id)
    state = conn.execute("SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
                         (str(tenant_id), str(job_id))).fetchone()
    if owner != str(run_id) or state is None or state[0] != "running":
        return False
    claim = _canonical_apply_claim(conn, tenant_id, job_id)
    if claim is not None and claim.get("run_id") != str(run_id):
        return False
    stopped = conn.execute(
        f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_MANUAL_STOP_SQL})",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    return stopped is None


def _email_authority_refusal_key(tenant_id, job_id, run_id):
    return "apply-email-refusal:" + sha256(json.dumps(
        [str(tenant_id), str(job_id), str(run_id)], separators=(",", ":"),
    ).encode()).hexdigest()


def _owned_email_authority_refusal_reason(conn, tenant_id, job_id, run_id):
    row = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type=? AND idempotency_key=? AND json_extract(payload_json,'$.run_id')=? "
        "ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id), EMAIL_AUTHORITY_REFUSAL_EVENT,
         _email_authority_refusal_key(tenant_id, job_id, run_id), str(run_id)),
    ).fetchone()
    payload = _payload_from_row(row) if row else {}
    reason = payload.get("reason")
    if (payload.get("submission_channel") != "email" or reason not in
            APPROVAL_GATE_REFUSAL_REASONS | {"approval_authority_unavailable", "email_application_approval_required"}):
        return None
    return reason


def _email_refusal_authority(conn, tenant_id, job_id, row):
    """Hash the current review and its sources without persisting private content."""
    try:
        decision = _latest_apply_review_decision(conn, tenant_id=tenant_id, job_id=job_id)
        review = None
        if decision:
            review_row = conn.execute(
                "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? "
                "AND event_type='ApplyReviewDecisionRecorded' AND json_extract(payload_json,'$.decisionId')=? "
                "ORDER BY event_id DESC LIMIT 1", (tenant_id, job_id, decision.get("decision_id")),
            ).fetchone()
            review = _payload_from_row(review_row) if review_row else None
        dry_runs = [tuple(item) for item in conn.execute(
            "SELECT event_type,payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
            "AND (event_type='DryRunCompleted' OR (event_type='ApplyRunStarted' "
            "AND json_extract(payload_json,'$.dry_run')=1)) ORDER BY event_id DESC LIMIT 72",
            (tenant_id, job_id),
        )]
        candidate = _latest_email_application_candidate(conn, tenant_id=tenant_id, job_id=job_id) or {}
        values = [candidate.get(key) for key in (
            "recipient", "subject", "body", "attachment_artifact_id", "attachment_name",
        )]
        source = _email_source_binding(conn, tenant_id, job_id, row)
        current_refusal = _approval_refusal_reason(
            conn, tenant_id=tenant_id, job_id=job_id,
            materials_generation=source["materials_generation"], profile_version=source["profile_version"],
            application_url=source["application_url"],
            email_source_row=row,
        )
        base = [decision, review, source, dry_runs]
        def digest(value):
            return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        return {"base": digest(base), "full": digest([base, values, current_refusal]), "candidate_run_id": candidate.get("run_id")}
    except Exception:  # noqa: BLE001 — unchanged unavailable authority must not spin
        return {"base": "unavailable", "full": "unavailable", "candidate_run_id": None}


def _record_email_refusal_park(conn, tenant_id, job_id, run_id, *, source_row=None):
    started = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplyRunStarted' AND json_extract(payload_json,'$.run_id')=? ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id), str(run_id)),
    ).fetchone()
    initial = _payload_from_row(started).get("email_authority") if started else None
    row = source_row if source_row is not None else _read_owned_refusal_source(conn, tenant_id, job_id, run_id)
    if not isinstance(initial, dict) or row is None:
        return False
    current = _email_refusal_authority(conn, str(tenant_id), str(job_id), row)
    # A newer review or other source change during this run deserves a new
    # attempt. This run's own newly recorded candidate is not such a change.
    fingerprints_prove_change = all(
        isinstance(value, str) and len(value) == 64
        for value in (initial.get("full"), initial.get("base"), current["full"], current["base"])
    )
    if fingerprints_prove_change and initial.get("full") != current["full"] and not (
        initial.get("base") == current["base"] and current["candidate_run_id"] == str(run_id)
    ):
        return True
    record_job_event(
        conn, job_id, "apply", "ApplyEmailAuthorityParked", tenant_id=tenant_id,
        payload={"run_id": str(run_id), "authority_sha256": current["full"]},
        idempotency_key=_email_authority_refusal_key(tenant_id, job_id, run_id) + ":park",
        defer_publication=True,
    )
    return True


def _email_refusal_is_parked(conn, tenant_id, job_id, row):
    claim = _canonical_apply_claim(conn, tenant_id, job_id)
    run_id = str(claim.get("run_id") or "") if claim else ""
    if not run_id or not _owned_email_authority_refusal_reason(conn, tenant_id, job_id, run_id):
        return False
    if _has_apply_submit_intent(conn, tenant_id=tenant_id, job_id=job_id, run_id=run_id):
        return False
    event = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplyEmailAuthorityParked' AND idempotency_key=? "
        "AND json_extract(payload_json,'$.run_id')=? ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id), _email_authority_refusal_key(tenant_id, job_id, run_id) + ":park", run_id),
    ).fetchone()
    if not event:
        return False
    return _payload_from_row(event).get("authority_sha256") == _email_refusal_authority(conn, tenant_id, job_id, row)["full"]


def _attempt_count_after_email_refusal(conn, tenant_id, job_id, run_id):
    """Refund only this active claim's durable, pre-intent owned refusal."""
    attempts = _attempt_count_for(conn, tenant_id=tenant_id, job_id=job_id)
    if not run_id or not _owns_apply(conn, tenant_id, job_id, run_id):
        return attempts
    if _has_apply_submit_intent(conn, tenant_id=tenant_id, job_id=job_id, run_id=run_id):
        return attempts
    claim = _canonical_apply_claim(conn, tenant_id, job_id)
    if not claim or claim.get("run_id") != str(run_id):
        return attempts
    if not _owned_email_authority_refusal_reason(conn, tenant_id, job_id, run_id):
        return attempts
    started = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplyRunStarted' AND json_extract(payload_json,'$.run_id')=? "
        "AND json_type(payload_json,'$.attempts')='integer' ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id), str(run_id)),
    ).fetchone()
    if not started or _payload_from_row(started).get("attempts") != attempts or attempts < 1:
        return attempts
    return attempts - 1


def _refund_email_refusal_and_park(conn, tenant_id, job_id, run_id):
    """Record the matching park with its refund under the caller's writer lock."""
    attempts = _attempt_count_for(conn, tenant_id=tenant_id, job_id=job_id)
    restored = _attempt_count_after_email_refusal(conn, tenant_id, job_id, run_id)
    if restored < attempts:
        if not _record_email_refusal_park(conn, tenant_id, job_id, run_id):
            return attempts
        _record_owned_refusal_refund(conn, tenant_id, job_id, run_id, attempts, restored)
    return restored


def _record_owned_refusal_refund(conn, tenant_id, job_id, run_id, before, after):
    """Record only an already-validated refund in the caller's transaction."""
    claim = _canonical_apply_claim(conn, tenant_id, job_id)
    if not claim or claim.get("run_id") != str(run_id) or before != after + 1:
        raise ApplyOwnershipLost("Email refusal refund lost its original claim")
    payload = {"run_id": str(run_id), "launcher_id": claim.get("launcher_id"),
               "attempts_before": before, "attempts_after": after}
    key = _email_authority_refusal_key(tenant_id, job_id, run_id) + ":refund"
    record_job_event(
        conn, job_id, "apply", "ApplyEmailAuthorityRefusalRefunded", tenant_id=tenant_id,
        payload=payload, idempotency_key=key, defer_publication=True,
    )
    saved = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplyEmailAuthorityRefusalRefunded' AND idempotency_key=?",
        (str(tenant_id), str(job_id), key),
    ).fetchone()
    if not saved or any(_payload_from_row(saved).get(k) != v for k, v in payload.items()):
        raise ApplyOwnershipLost("Email refusal refund evidence does not match its claim")


def _refund_refusal_before_manual_stop(conn, tenant_id, job_id, run_id):
    """Refund and park an exact pre-Stop refusal without changing the Stop.

    The writer serializes this with Stop, intent, and successor claims. A
    refusal recorded after the first Stop, an unprovable source, any submit
    intent, or a changed claim leaves the attempt untouched.
    """
    if not conn.in_transaction:
        raise RuntimeError("Stopped Apply refund requires a writer transaction")
    if not run_id or _latest_apply_run_started_run_id(conn, tenant_id=tenant_id, job_id=job_id) != str(run_id):
        return
    claim = _canonical_apply_claim(conn, tenant_id, job_id)
    if not claim or claim.get("run_id") != str(run_id):
        return
    state = conn.execute(
        "SELECT state,attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if not state or state[0] != "skipped" or int(state[1]) < 1:
        return
    controls = conn.execute(
        f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_MANUAL_STOP_SQL}) "
        f"AND NOT (({APPLY_SUBMIT_INTENT_SQL}) OR ({APPLY_UNRESOLVED_SKIP_SQL}) "
        f"OR ({APPLY_RECORDED_APPLIED_SQL}) OR ({APPLY_RETAINED_POLICY_SKIP_SQL}) OR ({APPLY_SKIPPED_QUEUED_SQL}))",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if not controls or not _owned_email_authority_refusal_reason(conn, tenant_id, job_id, run_id):
        return
    started = conn.execute(
        "SELECT event_id,payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplyRunStarted' AND json_extract(payload_json,'$.run_id')=? ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id), str(run_id)),
    ).fetchone()
    refusal = conn.execute(
        "SELECT event_id FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type=? AND idempotency_key=? AND json_extract(payload_json,'$.run_id')=? LIMIT 1",
        (str(tenant_id), str(job_id), EMAIL_AUTHORITY_REFUSAL_EVENT,
         _email_authority_refusal_key(tenant_id, job_id, run_id), str(run_id)),
    ).fetchone()
    if not started or not refusal or _payload_from_row((started[1],)).get("attempts") != int(state[1]):
        return
    stop = conn.execute(
        "SELECT MIN(event_id) FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='StageSkipped' AND event_id>? AND "
        "(json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.manualDisposition')='skip' "
        "OR message='Job marked skipped from the local API.')",
        (str(tenant_id), str(job_id), started[0]),
    ).fetchone()
    if not stop or stop[0] is None or int(refusal[0]) >= int(stop[0]):
        return
    source = _read_owned_refusal_source(conn, tenant_id, job_id, run_id, stopped=True)
    if source is None or not _record_email_refusal_park(conn, tenant_id, job_id, run_id, source_row=source):
        return
    updated = conn.execute(
        "UPDATE job_stage_states SET attempt_count=?,version=version+1 "
        "WHERE tenant_id=? AND job_id=? AND stage='apply' AND state='skipped' AND attempt_count=?",
        (int(state[1]) - 1, str(tenant_id), str(job_id), int(state[1])),
    )
    if updated.rowcount != 1:
        raise RuntimeError("Stopped Apply refund lost its owner-bound attempt")
    _record_owned_refusal_refund(conn, tenant_id, job_id, run_id, int(state[1]), int(state[1]) - 1)


def _canonical_apply_claim(conn, tenant_id, job_id) -> dict | None:
    row = conn.execute("SELECT payload_json FROM job_events WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'apply' AND event_type = 'ApplyClaimAcquired' ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id))).fetchone()
    return json.loads(row[0]) if row else None


def count_settled_email_refusals(tenant_id: str, launcher_id: str) -> int:
    """Count only this completed launcher's durably refunded, settled refusals."""
    conn = get_connection()
    if conn.in_transaction:
        raise RuntimeError("Apply refusal counts require committed evidence")
    rows = conn.execute(
        "SELECT event_id,job_id,payload_json,idempotency_key FROM job_events "
        "WHERE tenant_id=? AND stage='apply' AND event_type='ApplyEmailAuthorityRefusalRefunded' "
        "AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.launcher_id')=?",
        (str(tenant_id), str(launcher_id)),
    ).fetchall()
    seen = set()
    for event_id, job_id, raw, key in rows:
        try:
            payload = json.loads(raw)
            run_id = payload["run_id"]
            before, after = payload["attempts_before"], payload["attempts_after"]
        except (TypeError, ValueError, KeyError):
            continue
        if (not isinstance(run_id, str) or not run_id or type(before) is not int or type(after) is not int
                or before < 1 or after != before - 1
                or key != _email_authority_refusal_key(tenant_id, job_id, run_id) + ":refund"):
            continue
        reason = _owned_email_authority_refusal_reason(conn, tenant_id, job_id, run_id)
        if not reason:
            continue
        claim = conn.execute(
            "SELECT event_id FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
            "AND event_type='ApplyClaimAcquired' AND event_id<? "
            "AND json_extract(payload_json,'$.run_id')=? AND json_extract(payload_json,'$.launcher_id')=? "
            "ORDER BY event_id DESC LIMIT 1",
            (str(tenant_id), str(job_id), event_id, run_id, str(launcher_id)),
        ).fetchone()
        if not claim:
            continue
        started = conn.execute(
            "SELECT event_id FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
            "AND event_type='ApplyRunStarted' AND event_id>? AND event_id<? "
            "AND json_extract(payload_json,'$.run_id')=? AND json_type(payload_json,'$.attempts')='integer' "
            "AND json_extract(payload_json,'$.attempts')=? LIMIT 1",
            (str(tenant_id), str(job_id), claim[0], event_id, run_id, before),
        ).fetchone()
        if not started:
            continue
        refusal = conn.execute(
            "SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
            "AND event_type=? AND idempotency_key=? AND event_id>? AND event_id<? "
            "AND json_extract(payload_json,'$.run_id')=? LIMIT 1",
            (str(tenant_id), str(job_id), EMAIL_AUTHORITY_REFUSAL_EVENT,
             _email_authority_refusal_key(tenant_id, job_id, run_id), started[0], event_id, run_id),
        ).fetchone()
        if not refusal:
            continue
        settled = conn.execute(
            "SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
            "AND event_type IN ('ApplyClaimSettled','ApplyCustodyRetired') AND event_id>? "
            "AND json_extract(payload_json,'$.run_id')=? AND json_extract(payload_json,'$.launcher_id')=? LIMIT 1",
            (str(tenant_id), str(job_id), event_id, run_id, str(launcher_id)),
        ).fetchone()
        terminal = conn.execute(
            "SELECT event_type,payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
            "AND event_type IN ('ApplicationFailed','LockReleased') AND event_id>? "
            "AND json_extract(payload_json,'$.run_id')=? ORDER BY event_id DESC",
            (str(tenant_id), str(job_id), event_id, run_id),
        ).fetchall()
        no_intent = not conn.execute(
            f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_SUBMIT_INTENT_SQL})",
            (str(tenant_id), str(job_id)),
        ).fetchone()
        valid_terminal = any(
            (kind == "ApplicationFailed" and (
                _payload_from_row((content,)).get("result") == reason
                or (reason == "email_application_approval_required" and _payload_from_row((content,)).get("result") == "manual")
            )) or (kind == "LockReleased" and _payload_from_row((content,)).get("late_status") == "failed")
            for kind, content in terminal
        )
        if settled and no_intent and valid_terminal:
            seen.add((str(job_id), run_id))
    return len(seen)


def settle_finished_apply_claims(launcher_run: ApplyLauncherRun) -> None:
    """Settle accepted logical claims after joined-worker tracked cleanup.

    Source execution is deliberately best effort for escaped descendants. Its
    marker explicitly declines full-tree verification; installed born custody
    requires the actual dedicated native completion. Ambiguity stays parked.
    """
    from jobctrl.apply.process_birth import _write
    journal = launcher_run._journal
    if journal is None or journal.value is None:
        return
    from jobctrl.runtime import is_bundled_runtime
    source_best_effort = not is_bundled_runtime()
    born_workers = {birth["worker_id"] for birth in journal.value["births"]}
    conn = get_connection()
    settled = []
    try:
        for claim in journal.value["jobs"]:
            if claim["worker_id"] in born_workers and not source_best_effort:
                continue
            tenant, job, owner = claim["tenant_id"], claim["job_id"], claim["run_id"]
            _begin_apply_write(conn, tenant, job)
            current = _canonical_apply_claim(conn, tenant, job)
            if not current or current.get("run_id") != owner or current.get("launcher_id") != launcher_run.identity:
                continue
            state = conn.execute("SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
                                 (tenant, job)).fetchone()
            terminal_events = {
                "succeeded": {"ApplicationSubmitted"},
                "failed": {"ApplicationFailed"},
                "exhausted": {"ApplicationFailed"},
                "needs_verification": {"ApplicationFailed"},
                "skipped": {"DryRunCompleted", "ApplyManualSkip", "LockReleased", "ApplicationSubmitted"},
            }.get(str(state[0]) if state else "", set())
            if not terminal_events or not _has_apply_event(conn, tenant_id=TenantId(tenant), job_id=canonical_job_id(job),
                    run_id=owner, event_types=terminal_events):
                continue
            _refund_refusal_before_manual_stop(conn, tenant, job, owner)
            if not _has_apply_event(conn, tenant_id=TenantId(tenant), job_id=canonical_job_id(job), run_id=owner,
                    event_types={"ApplyClaimSettled"}):
                record_job_event(conn, job, "apply", "ApplyClaimSettled", tenant_id=tenant,
                    payload={"run_id": owner, "launcher_id": launcher_run.identity,
                             "no_process_birth": claim["worker_id"] not in born_workers,
                             "tracked_cleanup_completed": True, "full_tree_verified": False,
                             "source_best_effort": source_best_effort})
            settled.append(claim)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    if settled:
        # Canonical proof is durable first; a crash leaves redundant retained
        # metadata, never an unrecorded transfer to a new logical owner.
        journal.value["jobs"] = [row for row in journal.value["jobs"] if row not in settled]
        _write(journal.path, journal.value)


def _reconcile_stopped_native_stage(conn, tenant_id, job_id, run_id, launcher_id):
    """Restore a saved Stop's stage only inside its verified native retirement."""
    if not conn.in_transaction:
        raise RuntimeError("Native Apply retirement requires a writer transaction")
    claim = _canonical_apply_claim(conn, tenant_id, job_id)
    if (not claim or claim.get("run_id") != str(run_id) or claim.get("launcher_id") != launcher_id
            or _latest_apply_run_started_run_id(conn, tenant_id=tenant_id, job_id=job_id) != str(run_id)):
        return False
    started = conn.execute(
        "SELECT event_id FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplyRunStarted' AND json_extract(payload_json,'$.run_id')=? ORDER BY event_id DESC LIMIT 1",
        (str(tenant_id), str(job_id), str(run_id)),
    ).fetchone()
    if not started:
        return False
    stop = conn.execute(
        "SELECT MAX(event_id) FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='StageSkipped' AND "
        "(json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.manualDisposition')='skip' "
        "OR message='Job marked skipped from the local API.')",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if not stop or stop[0] is None or int(stop[0]) <= int(started[0]):
        return False
    safe = conn.execute(
        f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_MANUAL_STOP_SQL}) "
        f"AND NOT (({APPLY_SUBMIT_INTENT_SQL}) OR ({APPLY_UNRESOLVED_SKIP_SQL}) "
        f"OR ({APPLY_RECORDED_APPLIED_SQL}) OR ({APPLY_RETAINED_POLICY_SKIP_SQL}) OR ({APPLY_SKIPPED_QUEUED_SQL}))",
        (str(tenant_id), str(job_id)),
    ).fetchone()
    if not safe:
        return False
    return conn.execute(
        "UPDATE job_stage_states SET state='skipped',retryable=0,version=version+1 "
        "WHERE tenant_id=? AND job_id=? AND stage='apply' AND state='running'",
        (str(tenant_id), str(job_id)),
    ).rowcount == 1


def recover_apply_custody(launcher_id: str) -> None:
    """Recover only a specific launcher after its actual native scope stopped.

    Native proof covers escaped descendants. Workflow status, root exit and
    missing birth publications never replace that authority.
    """
    from jobctrl.apply.process_birth import ApplyCustodyJournal
    from jobctrl.apply.native_custody import verify_native_completion
    journal = ApplyCustodyJournal(config.APP_DIR, launcher_id)
    value = journal.load()
    if value is None:
        return
    verify_native_completion(value["native_custody"], journal.app_dir)
    conn = get_connection()
    try:
        for claim in value["jobs"]:
            tenant, job, owner = claim["tenant_id"], claim["job_id"], claim["run_id"]
            _begin_apply_write(conn, tenant, job)
            current = _canonical_apply_claim(conn, tenant, job)
            if not current or current.get("run_id") != owner or current.get("launcher_id") != launcher_id:
                continue
            reconciled_stop = False
            if _owns_apply(conn, tenant, job, owner):
                ambiguous = _has_apply_submit_intent(conn, tenant_id=TenantId(tenant),
                    job_id=canonical_job_id(job), run_id=owner)
                set_stage_state(conn, job, "apply", "needs_verification" if ambiguous else "pending",
                    tenant_id=tenant,
                    attempt_count=(_attempt_count_for(conn, tenant_id=tenant, job_id=job) if ambiguous
                                   else _refund_email_refusal_and_park(conn, tenant, job, owner)),
                    validate_transition=False)
            else:
                reconciled_stop = _reconcile_stopped_native_stage(conn, tenant, job, owner, launcher_id)
                _refund_refusal_before_manual_stop(conn, tenant, job, owner)
            if not _has_apply_event(conn, tenant_id=TenantId(tenant), job_id=canonical_job_id(job), run_id=owner,
                                     event_types={"ApplyCustodyRetired"}):
                record_job_event(conn, job, "apply", "ApplyCustodyRetired", tenant_id=tenant,
                    payload={"run_id": owner, "launcher_id": launcher_id, "native_completion": True,
                             "stopped_stage_reconciled": reconciled_stop})
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    journal.retire(verify_native_completion=lambda binding: verify_native_completion(binding, journal.app_dir))


def recover_ended_source_apply_claim(conn, *, tenant_id: str, job_id: str, launcher_id: str, run_id: str) -> None:
    """Release an ended source logical owner, explicitly without tree proof."""
    from jobctrl.apply.process_birth import ApplyCustodyJournal
    journal = ApplyCustodyJournal(config.APP_DIR, launcher_id)
    if journal.load() is None:
        raise ApplyOwnershipLost("The source owner has no retained lifetime record")
    with journal.ended_source_owner():
        started = not conn.in_transaction
        _begin_apply_write(conn, tenant_id, job_id)
        try:
            current = _canonical_apply_claim(conn, tenant_id, job_id)
            if not current or current.get("launcher_id") != launcher_id or current.get("run_id") != run_id:
                raise ApplyOwnershipLost("The source claim changed before best-effort recovery")
            ambiguous = _has_apply_submit_intent(conn, tenant_id=TenantId(tenant_id), job_id=canonical_job_id(job_id), run_id=run_id)
            state = conn.execute("SELECT state FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'",
                                 (tenant_id, job_id)).fetchone()
            if state and state[0] == "running" and _owns_apply(conn, tenant_id, job_id, run_id):
                set_stage_state(conn, job_id, "apply", "needs_verification" if ambiguous else "pending",
                                tenant_id=tenant_id,
                                attempt_count=(_attempt_count_for(conn, tenant_id=tenant_id, job_id=job_id) if ambiguous
                                               else _refund_email_refusal_and_park(conn, tenant_id, job_id, run_id)),
                                validate_transition=False)
            else:
                _refund_refusal_before_manual_stop(conn, tenant_id, job_id, run_id)
            if not _has_apply_event(conn, tenant_id=TenantId(tenant_id), job_id=canonical_job_id(job_id), run_id=run_id,
                                     event_types={"ApplyClaimSettled"}):
                record_job_event(conn, job_id, "apply", "ApplyClaimSettled", tenant_id=tenant_id,
                    payload={"run_id": run_id, "launcher_id": launcher_id, "source_best_effort": True,
                             "owner_lifetime_released": True, "tracked_cleanup_completed": False,
                             "full_tree_verified": False})
            if started:
                conn.commit()
        except BaseException:
            if started:
                conn.rollback()
            raise


def _has_unsettled_apply_owner(conn, *, tenant_id, job_id) -> bool:
    from jobctrl.apply.process_birth import ApplyCustodyJournal, CustodyUnverified
    from jobctrl.runtime import is_bundled_runtime
    claim = _canonical_apply_claim(conn, tenant_id, job_id)
    if claim:
        submit_intended = _has_apply_submit_intent(conn, tenant_id=TenantId(str(tenant_id)),
            job_id=canonical_job_id(str(job_id)), run_id=claim["run_id"])
    else:
        submit_intended = False
    if claim and claim.get("launcher_id"):
        if _has_apply_event(conn, tenant_id=TenantId(str(tenant_id)), job_id=canonical_job_id(str(job_id)),
                run_id=claim["run_id"], event_types={"ApplyCustodyRetired", "ApplyClaimSettled"}):
            # Generic stage reset is never an acknowledgement that an old
            # submit intent did not reach the employer.
            return submit_intended
        try:
            journal = ApplyCustodyJournal(config.APP_DIR, claim["launcher_id"])
            value = journal.load()
            if not is_bundled_runtime() and value is not None and value.get("source_best_effort") is True:
                recover_ended_source_apply_claim(conn, tenant_id=str(tenant_id), job_id=str(job_id),
                    launcher_id=claim["launcher_id"], run_id=claim["run_id"])
            elif not conn.in_transaction:
                recover_apply_custody(claim["launcher_id"])
            else:
                return True
        except (CustodyUnverified, OSError, ValueError, ApplyOwnershipLost):
            return True
        return submit_intended or not _has_apply_event(conn, tenant_id=TenantId(str(tenant_id)), job_id=canonical_job_id(str(job_id)),
                run_id=claim["run_id"], event_types={"ApplyCustodyRetired", "ApplyClaimSettled"})
    if submit_intended:
        return True
    owner = _latest_apply_run_started_run_id(conn, tenant_id=TenantId(str(tenant_id)), job_id=canonical_job_id(str(job_id)))
    if not owner:
        return _has_active_apply(conn, tenant_id=tenant_id, job_id=job_id)
    return not _has_apply_event(conn, tenant_id=TenantId(str(tenant_id)), job_id=canonical_job_id(str(job_id)),
        run_id=owner, event_types={"ApplicationSubmitted", "ApplicationFailed", "DryRunCompleted", "ApplyManualSkip", "ApplyCustodyRetired"})


def mark_result(
    job_id: JobId,
    status: str,
    error: str | None = None,
    permanent: bool = False,
    duration_ms: int | None = None,
    task_id: str | None = None,
    run_ctx: dict | None = None,
    tenant_id: TenantId | None = None,
) -> None:
    """Settle owned email attempts under the writer lock using durable receipts."""
    conn = get_connection()
    tenant = TenantId(str(tenant_id or (run_ctx or {}).get("tenant_id") or LOCAL_TENANT))
    job = canonical_job_id(str(job_id))
    run_id = str(task_id or (run_ctx or {}).get("run_id") or "")
    with _owned_apply_writer(conn, tenant, job):
        # Every supplied identity must own the active Apply run. Missing
        # identity remains the administrative mark_job entry point.
        identities = (task_id, (run_ctx or {}).get("run_id"))
        owner = _latest_apply_run_started_run_id(conn, tenant_id=tenant, job_id=job)
        manual_stop = conn.execute(
            f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_MANUAL_STOP_SQL})",
            (str(tenant), str(job)),
        ).fetchone()
        if manual_stop:
            claim = _canonical_apply_claim(conn, tenant, job)
            if (run_id and owner == run_id and (claim is None or claim.get("run_id") == run_id)
                    and all(not identity or str(identity) == run_id for identity in identities)):
                if _has_apply_submit_intent(conn, tenant_id=tenant, job_id=job, run_id=run_id):
                    if _has_email_confirmation(conn, tenant, job, run_id):
                        _record_apply_terminal_event_once(
                            conn, tenant_id=tenant, job_id=job, run_id=run_id,
                            event_type="ApplicationSubmitted", message="Application submitted",
                            payload={"run_id": run_id, "result": "applied", "finished_at": _utc_now()},
                        )
                        status = "applied"
                    else:
                        status = "needs_verification"
                else:
                    _refund_refusal_before_manual_stop(conn, tenant, job, run_id)
                _record_apply_terminal_event_once(
                    conn, tenant_id=tenant, job_id=job, run_id=run_id,
                    event_type="LockReleased", level="info",
                    message="Apply execution returned after its disposition changed; current stage preserved.",
                    payload={"run_id": run_id, "late_status": status, "stage_preserved": True},
                )
            return
        if any(not _owns_apply(conn, tenant, job, identity) for identity in identities if identity):
            return
        # Resolve authority from storage, never from the caller's lookup key.
        # Keep this read and the legacy write under the same writer lock: a
        # concurrent intent must not appear between the check and settlement.
        intent = _email_intent(conn, tenant, job, owner) if owner else None
        if intent and intent.get("submission_channel") == "email":
            if any(str(identity) != owner for identity in (task_id, (run_ctx or {}).get("run_id")) if identity):
                return
            if not _owns_email_settlement(conn, tenant, job, owner):
                return
            if _has_email_confirmation(conn, tenant, job, owner):
                status, error = "applied", None
            else:
                status, error, permanent = "failed", "email_send_outcome_ambiguous", True
            task_id = owner
        elif owner and intent is None and _has_apply_submit_intent(
            conn, tenant_id=tenant, job_id=job, run_id=owner,
        ):
            # An unresolvable or duplicated intent cannot identify one
            # operation. Do not trust the caller's uncorroborated result.
            status, error, permanent = "failed", "ambiguous_apply_submit_intent", True
            task_id = owner
        elif run_id and (_email_intent(conn, tenant, job, run_id) or {}).get("submission_channel") == "email":
            # An older email receipt cannot settle a successor on another path.
            return
        # Other result channels retain their existing result contract.
        _mark_result(job_id, status, error, permanent, duration_ms, task_id, run_ctx, tenant_id, _commit=False)


def _mark_result(
    job_id: JobId,
    status: str,
    error: str | None = None,
    permanent: bool = False,
    duration_ms: int | None = None,
    task_id: str | None = None,
    run_ctx: dict | None = None,
    tenant_id: TenantId | None = None,
    *,
    _commit: bool = True,
) -> None:
    """Update a job's apply outcome.

    Writes go to ``job_stage_states.apply`` (canonical lifecycle row),
    a terminal ``ApplicationSubmitted`` / ``ApplicationFailed`` /
    ``DryRunCompleted`` event whose payload feeds
    ``apply_run_projections``, and — when the run carries a
    ``worker_id`` — a ``job_artifacts`` row pointing at the agent's
    per-worker log file (kind ``apply_log``). A non-success result
    after this run's submit-intent checkpoint is parked in
    ``needs_verification`` and is never made retryable. The legacy
    ``jobs.apply_*`` columns are NOT touched.
    """
    conn = get_connection()
    now = _utc_now()
    stable_job_id = canonical_job_id(str(job_id))
    stable_tenant_id = TenantId(str(tenant_id or (run_ctx.get("tenant_id") if run_ctx else None) or LOCAL_TENANT))
    run_id = task_id or (run_ctx.get("run_id") if run_ctx else None) or new_apply_run_id()
    current_state = conn.execute(
        """
        SELECT state
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
        (str(stable_tenant_id), str(stable_job_id)),
    ).fetchone()
    immutable_states = {
        "succeeded",
        "failed",
        "skipped",
        "exhausted",
        "needs_verification",
        "canceled",
    }
    state_value = (
        str(current_state["state"])
        if current_state is not None and hasattr(current_state, "keys")
        else str(current_state[0])
        if current_state is not None
        else ""
    )
    requested_terminal_event = (
        "ApplicationSubmitted"
        if status == "applied"
        else "DryRunCompleted"
        if status == "dry_run"
        else "ApplicationFailed"
    )
    terminal_event_types = {
        event_type
        for event_type in {
            "ApplicationSubmitted",
            "ApplicationFailed",
            "DryRunCompleted",
            "ApplyManualSkip",
            "StageCanceled",
        }
        if _has_apply_event(
            conn,
            tenant_id=stable_tenant_id,
            job_id=stable_job_id,
            run_id=str(run_id),
            event_types={event_type},
        )
    }
    if state_value in immutable_states or (terminal_event_types and terminal_event_types != {requested_terminal_event}):
        return
    posting_url = _posting_url_for_job_id(
        conn,
        tenant_id=stable_tenant_id,
        job_id=stable_job_id,
    )
    ensure_job_stage_rows(
        conn,
        stable_job_id,
        tenant_id=stable_tenant_id,
    )

    worker_id = run_ctx.get("worker_id") if run_ctx else None
    model = run_ctx.get("model") if run_ctx else None
    dry_run = bool(run_ctx.get("dry_run")) if run_ctx else False
    submit_intent_recorded = status not in {"applied", "dry_run"} and _has_apply_submit_intent(
        conn,
        tenant_id=stable_tenant_id,
        job_id=stable_job_id,
        run_id=str(run_id),
    )

    if status == "applied":
        # The terminal guard above protects results written by cancellation,
        # recovery, or manual action. The launcher still owns the normal
        # Running -> Succeeded write for this active run.
        set_stage_state(
            conn,
            stable_job_id,
            "apply",
            "succeeded",
            tenant_id=stable_tenant_id,
            attempt_count=_attempt_count_for(conn, tenant_id=str(stable_tenant_id), job_id=str(stable_job_id)),
            finished_at=now,
            duration_ms=duration_ms,
            validate_transition=False,
        )
        _record_apply_terminal_event_once(
            conn,
            tenant_id=stable_tenant_id,
            job_id=stable_job_id,
            run_id=str(run_id),
            event_type="ApplicationSubmitted",
            message="Application submitted",
            payload={
                "run_id": str(run_id),
                "result": "applied",
                "finished_at": now,
                "duration_ms": duration_ms,
                "worker_id": worker_id,
                "model": model,
            },
        )
    elif status == "dry_run":
        binding = _dry_run_completion_binding(
            conn,
            tenant_id=stable_tenant_id,
            job_id=stable_job_id,
            run_id=str(run_id),
            run_ctx=run_ctx,
        )
        # Launcher owns lock-release policy: Running -> Skipped is a launcher
        # convention (dry-run completed), not in the canonical §8.5 table.
        set_stage_state(
            conn,
            stable_job_id,
            "apply",
            "skipped",
            tenant_id=stable_tenant_id,
            attempt_count=_attempt_count_for(conn, tenant_id=str(stable_tenant_id), job_id=str(stable_job_id)),
            finished_at=now,
            duration_ms=duration_ms,
            error_code="DRY_RUN",
            error_message="Dry run completed without submitting.",
            retryable=True,
            next_action=(f"jobctrl apply --url {posting_url}" if posting_url else None),
            validate_transition=False,
        )
        _record_apply_terminal_event_once(
            conn,
            tenant_id=stable_tenant_id,
            job_id=stable_job_id,
            run_id=str(run_id),
            event_type="DryRunCompleted",
            message="Dry run completed without submitting",
            payload={
                "run_id": str(run_id),
                "result": "dry_run_complete",
                "finished_at": now,
                "duration_ms": duration_ms,
                "worker_id": worker_id,
                "model": model,
                "dry_run": True,
                "coverage": binding["coverage"],
                "blocked_channels": binding["blocked_channels"],
                "allowed_navigations": binding["allowed_navigations"],
                "materials_generation": binding["materials_generation"],
                "application_url": binding["application_url"],
                "profile_version": binding["profile_version"],
            },
        )
    elif submit_intent_recorded:
        reason = (error or "unknown").strip()
        set_stage_state(
            conn,
            stable_job_id,
            "apply",
            "needs_verification",
            tenant_id=stable_tenant_id,
            attempt_count=_attempt_count_for(conn, tenant_id=str(stable_tenant_id), job_id=str(stable_job_id)),
            finished_at=now,
            duration_ms=duration_ms,
            error_code="APPLY_NEEDS_VERIFICATION",
            error_message=(
                f"Apply reached the submit-intent checkpoint, but the external outcome is ambiguous: {reason}"
            ),
            retryable=False,
            next_action=("Review the employer site or confirmation email before retrying."),
            validate_transition=False,
        )
        _record_apply_terminal_event_once(
            conn,
            tenant_id=stable_tenant_id,
            job_id=stable_job_id,
            run_id=str(run_id),
            event_type="ApplicationFailed",
            level="warn",
            message="Application outcome requires manual verification",
            payload={
                "run_id": str(run_id),
                "result": "needs_verification",
                "reason": reason,
                "finished_at": now,
                "duration_ms": duration_ms,
                "worker_id": worker_id,
                "model": model,
                "dry_run": dry_run,
                "retryable": False,
            },
        )
    else:
        reason = (error or "unknown").strip()
        # Same launcher-policy reasoning as the applied branch above:
        # the writer is the launcher, transitions are runner-owned.
        refunded_attempts = _refund_email_refusal_and_park(conn, stable_tenant_id, stable_job_id, str(run_id))
        set_stage_state(
            conn,
            stable_job_id,
            "apply",
            "failed",
            tenant_id=stable_tenant_id,
            attempt_count=refunded_attempts,
            finished_at=now,
            duration_ms=duration_ms,
            error_code=str(status).upper(),
            error_message=reason,
            retryable=not permanent,
            next_action=(f"jobctrl apply --url {posting_url}" if not permanent and posting_url else None),
            validate_transition=False,
        )
        _record_apply_terminal_event_once(
            conn,
            tenant_id=stable_tenant_id,
            job_id=stable_job_id,
            run_id=str(run_id),
            event_type="ApplicationFailed",
            level="error",
            message=reason,
            payload={
                "run_id": str(run_id),
                "result": reason,
                "finished_at": now,
                "duration_ms": duration_ms,
                "worker_id": worker_id,
                "model": model,
                "dry_run": dry_run,
            },
        )

    _register_apply_log_artifact(
        conn,
        stable_job_id,
        tenant_id=stable_tenant_id,
        worker_id=worker_id,
        run_id=str(run_id),
        occurred_at=now,
    )
    if _commit:
        conn.commit()


def _latest_apply_run_started_run_id(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> str | None:
    """Look up the latest ``ApplyRunStarted`` run id for one aggregate.

    Used by orphan rescue (and any caller without a ``run_ctx``) to
    close the SAME run row instead of minting a phantom new uuid that
    leaves the original run stuck in ``status='starting'`` forever.
    """
    row = conn.execute(
        "SELECT payload_json FROM job_events "
        "WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'apply' AND event_type IN ('ApplyClaimAcquired', 'ApplyRunStarted') "
        "ORDER BY (event_type = 'ApplyClaimAcquired') DESC, event_id DESC LIMIT 1",
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchone()
    if row is None:
        return None
    payload_json = row["payload_json"] if not isinstance(row, tuple) else row[0]
    if not payload_json:
        return None
    try:
        payload = json.loads(payload_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    run_id = payload.get("run_id")
    return str(run_id) if run_id else None


def release_lock(
    job_id: JobId,
    run_ctx: dict | None = None,
    *,
    tenant_id: TenantId | None = None,
) -> None:
    """Record that launcher cleanup ran without making retry decisions."""
    conn = get_connection()
    stable_job_id = canonical_job_id(str(job_id))
    stable_tenant_id = TenantId(str(tenant_id or (run_ctx.get("tenant_id") if run_ctx else None) or LOCAL_TENANT))
    ctx_run_id = run_ctx.get("run_id") if run_ctx else None
    if not ctx_run_id:
        return
    _begin_apply_write(conn, stable_tenant_id, stable_job_id)
    run_id = str(ctx_run_id)
    if _latest_apply_run_started_run_id(conn, tenant_id=stable_tenant_id, job_id=stable_job_id) != run_id:
        conn.rollback()
        return
    record_job_event(
        conn,
        stable_job_id,
        "apply",
        "LockReleased",
        tenant_id=stable_tenant_id,
        message="Apply lock released",
        payload={"run_id": str(run_id)},
    )
    conn.commit()


@contextmanager
def _owned_apply_writer(conn, tenant_id, job_id):
    savepoint = "owned_apply_" + uuid.uuid4().hex
    inherited = conn.in_transaction
    if not inherited:
        conn.execute("BEGIN IMMEDIATE")
    conn.execute(f"SAVEPOINT {savepoint}")
    try:
        if inherited:
            # An inherited deferred transaction may not hold the writer yet.
            conn.execute(
                "UPDATE job_stage_states SET state=state WHERE tenant_id=? AND job_id=? AND stage='apply'",
                (str(tenant_id), str(job_id)),
            )
        yield
    except BaseException:
        conn.execute(f"ROLLBACK TO {savepoint}")
        conn.execute(f"RELEASE {savepoint}")
        if not inherited:
            conn.rollback()
        raise
    else:
        conn.execute(f"RELEASE {savepoint}")
        if not inherited:
            conn.commit()


def recover_ambiguous_running_apply(console: Console | None = None, *, only_stopped: bool = False) -> int:
    """Recover apply rows inherited from a prior dead workflow/activity."""
    try:
        conn = get_connection()
        recovered = 0
        # Existing custody recovery authenticates the exact source lifetime or
        # installed native completion. A stopped stage or a dead root PID does
        # not prove descendants exited. Never take custody from a caller's
        # transaction; retry this sweep after that transaction finishes.
        if not conn.in_transaction:
            stopped = conn.execute(
                "SELECT jobs.tenant_id,jobs.job_id FROM jobs "
                f"WHERE ({APPLY_MANUAL_STOP_SQL})"
            ).fetchall()
            for row in stopped:
                tenant_id, job_id = str(row[0]), str(row[1])
                try:
                    claim = _canonical_apply_claim(conn, tenant_id, job_id)
                    if not claim or not claim.get("launcher_id") or not claim.get("run_id"):
                        continue
                    run_id = str(claim["run_id"])
                    events = {"ApplyClaimSettled", "ApplyCustodyRetired"}
                    before = _has_apply_event(conn, tenant_id=TenantId(tenant_id), job_id=canonical_job_id(job_id),
                                              run_id=run_id, event_types=events)
                    _has_unsettled_apply_owner(conn, tenant_id=tenant_id, job_id=job_id)
                    after = _has_apply_event(conn, tenant_id=TenantId(tenant_id), job_id=canonical_job_id(job_id),
                                             run_id=run_id, event_types=events)
                    recovered += int(not before and after)
                except Exception:  # noqa: BLE001
                    logger.exception("Stopped Apply custody recovery failed for %s/%s", tenant_id, job_id)
        if only_stopped:
            return recovered
        rows = conn.execute(
            "SELECT tenant_id, job_id FROM job_stage_states WHERE stage = 'apply' AND state = 'running'"
        ).fetchall()
        for row in rows:
            tenant_id = TenantId(str(row["tenant_id"] if hasattr(row, "keys") else row[0]))
            job_id = canonical_job_id(str(row["job_id"] if hasattr(row, "keys") else row[1]))
            posting_url = _posting_url_for_job_id(
                conn,
                tenant_id=tenant_id,
                job_id=job_id,
            )
            try:
                run_id, workflow_id = _latest_apply_run_started_identity(
                    conn,
                    tenant_id=tenant_id,
                    job_id=job_id,
                )
                if not _workflow_terminal_or_gone(
                    conn,
                    tenant_id=tenant_id,
                    workflow_id=workflow_id or run_id,
                ):
                    continue
                # Selection and workflow inspection may race a settling writer.
                # Recheck the exact owner and state under the same lock as parking.
                with _owned_apply_writer(conn, tenant_id, job_id):
                    current = conn.execute(
                        "SELECT state FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'",
                        (str(tenant_id), str(job_id)),
                    ).fetchone()
                    if current is None or current[0] != "running":
                        continue
                    if conn.execute(
                        f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_MANUAL_STOP_SQL})",
                        (str(tenant_id), str(job_id)),
                    ).fetchone():
                        continue
                    if _latest_apply_run_started_identity(conn, tenant_id=tenant_id, job_id=job_id) != (run_id, workflow_id):
                        continue
                    if run_id:
                        if _has_apply_terminal_result(
                            conn,
                            tenant_id=tenant_id,
                            job_id=job_id,
                            run_id=run_id,
                        ):
                            continue
                    if run_id and _has_apply_submit_intent(
                        conn,
                        tenant_id=tenant_id,
                        job_id=job_id,
                        run_id=run_id,
                    ):
                        if _has_email_confirmation(conn, tenant_id, job_id, run_id):
                            mark_result(job_id, "applied", run_ctx={"run_id": run_id}, tenant_id=tenant_id)
                            recovered += 1
                            continue
                        set_stage_state(
                            conn,
                            job_id,
                            "apply",
                            "needs_verification",
                            tenant_id=tenant_id,
                            attempt_count=_attempt_count_for(conn, tenant_id=str(tenant_id), job_id=str(job_id)),
                            error_code="APPLY_NEEDS_VERIFICATION",
                            error_message="Live apply reached the submit-intent checkpoint without a terminal result.",
                            retryable=False,
                            next_action="Review the employer site or confirmation email before retrying.",
                            validate_transition=False,
                        )
                    else:
                        previous_attempts = _attempt_count_for(conn, tenant_id=tenant_id, job_id=job_id)
                        restored_attempts = _attempt_count_after_email_refusal(conn, tenant_id, job_id, run_id)
                        if restored_attempts < previous_attempts:
                            reason = _owned_email_authority_refusal_reason(conn, tenant_id, job_id, run_id)
                            mark_result(job_id, "failed", reason, run_ctx={"run_id": run_id}, tenant_id=tenant_id)
                            recovered += 1
                            continue
                        set_stage_state(
                            conn,
                            job_id,
                            "apply",
                            "pending",
                            tenant_id=tenant_id,
                            attempt_count=previous_attempts,
                            next_action=(f"jobctrl apply --url {posting_url}" if posting_url else None),
                            validate_transition=False,
                        )
                    recovered += 1
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Apply recovery failed for %s/%s",
                    tenant_id,
                    job_id,
                )
                continue
        if recovered:
            if console is not None:
                console.print(f"[yellow]Recovered {recovered} ambiguous apply run(s) from prior crash[/yellow]")
        return recovered
    except Exception:  # noqa: BLE001
        logger.exception("Apply recovery sweep failed")
        return 0


def _latest_apply_run_started_identity(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
) -> tuple[str | None, str | None]:
    row = conn.execute(
        "SELECT payload_json FROM job_events "
        "WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'apply' AND event_type IN ('ApplyClaimAcquired', 'ApplyRunStarted') "
        "ORDER BY (event_type = 'ApplyClaimAcquired') DESC, event_id DESC LIMIT 1",
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchone()
    if row is None:
        return None, None
    payload_json = row["payload_json"] if hasattr(row, "keys") else row[0]
    try:
        payload = json.loads(payload_json or "{}")
    except (TypeError, ValueError):
        return None, None
    if not isinstance(payload, dict):
        return None, None
    run_id = str(payload.get("run_id") or "") or None
    workflow_id = str(payload.get("workflow_id") or "") or None
    return run_id, workflow_id


def _workflow_terminal_or_gone(
    conn,
    *,
    tenant_id: TenantId,
    workflow_id: str | None,
) -> bool:
    if not workflow_id:
        return True
    try:
        row = conn.execute(
            "SELECT status FROM workflow_run_projections WHERE tenant_id = ? AND workflow_id = ? LIMIT 1",
            (str(tenant_id), workflow_id),
        ).fetchone()
    except Exception:  # noqa: BLE001
        return True
    if row is None:
        return True
    status = str(row["status"] if hasattr(row, "keys") else row[0])
    return status in {"succeeded", "failed", "canceled", "timed_out", "terminated"}


def _has_apply_submit_intent(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    run_id: str,
) -> bool:
    return _has_apply_event(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        run_id=run_id,
        event_types={"ApplySubmitIntended"},
    )


def _has_apply_terminal_result(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    run_id: str,
) -> bool:
    return _has_apply_event(
        conn,
        tenant_id=tenant_id,
        job_id=job_id,
        run_id=run_id,
        event_types={
            "ApplicationSubmitted",
            "ApplicationFailed",
            "DryRunCompleted",
            "ApplyManualSkip",
        },
    )


def _has_apply_event(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    run_id: str,
    event_types: set[str],
) -> bool:
    placeholders = ",".join("?" for _ in event_types)
    rows = conn.execute(
        f"""
        SELECT payload_json FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND stage = 'apply' AND event_type IN ({placeholders})
        """,
        (
            str(tenant_id),
            str(canonical_job_id(str(job_id))),
            *event_types,
        ),
    ).fetchall()
    for row in rows:
        payload_json = row["payload_json"] if hasattr(row, "keys") else row[0]
        try:
            payload = json.loads(payload_json or "{}")
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict) and str(payload.get("run_id") or "") == run_id:
            return True
    return False


# ---------------------------------------------------------------------------
# Manual mark / reset helpers — operate on the canonical stage row +
# event stream, never on the legacy jobs.apply_* columns.
# ---------------------------------------------------------------------------


def mark_job(
    job_id: JobId,
    status: str,
    reason: str | None = None,
    *,
    tenant_id: TenantId | None = None,
) -> None:
    """Manually mark a job's apply status."""
    stable_job_id = canonical_job_id(str(job_id))
    stable_tenant_id = tenant_id or LOCAL_TENANT
    if status == "applied":
        conn = get_connection()
        now = _utc_now()
        ensure_job_stage_rows(
            conn,
            stable_job_id,
            tenant_id=stable_tenant_id,
        )
        set_stage_state(
            conn,
            stable_job_id,
            "apply",
            "succeeded",
            tenant_id=stable_tenant_id,
            attempt_count=_attempt_count_for(conn, tenant_id=str(stable_tenant_id), job_id=str(stable_job_id)),
            finished_at=now,
            duration_ms=0,
            retryable=False,
            validate_transition=False,
        )
        record_job_event(
            conn,
            stable_job_id,
            "apply",
            "ApplicationManuallyMarked",
            tenant_id=stable_tenant_id,
            message="Job manually marked as applied",
            payload={
                "reason": reason or "",
                "marked_at": now,
                "source": "user_attestation",
            },
        )
        conn.commit()
    else:
        _mark_failed_manually(stable_job_id, tenant_id=stable_tenant_id, reason=reason or "manual")


def _mark_failed_manually(job_id: JobId, *, tenant_id: TenantId, reason: str) -> None:
    """A local human label is neither worker settlement nor no-send evidence."""
    from jobctrl.infrastructure.apply_controls import assert_safe_apply_reset, has_unsettled_apply_run

    conn = get_connection()
    owned = not conn.in_transaction
    conn.execute("BEGIN IMMEDIATE" if owned else "SAVEPOINT manual_apply_failure")
    try:
        try:
            assert_safe_apply_reset(conn, tenant_id=tenant_id, job_id=job_id)
            stopped = conn.execute(
                f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_MANUAL_STOP_SQL})",
                (str(tenant_id), str(job_id)),
            ).fetchone()
            row = conn.execute(
                "SELECT state,attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'",
                (str(tenant_id), str(job_id)),
            ).fetchone()
            if stopped or (row and row[0] == "skipped") or has_unsettled_apply_run(conn, tenant_id=tenant_id, job_id=job_id):
                raise ValueError("Skip or an unsettled run still owns this job; stop and verify that run first.")
        except ValueError as exc:
            raise ValueError(f"Manual Apply failure refused: {exc}") from exc
        now = _utc_now()
        ensure_job_stage_rows(conn, job_id, tenant_id=tenant_id)
        set_stage_state(
            conn, job_id, "apply", "failed", tenant_id=tenant_id,
            attempt_count=int(row[1]) if row else 0, finished_at=now, duration_ms=0,
            error_code="FAILED", error_message=reason, retryable=False, validate_transition=False,
        )
        record_job_event(
            conn, job_id, "apply", "ApplicationFailed", tenant_id=tenant_id,
            level="error", message=reason,
            payload={"run_id": str(new_apply_run_id()), "result": reason, "finished_at": now,
                     "duration_ms": 0, "source": "user_attestation"},
        )
        if owned:
            conn.commit()
        else:
            conn.execute("RELEASE SAVEPOINT manual_apply_failure")
    except BaseException:
        if owned:
            conn.rollback()
        else:
            conn.execute("ROLLBACK TO SAVEPOINT manual_apply_failure")
            conn.execute("RELEASE SAVEPOINT manual_apply_failure")
        raise


def reset_failed() -> int:
    """Reset failed jobs so they can be retried.

    Re-queues every job whose canonical apply stage state is ``failed``
    by flipping it back to ``pending`` and zeroing the attempt counter.
    The historical event stream is preserved (no audit history is
    purged); only the live state row is rewound. Returns the number of
    jobs reset.
    """
    from jobctrl.pipeline.retry import reset_retry_stages

    conn = get_connection()
    rows = conn.execute(
        "SELECT tenant_id, job_id FROM job_stage_states "
        "WHERE stage='apply' AND state IN ('failed', 'exhausted')"
    ).fetchall()
    count = 0
    for row in rows:
        tenant_id, job_id = TenantId(str(row[0])), canonical_job_id(str(row[1]))
        try:
            reset_retry_stages(
                conn, [(str(job_id), "apply")], tenant_id=tenant_id,
                reset_attempts=True, only_failed=True, _allow_apply_only=True,
            )
            count += 1
        except ValueError as exc:
            logger.info("Apply reset refused for %s/%s: %s", tenant_id, job_id, exc)
    return count


# ---------------------------------------------------------------------------
# Profile snapshot loader (kept for back-compat with callers that
# import it).
# ---------------------------------------------------------------------------


def _load_profile_snapshot() -> ProfileSnapshot:
    from jobctrl.infrastructure.profile import get_profile_repository

    return get_profile_repository().load_snapshot(LOCAL_TENANT)


# ---------------------------------------------------------------------------
# gen_prompt (inspection helper) — no DB writes or live apply claim
# ---------------------------------------------------------------------------


def _load_job_for_prompt(
    job_id: JobId,
    *,
    tenant_id: TenantId,
    min_score: int,
) -> dict[str, Any] | None:
    """Read one eligible job without creating an apply attempt or consuming authority."""

    conn = get_connection()
    common_columns, common_joins = _apply_candidate_select_parts()
    row = conn.execute(
        f"""
        SELECT {common_columns}
        FROM jobs {common_joins}
        WHERE jobs.tenant_id = ? AND jobs.job_id = ?
          AND {_READY_TAILORED_RESUME_WITH_PDF}
          AND {_EFFECTIVE_FIT_SCORE} >= ?
          AND {_SCORE_ELIGIBLE_FOR_DOWNSTREAM}
          AND {_SCORE_CURRENT_FOR_DOWNSTREAM}
          AND {_NOT_CLOSED_ACTIVE_STATE}
        LIMIT 1
        """,
        (
            str(tenant_id),
            str(canonical_job_id(str(job_id))),
            min_score,
        ),
    ).fetchone()
    return _row_to_job_dict(row) if row is not None else None


def gen_prompt(
    job_id: JobId,
    min_score: int = 7,
    model: str = "default",
    worker_id: int = 0,
    snapshot: ProfileSnapshot | None = None,
    *,
    tenant_id: TenantId | None = None,
) -> Path | None:
    """Render an inspection-only dry-run prompt without claiming the job."""

    job = _load_job_for_prompt(
        canonical_job_id(str(job_id)),
        tenant_id=tenant_id or LOCAL_TENANT,
        min_score=min_score,
    )
    if not job:
        return None

    apply_url = str(job.get("application_url") or job.get("url") or "").strip()
    from jobctrl.infrastructure.network import validate_public_http_url

    decision = validate_public_http_url(apply_url)
    if not decision.allowed:
        raise ValueError(f"unsafe apply target URL: {decision.reason or 'not a public HTTP(S) destination'}")

    snapshot = snapshot or _load_profile_snapshot()
    cdp_port = BASE_CDP_PORT + worker_id
    builder = ApplyPromptBuilder()
    apply_prompt: ApplyPrompt = builder.build(
        job=job,
        snapshot=snapshot,
        cdp_port=cdp_port,
        dry_run=True,
    )

    config.ensure_dirs()
    site_slug = (job.get("site") or "unknown")[:20].replace(" ", "_")
    title_slug = job["title"][:30].replace(" ", "_")
    prompt_file = config.LOG_DIR / f"prompt_{site_slug}_{title_slug}.txt"
    prompt_file.write_text(apply_prompt.text, encoding="utf-8")

    mcp_path = config.APP_DIR / f".mcp-apply-{worker_id}.json"
    from jobctrl.infrastructure.apply.claude_code_cli import _write_private_json

    # Never carry a submit-capable MCP surface into this read-only utility.
    # Overwriting the per-worker file also prevents a stale live configuration
    # from being paired with the generated inspection prompt.
    _write_private_json(mcp_path, {"mcpServers": {}})

    return prompt_file


# ---------------------------------------------------------------------------
# run_job — kept on the public surface for the regression tests +
# pipeline.apply_jobs single-job flow. Delegates to the apply use case.
# ---------------------------------------------------------------------------


def _has_current_apply_review(conn, tenant_id: str, job_id: str) -> bool:
    from datetime import datetime, timedelta

    decision = _latest_apply_review_decision(conn, tenant_id=tenant_id, job_id=job_id)
    try:
        reviewed_at = datetime.fromisoformat(str((decision or {}).get("decided_at", "")).replace("Z", "+00:00"))
        now = datetime.fromisoformat(_utc_now())
        if reviewed_at.tzinfo is None or not timedelta(0) <= now - reviewed_at <= timedelta(minutes=15):
            return False
    except (ValueError, TypeError):
        return False
    rows = _select_apply_candidates(conn, tenant_id, canonical_job_id(job_id), 0, check_controls=False)
    if not rows:
        return False
    row = rows[0]
    return (
        _approval_refusal_reason(
            conn,
            tenant_id=tenant_id,
            job_id=job_id,
            materials_generation=row["materials_generation"],
            profile_version=_current_profile_version(conn, tenant_id=tenant_id),
            application_url=row["application_url"] or row["url"],
            email_source_row=row,
        )
        is None
    )


def _email_file_sha256(path):
    try:
        with Path(path).open("rb") as source:
            digest = sha256()
            size = 0
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
        return digest.hexdigest() if size else None
    except (OSError, TypeError, ValueError):
        return None


def _email_source_binding(conn, tenant_id: str, job_id: str, job) -> dict[str, Any]:
    """Freeze exact source identities, including replacements within a generation.

    This is a comparison of canonical source bytes/IDs, never a semantic judgment.
    Missing files remain unavailable rather than becoming accepted empty content.
    """
    artifacts = conn.execute(
        "SELECT generation,artifact_type,artifact_id,path,metadata_json FROM job_materials_artifacts "
        "WHERE tenant_id=? AND job_id=? AND status='approved' AND superseded_at IS NULL "
        "ORDER BY generation,artifact_type,artifact_id",
        (tenant_id, job_id),
    ).fetchall()
    return {
        "profile_version": _current_profile_version(conn, tenant_id=tenant_id),
        "posting_url": job["url"],
        "application_url": job["application_url"] or job["url"],
        "materials_generation": job["materials_generation"],
        "job": {key: job[key] for key in (
            "title", "site", "description", "full_description", "resume_pdf_path",
            "resume_pdf_artifact_id", "tailored_resume_path", "cover_letter_path",
        )},
        "artifacts": [list(row) for row in artifacts],
        "files": {str(row[3]): _email_file_sha256(row[3]) for row in artifacts},
    }


def _email_binding_digest(value):
    """Shared with the API: compact UTF-8 JSON arrays, preserving field order."""
    return sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _email_materials_digest(source):
    return _email_binding_digest([row + [source["files"].get(str(row[3]))] for row in source["artifacts"]])


def _email_candidate_digest(candidate):
    return _email_binding_digest([candidate[key] for key in (
        "recipient", "subject", "body", "attachment_artifact_id", "attachment_name",
    )])


def _email_posting_inputs_digest(source):
    return _email_binding_digest([source["job"][key] for key in ("title", "site", "description", "full_description")])


def _email_approval_binding_refusal(conn, tenant_id, job_id, decision, candidate, *, source_row=None):
    """Compare the recorded email approval with current canonical sources."""
    keys = ("recipient", "subject", "body", "attachment_artifact_id", "attachment_name")
    if not candidate or any(not isinstance(candidate.get(key), str) or not candidate[key] for key in keys):
        return "approval_stale_email_candidate"
    event = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? "
        "AND event_type='ApplyReviewDecisionRecorded' AND json_extract(payload_json,'$.decisionId')=? "
        "ORDER BY event_id DESC LIMIT 1", (tenant_id, job_id, decision.get("decision_id")),
    ).fetchone()
    authority = _payload_from_row(event).get("emailApprovalBinding") if event else None
    if not isinstance(authority, dict) or type(authority.get("version")) is not int or authority["version"] != 1:
        return "approval_stale_email_candidate"
    if source_row is None:
        rows = _select_apply_candidates(conn, tenant_id, canonical_job_id(job_id), 0)
        if not rows:
            return "awaiting_approval"
        source_row = rows[0]
    current = _email_source_binding(conn, tenant_id, job_id, source_row)
    if authority.get("postingUrlSha256") != _email_binding_digest([current["posting_url"]]):
        return "approval_stale_url"
    if authority.get("materialsSha256") != _email_materials_digest(current):
        return "approval_stale_materials"
    if (authority.get("candidateSha256") != _email_candidate_digest(candidate)
            or authority.get("postingInputsSha256") != _email_posting_inputs_digest(current)
            or str(decision.get("email_recipient") or "").lower() != candidate["recipient"].lower()
            or str(decision.get("email_attachment_artifact_id") or "") != candidate["attachment_artifact_id"]):
        return "approval_stale_email_candidate"
    return None


def _assert_current_email_approval(conn, tenant_id, job_id, run_id, candidate, context):
    from jobctrl.domain.apply.process_manager import EmailApprovalRefused

    job = _select_owned_apply_candidate(conn, tenant_id, job_id, run_id)
    if job is None:
        raise EmailApprovalRefused("awaiting_approval")
    current = _email_source_binding(conn, tenant_id, job_id, job)
    reason = _approval_refusal_reason(
        conn, tenant_id=tenant_id, job_id=job_id,
        materials_generation=current["materials_generation"],
        profile_version=current["profile_version"], application_url=current["application_url"],
        check_email_binding=False,
    )
    if reason:
        raise EmailApprovalRefused(reason)
    captured = context.source_binding or {}
    if (current["profile_version"] != captured.get("profile_version")
            or current["profile_version"] != context.profile_version):
        raise EmailApprovalRefused("approval_stale_profile")
    if any(current[key] != captured.get(key) for key in ("posting_url", "application_url")):
        raise EmailApprovalRefused("approval_stale_url")
    if current != captured or not current["files"].get(candidate.attachment_path):
        raise EmailApprovalRefused("approval_stale_materials")

    # A newly approved different candidate cannot authorize this delayed send.
    # The pending run's candidate has not yet been persisted: read the canonical
    # reviewed candidate before saving this run's events into the intent transaction.
    reviewed = _latest_email_application_candidate(conn, tenant_id=tenant_id, job_id=job_id)
    decision = _latest_apply_review_decision(conn, tenant_id=tenant_id, job_id=job_id) or {}
    reason = _email_approval_binding_refusal(conn, tenant_id, job_id, decision, reviewed, source_row=job)
    if reason:
        raise EmailApprovalRefused(reason)
    expected = {
        "recipient": candidate.recipient_email,
        "subject": candidate.subject,
        "body": candidate.body,
        "attachment_artifact_id": candidate.attachment_artifact_id,
        "attachment_name": candidate.attachment_name,
    }
    if (not reviewed or any(reviewed.get(key) != value for key, value in expected.items())
            or decision.get("email_recipient", "").lower() != candidate.recipient_email.lower()
            or decision.get("email_attachment_artifact_id") != candidate.attachment_artifact_id
            or job["resume_pdf_artifact_id"] != candidate.attachment_artifact_id
            or job["resume_pdf_path"] != candidate.attachment_path):
        raise EmailApprovalRefused("approval_stale_email_candidate")
    return {
        "approval_decision_id": decision["decision_id"],
        "email_source_sha256": sha256(json.dumps(current, sort_keys=True).encode()).hexdigest(),
        "email_candidate_sha256": sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest(),
    }


@contextmanager
def _authorize_posting_before_submit(
    tenant_id: str, job_id: str, posting_url: str, run_id: str, candidate=None, context=None,
):
    from datetime import timedelta
    from jobctrl.domain.errors import ApplyStoppedLocally, MissingInputError
    from jobctrl.enrichment.availability import require_fresh_active, assert_fresh_candidate

    def current_review():
        # These availability exceptions still depend on canonical approval reads.
        # Translate failures here too, before either availability caller can
        # misclassify them as a posting transport failure.
        try:
            return _has_current_apply_review(conn, tenant_id, job_id)
        except Exception as exc:
            if candidate is not None:
                from jobctrl.domain.apply.process_manager import EmailApprovalRefused
                raise EmailApprovalRefused("approval_authority_unavailable") from exc
            raise

    conn = get_connection()
    require_fresh_active(
        job_id,
        tenant_id=tenant_id,
        conn=conn,
        max_age=timedelta(minutes=15),
        expected_posting_url=posting_url,
        allow_unknown=current_review(),
    )
    conn.execute("BEGIN IMMEDIATE")
    yielded = False
    committing = False
    try:
        assert_fresh_candidate(
            conn,
            job_id,
            posting_url,
            tenant_id=tenant_id,
            max_age=timedelta(minutes=15),
            allow_unknown=current_review(),
        )
        owner = _latest_apply_run_started_run_id(conn, tenant_id=TenantId(tenant_id), job_id=canonical_job_id(job_id))
        running = conn.execute(
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (tenant_id, job_id),
        ).fetchone()
        manual_stop = conn.execute(
            f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_MANUAL_STOP_SQL})",
            (tenant_id, job_id),
        ).fetchone()
        claim = _canonical_apply_claim(conn, tenant_id, job_id)
        if owner != run_id or (claim is not None and claim.get("run_id") != str(run_id)):
            raise MissingInputError("Apply intent no longer owns the original posting attempt")
        uncertain = conn.execute(
            f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? "
            f"AND (({APPLY_SUBMIT_INTENT_SQL}) OR ({APPLY_UNRESOLVED_SKIP_SQL}))",
            (tenant_id, job_id),
        ).fetchone()
        if uncertain:
            raise MissingInputError("Apply submission evidence is already recorded; verify the external outcome before retrying")
        if manual_stop:
            raise ApplyStoppedLocally("Apply intent no longer owns the original posting attempt: skipped locally")
        if not running or running[0] != "running":
            raise MissingInputError("Apply intent no longer owns the original posting attempt")
        authority = None
        if candidate is not None:
            from dataclasses import replace
            from jobctrl.domain.apply.process_manager import EmailApprovalRefused
            from jobctrl.domain.ports.apply import EmailApplicationAuthorization
            try:
                authority = _assert_current_email_approval(conn, tenant_id, job_id, run_id, candidate, context)
                expected_files = dict(context.source_binding["files"])
                try:
                    attachment_bytes = Path(candidate.attachment_path).read_bytes()
                except OSError as exc:
                    raise EmailApprovalRefused("approval_stale_materials") from exc
                attachment_hash = sha256(attachment_bytes).hexdigest()
                if not attachment_bytes or attachment_hash != expected_files.get(candidate.attachment_path):
                    raise EmailApprovalRefused("approval_stale_materials")
                authority = EmailApplicationAuthorization(
                    candidate=replace(candidate, attachment_bytes=attachment_bytes),
                    evidence={**authority, "email_attachment_sha256": attachment_hash},
                )
            except EmailApprovalRefused:
                raise
            except Exception as exc:
                raise EmailApprovalRefused("approval_authority_unavailable") from exc
        yielded = True
        yield authority
        if candidate is not None:
            # Repository save cannot release the writer, but the filesystem is
            # independent of SQLite. Refuse a replacement during persistence.
            # Once admitted, the sender uses only the validated immutable copy.
            if any(_email_file_sha256(path) != digest for path, digest in expected_files.items()):
                raise EmailApprovalRefused("approval_stale_materials")
        committing = True
        conn.commit()
    except BaseException as exc:
        known_uncommitted = conn.in_transaction and yielded and not committing
        conn.rollback()
        if candidate is not None and known_uncommitted and isinstance(exc, Exception):
            from jobctrl.domain.apply.process_manager import EmailApprovalRefused, EmailIntentPersistenceFailed
            if not isinstance(exc, (EmailApprovalRefused, ApplyRunWriteConflict, ApplyOwnershipLost)):
                raise EmailIntentPersistenceFailed() from exc
        raise


class _OwnedApplyPublisher:
    def __init__(self, publisher):
        self.publisher = publisher

    def publish(self, event) -> None:
        self._publish(event, require_durable_record=False)

    def _publish(self, event, *, require_durable_record: bool) -> None:
        run_id = str(event.payload.get("run_id") or "")
        tenant = str(event.tenant_id)
        conn = get_connection()
        if not run_id:
            raise ApplyOwnershipLost("Apply publication lacks its attempt identity")
        # The source is the canonical claim, never the caller's prose/event.
        row = conn.execute("SELECT job_id FROM job_events WHERE tenant_id = ? AND stage = 'apply' "
            "AND event_type = 'ApplyClaimAcquired' "
            "AND json_extract(payload_json, '$.run_id') = ? ORDER BY event_id DESC LIMIT 1", (tenant, run_id)).fetchone()
        if row is None:
            raise ApplyOwnershipLost("Apply publication has no canonical owner")
        job = str(row[0])
        if event.payload.get("job_id") not in {None, job}:
            raise ApplyOwnershipLost("Apply publication changed its canonical job identity")
        inherited = conn.in_transaction
        with _owned_apply_writer(conn, tenant, job):
            if not _owns_apply(conn, tenant, job, run_id) and not _is_settled_email_record(conn, tenant, job, run_id, event):
                raise ApplyOwnershipLost("Apply publication no longer owns its original claim")
            if require_durable_record and event.event_type == "ApplyRunEventRecorded" and not _is_stored_apply_record(conn, tenant, job, run_id, event):
                raise ApplyOwnershipLost("Apply publication no longer has its durable event")
            if inherited:
                from jobctrl.infrastructure.commit_notifications import NotificationConnection

                if not isinstance(conn, NotificationConnection):
                    raise ApplyOwnershipLost("Apply publication requires a commit-aware connection")
                # Do not commit the caller's work or expose its pending event.
                # Recheck ownership after the caller commits.
                conn.defer_notification(("owned_apply_event", uuid.uuid4().hex), lambda: self._publish_after_commit(event))
            else:
                self.publisher.publish(event)

    def _publish_after_commit(self, event) -> None:
        try:
            self._publish(event, require_durable_record=True)
        except ApplyOwnershipLost:
            # A successor or rollback retired this notification's authority.
            return


def _is_settled_email_record(conn, tenant, job, run_id, event) -> bool:
    """Allow only the settled owner's exact, redacted durable event wrappers."""
    if event.event_type != "ApplyRunEventRecorded":
        return False
    if _latest_apply_run_started_run_id(conn, tenant_id=tenant, job_id=job) != run_id:
        return False
    state = conn.execute("SELECT state FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'",
                         (tenant, job)).fetchone()
    manual_stop = conn.execute(
        f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_MANUAL_STOP_SQL})", (tenant, job),
    ).fetchone()
    if not state or (state[0] != "succeeded" and not manual_stop) or not _has_email_confirmation(conn, tenant, job, run_id):
        return False
    if not _has_apply_event(conn, tenant_id=tenant, job_id=job, run_id=run_id, event_types={"ApplicationSubmitted"}):
        return False
    return _is_stored_apply_record(conn, tenant, job, run_id, event)


def _is_stored_apply_record(conn, tenant, job, run_id, event) -> bool:
    from jobctrl.domain.apply.entities import ApplyRunEvent
    from jobctrl.domain.apply.event_privacy import email_event_references, private_apply_event

    if set(event.payload) != {"run_id", "event"}:
        return False
    wrapped = event.payload["event"]
    if not isinstance(wrapped, dict) or type(wrapped.get("event_id")) is not int or wrapped["event_id"] <= 0:
        return False
    rows = _existing_apply_events(conn, tenant_id=tenant, job_id=job, run_id=run_id).get(wrapped["event_id"], [])
    if not rows:
        return False
    for row in rows:
        if private_apply_event(row["event_type"], row["payload"]):
            canonical = {"event_id": wrapped["event_id"], "event_type": row["event_type"],
                         "level": row["level"], "message": row["message"], "payload": row["payload"],
                         "occurred_at": row["occurred_at"]}
            if email_event_references("ApplyRunEventRecorded", {"event": canonical})["event"] != wrapped:
                return False
        else:
            try:
                child = ApplyRunEvent(**wrapped)
            except (TypeError, ValueError):
                return False
            if not _same_apply_event(row, child, job):
                return False
    return True


def _build_use_case():
    """Construct the canonical local-mode use case wiring.

    Imported lazily — the use case pulls the `Applied`/`Failed` value
    objects, which only the run-job path needs.

    The process-wide ``InProcessEventBus`` is wired in as the publisher.
    Saga events are persisted directly by ``SqliteApplyRunRepository`` as
    the saga checkpoints progress, so ``run_job`` must not replay the
    aggregate timeline at the end of the run.
    """
    from jobctrl.domain.apply.process_manager import ApplySaga
    from jobctrl.domain.apply.services import ApplyEligibilityChecker
    from jobctrl.domain.apply.use_cases import SubmitApplicationUseCase
    from jobctrl.browser_capabilities import require_system_browser_capability
    from jobctrl.infrastructure.apply import (
        ClaudeCodeCliAdapter,
        GmailEmailApplicationSender,
        LocalChromeAdapter,
    )
    from jobctrl.infrastructure.events import get_default_publisher

    browser_port = LocalChromeAdapter()
    agent_port = ClaudeCodeCliAdapter()
    saga = ApplySaga(
        browser_port=browser_port,
        agent_port=agent_port,
        repository=SqliteApplyRunRepository(),
        email_sender=GmailEmailApplicationSender(),
        timeout_seconds=config.get_apply_timeout_seconds(),
        submission_authorizer=lambda: require_system_browser_capability("auto-apply-browser"),
        email_intent_authorizer=_authorize_posting_before_submit,
    )
    return SubmitApplicationUseCase(
        repository=SqliteApplyRunRepository(),
        browser_port=browser_port,
        agent_port=agent_port,
        eligibility_checker=ApplyEligibilityChecker(max_attempts=int(config.DEFAULTS["max_apply_attempts"])),
        prompt_builder=ApplyPromptBuilder(),
        publisher=_OwnedApplyPublisher(get_default_publisher()),
        saga=saga,
        timeout_seconds=config.get_apply_timeout_seconds(),
    )


class EmailSettlementError(RuntimeError):
    """An email receipt or intent no longer has durable settlement authority."""


def _owns_email_settlement(conn, tenant_id, job_id, run_id) -> bool:
    return _owns_apply(conn, tenant_id, job_id, run_id)


def _valid_email_operation(operation, tenant_id, job_id, run_id) -> bool:
    return valid_email_operation(operation, tenant_id, job_id, run_id)


def _email_intent_event(conn, tenant_id, job_id, run_id):
    rows = conn.execute(
        "SELECT event_id,payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
        "AND event_type='ApplySubmitIntended' AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.run_id')=? ORDER BY event_id LIMIT 2",
        (str(tenant_id), str(job_id), str(run_id)),
    ).fetchall()
    return (int(rows[0][0]), json.loads(rows[0][1])) if len(rows) == 1 else None


def _email_intent(conn, tenant_id, job_id, run_id):
    event = _email_intent_event(conn, tenant_id, job_id, run_id)
    return event[1] if event else None


def _valid_email_confirmation(conn, tenant_id, job_id, run_id, payload) -> bool:
    intent = _email_intent(conn, tenant_id, job_id, run_id)
    return valid_email_confirmation(intent, payload, tenant_id, job_id, run_id)


def _has_email_confirmation(conn, tenant_id, job_id, run_id) -> bool:
    # Called by settlement under the writer lock: a receipt can confirm only
    # the unique admitted intent that precedes it in the durable event stream.
    intent = _email_intent_event(conn, tenant_id, job_id, run_id)
    if intent is None:
        return False
    intent_id, intent_payload = intent
    rows = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' AND event_type='EmailApplicationSent' "
        "AND event_id>? AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.run_id')=?",
        (str(tenant_id), str(job_id), intent_id, str(run_id)),
    ).fetchall()
    return any(valid_email_confirmation(intent_payload, json.loads(row[0]), tenant_id, job_id, run_id) for row in rows)


class SqliteApplyRunRepository:
    """Persist ``ApplyRun`` aggregate events into the canonical event stream."""

    def admit_email_intent(self, run) -> None:
        self.save(run, admitting_email=True)

    def email_intent_matches(self, run) -> bool:
        conn = get_connection()
        tenant, job, run_id = run.tenant_id, run.job_id, str(run.run_id)
        expected = next((event.payload.get("operation") for event in run.events
                         if event.event_type == "ApplySubmitIntended"), None)
        actual = _email_intent(conn, tenant, job, run_id)
        return bool(
            actual and _owns_email_settlement(conn, tenant, job, run_id)
            and _valid_email_operation(expected, tenant, job, run_id)
            and actual.get("operation") == expected
        )

    def email_intent_durable(self, run) -> bool:
        conn = get_connection()
        # A savepoint release is not a commit when another caller owns the
        # surrounding transaction. Do not mutate that caller's transaction.
        return not conn.in_transaction and self.email_intent_matches(run)

    def save(self, run, *, admitting_email: bool = False) -> None:
        job_id_raw = str(getattr(run, "job_id", "") or "")
        run_id = str(getattr(run, "run_id", "") or "")
        if not job_id_raw or not run_id:
            return
        job_id = canonical_job_id(job_id_raw)
        tenant_id = TenantId(str(getattr(run, "tenant_id", "") or LOCAL_TENANT))

        conn = get_connection()
        inherited = conn.in_transaction
        if not inherited:
            conn.execute("BEGIN IMMEDIATE")
        conn.execute("SAVEPOINT email_run_save")
        try:
            _begin_apply_write(conn, tenant_id, job_id)
            owner = _latest_apply_run_started_run_id(conn, tenant_id=tenant_id, job_id=job_id)
            if owner is not None and owner != run_id:
                raise ApplyOwnershipLost("Apply aggregate no longer owns its original canonical claim")
            if owner is None and _has_active_apply(conn, tenant_id=str(tenant_id), job_id=str(job_id)):
                raise ApplyOwnershipLost("Apply aggregate cannot adopt an unknown running owner")
            active_owner = owner is None or _owns_apply(conn, tenant_id, job_id, run_id)
            stopped = conn.execute(
                f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_MANUAL_STOP_SQL})",
                (str(tenant_id), str(job_id)),
            ).fetchone()
            if stopped:
                active_owner = False
            late_owner = bool(
                stopped and owner == run_id
                and not _has_apply_event(conn, tenant_id=tenant_id, job_id=job_id, run_id=run_id,
                                         event_types={"ApplyClaimSettled", "ApplyCustodyRetired"})
            )
            late_intent = _email_intent(conn, tenant_id, job_id, run_id) if late_owner else None
            late_email_owner = bool(
                late_intent and late_intent.get("submission_channel") == "email"
                and _valid_email_operation(late_intent.get("operation"), tenant_id, job_id, run_id)
            )
            started_dry_run = conn.execute(
                "SELECT 1 FROM job_events WHERE tenant_id=? AND job_id=? AND stage='apply' "
                "AND event_type='ApplyRunStarted' "
                "AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.run_id')=? "
                "AND json_type(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.dry_run')='true' LIMIT 1",
                (str(tenant_id), str(job_id), run_id),
            ).fetchone()
            any_intent = conn.execute(
                f"SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=? AND ({APPLY_SUBMIT_INTENT_SQL})",
                (str(tenant_id), str(job_id)),
            ).fetchone()
            late_dry_run = bool(late_owner and getattr(run, "dry_run", False) and started_dry_run and not any_intent)
            if admitting_email and _has_apply_submit_intent(conn, tenant_id=tenant_id, job_id=job_id, run_id=run_id):
                raise ApplyRunWriteConflict("Email intent already admitted")
            seen = _existing_apply_events(
                conn,
                tenant_id=tenant_id,
                job_id=job_id,
                run_id=run_id,
            )
            new_email_confirmation = False
            for event in list(getattr(run, "events", ()) or ()):
                event_id = int(getattr(event, "event_id", 0) or 0)
                if event_id and event_id in seen:
                    if not all(_same_apply_event(row, event, job_id) for row in seen[event_id]):
                        raise ApplyRunWriteConflict("Apply event sequence belongs to a different event")
                    continue
                event_type = str(getattr(event, "event_type", "") or "")
                if not event_type:
                    continue
                # Skip removes permission to initiate work. An already admitted
                # email operation may still record its exact receipt or ambiguous
                # failure while its original claim has not settled.
                late_observation = late_owner and not admitting_email and (
                    event_type in {"ClaudeLaunched", "AssistantText", "ToolUse", "ApplyTerminalDetermination",
                                   "EmailApplicationCandidateRecorded", "ApplySubmissionBlocked", "AgentResult"}
                    or (late_email_owner and event_type in {"EmailApplicationSent", "EmailApplicationSendFailed"})
                    or (late_dry_run and event_type in {"DryRunBlockedChannels", "DryRunCompleted"})
                )
                if not active_owner and not late_observation:
                    raise ApplyOwnershipLost("Apply aggregate no longer owns its original canonical claim")
                payload = dict(getattr(event, "payload", {}) or {})
                payload.setdefault("run_id", run_id)
                payload["event_id"] = event_id
                payload.setdefault("apply_status", str(getattr(run, "status", "") or ""))
                payload["event_fingerprint"] = _apply_event_fingerprint(event)
                if event_type in {"ApplySubmitIntended", "EmailApplicationSent"} and payload.get("operation"):
                    if not _owns_email_settlement(conn, tenant_id, job_id, run_id) and not (
                        event_type == "EmailApplicationSent" and late_email_owner
                    ):
                        raise EmailSettlementError("Email operation no longer owns the attempt")
                    operation = payload["operation"]
                    if not _valid_email_operation(operation, tenant_id, job_id, run_id):
                        raise EmailSettlementError("Invalid email operation binding")
                    if event_type == "EmailApplicationSent" and not _valid_email_confirmation(conn, tenant_id, job_id, run_id, payload):
                        raise EmailSettlementError("Invalid email confirmation binding")
                if event_type == "EmailApplicationSent" and not payload.get("operation"):
                    raise EmailSettlementError("Missing email confirmation binding")
                if event_type == "EmailApplicationSent":
                    new_email_confirmation = True
                if event_type == "ApplyTerminalDetermination":
                    from jobctrl.domain.apply.terminal_report import ApplyTerminalReport, report_envelope
                    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository

                    report = ApplyTerminalReport.model_validate(payload["result"])
                    envelope = report_envelope(
                        report=report,
                        tenant_id=tenant_id,
                        run_id=run_id,
                        model=payload["model"],
                        input_fingerprint=payload["input_fingerprint"],
                    )
                    repository = SqliteDeterminationRepository(conn)
                    repository.save(envelope)
                    repository.bind(
                        tenant_id=str(tenant_id),
                        entity_kind="apply_run",
                        entity_id=run_id,
                        entity_version="1",
                        determination_kind="apply_terminal_report",
                        determination_id=envelope.determination_id,
                    )
                    payload["determination_id"] = envelope.determination_id
                record_job_event(
                    conn,
                    job_id,
                    "apply",
                    event_type,
                    tenant_id=tenant_id,
                    level=str(getattr(event, "level", "info") or "info"),
                    message=getattr(event, "message", None),
                    payload=payload,
                    defer_publication=True,
                    occurred_at=str(getattr(event, "occurred_at", "") or "") or None,
                    idempotency_key=(
                        _email_authority_refusal_key(tenant_id, job_id, run_id)
                        if event_type == EMAIL_AUTHORITY_REFUSAL_EVENT else
                        "apply-email:" + sha256(json.dumps(
                            [str(tenant_id), str(job_id), run_id, event_type],
                            separators=(",", ":"),
                        ).encode()).hexdigest()
                        if event_type in {"ApplySubmitIntended", "EmailApplicationSent"} and payload.get("operation")
                        else None
                    ),
                )
                _persist_agent_artifacts(
                    conn,
                    tenant_id=tenant_id,
                    job_id=job_id,
                    run_id=run_id,
                    event_type=event_type,
                    payload=payload,
                )
            if new_email_confirmation:
                # Receipt, submitted fact and owned stage settle atomically.
                # A lost acknowledgement or successor cannot strand an accepted
                # send between confirmation persistence and terminal settlement.
                # An idempotency collision may have suppressed the insert; the
                # durable receipt still must follow the unique admitted intent.
                if not _has_email_confirmation(conn, tenant_id, job_id, run_id):
                    raise EmailSettlementError("Email confirmation is not recorded after its unique intent")
                if late_email_owner:
                    _record_apply_terminal_event_once(
                        conn, tenant_id=tenant_id, job_id=job_id, run_id=run_id,
                        event_type="ApplicationSubmitted", message="Application submitted",
                        payload={"run_id": run_id, "result": "applied", "finished_at": _utc_now(),
                                 "duration_ms": run.duration_ms, "worker_id": run.worker_id, "model": run.model},
                    )
                else:
                    _mark_result(
                        job_id, "applied", task_id=run_id, tenant_id=tenant_id,
                        duration_ms=run.duration_ms,
                        run_ctx={"run_id": run_id, "worker_id": run.worker_id, "model": run.model},
                        _commit=False,
                    )
            conn.execute("RELEASE email_run_save")
            if not inherited:
                conn.commit()
        except BaseException:
            try:
                conn.execute("ROLLBACK TO email_run_save")
                conn.execute("RELEASE email_run_save")
                if not inherited:
                    conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            raise

    def load(self, tenant_id, run_id):
        return None

    def list_active(self, tenant_id):
        return []

    def list_recent(self, tenant_id, *, limit: int = 50):
        return []


def _apply_event_fingerprint(event) -> str:
    # Root aggregate status changes during the run; immutable child identity does not.
    return sha256(json.dumps(event.to_dict(), sort_keys=True, default=str).encode()).hexdigest()


def _same_apply_event(row, event, job_id) -> bool:
    payload = row["payload"]
    if (row["event_type"], row["occurred_at"], row["level"], row["message"]) != (
        event.event_type, event.occurred_at, event.level, event.message,
    ):
        return False
    fingerprint = payload.get("event_fingerprint")
    if fingerprint is not None and fingerprint != _apply_event_fingerprint(event):
        return False
    # Legacy rows have no fingerprint. In both formats verify the actual
    # canonical child content, ignoring only writer-added envelope metadata.
    expected = dict(event.payload)
    for alias in ("jobId", "job_id", "jobUrl", "job_url", "jobKey", "job_key", "event_fingerprint"):
        expected.pop(alias, None)
    expected.update(stage="apply", level=event.level, message=event.message or "", jobId=str(job_id))
    return all(
        key in payload and json.dumps(payload[key], sort_keys=True, default=str) == json.dumps(value, sort_keys=True, default=str)
        for key, value in expected.items()
    )


def _existing_apply_events(conn, *, tenant_id: TenantId, job_id: JobId, run_id: str) -> dict[int, list[dict]]:
    rows = conn.execute(
        "SELECT event_type, occurred_at, level, message, payload_json FROM job_events "
        "WHERE tenant_id=? AND job_id=? AND stage='apply' AND payload_json IS NOT NULL ORDER BY event_id",
        (str(tenant_id), str(canonical_job_id(str(job_id)))),
    ).fetchall()
    seen: dict[int, list[dict]] = {}
    for row in rows:
        try:
            payload = json.loads(row["payload_json"] or "{}")
            if not isinstance(payload, dict) or str(payload.get("run_id") or "") != run_id:
                continue
            event_id = int(payload.get("event_id") or 0)
        except (TypeError, ValueError):
            continue
        if event_id:
            seen.setdefault(event_id, []).append({
                "event_type": row["event_type"], "occurred_at": row["occurred_at"],
                "level": row["level"], "message": row["message"], "payload": payload,
            })
    return seen


def _persist_agent_artifacts(
    conn,
    *,
    tenant_id: TenantId,
    job_id: JobId,
    run_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    safe_run = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in run_id)
    artifact_dir = config.LOG_DIR / "apply-artifacts"
    if event_type == "DryRunBlockedChannels":
        blocked_requests = payload.get("blocked_requests")
        if not isinstance(blocked_requests, list) or not blocked_requests:
            return
        artifact_dir.mkdir(parents=True, exist_ok=True)
        blocked_path = artifact_dir / f"{safe_run}-dry-run-blocked.json"
        blocked_path.write_text(
            json.dumps(
                {
                    "run_id": run_id,
                    "coverage": payload.get("coverage") or "partial",
                    "blocked_channels": payload.get("blocked_channels") or [],
                    "blocked_requests": blocked_requests,
                },
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        _record_apply_artifact(
            conn,
            job_id,
            tenant_id=tenant_id,
            artifact_type="apply_dryrun_blocked",
            path=blocked_path,
            status="active",
            metadata={
                "run_id": run_id,
                "coverage": payload.get("coverage") or "partial",
                "blocked_count": len(blocked_requests),
            },
        )
        return
    if event_type != "AgentResult":
        return
    raw_output = str(payload.get("raw_output") or "")
    if not raw_output:
        return
    artifact_dir.mkdir(parents=True, exist_ok=True)
    output_path = artifact_dir / f"{safe_run}-agent-output.txt"
    output_path.write_text(raw_output, encoding="utf-8")
    _record_apply_artifact(
        conn,
        job_id,
        tenant_id=tenant_id,
        artifact_type="apply_agent_output",
        path=output_path,
        status="active",
        metadata={"run_id": run_id},
    )
    if str(payload.get("kind") or "") != "applied":
        return
    confirmation_path = artifact_dir / f"{safe_run}-confirmation.html"
    confirmation_path.write_text(
        f'<!doctype html><meta charset="utf-8"><title>Apply confirmation</title><pre>{html.escape(raw_output)}</pre>',
        encoding="utf-8",
    )
    _record_apply_artifact(
        conn,
        job_id,
        tenant_id=tenant_id,
        artifact_type="apply_confirmation",
        path=confirmation_path,
        status="active",
        metadata={"run_id": run_id, "source": "agent_output"},
    )


def run_job(
    job: dict,
    port: int,
    worker_id: int = 0,
    model: str = "default",
    dry_run: bool = False,
    run_ctx: dict | None = None,
    snapshot: ProfileSnapshot | None = None,
    *,
    tenant_id: TenantId,
) -> tuple[SubmissionResult | None, int]:
    """Run the Apply saga and return its typed result.

    A skipped run returns None. Retryability is carried by the typed failure;
    launcher code never reinterprets the agent's reason prose.
    """
    from datetime import timedelta
    from jobctrl.enrichment.availability import require_fresh_active

    try:
        require_fresh_active(
            str(job["job_id"]),
            tenant_id=str(tenant_id),
            conn=get_connection(),
            max_age=timedelta(minutes=15),
            expected_posting_url=job["url"],
            allow_unknown=dry_run or _has_current_apply_review(get_connection(), str(tenant_id), str(job["job_id"])),
        )
    except Exception:
        return Failed(error="posting_availability_blocked", retryable=False), 0
    run_ctx = run_ctx or {}
    run_id = run_ctx.setdefault("run_id", uuid.uuid4().hex)
    run_ctx.setdefault("worker_id", worker_id)
    run_ctx.update(
        {
            "model": model,
            "dry_run": dry_run,
            "port": port,
        }
    )
    snapshot = snapshot or _load_profile_snapshot()
    use_case = _build_use_case()
    resource_worker_id = int(run_ctx.get("resource_worker_id", worker_id))
    worker_path = config.APPLY_WORKER_DIR / f"worker-{resource_worker_id}"
    # This namespace belongs exclusively to this attempt; never reset it.
    worker_path.mkdir(parents=True, exist_ok=True)
    worker_dir = str(worker_path)
    run_ctx["worker_dir"] = worker_dir

    start = time.time()
    update_state(
        worker_id,
        run_id=run_id,
        status="applying",
        job_title=job.get("title", ""),
        company=job.get("site", ""),
        score=job.get("fit_score", 0),
        start_time=start,
        actions=0,
        last_action="starting",
    )
    add_event(f"[W{worker_id} {run_id[:8]}] Starting: {(job.get('title') or '')[:40]} @ {job.get('site', '')}", worker_id=worker_id)

    outcome = use_case.execute(
        tenant_id=tenant_id,
        job=job,
        snapshot=snapshot,
        worker_id=resource_worker_id,
        cdp_port=port,
        model=model,
        dry_run=dry_run,
        headless=bool(run_ctx.get("headless", False)),
        run_id=ApplyRunId(run_id),
        worker_dir=worker_dir,
    )
    duration_ms = int((time.time() - start) * 1000)
    if outcome.skipped:
        if outcome.skip_reason == "apply_run_conflict":
            raise ApplyRunWriteConflict("Apply execution is already owned")
        return None, duration_ms

    submission = outcome.submission_result
    if submission is None:
        return Failed(error="no_result", retryable=False), duration_ms

    update_state(worker_id, status=submission.kind, last_action=submission.kind)
    return submission, duration_ms


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------


@dataclass
class _WorkerProgress:
    """Counts already published by one worker, retained if its loop crashes."""

    applied: int = 0
    failed: int = 0


@dataclass
class _BatchProgress:
    applied: int = 0
    failed: int = 0
    worker_crashes: int = 0
    joined: bool = False
    terminal_metric: dict[str, Any] | None = None
    metric_started: float | None = None

    def counts(self) -> ApplyBatchCounts:
        return ApplyBatchCounts(self.applied, self.failed, self.worker_crashes)


def worker_loop(
    worker_id: int = 0,
    limit: int = 1,
    target_job_id: JobId | None = None,
    min_score: int = 7,
    headless: bool = False,
    model: str = "default",
    dry_run: bool = False,
    snapshot: ProfileSnapshot | None = None,
    approval_required: bool = True,
    workflow_id: str | None = None,
    tenant_id: str | None = None,
    launcher_run: ApplyLauncherRun | None = None,
    poll_interval: float | None = None,
    standing_refusal_poll: bool = False,
    dispatch_frontier=_DIRECT_DISPATCH,
    _progress: _WorkerProgress | None = None,
) -> tuple[int, int]:
    """Run jobs sequentially until ``limit`` is reached or the queue is empty."""
    progress = _progress if _progress is not None else _WorkerProgress()
    continuous = limit == 0
    jobs_done = 0
    empty_polls = 0
    needs_fresh_resource = False
    stop_event = launcher_run.stop_event if launcher_run else _stop_event
    interval = POLL_INTERVAL if poll_interval is None else poll_interval
    port = launcher_run.ports[worker_id] if launcher_run else BASE_CDP_PORT + worker_id
    resource_worker_id = launcher_run.worker_ids[worker_id] if launcher_run else worker_id
    display_worker_id = worker_id
    worker_id = resource_worker_id
    stable_tenant_id = TenantId(str(tenant_id or LOCAL_TENANT))
    if dispatch_frontier is _DIRECT_DISPATCH:
        dispatch_frontier = capture_apply_dispatch_frontier(get_connection(), tenant_id=stable_tenant_id)[0]

    while not stop_event.is_set():
        if launcher_run is not None:
            launcher_run.verify_worker_cleanup(resource_worker_id)
        if not continuous and jobs_done >= limit:
            break
        if launcher_run is not None and needs_fresh_resource:
            resource_worker_id, port = launcher_run.new_attempt()
            worker_id = resource_worker_id
            needs_fresh_resource = False
            init_worker(worker_id, display_id=display_worker_id)

        # A standing loop may live for hours. Check again before every claim so
        # disabling the capability stops subsequent candidates without waiting
        # for a process restart or a browser launch attempt.
        from jobctrl.browser_capabilities import BrowserCapabilityError, require_system_browser_capability

        try:
            require_system_browser_capability("auto-apply-browser")
        except BrowserCapabilityError as exc:
            add_event(f"[W{worker_id}] Auto-apply browser capability unavailable: {exc}", worker_id=worker_id)
            update_state(worker_id, status="done", last_action="browser capability disabled")
            break

        update_state(
            worker_id,
            status="idle",
            job_title="",
            company="",
            run_id="",
            last_action="waiting for job",
            actions=0,
        )

        run_ctx: dict[str, Any] = {
            # One workflow/activity may claim several jobs. Each apply attempt
            # needs its own run identity; workflow_id remains the Temporal
            # correlation key in the adjacent field.
            "run_id": uuid.uuid4().hex,
            "launcher_run": launcher_run,
            "worker_id": resource_worker_id,
            "resource_worker_id": resource_worker_id,
            "model": model,
            "dry_run": dry_run,
            "workflow_id": workflow_id,
            "target_job_id": str(target_job_id) if target_job_id is not None else None,
            "tenant_id": str(stable_tenant_id),
            "min_score": min_score,
            "headless": headless,
        }
        run_ctx['dispatch_frontier'] = dispatch_frontier
        job = acquire_job(
            target_job_id=target_job_id,
            min_score=min_score,
            worker_id=worker_id,
            run_ctx=run_ctx,
            approval_required=approval_required,
            tenant_id=str(stable_tenant_id),
            retry_refused_email=target_job_id is not None and not continuous and not standing_refusal_poll,
        )
        if not job:
            if not continuous:
                add_event(f"[W{worker_id}] Queue empty", worker_id=worker_id)
                update_state(worker_id, status="done", last_action="queue empty")
                break
            empty_polls += 1
            update_state(worker_id, status="idle", last_action=f"polling ({empty_polls})")
            if empty_polls == 1:
                add_event(f"[W{worker_id}] Queue empty, polling every {interval}s...", worker_id=worker_id)
            if stop_event.wait(timeout=interval):
                break
            if workflow_id is None:
                # A later direct standing poll is a new request, after the
                # previous scan has finished; a scan already in flight stays fenced.
                dispatch_frontier = capture_apply_dispatch_frontier(get_connection(), tenant_id=stable_tenant_id)[0]
            continue

        empty_polls = 0
        # The finite limit bounds claims, including attempts the use case later
        # skips or the operator interrupts. Otherwise releasing a skipped job
        # can let the same worker claim beyond its allocation indefinitely.
        jobs_done += 1
        needs_fresh_resource = True
        job_id = canonical_job_id(str(job["job_id"]))
        job_tenant_id = TenantId(str(job["tenant_id"]))
        try:
            result, duration_ms = run_job(
                job,
                port=port,
                worker_id=worker_id,
                model=model,
                dry_run=dry_run,
                run_ctx=run_ctx,
                snapshot=snapshot,
                tenant_id=stable_tenant_id,
            )

            if result is None:
                release_lock(
                    job_id,
                    run_ctx=run_ctx,
                    tenant_id=job_tenant_id,
                )
                add_event(f"[W{worker_id} {run_ctx['run_id'][:8]}] Skipped: {(job.get('title') or '')[:30]}", worker_id=worker_id)
                if target_job_id is not None:
                    break
                continue
            if isinstance(result, Applied):
                mark_result(
                    job_id,
                    "applied",
                    duration_ms=duration_ms,
                    task_id=run_ctx.get("run_id"),
                    run_ctx=run_ctx,
                    tenant_id=job_tenant_id,
                )
                progress.applied += 1
                update_state(
                    worker_id,
                    jobs_applied=1,
                    jobs_done=1,
                )
            elif isinstance(result, DryRunComplete):
                mark_result(
                    job_id,
                    "dry_run",
                    duration_ms=duration_ms,
                    task_id=run_ctx.get("run_id"),
                    run_ctx=run_ctx,
                    tenant_id=job_tenant_id,
                )
                update_state(worker_id, jobs_done=1)
            elif isinstance(result, Manual) and result.reason == "local_apply_skip":
                mark_result(
                    job_id, "skipped", duration_ms=duration_ms, task_id=run_ctx.get("run_id"),
                    run_ctx=run_ctx, tenant_id=job_tenant_id,
                )
                add_event(f"[W{worker_id} {run_ctx['run_id'][:8]}] Skipped locally", worker_id=worker_id)
                update_state(worker_id, jobs_done=1)
            else:
                reason = result.error if isinstance(result, Failed) else result.kind
                mark_result(
                    job_id,
                    "failed",
                    reason,
                    permanent=not result.retryable if isinstance(result, Failed) else True,
                    duration_ms=duration_ms,
                    task_id=run_ctx.get("run_id"),
                    run_ctx=run_ctx,
                    tenant_id=job_tenant_id,
                )
                progress.failed += 1
                update_state(worker_id, jobs_failed=1, jobs_done=1)
        except ApplyRunWriteConflict:
            # This invocation owns no terminal or lock-release authority.
            add_event(f"[W{worker_id}] Apply execution is already owned")
        except KeyboardInterrupt:
            release_lock(
                job_id,
                run_ctx=run_ctx,
                tenant_id=job_tenant_id,
            )
            add_event(f"[W{worker_id} {run_ctx['run_id'][:8]}] Job skipped (Ctrl+C)", worker_id=worker_id)
            if stop_event.is_set() or target_job_id is not None:
                break
            continue
        except Exception as exc:  # noqa: BLE001
            logger.exception("Worker %d launcher error", worker_id)
            add_event(f"[W{worker_id} {run_ctx['run_id'][:8]}] Launcher error: {str(exc)[:40]}", worker_id=worker_id)
            release_lock(
                job_id,
                run_ctx=run_ctx,
                tenant_id=job_tenant_id,
            )
            progress.failed += 1
            update_state(worker_id, jobs_failed=1)

        if target_job_id is not None:
            break

    update_state(worker_id, run_id="", status="done", last_action="finished")
    return progress.applied, progress.failed


# ---------------------------------------------------------------------------
# Main entry point — kept identical for cli.py / pipeline / actions
# ---------------------------------------------------------------------------


def main(
    limit: int = 1,
    target_job_id: JobId | None = None,
    tenant_id: str | None = None,
    min_score: int = 7,
    headless: bool = False,
    model: str = "default",
    dry_run: bool = False,
    continuous: bool = False,
    poll_interval: int = 60,
    workers: int = 1,
    snapshot: ProfileSnapshot | None = None,
    install_signal_handlers: bool = True,
    approval_required: bool = True,
    workflow_id: str | None = None,
    launcher_run: ApplyLauncherRun | None = None,
    standing_refusal_poll: bool = False,
    dispatch_frontier=_DIRECT_DISPATCH,
    _terminal_metric_sink: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[int, int]:
    """Run an independently owned Apply cohort with bounded internal fan-out."""
    run = launcher_run or ApplyLauncherRun()
    batch = _BatchProgress()
    outer_error: BaseException | None = None
    try:
        with run.lease():
            try:
                if run.stop_event.is_set():
                    batch.joined = True
                    return 0, 0
                return _main(
                    limit=limit, target_job_id=target_job_id, tenant_id=tenant_id,
                    min_score=min_score, headless=headless, model=model, dry_run=dry_run,
                    continuous=continuous, poll_interval=poll_interval, workers=workers,
                    snapshot=snapshot, install_signal_handlers=install_signal_handlers,
                    approval_required=approval_required, workflow_id=workflow_id,
                    standing_refusal_poll=standing_refusal_poll,
                    dispatch_frontier=dispatch_frontier,
                    launcher_run=run, batch_progress=batch,
                )
            finally:
                run.finish()
    except ApplyLauncherCleanupIncomplete as exc:
        outer_error = exc
        # Do not claim counts when the launcher never joined its workers.
        if batch.joined:
            raise ApplyBatchCleanupIncomplete(str(exc), batch.counts()) from exc
        raise
    except BaseException as exc:
        outer_error = exc
        raise
    finally:
        if batch.terminal_metric is not None:
            metric = batch.terminal_metric
            if batch.metric_started is not None:
                metric["duration_ms"] = int((time.time() - batch.metric_started) * 1000)
            if isinstance(outer_error, ApplyLauncherCleanupIncomplete):
                metric.update(outcome="failed", error_class="ApplyLauncherCleanupIncomplete", error_message=str(outer_error))
            elif outer_error is not None and metric["outcome"] != "failed":
                metric.update(outcome="failed", error_class=type(outer_error).__name__, error_message=str(outer_error))
            if _terminal_metric_sink is None:
                _record_apply_batch_metric(**metric)
            else:
                _terminal_metric_sink(metric)


def _main(
    limit: int = 1,
    target_job_id: JobId | None = None,
    tenant_id: str | None = None,
    min_score: int = 7,
    headless: bool = False,
    model: str = "default",
    dry_run: bool = False,
    continuous: bool = False,
    poll_interval: int = 60,
    workers: int = 1,
    snapshot: ProfileSnapshot | None = None,
    install_signal_handlers: bool = True,
    approval_required: bool = True,
    workflow_id: str | None = None,
    standing_refusal_poll: bool = False,
    dispatch_frontier=_DIRECT_DISPATCH,
    *,
    launcher_run: ApplyLauncherRun,
    batch_progress: _BatchProgress,
) -> tuple[int, int]:
    config.ensure_dirs()
    console = Console()
    batch_run_id = f"apply:{launcher_run.identity}"
    batch_started = time.time()
    batch_progress.metric_started = batch_started
    metric_error_class: str | None = None
    metric_error_message: str | None = None
    stable_tenant_id = TenantId(str(tenant_id or LOCAL_TENANT))
    if dispatch_frontier is _DIRECT_DISPATCH:
        dispatch_frontier = capture_apply_dispatch_frontier(get_connection(), tenant_id=stable_tenant_id)[0]

    if continuous:
        effective_limit = 0
        mode_label = "continuous"
    else:
        effective_limit = limit
        mode_label = f"{limit} jobs"

    # One explicit target is one job, even when a caller supplies a larger
    # worker count. This prevents peer workers reclaiming it after a skip.
    if target_job_id is not None:
        workers = 1
    elif effective_limit > 0:
        # Avoid showing idle dashboard workers that have no finite allocation.
        workers = min(workers, effective_limit)

    _record_apply_batch_metric(
        outcome="started",
        run_id=batch_run_id,
        tenant_id=stable_tenant_id,
        job_id=target_job_id,
        dry_run=dry_run,
        workers=workers,
        model=model,
    )

    if snapshot is None:
        try:
            snapshot = _load_profile_snapshot()
        except FileNotFoundError:
            snapshot = None


    total_applied = 0
    total_failed = 0
    worker_crashes = 0

    launcher_run.allocate_workers(workers)
    reset_dashboard(launcher_run.worker_ids)
    for i, resource_worker_id in enumerate(launcher_run.worker_ids):
        init_worker(resource_worker_id, display_id=i)

    worker_label = f"{workers} worker{'s' if workers > 1 else ''}"
    console.print(f"Launching apply pipeline ({mode_label}, {worker_label}, poll every {poll_interval}s)...")
    console.print("[dim]Ctrl+C = skip current job(s) | Ctrl+C x2 = stop[/dim]")

    _ctrl_c_count = 0

    def _sigint_handler(_sig, _frame):
        nonlocal _ctrl_c_count
        _ctrl_c_count += 1
        if _ctrl_c_count == 1:
            console.print("\n[yellow]Skipping current job(s)... (Ctrl+C again to STOP)[/yellow]")
            launcher_run.interrupt()
        else:
            console.print("\n[red bold]STOPPING[/red bold]")
            launcher_run.request_stop()
            raise KeyboardInterrupt

    previous_sigint_handler = signal.getsignal(signal.SIGINT)
    if install_signal_handlers:
        signal.signal(signal.SIGINT, _sigint_handler)

    try:
        with Live(render_full(launcher_run.worker_ids), console=console, refresh_per_second=2) as live:
            _dashboard_running = True

            def _refresh():
                while _dashboard_running:
                    live.update(render_full(launcher_run.worker_ids))
                    time.sleep(0.5)

            refresh_thread = threading.Thread(target=_refresh, daemon=True)
            refresh_thread.start()

            if workers == 1:
                single_progress = _WorkerProgress()
                try:
                    total_applied, total_failed = worker_loop(
                        worker_id=0,
                        limit=effective_limit,
                        target_job_id=target_job_id,
                        min_score=min_score,
                        headless=headless,
                        model=model,
                        dry_run=dry_run,
                        snapshot=snapshot,
                        approval_required=approval_required,
                        workflow_id=workflow_id,
                        tenant_id=stable_tenant_id,
                        launcher_run=launcher_run,
                        poll_interval=poll_interval,
                        standing_refusal_poll=standing_refusal_poll,
                        dispatch_frontier=dispatch_frontier,
                        _progress=single_progress,
                    )
                except BaseException as exc:
                    total_applied, total_failed = single_progress.applied, single_progress.failed
                    if isinstance(exc, ApplyLauncherCleanupIncomplete):
                        worker_crashes = 1
                        raise
                    if not isinstance(exc, Exception):
                        raise
                    logger.exception("Worker 0 crashed")
                    worker_crashes = 1
                    metric_error_class = "apply_worker_crashed"
                    metric_error_message = "apply_worker_crashed"
                finally:
                    batch_progress.applied = total_applied
                    batch_progress.failed = total_failed
                    batch_progress.worker_crashes = worker_crashes
                    batch_progress.joined = True
            else:
                if effective_limit:
                    base = effective_limit // workers
                    extra = effective_limit % workers
                    limits = [base + (1 if i < extra else 0) for i in range(workers)]
                else:
                    limits = [0] * workers

                progress = [_WorkerProgress() for _ in range(workers)]
                with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="apply-worker") as executor:
                    futures = {
                        executor.submit(
                            worker_loop,
                            worker_id=i,
                            limit=limits[i],
                            target_job_id=target_job_id,
                            min_score=min_score,
                            headless=headless,
                            model=model,
                            dry_run=dry_run,
                            snapshot=snapshot,
                            approval_required=approval_required,
                            workflow_id=workflow_id,
                            tenant_id=stable_tenant_id,
                            launcher_run=launcher_run,
                            poll_interval=poll_interval,
                            standing_refusal_poll=standing_refusal_poll,
                            dispatch_frontier=dispatch_frontier,
                            _progress=progress[i],
                        ): i
                        # Zero is the continuous sentinel in worker_loop, not
                        # an empty finite allocation. Do not start such workers
                        # when the requested batch is bounded.
                        for i in range(workers)
                        if not effective_limit or limits[i] > 0
                    }

                    cleanup_failure: ApplyLauncherCleanupIncomplete | None = None
                    for future in as_completed(futures):
                        wid = futures[future]
                        try:
                            applied, failed = future.result()
                        except Exception as exc:  # noqa: BLE001
                            logger.exception("Worker %d crashed", wid)
                            # Keep known completed job counts separate from the
                            # crashed worker's unknown job/submission outcome.
                            applied, failed = progress[wid].applied, progress[wid].failed
                            total_applied += applied
                            total_failed += failed
                            worker_crashes += 1
                            if isinstance(exc, ApplyLauncherCleanupIncomplete):
                                cleanup_failure = cleanup_failure or exc
                            else:
                                metric_error_class = "apply_worker_crashed"
                                metric_error_message = "apply_worker_crashed"
                        else:
                            total_applied += applied
                            total_failed += failed
                    batch_progress.applied = total_applied
                    batch_progress.failed = total_failed
                    batch_progress.worker_crashes = worker_crashes
                    batch_progress.joined = True
                    if cleanup_failure is not None:
                        raise cleanup_failure

            _dashboard_running = False
            refresh_thread.join(timeout=2)
            live.update(render_full(launcher_run.worker_ids))

        totals = get_totals(launcher_run.worker_ids)
        crash_summary = f", {worker_crashes} worker(s) crashed" if worker_crashes else ""
        console.print(f"\n[bold]Completed work: {total_applied} applied, {total_failed} failed{crash_summary} (${totals['cost']:.3f})[/bold]")
        console.print(f"Logs: {config.LOG_DIR}")
    except KeyboardInterrupt:
        metric_error_class = "manual_abort_apply"
        metric_error_message = "manual_abort_apply"
        pass
    except Exception as exc:
        metric_error_class = type(exc).__name__
        metric_error_message = str(exc)
        raise
    finally:
        _dashboard_running = False
        if install_signal_handlers:
            signal.signal(signal.SIGINT, previous_sigint_handler)
        if metric_error_class:
            metric_outcome = "failed"
        elif dry_run:
            metric_outcome = "dry_run"
        else:
            metric_outcome = "succeeded" if total_failed == 0 else "failed"
        # The owner still has to finish its scoped cleanup after _main returns.
        # Publish the terminal metric only after that boundary has completed.
        batch_progress.terminal_metric = {
            "outcome": metric_outcome, "run_id": batch_run_id, "tenant_id": stable_tenant_id,
            "job_id": target_job_id, "dry_run": dry_run, "workers": workers, "model": model,
            "duration_ms": int((time.time() - batch_started) * 1000),
            "total_applied": total_applied, "total_failed": total_failed, "worker_crashes": worker_crashes,
            "error_class": metric_error_class, "error_message": metric_error_message,
        }
    if worker_crashes:
        raise ApplyBatchWorkersCrashed(batch_progress.counts())
    return total_applied, total_failed


def _record_apply_batch_metric(
    *,
    outcome: str,
    run_id: str,
    tenant_id: str | None,
    job_id: JobId | None,
    dry_run: bool,
    workers: int,
    model: str,
    duration_ms: int | None = None,
    total_applied: int | None = 0,
    total_failed: int | None = 0,
    worker_crashes: int | None = 0,
    counts_known: bool = True,
    error_class: str | None = None,
    error_message: str | None = None,
) -> None:
    try:
        conn = get_connection()
        record_operational_attempt_metric(
            conn,
            stage="apply",
            attempt_kind="apply_batch",
            outcome=outcome,
            adapter="browser",
            run_id=run_id,
            tenant_id=tenant_id,
            job_id=str(canonical_job_id(str(job_id))) if job_id is not None else None,
            duration_ms=duration_ms,
            counts={"total": total_applied + total_failed if total_applied is not None and total_failed is not None else None},
            error_class=error_class,
            error_message=error_message,
            metadata={
                "dryRun": dry_run,
                "workers": workers,
                "model": model,
                "applied": total_applied,
                "failed": total_failed,
                "failedJobs": total_failed,
                "workerCrashes": worker_crashes,
                "countsKnown": counts_known if outcome != "started" else False,
            },
        )
        conn.commit()
    except Exception:
        logger.exception("Failed to record apply operational metric")


# Re-import LOCAL_TENANT lazily to avoid an import cycle (use_cases pulls
# in the launcher transitively through the apply package init).
from jobctrl.domain.tenant import LOCAL_TENANT  # noqa: E402


__all__ = [
    "acquire_job",
    "gen_prompt",
    "main",
    "mark_job",
    "mark_result",
    "recover_ambiguous_running_apply",
    "release_lock",
    "reset_failed",
    "run_job",
    "worker_loop",
]
