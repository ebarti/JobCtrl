"""ProjectionBuilder — wires the in-process event bus into the SQLite read-model.

Per ddd-target.md §6.6 the Operations context maintains denormalised
projections by subscribing to domain events emitted from every other
context.  In the local-first architecture this is a synchronous,
in-process subscriber: the wildcard handler runs on every published
event and rebuilds the affected projection rows from canonical
aggregate state (jobs / job_stage_states / job_scores / job_materials /
job_enrichments / job_artifacts / jobctrl_deleted_jobs) plus the
``job_events`` row stream (which now sources ``apply_run_projections``
directly — PR 4 of the Temporal stack collapsed the bespoke
``apply_runs`` table into the workflow run history).

This is intentionally **derive-from-canonical** rather than
**derive-from-event-payload**: the projection refresh re-reads the
authoritative aggregate tables for each dirty job, which means

    1. The projection logic doesn't have to mirror every domain-event
       payload shape — it owns the join shape once.
    2. Out-of-order or partially-missed events are self-correcting on
       the next refresh.
    3. The same code path serves the ``replay_from_events`` initial
       backfill and the ``process_event`` live update.

Watermark semantics (``event_watermarks`` table from Phase 3 / S-10):
the builder reads ``last_event_id`` for the
``operations_projections`` projection name, processes every newer
``job_events`` row, and advances the watermark in the same
transaction.  On startup the projection tables may be empty AND the
watermark zero — we handle that by force-marking every existing
``jobs`` row as dirty so the initial backfill catches pre-event-history
rows.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import sqlite3
import threading
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.operations.projections import (
    ApplyUrlOutcomeProjection,
    ApplyRunProjection,
    ArtifactListProjection,
    ContactProjection,
    ContactResearchTaskProjection,
    DashboardFunnelStage,
    DashboardProjection,
    DueFollowUpProjection,
    JobDetailProjection,
    JobListProjection,
    OutreachThreadProjection,
    StageProjection,
    WorkflowRunProjection,
)
from jobctrl.domain.ports.events import EventPublisher, Subscription
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.compensation.benchmark_lineage import (
    load_market_benchmark_lineage,
)
from jobctrl.infrastructure.events.watermark import SqliteEventWatermarkRepository
from jobctrl.infrastructure.projections.location_normalization import (
    normalize_job_location,
)
from jobctrl.infrastructure.projections.sqlite_projection_store import (
    SqliteProjectionStore,
    ensure_projection_tables,
)
from jobctrl.infrastructure.projections.source_quality import (
    SOURCE_QUALITY_EVENT_TYPES,
    event_row_from_sql,
    project_source_quality,
)


@dataclass(frozen=True)
class _ProvenanceProjection:
    """Provenance + coverage + voice read shapes per artifact.

    Each maps ``artifact_id -> serialised JSON`` so the artifact projection can
    attach the canonical Phase-2 (provenance) and Phase-3 (coverage + voice) read
    shapes directly, all loaded once from the canonical ``job_bullet_provenance``
    rows by the single projection owner.
    """

    provenance: dict[str, str]
    coverage: dict[str, str]
    voice: dict[str, str]


log = logging.getLogger(__name__)


PROJECTION_NAME = "operations_projections"
# One-time backfill marker: existing DBs already had the score-audit projection
# columns (the TS builder added them via ensureProjectionColumn), so the schema-
# migration reset in ``ensure_projection_tables`` never fires for them and the
# scored rows the Python builder wrote before it learned to project the audit
# columns keep NULL criteria/trace/correction. This marker drives a single
# targeted rebuild of those rows, independent of column creation.
SCORE_AUDIT_BACKFILL = "score_audit_columns_v1"
COMPENSATION_PROJECTION_VERSION = 3

_APPLY_URL_OUTCOME_DETAILS: dict[str, tuple[str, bool]] = {
    "APPLY_URL_EXTERNAL_RECOVERED": (
        "An external application URL was recovered.",
        False,
    ),
    "APPLY_URL_LINKEDIN_ONSITE": (
        "LinkedIn uses an on-site application flow for this posting; no external application URL exists.",
        False,
    ),
    "APPLY_URL_CONTROL_MISSING": (
        "No application control was visible on the authenticated LinkedIn page.",
        True,
    ),
    "APPLY_URL_EXTERNAL_TARGET_MISSING": (
        "An application control was visible, but no external application URL could be verified.",
        True,
    ),
    "APPLY_URL_NAVIGATION_FAILED": (
        "The authenticated LinkedIn page could not be inspected.",
        True,
    ),
    "APPLY_URL_UNSAFE_TARGET": (
        "JobCtrl rejected the discovered application target because it is not a safe public HTTP(S) destination.",
        False,
    ),
}
_APPLY_URL_OUTCOME_METHODS = frozenset(
    {
        "authenticated_browser",
        "current_url",
        "href_redirect",
        "href",
        "click",
        "linkedin_onsite_apply",
        "apply_button_missing",
        "external_url_missing",
        "navigation_error",
        "resolver_error",
        "unsafe_url",
    }
)


def _apply_url_outcome_from_stage_metadata(
    value: str | None,
) -> ApplyUrlOutcomeProjection | None:
    """Project only stable, code-owned application-target diagnostics."""

    if not value:
        return None
    try:
        metadata = json.loads(value)
    except (TypeError, ValueError):
        return None
    if not isinstance(metadata, dict):
        return None
    code_value = metadata.get("applyUrlOutcomeCode")
    code = code_value.strip() if isinstance(code_value, str) else ""
    details = _APPLY_URL_OUTCOME_DETAILS.get(code)
    if details is None:
        return None
    method_value = metadata.get("authenticatedApplyUrlMethod")
    method = method_value.strip() if isinstance(method_value, str) else ""
    message, retryable = details
    return ApplyUrlOutcomeProjection(
        code=code,
        message=message,
        retryable=retryable,
        method=method if method in _APPLY_URL_OUTCOME_METHODS else None,
    )


# State-bearing workflow lifecycle events fold into
# ``workflow_run_projections`` keyed by ``workflowId``. The ``WorkflowStarted``
# marker opens a row; each terminal event maps to a terminal status in the
# 12-state ``WORKFLOW_RUN_STATUSES``.
WORKFLOW_STATE_EVENT_TYPES: tuple[str, ...] = (
    "WorkflowStarted",
    "WorkflowCompleted",
    "WorkflowFailed",
    "WorkflowCanceled",
    "WorkflowTimedOut",
    "WorkflowTerminated",
)
# Audit-only facts riding the same per-run stream: they enrich the projected
# timeline but must never drive the lifecycle fold. A group that contains only
# audit facts (e.g. a cancellation-requester backfill for a legacy canceled
# run) materialises nothing, so the stored row is preserved verbatim.
WORKFLOW_AUDIT_EVENT_TYPES: tuple[str, ...] = ("WorkflowCancellationRequested",)
WORKFLOW_EVENT_TYPES: tuple[str, ...] = WORKFLOW_STATE_EVENT_TYPES + WORKFLOW_AUDIT_EVENT_TYPES

PIPELINE_STEP_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "PipelineStepQueued",
        "PipelineStepStarted",
        "PipelineStepCompleted",
        "PipelineStepFailed",
    }
)
_PIPELINE_STEP_EVENT_STATES: dict[str, str] = {
    "PipelineStepQueued": "queued",
    "PipelineStepStarted": "running",
    "PipelineStepCompleted": "succeeded",
    "PipelineStepFailed": "failed",
}
_PIPELINE_STEP_KINDS: frozenset[str] = frozenset(
    {
        "source_planning",
        "source_family",
        "enrichment_pass",
        "preparation_fanout",
        "existing_backlog_sweep",
        "pdf_render",
    }
)
_PIPELINE_STEP_DETAIL_CODES: frozenset[str] = frozenset(
    {
        "source_plan",
        "source_family",
        "streaming_pass",
        "terminal_reconciliation",
        "existing_backlog",
        "pdf_render",
    }
)
_SAFE_PIPELINE_ITEM_KEY = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,159}$")
_SAFE_PIPELINE_ERROR_CODE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,79}$")
_MAX_SAFE_PIPELINE_INTEGER = 9_007_199_254_740_991


@dataclass(frozen=True)
class _PipelineStepFold:
    tenant_id: str
    workflow_id: str
    temporal_run_id: str
    step_kind: str
    item_key: str
    state: str
    attempt: int
    queued_at: str | None
    started_at: str | None
    finished_at: str | None
    duration_ms: int | None
    error_code: str | None
    retryable: bool
    detail_code: str | None
    detail_count: int | None
    last_event_id: int
    last_updated_at: str


_WORKFLOW_TERMINAL_STATUS: dict[str, str] = {
    "WorkflowCompleted": "succeeded",
    "WorkflowFailed": "failed",
    "WorkflowCanceled": "canceled",
    "WorkflowTimedOut": "timed_out",
    "WorkflowTerminated": "terminated",
}
# The terminal statuses those events fold to. The fold is first-terminal-wins:
# once a run is terminal, a later terminal ``Workflow*`` event for the same
# ``workflowId`` cannot replace it (see ``_project_workflow_run``).
_WORKFLOW_TERMINAL_STATUSES: frozenset[str] = frozenset(_WORKFLOW_TERMINAL_STATUS.values())

# Contact aggregate events (Contact & Outreach, ninth context). Any of these
# marks the contact read model dirty; ``_rebuild_contacts`` then rematerialises
# every contact projection from the canonical ``contacts`` / ``contact_attributes``
# rows (values never enter the projection — sensitivity rule, plan §6).
CONTACT_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "ContactCreated",
        "ContactUpdated",
        "ContactAttributeRecorded",
        "ContactDeleted",
        "WarmIntroIdentified",
    }
)

# ContactResearchTask events (§4.2). Any of these marks the research read model
# dirty; ``_rebuild_contact_research`` then rematerialises every research-task
# projection from the canonical ``contact_research_tasks`` / ``contact_candidates``
# rows (candidate values never enter the projection — sensitivity rule, plan §6).
CONTACT_RESEARCH_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "ContactResearchTaskStarted",
        "ContactCandidateProposed",
        "ContactResearchTaskNeedsReview",
        "ContactResearchTaskCompleted",
        "ContactResearchTaskFailed",
    }
)

# OutreachThread events (§4.3, §4.4/§9). Any of these marks the outreach read
# model dirty; ``_rebuild_outreach`` rematerialises every outreach-thread
# projection and ``_rebuild_due_follow_ups`` rematerialises the scheduled
# follow-ups (draft body, gate internals, provenance, and contact PII never enter
# a projection — sensitivity rule, plan §6). The send-log and follow-up events
# carry only ids, a channel label, and timestamps.
OUTREACH_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "OutreachDraftGenerated",
        "OutreachDraftRevised",
        "OutreachDraftApproved",
        "OutreachDraftRejected",
        "OutreachSendLogged",
        "FollowUpScheduled",
        "FollowUpCompleted",
        "FollowUpDismissed",
    }
)
POSTED_COMPENSATION_WARNING_MESSAGES = {
    "ambiguous_multiple_amounts": "Multiple compensation amounts were present and the primary range is ambiguous.",
    "bonus_component": "The source text mentions bonus compensation.",
    "broad_range": "The posted range is broad enough to reduce precision.",
    "commission_component": "The source text mentions commission compensation.",
    "equity_component": "The source text mentions equity or stock compensation.",
    "hourly_period": "The source text uses an hourly compensation period.",
    "missing_currency": "The parser could not identify an explicit currency.",
    "missing_period": "The parser could not identify an explicit compensation period.",
    "monthly_period": "The source text uses a monthly compensation period.",
    "no_amount_found": "No compensation amount could be safely extracted.",
    "one_sided_range": "The posted range is one-sided.",
    "ote_component": "The source text mentions on-target earnings.",
    "source_text_truncated": "The stored source text was truncated to the bounded salary excerpt limit.",
}
MARKET_COMPENSATION_WARNING_MESSAGES = {
    "benchmark_extrapolated": "The range was extrapolated from direct benchmark evidence in another geography.",
    "benchmark_level_fallback": "The benchmark uses an all-level fallback because exact seniority evidence was unavailable.",
    "company_role_fallback": "The estimate fell back from exact company-role evidence to adjacent company or tier evidence.",
    "cost_of_living_only": "The geographic adjustment relies on cost-of-living evidence without a matched-company pay bridge.",
    "factor_out_of_bounds": "The raw geographic adjustment is outside the supported 0.1x to 10x range and needs careful review.",
    "limited_matched_company_evidence": "Only limited matched-company cross-country evidence supports the geographic adjustment.",
    "location_mismatch": "Reported compensation locations did not strongly match the job location.",
    "low_sample_count": "Reported compensation sample support is low.",
    "reported_compensation_sample": "The estimate uses reported compensation rows for the job company and role.",
    "posted_salary_sample": "The estimate uses employer-posted salary text captured by JobCtrl.",
    "source_conflict_with_posted_salary": "Reported compensation diverges materially from the posted salary.",
    "stale_source_snapshot": "A source snapshot is stale under the freshness policy.",
    "trimodal_tier_inferred": "The company tier was inferred from reported compensation amounts.",
}
MARKET_COMPENSATION_REASON_MESSAGES = {
    "low_sample_count": "Reported compensation sample support is below the configured confidence threshold.",
    "missing_company": "The job has no company name to match reported compensation.",
    "missing_reported_observation": "No reported compensation row matched this job's company and role.",
    "missing_role": "The job has no title/role text to match reported compensation.",
    "source_dispersion_too_high": "Reported compensation rows diverged too much to emit a precise range.",
    "stale_source_snapshot": "A required reported compensation source snapshot is stale under the freshness policy.",
    "unsupported_component": "The compensation component is outside the supported reported compensation model.",
    "unsupported_source": "Unsupported source evidence was rejected.",
    "weak_company_match": "Company match support was too weak for a range.",
    "weak_level_match": "Level/seniority support was too weak for a range.",
    "weak_location_match": "Location support was too weak for a range.",
    "weak_role_match": "Role match support was too weak for a range.",
}
MARKET_SOURCE_DEFAULTS = {
    "levels_fyi": {
        "displayName": "Levels.fyi",
        "sourceType": "reported_compensation",
        "provenance": "licensed",
        "snapshotVersion": "reported-compensation-import-v1",
        "geographyScope": "reported",
        "aggregateBucket": "reported company-role compensation",
        "attribution": "Levels.fyi licensed compensation data",
    },
    "glassdoor": {
        "displayName": "Glassdoor",
        "sourceType": "reported_compensation",
        "provenance": "licensed",
        "snapshotVersion": "reported-compensation-import-v1",
        "geographyScope": "reported",
        "aggregateBucket": "reported company-role compensation",
        "attribution": "Glassdoor reported compensation data",
    },
    "manual_reported_compensation": {
        "displayName": "Manual reported compensation import",
        "sourceType": "reported_compensation",
        "provenance": "manual",
        "snapshotVersion": "reported-compensation-import-v1",
        "geographyScope": "reported",
        "aggregateBucket": "reported company-role compensation",
        "attribution": "Manual reported compensation import",
    },
    "euro_top_tech": {
        "displayName": "Euro Top Tech",
        "sourceType": "reported_compensation",
        "provenance": "public",
        "snapshotVersion": "eurotoptech-data-public",
        "geographyScope": "Europe",
        "aggregateBucket": "reported company-role compensation",
        "attribution": "Euro Top Tech public crowdsourced compensation data",
    },
    "posted_salary_text": {
        "displayName": "Job posting salary text",
        "sourceType": "posted_salary",
        "provenance": "employer_posted",
        "snapshotVersion": "jobctrl-posted-compensation-v1",
        "geographyScope": "reported",
        "aggregateBucket": "employer-posted company-role compensation",
        "attribution": "Employer-posted salary text captured by JobCtrl",
    },
}
MARKET_SAFE_AGGREGATE_BUCKETS = {
    "reported company-role compensation",
    "reported company adjacent-role compensation",
    "same-location role compensation fallback",
    "trimodal tier role fallback",
    "trimodal market baseline fallback",
    "employer-posted company-role compensation",
    "employer-posted same-location role compensation",
    "employer-posted trimodal tier compensation",
    "employer-posted trimodal market baseline",
}
MARKET_SAFE_GEOGRAPHY_SCOPES = {
    "Europe",
    "reported",
    "country",
    "country_subdivision",
    "locality",
}
MARKET_SAFE_FACTOR_NAMES = {
    "agreement",
    "company",
    "component",
    "freshness",
    "level",
    "location",
    "role",
    "sample",
    "trimodal_tier",
}
MARKET_CONFIDENCE_BANDS = {"high", "medium", "low", "none"}
MARKET_RECORDED_STATES = {"unsupported", "source_unavailable", "insufficient_evidence", "estimated_range"}
MARKET_DEFAULT_FACTOR_REASON = (
    "Reported compensation estimate factor recorded by the deterministic company-role estimator."
)
MARKET_MAX_FACTOR_REASON_LENGTH = 240
MARKET_UNSAFE_FACTOR_REASON_TERMS = (
    "/users/",
    "\\users\\",
    "file://",
    "rawproviderpayload",
    "credential",
    "secret",
    "token",
    "password",
    "api_key",
    "api key",
    "api-key",
    "private",
)

STAGE_ORDER: tuple[str, ...] = (
    "discover",
    "enrich",
    "score",
    "tailor",
    "cover",
    "apply",
)

DEFAULT_MAX_ATTEMPTS: dict[str, int] = {
    "discover": 1,
    "enrich": 3,
    "score": 3,
    "tailor": 5,
    "cover": 5,
    "apply": 3,
}


def _job_list_stage(stage: str | None, *, has_resume: bool = False) -> str:
    return "apply" if stage == "apply" or (stage == "cover" and has_resume) else "discover"


_UNKNOWN_EMPLOYER = "Unknown company"

# Score bands bucket ``fit_score`` by the user-facing scoring criteria in
# ``domain/scoring/use_cases.py`` SCORE_PROMPT (9-10 perfect ... 1-2 poor) so the
# outcome-conversion funnel reads by the same bands the score view shows.
SCORE_BAND_ORDER: tuple[str, ...] = ("perfect", "strong", "moderate", "weak", "poor", "unscored")
FIT_BAND_ORDER: tuple[str, ...] = ("excellent", "strong", "plausible", "stretch", "poor", "unreported")
APPLY_MODE_ORDER: tuple[str, ...] = ("automated_live", "manual_marked", "external_confirmed")

# Outcome kinds that mark an applied job as having reached each funnel stage.
# Later stages imply earlier ones (an offer implies an interview and a reply), so
# the sets are cumulative and reply >= interview >= offer holds within each group.
_REPLY_OUTCOME_KINDS = frozenset({"recruiter_reply", "interview", "assessment", "offer", "rejection"})
_INTERVIEW_OUTCOME_KINDS = frozenset({"interview", "assessment", "offer"})
_OFFER_OUTCOME_KINDS = frozenset({"offer"})
_REJECTION_OUTCOME_KINDS = frozenset({"rejection"})


def _score_band(fit_score: int | None) -> str:
    if fit_score is None:
        return "unscored"
    if fit_score >= 9:
        return "perfect"
    if fit_score >= 7:
        return "strong"
    if fit_score >= 5:
        return "moderate"
    if fit_score >= 3:
        return "weak"
    return "poor"


def _fit_band(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in FIT_BAND_ORDER else "unreported"


def _apply_mode(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in APPLY_MODE_ORDER else "manual_marked"


def _projection_text(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def _projection_int(value: object) -> int | None:
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number


def _decode_json_dicts(raw: object) -> tuple[dict[str, Any], ...]:
    """Parse a JSON array of dicts, dropping anything malformed (safe refs only)."""
    if not raw:
        return ()
    try:
        items = json.loads(str(raw))
    except (TypeError, ValueError):
        return ()
    if not isinstance(items, list):
        return ()
    return tuple(item for item in items if isinstance(item, dict))


def _attribute_kinds(attributes_json: object) -> list[str]:
    """Return the distinct attribute kinds on a candidate — never the values.

    The projection carries which facts a candidate proposes (name / title /
    email) without ever copying the sensitive value into derived read data.
    """
    kinds: list[str] = []
    for attribute in _decode_json_dicts(attributes_json):
        kind = str(attribute.get("kind") or "").strip()
        if kind and kind not in kinds:
            kinds.append(kind)
    return kinds


def _gate_passed(raw: object) -> bool:
    """Read the persisted gate outcome (INV-5) from ``gate_results_json``.

    Only an explicit ``passed: true`` counts as passed; a missing, null, or
    malformed gate result is treated as not passed so the projection never
    reports a draft as approvable when the gate record cannot confirm it.
    """
    if not raw:
        return False
    try:
        parsed = json.loads(str(raw))
    except (TypeError, ValueError):
        return False
    return isinstance(parsed, dict) and parsed.get("passed") is True


def _material_analytics_from_metadata(metadata_json: str | None) -> dict[str, object]:
    metadata = _json_loads(metadata_json, {})
    if not isinstance(metadata, dict):
        return {}
    template = metadata.get("resume_template")
    if not isinstance(template, dict):
        template = {}
    return {
        "resume_template_id": _projection_text(template.get("templateId") or template.get("template_id")),
        "resume_template_name": _projection_text(
            template.get("templateName") or template.get("template_name") or template.get("displayName")
        ),
        "tailoring_policy_version": _projection_int(
            metadata.get("tailoring_policy_version") or metadata.get("tailoringPolicyVersion")
        ),
    }


def _merge_material_analytics(metadata_jsons: list[str | None]) -> dict[str, object]:
    merged: dict[str, object] = {
        "resume_template_id": None,
        "resume_template_name": None,
        "tailoring_policy_version": None,
    }
    for metadata_json in metadata_jsons:
        next_value = _material_analytics_from_metadata(metadata_json)
        if merged["resume_template_id"] is None:
            merged["resume_template_id"] = next_value.get("resume_template_id")
        if merged["resume_template_name"] is None:
            merged["resume_template_name"] = next_value.get("resume_template_name")
        if merged["tailoring_policy_version"] is None:
            merged["tailoring_policy_version"] = next_value.get("tailoring_policy_version")
    return merged


def _material_analytics_complete(value: dict[str, object]) -> bool:
    return (
        value.get("resume_template_id") is not None
        and value.get("resume_template_name") is not None
        and value.get("tailoring_policy_version") is not None
    )


def _material_metadata_references(
    metadata_jsons: list[str | None],
) -> tuple[int | None, list[str]]:
    base_generation: int | None = None
    base_artifact_ids: set[str] = set()
    for metadata_json in metadata_jsons:
        metadata = _json_loads(metadata_json, {})
        if not isinstance(metadata, dict):
            continue
        if base_generation is None:
            base_generation = _projection_int(metadata.get("base_generation") or metadata.get("baseGeneration"))
        for key in (
            "base_resume_text_artifact_id",
            "baseResumeTextArtifactId",
            "base_resume_pdf_artifact_id",
            "baseResumePdfArtifactId",
        ):
            artifact_id = _projection_text(metadata.get(key))
            if artifact_id:
                base_artifact_ids.add(artifact_id)
    return base_generation, sorted(base_artifact_ids)


def _template_key(value: str | None) -> str:
    return _projection_text(value) or "unreported"


def _template_conversion_sort_key(
    item: tuple[str, dict[str, object]],
) -> tuple[int, str, str]:
    template_id, bucket = item
    counts = bucket["counts"]
    assert isinstance(counts, dict)
    return (
        -int(counts["applied"]),
        str(bucket.get("templateName") or template_id),
        template_id,
    )


def _policy_key(value: int | None) -> str:
    return "unreported" if value is None else str(int(value))


def _policy_version_from_key(value: str) -> int | None:
    if value == "unreported":
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _policy_label(version: int | None) -> str:
    return "Unreported" if version is None else f"Policy v{version}"


def _parse_iso_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _has_any_kind(outcomes: tuple[dict[str, str | None], ...], target: frozenset[str]) -> bool:
    return any(str(outcome.get("kind") or "") in target for outcome in outcomes)


def _first_response_minutes(
    applied_at: str | None,
    outcomes: tuple[dict[str, str | None], ...],
) -> int | None:
    applied = _parse_iso_timestamp(applied_at)
    if applied is None:
        return None
    earliest: datetime | None = None
    for outcome in outcomes:
        if str(outcome.get("kind") or "") not in _REPLY_OUTCOME_KINDS:
            continue
        occurred = _parse_iso_timestamp(outcome.get("occurredAt"))
        if occurred is None or occurred < applied:
            continue
        earliest = occurred if earliest is None else min(earliest, occurred)
    if earliest is None:
        return None
    return int((earliest - applied).total_seconds() // 60)


def _starts_new_execution(
    *,
    folded_run_id: str | None,
    folded_finished_at: str | None,
    event_run_id: str | None,
    event_occurred_at: str | None,
) -> bool:
    """Whether a ``WorkflowStarted`` belongs to a new execution of the id.

    A workflow_id is reused when Temporal restarts a run the reconciler already
    closed. When both the folded terminal and the start event carry a Temporal
    run id, a differing id is authoritative. When run ids are absent, fall back
    to wall-clock ordering: a start that occurred after the folded run finished
    is a new execution.
    """
    if event_run_id and folded_run_id:
        return event_run_id != folded_run_id
    started = _parse_iso_timestamp(event_occurred_at)
    finished = _parse_iso_timestamp(folded_finished_at)
    if started is None or finished is None:
        return False
    return started > finished


class ProjectionBuilder:
    """In-process projection materialiser.

    Wire it once on worker startup with
    :func:`ProjectionBuilder.subscribe_to`.  Call
    :meth:`refresh` after the canonical write so the derived projections
    catch up.  Tests can also drive it manually via :meth:`refresh` after
    seeding data.

    The builder takes a ``conn_factory`` rather than a fixed
    :class:`sqlite3.Connection` because the in-process bus's wildcard
    subscriber (``_on_event``) fires synchronously on whatever thread
    published the event — and SQLite connections are thread-bound.
    The factory lets ``_on_event`` open a per-call connection on the
    publishing thread (see ``get_connection`` in
    :mod:`jobctrl.database`, which is itself thread-local-cached).

    For single-threaded callers (CLI bootstrap, tests) the factory can
    legitimately return the same shared connection on every call:
    ``ProjectionBuilder(conn_factory=lambda: conn)``.
    """

    def __init__(
        self,
        *,
        conn_factory: Callable[[], sqlite3.Connection],
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> None:
        self._conn_factory = conn_factory
        self._tenant_id: TenantId = tenant_id
        # Thread-local binding scope for refresh().  Each thread that
        # calls refresh() (or _on_event) gets its own conn / store /
        # watermarks rooted at the connection the factory returned on
        # that thread.  This is necessary because the wildcard
        # subscriber fires on whatever thread published the event.
        self._local = threading.local()
        # Schema setup runs once on construction.  We pull a connection
        # from the factory and intentionally do **not** close it: when
        # the factory returns a thread-local cached handle (production)
        # or a shared test handle (``lambda: conn``), closing here would
        # break subsequent callers.  The factory is the right place to
        # own connection lifetime.
        boot_conn = conn_factory()
        ensure_projection_tables(boot_conn)
        boot_conn.commit()

    @property
    def _watermark_name(self) -> str:
        tenant = str(self._tenant_id)
        return PROJECTION_NAME if tenant == str(LOCAL_TENANT) else f"{PROJECTION_NAME}:{tenant}"

    # ------------------------------------------------------------ subscription

    def subscribe_to(self, publisher: EventPublisher) -> Subscription:
        """Wildcard-subscribe — refresh on every published event."""
        return publisher.subscribe(None, self._on_event)

    def _on_event(self, event: DomainEvent) -> None:
        # Open a thread-local connection via the factory so the refresh
        # runs on whichever thread published the event.  We deliberately
        # do **not** close the connection here: in production the
        # factory is :func:`jobctrl.database.get_connection` which
        # returns the thread-local cached handle that the publishing
        # caller is itself using — closing it would yank the conn out
        # from under the writer.  Tests pass ``lambda: conn`` (shared
        # handle) for the same reason.  The factory owns connection
        # lifetime; the builder must never close.
        try:
            conn = self._conn_factory()
            self._refresh(conn)
        except Exception:  # noqa: BLE001 — projection failure must not break write
            # ``log.exception`` (=== ``log.error(..., exc_info=True)``)
            # records the full traceback.  A silent swallow here is
            # what previously hid the cross-thread ProgrammingError.
            log.exception("ProjectionBuilder failed to refresh after %s", event.event_type)

    # ----------------------------------------------------------- thread-local

    @property
    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            raise RuntimeError("ProjectionBuilder._conn accessed outside a refresh scope")
        return conn

    @property
    def _store(self) -> SqliteProjectionStore:
        store = getattr(self._local, "store", None)
        if store is None:
            raise RuntimeError("ProjectionBuilder._store accessed outside a refresh scope")
        return store

    @property
    def _watermarks(self) -> SqliteEventWatermarkRepository:
        watermarks = getattr(self._local, "watermarks", None)
        if watermarks is None:
            raise RuntimeError("ProjectionBuilder._watermarks accessed outside a refresh scope")
        return watermarks

    @contextlib.contextmanager
    def _bind(self, conn: sqlite3.Connection):
        """Bind ``conn`` (+ derived adapters) to thread-local state.

        Restores any prior binding on exit so reentrant refreshes from
        the same thread do not clobber each other.
        """
        prev_conn = getattr(self._local, "conn", None)
        prev_store = getattr(self._local, "store", None)
        prev_watermarks = getattr(self._local, "watermarks", None)
        self._local.conn = conn
        self._local.store = SqliteProjectionStore(conn)
        self._local.watermarks = SqliteEventWatermarkRepository(conn)
        try:
            yield
        finally:
            self._local.conn = prev_conn
            self._local.store = prev_store
            self._local.watermarks = prev_watermarks

    # ----------------------------------------------------------------- refresh

    def refresh(self) -> int:
        """Process new ``job_events`` rows and rebuild affected projections.

        Returns the number of dirty jobs processed.  Idempotent: running
        twice in a row produces the same projection state.

        External callers (CLI bootstrap, tests) drive this directly; the
        connection comes from the factory and is **not** closed here —
        the bootstrap path reuses a thread-local cached connection
        (``get_connection`` in :mod:`jobctrl.database`) and tests
        commonly pass ``lambda: conn`` so the same shared handle is
        returned every call.  Only :meth:`_on_event` owns the close
        because it opens a per-event connection on whichever thread
        published the event.
        """
        conn = self._conn_factory()
        return self._refresh(conn)

    def _refresh(self, conn: sqlite3.Connection) -> int:
        """Refresh against an already-opened connection (used by ``_on_event``)."""
        with self._bind(conn):
            return self._refresh_impl()

    def _refresh_impl(self) -> int:
        watermark_name = self._watermark_name
        watermark = self._watermarks.get(watermark_name)
        rows = self._conn.execute(
            """
            SELECT events.event_id, events.job_id, events.event_type,
                   events.occurred_at, events.payload_json
            FROM job_events AS events
            WHERE events.tenant_id = ?
              AND events.event_id > ?
            ORDER BY events.event_id ASC
            """,
            (str(self._tenant_id), watermark),
        ).fetchall()

        dirty_job_ids: set[str] = set()
        source_quality_dirty = False
        workflow_runs_dirty = False
        pipeline_steps_dirty = False
        contacts_dirty = False
        contact_research_dirty = False
        outreach_dirty = False
        evidence_usage_dirty = bool(rows)
        max_event_id = watermark
        for row in rows:
            event_id = int(row["event_id"]) if not isinstance(row, tuple) else int(row[0])
            if event_id > max_event_id:
                max_event_id = event_id
            job_id = row["job_id"] if not isinstance(row, tuple) else row[1]
            if job_id:
                dirty_job_ids.add(str(job_id))
            event_type = row["event_type"] if not isinstance(row, tuple) else row[2]
            if str(event_type) in SOURCE_QUALITY_EVENT_TYPES:
                source_quality_dirty = True
            if str(event_type) in WORKFLOW_EVENT_TYPES:
                workflow_runs_dirty = True
            if str(event_type) in PIPELINE_STEP_EVENT_TYPES:
                pipeline_steps_dirty = True
            if str(event_type) in CONTACT_EVENT_TYPES:
                contacts_dirty = True
            if str(event_type) in CONTACT_RESEARCH_EVENT_TYPES:
                contact_research_dirty = True
            if str(event_type) in OUTREACH_EVENT_TYPES:
                outreach_dirty = True

        # First-run backfill for contacts: if the contact read model is empty
        # but canonical contact rows exist (e.g. tables recreated), rebuild.
        if not contacts_dirty and self._contacts_backfill_pending():
            contacts_dirty = True
        if not contact_research_dirty and self._contact_research_backfill_pending():
            contact_research_dirty = True
        if not outreach_dirty and self._outreach_backfill_pending():
            outreach_dirty = True

        # First-run backfill: if projections are empty, mark every
        # existing job as dirty so pre-event-history rows still get
        # projected.  This also covers the case where the projection
        # tables were dropped + recreated.
        if self._store.count_job_list(str(self._tenant_id)) == 0:
            try:
                jobs_rows = self._conn.execute(
                    "SELECT job_id FROM jobs WHERE tenant_id = ?",
                    (str(self._tenant_id),),
                ).fetchall()
                for jrow in jobs_rows:
                    job_id = jrow["job_id"] if not isinstance(jrow, tuple) else jrow[0]
                    if job_id:
                        dirty_job_ids.add(str(job_id))
            except sqlite3.OperationalError:
                # ``jobs`` table not yet created (very-fresh DB) — nothing
                # to backfill.
                pass
        dirty_job_ids.update(self._stale_deleted_projection_jobs())
        dirty_job_ids.update(self._stale_artifact_projection_jobs())
        dirty_job_ids.update(self._stale_stage_projection_jobs())
        dirty_job_ids.update(self._stale_compensation_projection_jobs())

        # One-time score-audit backfill (see SCORE_AUDIT_BACKFILL): rebuild any
        # already-projected scored job whose audit columns are still NULL. This
        # is independent of schema migration — on existing DBs the columns were
        # added long ago by the TS builder, so the migration reset never runs.
        audit_backfill_pending = not self._score_audit_backfill_done()
        if audit_backfill_pending:
            dirty_job_ids.update(self._jobs_missing_score_audit_projection())
        workflow_runs_backfill_pending = self._workflow_runs_backfill_pending()
        if not pipeline_steps_dirty and self._pipeline_steps_backfill_pending():
            pipeline_steps_dirty = True
        evidence_usage_exists = (
            self._conn.execute(
                "SELECT 1 FROM evidence_usage_projections WHERE tenant_id = ? LIMIT 1",
                (str(self._tenant_id),),
            ).fetchone()
            is not None
        )
        if not evidence_usage_exists:
            evidence_usage_dirty = True

        # L5 (round-1 review): if there's nothing dirty AND we've already
        # synced past the latest event, skip the O(jobs × stages)
        # dashboard / apply-run rebuilds.  Exception: first-run, when
        # the dashboard row doesn't exist yet — materialise an empty
        # one so reads always return data.
        dashboard_exists = (
            self._conn.execute(
                "SELECT 1 FROM dashboard_projections WHERE tenant_id = ?",
                (str(self._tenant_id),),
            ).fetchone()
            is not None
        )
        source_quality_exists = (
            self._conn.execute(
                "SELECT 1 FROM source_quality_stats WHERE tenant_id = ? LIMIT 1",
                (str(self._tenant_id),),
            ).fetchone()
            is not None
        )
        source_quality_history = source_quality_dirty or self._has_source_quality_history()
        if (
            not dirty_job_ids
            and not source_quality_dirty
            and dashboard_exists
            and (source_quality_exists or not source_quality_history)
            and max_event_id == watermark
            and not audit_backfill_pending
            and not workflow_runs_backfill_pending
            and not pipeline_steps_dirty
            and not evidence_usage_dirty
            and not contacts_dirty
            and not contact_research_dirty
            and not outreach_dirty
        ):
            return 0

        # ``record_job_event`` invokes the wildcard subscriber inside the
        # caller's open transaction (e.g. ``acquire_job``'s
        # ``BEGIN IMMEDIATE`` block). Issuing our own ``commit()`` mid-
        # transaction would prematurely release the row lock and break
        # the caller's rollback path. Detect the in-transaction case and
        # let the caller flush both writes; standalone refreshes (the
        # CLI / tests) commit themselves.
        defer_commit = bool(getattr(self._conn, "in_transaction", False))

        if not dirty_job_ids:
            # Watermark advanced past events with no job (e.g.
            # system events, workflow lifecycle events) OR first-run: bump
            # the watermark + ensure the dashboard row exists.
            if source_quality_dirty or (not source_quality_exists and source_quality_history):
                self._rebuild_source_quality()
            if workflow_runs_dirty or workflow_runs_backfill_pending:
                self._rebuild_workflow_runs()
            if pipeline_steps_dirty:
                self._rebuild_pipeline_steps()
            if contacts_dirty:
                self._rebuild_contacts()
            if contact_research_dirty:
                self._rebuild_contact_research()
            if outreach_dirty:
                self._rebuild_outreach()
                self._rebuild_due_follow_ups()
            if evidence_usage_dirty:
                self._rebuild_evidence_usage()
            if max_event_id > watermark:
                self._watermarks.set(watermark_name, max_event_id, commit=not defer_commit)
            if not dashboard_exists:
                self._rebuild_dashboard()
            if audit_backfill_pending:
                self._mark_score_audit_backfill_done()
            if not defer_commit:
                self._conn.commit()
            return 0

        # PR 4 of the Temporal stack: rebuild ``apply_run_projections``
        # first so ``_rebuild_job`` can read the freshly derived apply
        # lifecycle status when it materialises ``job_list_projections``.
        self._rebuild_apply_runs()
        if workflow_runs_dirty or workflow_runs_backfill_pending:
            self._rebuild_workflow_runs()
        if pipeline_steps_dirty:
            self._rebuild_pipeline_steps()
        if source_quality_dirty or (not source_quality_exists and source_quality_history):
            self._rebuild_source_quality()
        if contacts_dirty:
            self._rebuild_contacts()
        if contact_research_dirty:
            self._rebuild_contact_research()
        if outreach_dirty:
            self._rebuild_outreach()
            self._rebuild_due_follow_ups()
        for job_id in dirty_job_ids:
            self._rebuild_job(job_id)
        self._rebuild_dashboard()
        self._rebuild_evidence_usage()
        if max_event_id > watermark:
            self._watermarks.set(watermark_name, max_event_id, commit=not defer_commit)
        if audit_backfill_pending:
            self._mark_score_audit_backfill_done()
        if not defer_commit:
            self._conn.commit()
        return len(dirty_job_ids)

    # -------------------------------------------------------------- builders

    def _contacts_backfill_pending(self) -> bool:
        if self._store.count_contacts(str(self._tenant_id)) > 0:
            return False
        try:
            row = self._conn.execute(
                "SELECT 1 FROM contacts WHERE tenant_id = ? AND deleted_at IS NULL LIMIT 1",
                (str(self._tenant_id),),
            ).fetchone()
        except sqlite3.OperationalError:
            return False
        return row is not None

    def _rebuild_contacts(self) -> None:
        """Rematerialise every contact projection from canonical rows.

        Idempotent full rebuild for the tenant (contacts are few in a local
        workspace). Values are never read into the projection — only the link,
        role, counts, distinct source kinds, and per-attribute provenance
        (INV-2). Projections for soft-deleted / purged contacts are dropped.
        """
        tenant = str(self._tenant_id)
        try:
            contact_rows = self._conn.execute(
                """
                SELECT contact_id, employer, job_id, role, created_at, updated_at
                FROM contacts
                WHERE tenant_id = ? AND deleted_at IS NULL
                """,
                (tenant,),
            ).fetchall()
        except sqlite3.OperationalError:
            return
        live_ids: set[str] = set()
        for row in contact_rows:
            contact_id = str(row[0])
            live_ids.add(contact_id)
            attribute_rows = self._conn.execute(
                """
                SELECT attribute_id, attribute_kind, source_kind, source_ref,
                       capture_method, confidence, user_confirmed, recorded_at
                FROM contact_attributes
                WHERE tenant_id = ? AND contact_id = ?
                ORDER BY recorded_at ASC, attribute_id ASC
                """,
                (tenant, contact_id),
            ).fetchall()
            provenance: list[dict[str, Any]] = []
            source_kinds: list[str] = []
            confirmed = 0
            for attr in attribute_rows:
                source_kind = str(attr[2])
                if source_kind not in source_kinds:
                    source_kinds.append(source_kind)
                user_confirmed = bool(attr[6])
                if user_confirmed:
                    confirmed += 1
                provenance.append(
                    {
                        "attributeId": str(attr[0]),
                        "attributeKind": str(attr[1]),
                        "sourceKind": source_kind,
                        "sourceRef": str(attr[3]),
                        "captureMethod": str(attr[4] or "manual"),
                        "confidence": float(attr[5] or 0.0),
                        "userConfirmed": user_confirmed,
                        "recordedAt": str(attr[7] or ""),
                    }
                )
            self._store.upsert_contact(
                ContactProjection(
                    tenant_id=self._tenant_id,
                    contact_id=contact_id,
                    employer=row[1],
                    job_id=row[2],
                    role=str(row[3] or "other"),
                    attribute_count=len(attribute_rows),
                    confirmed_count=confirmed,
                    source_kinds=tuple(source_kinds),
                    provenance=tuple(provenance),
                    created_at=str(row[4] or ""),
                    updated_at=str(row[5] or ""),
                    last_updated_at=str(row[5] or ""),
                )
            )
        for existing in self._conn.execute(
            "SELECT contact_id FROM contact_projections WHERE tenant_id = ?", (tenant,)
        ).fetchall():
            contact_id = str(existing[0])
            if contact_id not in live_ids:
                self._store.delete_contact(tenant, contact_id)

    def _contact_research_backfill_pending(self) -> bool:
        if self._store.count_contact_research_tasks(str(self._tenant_id)) > 0:
            return False
        try:
            row = self._conn.execute(
                "SELECT 1 FROM contact_research_tasks WHERE tenant_id = ? LIMIT 1",
                (str(self._tenant_id),),
            ).fetchone()
        except sqlite3.OperationalError:
            return False
        return row is not None

    def _rebuild_contact_research(self) -> None:
        """Rematerialise every research-task projection from canonical rows.

        Candidate *values* are never read into the projection — only the task
        lifecycle, counts, source-attempt outcomes (provenance of the search),
        and per-candidate provenance metadata + attribute kinds (INV-2). The read
        model joins canonical candidate values at read time.
        """
        tenant = str(self._tenant_id)
        try:
            task_rows = self._conn.execute(
                """
                SELECT task_id, employer, job_id, status, source_attempts_json,
                       started_at, updated_at, needs_review_at, completed_at,
                       failed_at, error_class
                FROM contact_research_tasks
                WHERE tenant_id = ?
                """,
                (tenant,),
            ).fetchall()
        except sqlite3.OperationalError:
            return
        live_ids: set[str] = set()
        for row in task_rows:
            task_id = str(row[0])
            live_ids.add(task_id)
            candidate_rows = self._conn.execute(
                """
                SELECT candidate_id, role, source_kind, source_ref, capture_method,
                       confidence, status, proposed_at, confirmed_contact_id,
                       confirmed_at, attributes_json
                FROM contact_candidates
                WHERE tenant_id = ? AND task_id = ?
                ORDER BY proposed_at ASC, candidate_id ASC
                """,
                (tenant, task_id),
            ).fetchall()
            candidates: list[dict[str, Any]] = []
            needs_review = 0
            confirmed = 0
            for candidate in candidate_rows:
                status = str(candidate[6] or "needs_review")
                if status == "needs_review":
                    needs_review += 1
                elif status == "confirmed":
                    confirmed += 1
                candidates.append(
                    {
                        "candidateId": str(candidate[0]),
                        "role": str(candidate[1] or "other"),
                        "sourceKind": str(candidate[2]),
                        "sourceRef": str(candidate[3]),
                        "captureMethod": str(candidate[4] or "llm_assisted"),
                        "confidence": float(candidate[5] or 0.0),
                        "status": status,
                        "proposedAt": str(candidate[7] or ""),
                        "confirmedContactId": candidate[8],
                        "confirmedAt": candidate[9],
                        "attributeKinds": _attribute_kinds(candidate[10]),
                    }
                )
            self._store.upsert_contact_research_task(
                ContactResearchTaskProjection(
                    tenant_id=self._tenant_id,
                    task_id=task_id,
                    employer=row[1],
                    job_id=row[2],
                    status=str(row[3] or "queued"),
                    candidate_count=len(candidate_rows),
                    needs_review_count=needs_review,
                    confirmed_count=confirmed,
                    source_attempts=_decode_json_dicts(row[4]),
                    candidates=tuple(candidates),
                    started_at=row[5],
                    updated_at=row[6],
                    needs_review_at=row[7],
                    completed_at=row[8],
                    failed_at=row[9],
                    error_class=row[10],
                    last_updated_at=row[6],
                )
            )
        for existing in self._conn.execute(
            "SELECT task_id FROM contact_research_task_projections WHERE tenant_id = ?",
            (tenant,),
        ).fetchall():
            task_id = str(existing[0])
            if task_id not in live_ids:
                self._store.delete_contact_research_task(tenant, task_id)

    def _outreach_backfill_pending(self) -> bool:
        if self._store.count_outreach_threads(str(self._tenant_id)) > 0:
            return False
        try:
            row = self._conn.execute(
                "SELECT 1 FROM outreach_threads WHERE tenant_id = ? LIMIT 1",
                (str(self._tenant_id),),
            ).fetchone()
        except sqlite3.OperationalError:
            return False
        return row is not None

    def _rebuild_outreach(self) -> None:
        """Rematerialise every outreach-thread projection from canonical rows.

        Idempotent full tenant rebuild. The draft body, gate internals, and claim
        provenance are never read into the projection — only the thread lifecycle
        summary and per-draft metadata (generation, kind, status, the persisted
        gate outcome INV-5, and timestamps). The read model joins canonical draft
        content at DETAIL read time. Projections for threads no longer present are
        dropped so the rebuild stays a faithful mirror of canonical state.
        """
        tenant = str(self._tenant_id)
        try:
            thread_rows = self._conn.execute(
                """
                SELECT thread_id, contact_id, job_id, created_at, updated_at
                FROM outreach_threads
                WHERE tenant_id = ?
                """,
                (tenant,),
            ).fetchall()
        except sqlite3.OperationalError:
            return
        live_ids: set[str] = set()
        for row in thread_rows:
            thread_id = str(row[0])
            live_ids.add(thread_id)
            draft_rows = self._conn.execute(
                """
                SELECT draft_id, generation, kind, status, gate_results_json,
                       created_at, approved_at, rejected_at
                FROM outreach_drafts
                WHERE tenant_id = ? AND thread_id = ?
                ORDER BY generation ASC, draft_id ASC
                """,
                (tenant, thread_id),
            ).fetchall()
            drafts: list[dict[str, Any]] = []
            latest_generation = 0
            latest_status: str | None = None
            has_approved = False
            approved_draft_id: str | None = None
            for draft in draft_rows:
                generation = int(draft[1] or 0)
                status = str(draft[3] or "candidate")
                latest_generation = generation
                latest_status = status
                if status == "approved":
                    has_approved = True
                    approved_draft_id = str(draft[0])
                drafts.append(
                    {
                        "draftId": str(draft[0]),
                        "generation": generation,
                        "kind": str(draft[2] or ""),
                        "status": status,
                        "gatePassed": _gate_passed(draft[4]),
                        "createdAt": draft[5],
                        "approvedAt": draft[6],
                        "rejectedAt": draft[7],
                    }
                )
            self._store.upsert_outreach_thread(
                OutreachThreadProjection(
                    tenant_id=self._tenant_id,
                    thread_id=thread_id,
                    contact_id=str(row[1]),
                    job_id=row[2],
                    draft_count=len(draft_rows),
                    latest_generation=latest_generation,
                    has_approved_draft=has_approved,
                    approved_draft_id=approved_draft_id,
                    latest_status=latest_status,
                    drafts=tuple(drafts),
                    created_at=row[3],
                    updated_at=row[4],
                    last_updated_at=row[4],
                )
            )
        for existing in self._conn.execute(
            "SELECT thread_id FROM outreach_thread_projections WHERE tenant_id = ?",
            (tenant,),
        ).fetchall():
            thread_id = str(existing[0])
            if thread_id not in live_ids:
                self._store.delete_outreach_thread(tenant, thread_id)

    def _rebuild_due_follow_ups(self) -> None:
        """Rematerialise one row per thread with a SCHEDULED follow-up (§9, §10).

        Whether a scheduled follow-up is *due* is computed at read time from
        ``due_at`` + the clock — this projection just holds the schedule (a
        derived read-model signal, never an action; INV-1). Completed/dismissed/
        unscheduled threads are dropped, so the projection is a faithful mirror of
        the currently-scheduled follow-ups. Carries safe references only.
        """
        tenant = str(self._tenant_id)
        try:
            rows = self._conn.execute(
                """
                SELECT thread_id, contact_id, job_id, follow_up_due_at,
                       follow_up_basis, follow_up_state, created_at, updated_at
                FROM outreach_threads
                WHERE tenant_id = ? AND follow_up_state = 'scheduled'
                """,
                (tenant,),
            ).fetchall()
        except sqlite3.OperationalError:
            return
        live_ids: set[str] = set()
        for row in rows:
            thread_id = str(row[0])
            live_ids.add(thread_id)
            self._store.upsert_due_follow_up(
                DueFollowUpProjection(
                    tenant_id=self._tenant_id,
                    thread_id=thread_id,
                    contact_id=str(row[1]),
                    job_id=row[2],
                    due_at=row[3],
                    basis=str(row[4] or ""),
                    state=str(row[5] or "scheduled"),
                    created_at=row[6],
                    updated_at=row[7],
                    last_updated_at=row[7],
                )
            )
        for existing in self._conn.execute(
            "SELECT thread_id FROM due_follow_up_projections WHERE tenant_id = ?",
            (tenant,),
        ).fetchall():
            thread_id = str(existing[0])
            if thread_id not in live_ids:
                self._store.delete_due_follow_up(tenant, thread_id)

    def _rebuild_job(self, job_id: str) -> None:
        job_row = self._conn.execute(
            """
            SELECT *
            FROM jobs
            WHERE tenant_id = ? AND job_id = ?
            """,
            (str(self._tenant_id), job_id),
        ).fetchone()
        if job_row is None:
            # Orphaned event (e.g. job deleted from upstream) — drop projection.
            self._store.delete_job_list(str(self._tenant_id), job_id)
            return

        stages = self._load_stage_projections(job_id)
        score = self._load_latest_score(job_id)
        materials = self._load_latest_materials(job_id)
        material_analytics = self._load_material_analytics(job_id)
        employer_analysis_json = self._load_employer_analysis(job_id)
        requirement_fit_report_json = self._load_requirement_fit_report(job_id)
        requirement_fit_band = _fit_band_from_report_json(requirement_fit_report_json)
        interview_prep_json = self._load_interview_prep(job_id)
        provenance_by_artifact = self._load_bullet_provenance_by_artifact(job_id)
        layout_boxes_by_artifact = self._load_layout_boxes_by_artifact(job_id)
        enrichment = self._load_enrichment(job_id)
        apply_run = self._load_latest_apply_run(job_id)
        explicit_application = self._load_explicit_application(job_id)
        deleted_at = self._load_deleted_at(job_id)
        artifacts = self._load_artifacts(job_id)

        title = _row_str(job_row, "title")
        site = _row_str(job_row, "site")
        application_url = enrichment.get("application_url") or _row_nullable_str(job_row, "application_url")
        employer = _canonical_employer(job_row)

        # currentStage/State: the list view exposes only product stages.
        # The full internal preparation state remains available in
        # JobDetailProjection.stages for operational diagnostics.
        current_stage = "discover"
        current_substage = "discover"
        current_state = "pending"
        current_error_code: str | None = None
        current_error_message: str | None = None
        current_next_action: str | None = None
        first_actionable = next(
            (s for s in stages if s.state not in {"succeeded", "skipped"}),
            stages[-1] if stages else None,
        )
        if first_actionable is not None:
            current_stage = _job_list_stage(first_actionable.stage)
            current_substage = first_actionable.stage
            current_state = first_actionable.state
            current_error_code = first_actionable.error_code
            current_error_message = first_actionable.error_message
            current_next_action = first_actionable.next_action

        # Score is owned by the canonical per-job score history.
        fit_score = score.get("fit_score")
        score_reasoning = score.get("reasoning") or ""
        score_breakdown_json = score.get("breakdown_json")
        score_keywords_json = score.get("keywords_json") or "[]"
        score_version = score.get("version")
        scored_at = score.get("scored_at")
        score_criteria_json = score.get("criteria_json")
        score_trace_json = score.get("trace_json")
        score_correction_json = score.get("correction_json")

        # Materials presence:
        tailor_path = materials.get("tailor_path")
        cover_path = materials.get("cover_path")
        resume_pdf_path = materials.get("resume_pdf_path")
        cover_pdf_path = materials.get("cover_pdf_path")

        has_resume = bool(tailor_path)
        has_cover_letter = bool(cover_path)
        has_pdf = bool(resume_pdf_path or cover_pdf_path)
        if first_actionable is not None:
            current_stage = _job_list_stage(first_actionable.stage, has_resume=has_resume)

        # Apply state:
        ar_status = apply_run.get("status") if apply_run else None
        ar_finished = apply_run.get("finished_at") if apply_run else None
        apply_status = _derive_apply_status(ar_status, None)
        applied_at: str | None
        if ar_status == "succeeded":
            applied_at = ar_finished
        elif explicit_application is not None:
            apply_status = "applied"
            applied_at = explicit_application[1]
        else:
            applied_at = None
        apply_mode = (
            "automated_live"
            if ar_status == "succeeded" and not apply_run.get("dry_run")
            else explicit_application[0]
            if explicit_application is not None
            else None
        )

        # description fallbacks
        description = _row_str(job_row, "description")
        full_description = enrichment.get("full_description") or description
        compensation_summary, compensation_audit = self._build_compensation_projection(
            job_id=job_id,
            legacy_raw_salary=_row_nullable_str(job_row, "salary"),
        )

        last_updated_at = _utc_now()

        list_proj = JobListProjection(
            tenant_id=self._tenant_id,
            job_id=job_id,
            title=title or "Untitled",
            employer=employer,
            source=site or "unknown",
            strategy=_row_str(job_row, "strategy"),
            # Normalize identically to the TS builder (see location_normalization)
            # so both runtimes write the same job_list_projections.location.
            location=normalize_job_location(_row_str(job_row, "location")),
            salary=_row_str(job_row, "salary"),
            application_url=application_url,
            discovered_at=_row_nullable_str(job_row, "discovered_at"),
            description=description,
            full_description=full_description,
            fit_score=fit_score,
            fit_band=requirement_fit_band,
            compensation_summary_json=compensation_summary,
            score_breakdown_json=score_breakdown_json,
            score_keywords_json=score_keywords_json,
            score_reasoning=score_reasoning,
            score_version=score_version,
            scored_at=scored_at,
            score_criteria_json=score_criteria_json,
            score_trace_json=score_trace_json,
            score_correction_json=score_correction_json,
            current_stage=current_stage,
            current_substage=current_substage,
            current_state=current_state,
            current_error_code=current_error_code,
            current_error_message=current_error_message,
            current_next_action=current_next_action,
            has_resume=has_resume,
            has_cover_letter=has_cover_letter,
            has_pdf=has_pdf,
            apply_status=apply_status,
            applied_at=applied_at,
            apply_mode=apply_mode,
            resume_template_id=material_analytics.get("resume_template_id"),  # type: ignore[arg-type]
            resume_template_name=material_analytics.get("resume_template_name"),  # type: ignore[arg-type]
            tailoring_policy_version=material_analytics.get("tailoring_policy_version"),  # type: ignore[arg-type]
            artifact_count=len(artifacts),
            deleted_at=deleted_at,
            last_updated_at=last_updated_at,
        )
        self._store.upsert_job_list(list_proj)

        # JobDetail
        detail_proj = JobDetailProjection(
            tenant_id=self._tenant_id,
            job_id=job_id,
            description_preview=_preview_text(full_description or description, 6000),
            compensation_summary_json=compensation_summary,
            compensation_audit_json=compensation_audit,
            score_breakdown_json=score_breakdown_json,
            score_keywords_json=score_keywords_json,
            score_reasoning=score_reasoning,
            score_version=score_version,
            scored_at=scored_at,
            score_criteria_json=score_criteria_json,
            score_trace_json=score_trace_json,
            score_correction_json=score_correction_json,
            stages=tuple(stages),
            employer_analysis_json=employer_analysis_json,
            requirement_fit_report_json=requirement_fit_report_json,
            interview_prep_json=interview_prep_json,
            last_updated_at=last_updated_at,
        )
        self._store.upsert_job_detail(detail_proj)

        # Artifacts (replace-set per job).
        artifact_projs = [
            ArtifactListProjection(
                artifact_id=a["artifact_id"],
                tenant_id=self._tenant_id,
                job_id=job_id,
                job_title=title or "Untitled",
                job_employer=employer,
                artifact_type=a.get("artifact_type", ""),
                status=a.get("status", "active"),
                local_path=a.get("local_path", ""),
                size_bytes=a.get("size_bytes"),
                created_at=a.get("created_at"),
                generation=a.get("generation"),
                metadata_json=a.get("metadata_json"),
                layout_boxes_json=layout_boxes_by_artifact.get(a["artifact_id"]),
                bullet_provenance_json=provenance_by_artifact.provenance.get(a["artifact_id"]),
                coverage_audit_json=provenance_by_artifact.coverage.get(a["artifact_id"]),
                voice_pass_json=provenance_by_artifact.voice.get(a["artifact_id"]),
            )
            for a in artifacts
        ]
        self._store.replace_artifacts_for_job(str(self._tenant_id), job_id, artifact_projs)

    def _rebuild_evidence_usage(self) -> None:
        tenant_id = str(self._tenant_id)
        now = _utc_now()
        entries: dict[str, dict[str, Any]] = {}
        gaps: dict[str, dict[str, Any]] = {}
        self._load_profile_evidence_entries(entries)
        skill_entries_by_name = self._load_profile_skill_entries(entries)
        self._attach_resume_usages(entries)
        self._attach_requirement_usages_and_gaps(entries, gaps)
        self._attach_skill_coverage_usages_and_gaps(skill_entries_by_name, gaps)

        rows: list[dict[str, object]] = []
        for entry in sorted(entries.values(), key=lambda item: str(item["title"]).lower()):
            rows.append(
                {
                    "projection_kind": "entry",
                    "projection_id": entry["entryId"],
                    "evidence_id": entry["evidenceId"],
                    "skill_id": entry["skillId"],
                    "requirement_id": None,
                    "title": entry["title"],
                    "payload_json": json.dumps(entry),
                    "last_updated_at": now,
                }
            )
        for gap in sorted(gaps.values(), key=lambda item: str(item["requirementText"]).lower()):
            rows.append(
                {
                    "projection_kind": "gap",
                    "projection_id": gap["gapId"],
                    "evidence_id": None,
                    "skill_id": None,
                    "requirement_id": gap["requirementId"],
                    "title": gap["requirementText"],
                    "payload_json": json.dumps(gap),
                    "last_updated_at": now,
                }
            )
        self._store.replace_evidence_usage_rows(tenant_id, rows)

    def _load_profile_evidence_entries(self, entries: dict[str, dict[str, Any]]) -> None:
        if not _table_exists(self._conn, "candidate_profile_achievement_evidence"):
            return
        evidence_strength_expr = _column_or_literal(
            self._conn,
            "candidate_profile_achievement_evidence",
            "evidence_strength",
            "'supported'",
            "evidence",
        )
        claim_confidence_expr = _column_or_literal(
            self._conn,
            "candidate_profile_achievement_evidence",
            "claim_confidence",
            "0",
            "evidence",
        )
        user_confirmed_expr = _column_or_literal(
            self._conn,
            "candidate_profile_achievement_evidence",
            "user_confirmed",
            "0",
            "evidence",
        )
        tags_json_expr = _column_or_literal(
            self._conn,
            "candidate_profile_achievement_evidence",
            "tags_json",
            "'[]'",
            "evidence",
        )
        has_experience = _table_exists(
            self._conn,
            "candidate_profile_experience_entries",
        ) and _has_column(self._conn, "candidate_profile_experience_entries", "date_range")
        query = (
            f"""
            SELECT evidence.entry_id, evidence.evidence_id, evidence.source_text,
                   evidence.scope, evidence.action, evidence.tools_json,
                   evidence.metrics_json, evidence.outcome,
                   {evidence_strength_expr} AS evidence_strength,
                   {claim_confidence_expr} AS claim_confidence,
                   {user_confirmed_expr} AS user_confirmed,
                   {tags_json_expr} AS tags_json,
                   experience.date_range
              FROM candidate_profile_achievement_evidence AS evidence
              LEFT JOIN candidate_profile_experience_entries AS experience
                ON experience.tenant_id = evidence.tenant_id
               AND experience.profile_id = evidence.profile_id
               AND experience.entry_id = evidence.entry_id
             WHERE evidence.tenant_id = ? AND evidence.profile_id = 'default'
               AND TRIM(evidence.evidence_id) != ''
             ORDER BY evidence.entry_id, evidence.evidence_index
            """
            if has_experience
            else f"""
            SELECT evidence.entry_id, evidence.evidence_id, evidence.source_text,
                   evidence.scope, evidence.action, evidence.tools_json,
                   evidence.metrics_json, evidence.outcome,
                   {evidence_strength_expr} AS evidence_strength,
                   {claim_confidence_expr} AS claim_confidence,
                   {user_confirmed_expr} AS user_confirmed,
                   {tags_json_expr} AS tags_json,
                   NULL AS date_range
              FROM candidate_profile_achievement_evidence AS evidence
             WHERE evidence.tenant_id = ? AND evidence.profile_id = 'default'
               AND TRIM(evidence.evidence_id) != ''
             ORDER BY evidence.entry_id, evidence.evidence_index
            """
        )
        for row in self._conn.execute(query, (str(self._tenant_id),)).fetchall():
            evidence_id = _row_str(row, "evidence_id").strip()
            if not evidence_id:
                continue
            title = _preview_text(
                _row_str(row, "action")
                or _row_str(row, "scope")
                or _row_str(row, "outcome")
                or _row_str(row, "source_text")
                or evidence_id,
                140,
            )
            entries[evidence_id] = {
                "entryId": evidence_id,
                "kind": "achievement_evidence",
                "evidenceId": evidence_id,
                "skillId": None,
                "title": title,
                "story": {
                    "scope": _row_str(row, "scope"),
                    "action": _row_str(row, "action"),
                    "outcome": _row_str(row, "outcome"),
                    "metrics": _json_strings(_row_str(row, "metrics_json")),
                },
                "skills": _json_strings(_row_str(row, "tools_json")),
                "tags": _json_strings(_row_str(row, "tags_json")),
                "freshness": {
                    "evidenceDateRange": _row_nullable_str(row, "date_range"),
                    "evidenceStrength": _row_nullable_str(row, "evidence_strength"),
                    "userConfirmed": bool(_row_int(row, "user_confirmed")),
                    "claimConfidence": _row_float(row, "claim_confidence")
                    if _row_get(row, "claim_confidence") is not None
                    else None,
                    "lastUsedAt": None,
                },
                "resumeUsages": [],
                "requirementUsages": [],
                "coverageUsages": [],
                "gaps": [],
            }

    def _load_profile_skill_entries(self, entries: dict[str, dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        by_name: dict[str, list[dict[str, Any]]] = {}
        if not _table_exists(self._conn, "candidate_profile_skill_items"):
            return by_name
        has_categories = _table_exists(self._conn, "candidate_profile_skill_categories")
        query = (
            """
            SELECT skills.category_id, skills.item_index, skills.item_text,
                   COALESCE(NULLIF(categories.label, ''), skills.category_id) AS label
              FROM candidate_profile_skill_items AS skills
              LEFT JOIN candidate_profile_skill_categories AS categories
                ON categories.tenant_id = skills.tenant_id
               AND categories.profile_id = skills.profile_id
               AND categories.category_id = skills.category_id
             WHERE skills.tenant_id = ? AND skills.profile_id = 'default'
               AND TRIM(skills.item_text) != ''
             ORDER BY categories.position_index, skills.item_index
            """
            if has_categories
            else """
            SELECT category_id, item_index, item_text, category_id AS label
              FROM candidate_profile_skill_items
             WHERE tenant_id = ? AND profile_id = 'default'
               AND TRIM(item_text) != ''
             ORDER BY category_id, item_index
            """
        )
        for row in self._conn.execute(query, (str(self._tenant_id),)).fetchall():
            skill_text = _row_str(row, "item_text").strip()
            if not skill_text:
                continue
            skill_id = f"skill:{_row_str(row, 'category_id')}:{_row_int(row, 'item_index')}"
            entry = {
                "entryId": skill_id,
                "kind": "skill",
                "evidenceId": None,
                "skillId": skill_id,
                "title": skill_text,
                "story": None,
                "skills": [skill_text],
                "tags": [_row_str(row, "label")] if _row_str(row, "label") else [],
                "freshness": {
                    "evidenceDateRange": None,
                    "evidenceStrength": "declared",
                    "userConfirmed": True,
                    "claimConfidence": None,
                    "lastUsedAt": None,
                },
                "resumeUsages": [],
                "requirementUsages": [],
                "coverageUsages": [],
                "gaps": [],
            }
            entries[skill_id] = entry
            by_name.setdefault(skill_text.lower(), []).append(entry)
        return by_name

    def _attach_resume_usages(self, entries: dict[str, dict[str, Any]]) -> None:
        if not _table_exists(self._conn, "job_bullet_provenance"):
            return
        job_metadata = _job_metadata_join_sql(self._conn, "provenance.tenant_id", "provenance.job_id")
        lifecycle = _job_lifecycle_exclusion_sql(self._conn, "provenance.tenant_id", "provenance.job_id")
        rows = self._conn.execute(
            f"""
            SELECT provenance.job_id, provenance.artifact_id, provenance.generation,
                   provenance.bullet_id, provenance.generated_text, provenance.created_at,
                   provenance.evidence_ids_json,
                   {job_metadata["select_sql"]}
              FROM job_bullet_provenance AS provenance
              {job_metadata["join_sql"]}{lifecycle["join_sql"]}
             WHERE provenance.tenant_id = ?{lifecycle["where_sql"]}
               AND provenance.generation = (
                 SELECT MAX(latest.generation)
                  FROM job_bullet_provenance AS latest
                  WHERE latest.tenant_id = provenance.tenant_id
                    AND latest.job_id = provenance.job_id
               )
             ORDER BY provenance.job_id, provenance.position, provenance.bullet_id
            """,
            (str(self._tenant_id),),
        ).fetchall()
        for row in rows:
            usage = {
                "kind": "resume_bullet",
                "jobId": _row_str(row, "job_id"),
                "jobTitle": _row_nullable_str(row, "job_title"),
                "employer": _row_nullable_str(row, "employer"),
                "artifactId": _row_nullable_str(row, "artifact_id"),
                "bulletId": _row_nullable_str(row, "bullet_id"),
                "generation": _row_int(row, "generation"),
                "generatedTextPreview": _preview_text(_row_str(row, "generated_text"), 240),
                "scoreVersion": None,
                "requirementId": None,
                "requirementText": None,
                "requirementFitKind": None,
                "artifactCoverageState": None,
                "keyword": None,
                "coverageState": None,
                "occurredAt": _row_nullable_str(row, "created_at"),
            }
            for evidence_id in _json_strings(_row_str(row, "evidence_ids_json")):
                entry = entries.get(evidence_id)
                if entry is None:
                    continue
                entry["resumeUsages"].append(usage)
                freshness = entry["freshness"]
                occurred = usage["occurredAt"]
                if occurred and (not freshness["lastUsedAt"] or str(occurred) > str(freshness["lastUsedAt"])):
                    freshness["lastUsedAt"] = occurred

    def _attach_requirement_usages_and_gaps(
        self,
        entries: dict[str, dict[str, Any]],
        gaps: dict[str, dict[str, Any]],
    ) -> None:
        if not _table_exists(self._conn, "job_requirement_fit_reports") or not _table_exists(
            self._conn, "job_requirement_fit_items"
        ):
            return
        job_metadata = _job_metadata_join_sql(self._conn, "items.tenant_id", "items.job_id")
        lifecycle = _job_lifecycle_exclusion_sql(self._conn, "items.tenant_id", "items.job_id")
        rows = self._conn.execute(
            f"""
            SELECT items.job_id, items.score_version, items.requirement_id,
                   items.requirement_text, items.tier, items.weight,
                   items.fit_json, items.artifact_coverage_json,
                   {job_metadata["select_sql"]}
              FROM job_requirement_fit_items AS items
              {job_metadata["join_sql"]}{lifecycle["join_sql"]}
             WHERE items.tenant_id = ?{lifecycle["where_sql"]}
               AND items.score_version = (
                 SELECT MAX(report.score_version)
                  FROM job_requirement_fit_reports AS report
                  WHERE report.tenant_id = items.tenant_id
                    AND report.job_id = items.job_id
               )
             ORDER BY items.job_id, items.position, items.requirement_id
            """,
            (str(self._tenant_id),),
        ).fetchall()
        for row in rows:
            fit = _requirement_fit_status_to_read_model(_json_loads(_row_str(row, "fit_json"), {}))
            fit_kind = str(fit.get("kind") or "not_assessed")
            coverage = (
                _requirement_artifact_coverage_to_read_model(
                    _json_loads(_row_nullable_str(row, "artifact_coverage_json"), {})
                )
                if _row_nullable_str(row, "artifact_coverage_json")
                else None
            )
            usage = {
                "kind": "requirement_fit",
                "jobId": _row_str(row, "job_id"),
                "jobTitle": _row_nullable_str(row, "job_title"),
                "employer": _row_nullable_str(row, "employer"),
                "artifactId": None,
                "bulletId": None,
                "generation": None,
                "generatedTextPreview": None,
                "scoreVersion": _row_int(row, "score_version"),
                "requirementId": _row_str(row, "requirement_id"),
                "requirementText": _row_str(row, "requirement_text"),
                "requirementFitKind": fit_kind,
                "artifactCoverageState": coverage.get("state") if coverage else None,
                "keyword": None,
                "coverageState": None,
                "occurredAt": None,
            }
            for evidence_id in fit.get("evidenceIds", []):
                entry = entries.get(str(evidence_id))
                if entry is not None:
                    entry["requirementUsages"].append(usage)
            if fit_kind in {"missing", "blocked", "transferable"}:
                kind = {
                    "missing": "missing_requirement",
                    "blocked": "blocked_requirement",
                    "transferable": "transferable_requirement",
                }[fit_kind]
                gap = {
                    "gapId": f"{_row_str(row, 'job_id')}#{_row_str(row, 'requirement_id')}",
                    "kind": kind,
                    "requirementId": _row_str(row, "requirement_id"),
                    "requirementText": _row_str(row, "requirement_text"),
                    "demandedSkill": None,
                    "tier": _row_nullable_str(row, "tier"),
                    "weight": _row_float(row, "weight"),
                    "fitKind": fit_kind,
                    "reason": str(
                        fit.get("reason") or fit.get("blocker") or fit.get("gap") or "Recorded requirement gap."
                    ),
                    "jobRefs": [usage],
                }
                gaps[str(gap["gapId"])] = gap

    def _attach_skill_coverage_usages_and_gaps(
        self,
        skill_entries_by_name: dict[str, list[dict[str, Any]]],
        gaps: dict[str, dict[str, Any]],
    ) -> None:
        if not _table_exists(self._conn, "artifact_list_projections"):
            return
        lifecycle = _job_lifecycle_exclusion_sql(self._conn, "alp.tenant_id", "alp.job_id")
        rows = self._conn.execute(
            f"""
            SELECT alp.job_id, alp.job_title, alp.job_employer, alp.artifact_id, alp.generation,
                   alp.coverage_audit_json, alp.created_at
              FROM artifact_list_projections alp{lifecycle["join_sql"]}
             WHERE alp.tenant_id = ?{lifecycle["where_sql"]}
               AND alp.coverage_audit_json IS NOT NULL
               AND TRIM(alp.coverage_audit_json) != ''
            """,
            (str(self._tenant_id),),
        ).fetchall()
        for row in rows:
            coverage = _json_loads(_row_nullable_str(row, "coverage_audit_json"), {})
            for state in ("covered", "declared"):
                for keyword in _strings_from_unknown(coverage.get(state)):
                    for entry in skill_entries_by_name.get(keyword.lower(), []):
                        entry["coverageUsages"].append(_skill_coverage_usage(row, keyword, state))
            for keyword in _strings_from_unknown(coverage.get("missing")):
                gap = {
                    "gapId": f"{_row_str(row, 'job_id')}#skill#{keyword.lower()}",
                    "kind": "missing_skill",
                    "requirementId": None,
                    "requirementText": keyword,
                    "demandedSkill": keyword,
                    "tier": None,
                    "weight": None,
                    "fitKind": None,
                    "reason": (
                        "The generated coverage audit recorded this demanded skill as missing from shipped materials."
                    ),
                    "jobRefs": [_skill_coverage_usage(row, keyword, "missing")],
                }
                gaps[str(gap["gapId"])] = gap
                for entry in skill_entries_by_name.get(keyword.lower(), []):
                    entry["gaps"].append(gap)

    def _build_compensation_projection(
        self,
        *,
        job_id: str,
        legacy_raw_salary: str | None,
    ) -> tuple[str, str]:
        posted = self._load_posted_compensation(
            job_id,
            legacy_raw_salary,
        )
        market = self._load_market_compensation(job_id)
        posted_warning_count = (
            len(posted["fact"]["warnings"])
            if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
            else 0
        )
        market_warning_count = (
            len(market["estimate"]["warnings"])
            if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
            else 0
        )
        posted_range = (
            _posted_range_summary(posted["fact"])
            if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
            else None
        )
        market_range = (
            _market_range_summary(market["estimate"])
            if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
            else None
        )
        market_confidence_interval = (
            _market_confidence_interval_summary(market["estimate"])
            if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
            else None
        )
        summary = {
            "projectionVersion": COMPENSATION_PROJECTION_VERSION,
            "legacyRawSalary": (
                posted["fact"]["legacyRawSalary"]
                if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
                else posted.get("legacyRawSalary")
            ),
            "warningCount": posted_warning_count + market_warning_count,
            "posted": {
                "sourceKind": "posted",
                "recordStatus": posted["recordStatus"],
                "parseState": (
                    posted["fact"]["parseState"]
                    if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
                    else None
                ),
                "confidence": (
                    posted["fact"]["confidence"]
                    if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
                    else "none"
                ),
                "warningCount": posted_warning_count,
                "range": posted_range,
                "displayRange": posted_range.get("displayRange") if posted_range else None,
            },
            "market": {
                "sourceKind": "reported_company_role_market",
                "recordStatus": market["recordStatus"],
                "benchmarkKind": (
                    market["estimate"]["benchmarkLineage"]["kind"]
                    if market["recordStatus"] == "recorded"
                    and isinstance(market.get("estimate"), dict)
                    and isinstance(market["estimate"].get("benchmarkLineage"), dict)
                    else None
                ),
                "estimateState": (
                    market["estimate"]["estimateState"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else "not_requested"
                ),
                "confidenceBand": (
                    market["estimate"]["confidenceBand"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else "none"
                ),
                "confidenceScore": (
                    market["estimate"]["confidenceScore"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else None
                ),
                "sourceCount": (
                    market["estimate"]["sourceCount"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else 0
                ),
                "sampleCount": (
                    market["estimate"]["sampleCount"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else None
                ),
                "warningCount": market_warning_count,
                "range": market_range,
                "displayRange": market_range.get("displayRange") if market_range else None,
                "confidenceInterval": market_confidence_interval,
                "displayConfidenceInterval": (
                    market_confidence_interval.get("displayRange") if market_confidence_interval else None
                ),
            },
        }
        audit = {
            "projectionVersion": COMPENSATION_PROJECTION_VERSION,
            "posted": posted,
            "market": market,
        }
        return json.dumps(summary), json.dumps(audit)

    def _load_posted_compensation(
        self,
        job_id: str,
        legacy_raw_salary: str | None,
    ) -> dict[str, Any]:
        try:
            row = self._conn.execute(
                """
                SELECT tenant_id, job_id, source_field, source_text,
                       legacy_raw_salary, parse_state, currency, period,
                       component, minimum_amount, maximum_amount,
                       annualized_minimum_amount, annualized_maximum_amount,
                       annualization_assumption, confidence, warnings_json,
                       parser_version, source_hash, parsed_at
                FROM job_posted_compensation_facts
                WHERE tenant_id = ? AND job_id = ?
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            row = None
        if row is None:
            return {
                "ok": True,
                "recordStatus": "not_recorded",
                "jobId": job_id,
                "legacyRawSalary": _nullable_text(legacy_raw_salary),
            }
        fact = _posted_fact_from_row(row, job_id)
        return {"ok": True, "recordStatus": "recorded", "fact": fact}

    def _load_market_compensation(self, job_id: str) -> dict[str, Any]:
        try:
            row = self._conn.execute(
                """
                SELECT tenant_id, job_id, estimate_state, currency, period,
                       component, minimum_amount, maximum_amount,
                       confidence_interval_minimum_amount,
                       confidence_interval_maximum_amount,
                       confidence_band, confidence_score, source_count,
                       sample_count, aggregate_bucket, geography_scope,
                       occupation_code, occupation_label, seniority_label,
                       source_snapshot_json, factor_reasons_json,
                       selected_evidence_json,
                       insufficient_reasons_json, unsupported_reasons_json,
                       source_unavailable_reasons_json, warnings_json,
                       estimator_version, estimated_at, company_name,
                       normalized_company, role_title, normalized_role,
                       company_tier, match_scope
                FROM job_market_compensation_estimates
                WHERE tenant_id = ? AND job_id = ?
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            row = None
        if row is None:
            return {"ok": True, "recordStatus": "not_requested", "jobId": job_id}
        if not _row_str(row, "estimator_version").startswith("company-role-reported-compensation-"):
            return {"ok": True, "recordStatus": "not_requested", "jobId": job_id}
        estimate_state = _row_str(row, "estimate_state")
        if estimate_state not in MARKET_RECORDED_STATES:
            return {"ok": True, "recordStatus": "not_requested", "jobId": job_id}
        if _market_uses_employer_posted_authority(_row_str(row, "source_snapshot_json")):
            return {"ok": True, "recordStatus": "not_requested", "jobId": job_id}
        estimate = _market_estimate_from_row(
            row,
            job_id,
            benchmark_lineage=load_market_benchmark_lineage(
                self._conn,
                tenant_id=str(self._tenant_id),
                estimator_version=_row_str(row, "estimator_version"),
            ),
        )
        return {"ok": True, "recordStatus": "recorded", "estimate": estimate}

    # ------------------------------------------------------------- joiners

    def _load_stage_projections(self, job_id: str) -> list[StageProjection]:
        try:
            rows = self._conn.execute(
                """
                SELECT * FROM job_stage_states
                WHERE tenant_id = ? AND job_id = ?
                """,
                (str(self._tenant_id), job_id),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
        # ``sqlite3.Row`` (configured via ``row_factory``) is always mapping-like,
        # never a plain tuple — drop the dead isinstance branch so the dict's
        # key type narrows to ``str`` for static analyzers.
        explicit: dict[str, sqlite3.Row] = {row["stage"]: row for row in rows}
        result: list[StageProjection] = []
        for stage in STAGE_ORDER:
            row = explicit.get(stage)
            if row is None:
                result.append(
                    StageProjection(
                        stage=stage,
                        state="pending",
                        max_attempts=DEFAULT_MAX_ATTEMPTS.get(stage),
                    )
                )
                continue
            blocked_by = _json_loads(_row_nullable_str(row, "blocked_by_json"), [])
            result.append(
                StageProjection(
                    stage=stage,
                    state=_row_str(row, "state") or "pending",
                    attempt_count=_row_nullable_int(row, "attempt_count") or 0,
                    max_attempts=_row_nullable_int(row, "max_attempts") or DEFAULT_MAX_ATTEMPTS.get(stage),
                    started_at=_row_nullable_str(row, "started_at"),
                    updated_at=_row_nullable_str(row, "updated_at"),
                    finished_at=_row_nullable_str(row, "finished_at"),
                    duration_ms=_row_nullable_int(row, "duration_ms"),
                    error_code=_row_nullable_str(row, "error_code"),
                    error_message=_row_nullable_str(row, "error_message"),
                    retryable=_row_nullable_int(row, "retryable") != 0,
                    blocked_by=tuple(str(item) for item in blocked_by) if isinstance(blocked_by, list) else (),
                    next_action=_row_nullable_str(row, "next_action"),
                    apply_url_outcome=_apply_url_outcome_from_stage_metadata(_row_nullable_str(row, "metadata_json")),
                )
            )
        return result

    def _load_latest_score(self, job_id: str) -> dict:
        try:
            row = self._conn.execute(
                """
                SELECT s.version, s.fit_score, s.scored_at, s.breakdown_json,
                       s.keywords_json, s.criteria_json, s.trace_json,
                       s.correction_json
                FROM job_scores s
                WHERE s.tenant_id = ? AND s.job_id = ?
                ORDER BY s.version DESC
                LIMIT 1
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            return {}
        if row is None:
            return {}
        breakdown = _json_loads(_row_nullable_str(row, "breakdown_json"), {})
        reasoning = ""
        if isinstance(breakdown, dict):
            if isinstance(breakdown.get("reasoning"), str):
                reasoning = breakdown["reasoning"]
        keywords = _normalize_keywords(_json_loads(_row_nullable_str(row, "keywords_json"), []))
        return {
            "version": _row_nullable_int(row, "version"),
            "fit_score": _row_nullable_int(row, "fit_score"),
            "scored_at": _row_nullable_str(row, "scored_at"),
            "breakdown_json": json.dumps(_camel_score_breakdown(breakdown)),
            "keywords_json": json.dumps(keywords),
            "reasoning": reasoning,
            "criteria_json": _row_nullable_str(row, "criteria_json"),
            "trace_json": _row_nullable_str(row, "trace_json"),
            "correction_json": _row_nullable_str(row, "correction_json"),
        }

    def _load_latest_materials(self, job_id: str) -> dict:
        try:
            generation_row = self._conn.execute(
                """
                SELECT MAX(generation)
                FROM job_materials_artifacts
                WHERE tenant_id = ? AND job_id = ?
                  AND status = 'approved'
                  AND superseded_at IS NULL
                  AND artifact_type IN (
                    'tailored_resume',
                    'cover_letter',
                    'resume_pdf',
                    'cover_letter_pdf'
                  )
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            return {}
        if generation_row is None:
            return {}
        max_generation = generation_row[0]
        if max_generation is None:
            return {}
        try:
            artifact_rows = self._conn.execute(
                """
                SELECT artifact_type, path, status, created_at
                FROM job_materials_artifacts
                WHERE tenant_id = ? AND job_id = ? AND generation = ?
                  AND status = 'approved' AND superseded_at IS NULL
                """,
                (str(self._tenant_id), job_id, int(max_generation)),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        result: dict = {"generation": int(max_generation)}
        for row in artifact_rows:
            atype = _row_str(row, "artifact_type")
            path = _row_nullable_str(row, "path")
            if not path:
                continue
            if atype == "tailored_resume":
                result["tailor_path"] = path
                result["tailored_at"] = _row_nullable_str(row, "created_at")
            elif atype == "cover_letter":
                result["cover_path"] = path
                result["cover_at"] = _row_nullable_str(row, "created_at")
            elif atype == "resume_pdf":
                result["resume_pdf_path"] = path
            elif atype == "cover_letter_pdf":
                result["cover_pdf_path"] = path
        return result

    def _load_material_analytics(self, job_id: str) -> dict[str, object]:
        try:
            row = self._conn.execute(
                """
                SELECT a.artifact_id, a.generation, a.metadata_json,
                       m.metadata_json AS material_metadata_json
                FROM job_materials_artifacts a
                LEFT JOIN job_materials m
                  ON m.tenant_id = a.tenant_id
                 AND m.job_id = a.job_id
                 AND m.generation = a.generation
                WHERE a.tenant_id = ? AND a.job_id = ?
                  AND a.status = 'approved'
                  AND a.superseded_at IS NULL
                  AND a.artifact_type IN ('tailored_resume', 'tailored_resume_txt', 'resume_pdf')
                ORDER BY COALESCE(a.generation, -1) DESC,
                         CASE a.artifact_type
                           WHEN 'tailored_resume' THEN 0
                           WHEN 'tailored_resume_txt' THEN 1
                           WHEN 'resume_pdf' THEN 2
                           ELSE 3
                         END,
                         a.created_at DESC,
                         a.rowid DESC
                LIMIT 1
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            return {}
        metadata_jsons = [
            _row_nullable_str(row, "metadata_json"),
            _row_nullable_str(row, "material_metadata_json"),
        ]
        current = _merge_material_analytics(metadata_jsons)
        if _material_analytics_complete(current):
            return current
        return _merge_material_analytics(metadata_jsons + self._load_base_material_metadata(job_id, metadata_jsons))

    def _load_base_material_metadata(
        self,
        job_id: str,
        metadata_jsons: list[str | None],
    ) -> list[str | None]:
        base_generation, base_artifact_ids = _material_metadata_references(metadata_jsons)
        metadata: list[str | None] = []
        if base_generation is not None:
            try:
                row = self._conn.execute(
                    """
                    SELECT metadata_json
                    FROM job_materials
                    WHERE tenant_id = ? AND job_id = ? AND generation = ?
                    LIMIT 1
                    """,
                    (str(self._tenant_id), job_id, base_generation),
                ).fetchone()
            except sqlite3.OperationalError:
                row = None
            metadata.append(_row_nullable_str(row, "metadata_json"))
            try:
                rows = self._conn.execute(
                    """
                    SELECT metadata_json
                    FROM job_materials_artifacts
                    WHERE tenant_id = ? AND job_id = ?
                      AND generation = ?
                      AND artifact_type IN ('tailored_resume', 'tailored_resume_txt', 'resume_pdf')
                    ORDER BY CASE artifact_type
                               WHEN 'tailored_resume' THEN 0
                               WHEN 'tailored_resume_txt' THEN 1
                               WHEN 'resume_pdf' THEN 2
                               ELSE 3
                             END,
                             rowid DESC
                    """,
                    (str(self._tenant_id), job_id, base_generation),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
            metadata.extend(_row_nullable_str(row, "metadata_json") for row in rows)
        if base_artifact_ids:
            placeholders = ", ".join("?" for _ in base_artifact_ids)
            try:
                rows = self._conn.execute(
                    f"""
                    SELECT metadata_json
                    FROM job_materials_artifacts
                    WHERE tenant_id = ? AND job_id = ?
                      AND artifact_id IN ({placeholders})
                    ORDER BY COALESCE(generation, -1) DESC,
                             CASE artifact_type
                               WHEN 'tailored_resume' THEN 0
                               WHEN 'tailored_resume_txt' THEN 1
                               WHEN 'resume_pdf' THEN 2
                               ELSE 3
                             END,
                             rowid DESC
                    """,
                    (str(self._tenant_id), job_id, *base_artifact_ids),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
            metadata.extend(_row_nullable_str(row, "metadata_json") for row in rows)
        return metadata

    def _load_employer_analysis(self, job_id: str) -> str | None:
        """Project the latest canonical employer analysis read shape (Phase 1).

        The single owner of the analysis read shape: it loads the latest
        ``EmployerAnalysis`` generation from canonical rows and serialises
        ``to_read_model()`` to JSON for the detail projection. Returns ``None``
        when no analysis exists yet (the common case before a job is tailored).
        """
        from jobctrl.infrastructure.materials.employer_analysis_repository import (
            SqliteEmployerAnalysisRepository,
        )

        try:
            record = SqliteEmployerAnalysisRepository(self._conn).load(self._tenant_id, JobId(job_id))
        except sqlite3.OperationalError:
            return None
        if record is None:
            return None
        return json.dumps(record.to_read_model(), ensure_ascii=False)

    def _load_requirement_fit_report(self, job_id: str) -> str | None:
        """Project the latest canonical requirement-fit report read shape.

        The score aggregate owns the source rows. The detail projection exposes
        the latest ``RequirementFitReport.to_read_model()`` so the UI can show
        exactly which requirements produced the fit score and what tailoring
        directives were generated from them.
        """
        from jobctrl.infrastructure.scoring import SqliteRequirementFitReportRepository

        try:
            record = SqliteRequirementFitReportRepository(self._conn).load(self._tenant_id, JobId(job_id))
        except sqlite3.OperationalError:
            return None
        if record is None:
            return None
        read_model = record.to_read_model()
        read_model.pop("jobKey", None)
        read_model["jobId"] = job_id
        return json.dumps(read_model, ensure_ascii=False)

    def _load_interview_prep(self, job_id: str) -> str | None:
        """Project the latest accepted interview-prep read shape.

        Failed generations stay in canonical history but never replace the
        accepted prep shown on job detail.
        """
        from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository

        try:
            record = SqliteInterviewPrepRepository(self._conn).load_latest(
                self._tenant_id, JobId(job_id), status="accepted"
            )
        except sqlite3.OperationalError:
            return None
        if record is None:
            return None
        read_model = record.to_read_model()
        read_model.pop("jobKey", None)
        read_model["jobId"] = job_id
        return json.dumps(read_model, ensure_ascii=False)

    def _load_bullet_provenance_by_artifact(self, job_id: str) -> "_ProvenanceProjection":
        """Project provenance + coverage + voice read shapes, keyed by artifact.

        The single owner of the provenance/coverage/voice read shapes (Phase 2 +
        Phase 3): it loads each ``BulletProvenanceSet`` generation from canonical
        rows and serialises ``to_read_model()`` (per-bullet provenance),
        ``coverage_to_read_model()`` (generation-time keyword coverage,
        GROUND-06), and ``voice_to_read_model()`` (the voice-pass audit, VOICE-02)
        to JSON, each mapped to the ``artifact_id`` it explains so historical
        artifact detail reads keep their generation's rows. Returns empty mappings
        when no provenance exists (the common case before tailoring, or for PDF
        artifacts).
        """
        from jobctrl.infrastructure.materials.bullet_provenance_repository import (
            SqliteBulletProvenanceRepository,
        )

        empty = _ProvenanceProjection(provenance={}, coverage={}, voice={})
        try:
            generation_rows = self._conn.execute(
                """
                SELECT DISTINCT generation
                FROM job_bullet_provenance
                WHERE tenant_id = ? AND job_id = ?
                ORDER BY generation
                """,
                (str(self._tenant_id), job_id),
            ).fetchall()
        except sqlite3.OperationalError:
            return empty
        if not generation_rows:
            return empty
        repository = SqliteBulletProvenanceRepository(self._conn)
        provenance: dict[str, str] = {}
        coverage_by_artifact: dict[str, str] = {}
        voice_by_artifact: dict[str, str] = {}
        for row in generation_rows:
            record = repository.load(
                self._tenant_id,
                JobId(job_id),
                generation=int(row["generation"]),
            )
            if record is None or record.is_empty:
                continue
            provenance[record.artifact_id] = json.dumps(
                record.to_read_model(),
                ensure_ascii=False,
            )
            coverage = record.coverage_to_read_model()
            if coverage is not None:
                coverage_by_artifact[record.artifact_id] = json.dumps(
                    coverage,
                    ensure_ascii=False,
                )
            voice = record.voice_to_read_model()
            if voice is not None:
                voice_by_artifact[record.artifact_id] = json.dumps(
                    voice,
                    ensure_ascii=False,
                )
        return _ProvenanceProjection(
            provenance=provenance,
            coverage=coverage_by_artifact,
            voice=voice_by_artifact,
        )

    def _load_enrichment(self, job_id: str) -> dict:
        try:
            row = self._conn.execute(
                """
                SELECT full_description, application_url, enriched_at,
                       current_status, extraction_tier
                FROM job_enrichments
                WHERE tenant_id = ? AND job_id = ?
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            return {}
        if row is None:
            return {}
        return {
            "full_description": _row_nullable_str(row, "full_description"),
            "application_url": _row_nullable_str(row, "application_url"),
            "enriched_at": _row_nullable_str(row, "enriched_at"),
            "current_status": _row_nullable_str(row, "current_status"),
            "extraction_tier": _row_nullable_str(row, "extraction_tier"),
        }

    def _load_latest_apply_run(self, job_id: str) -> dict:
        # PR 4 of the Temporal stack: ``apply_run_projections`` is the
        # canonical apply lifecycle row (sourced from ``job_events`` by
        # ``_rebuild_apply_runs`` below). ``_rebuild_job`` reads it
        # back here to derive ``apply_status`` / ``applied_at`` for
        # ``job_list_projections``.
        try:
            row = self._conn.execute(
                """
                SELECT run_id, status, result, started_at, finished_at,
                       worker_id, model, dry_run, duration_ms
                FROM apply_run_projections
                WHERE tenant_id = ? AND job_id = ?
                ORDER BY started_at DESC, run_id DESC
                LIMIT 1
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            return {}
        if row is None:
            return {}
        return {
            "run_id": _row_nullable_str(row, "run_id"),
            "status": _row_nullable_str(row, "status"),
            "result": _row_nullable_str(row, "result"),
            "started_at": _row_nullable_str(row, "started_at"),
            "finished_at": _row_nullable_str(row, "finished_at"),
            "worker_id": _row_nullable_int(row, "worker_id"),
            "model": _row_nullable_str(row, "model"),
            "dry_run": bool(_row_nullable_int(row, "dry_run") or 0),
            "duration_ms": _row_nullable_int(row, "duration_ms"),
        }

    def _load_explicit_application(self, job_id: str) -> tuple[str, str] | None:
        try:
            row = self._conn.execute(
                """
                SELECT occurred_at
                FROM job_events AS events
                WHERE events.tenant_id = ?
                  AND events.job_id = ?
                  AND events.event_type = 'ApplicationManuallyMarked'
                ORDER BY events.occurred_at DESC, events.event_id DESC
                LIMIT 1
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            row = None
        occurred_at = _row_nullable_str(row, "occurred_at")
        if occurred_at:
            return ("manual_marked", occurred_at)
        try:
            row = self._conn.execute(
                """
                SELECT occurred_at
                FROM application_outcomes
                WHERE tenant_id = ?
                  AND job_id = ?
                  AND kind = 'applied_confirmation'
                ORDER BY occurred_at DESC, outcome_id DESC
                LIMIT 1
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
        occurred_at = _row_nullable_str(row, "occurred_at")
        return ("external_confirmed", occurred_at) if occurred_at else None

    def _load_deleted_at(self, job_id: str) -> str | None:
        try:
            row = self._conn.execute(
                """
                SELECT deleted_at FROM jobctrl_deleted_jobs
                WHERE tenant_id = ? AND job_id = ?
                  AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
        if row is None:
            return None
        return _row_nullable_str(row, "deleted_at")

    def _stale_deleted_projection_jobs(self) -> set[str]:
        try:
            rows = self._conn.execute(
                """
                SELECT p.job_id
                FROM job_list_projections p
                JOIN jobctrl_deleted_jobs d
                  ON d.tenant_id = p.tenant_id
                 AND d.job_id = p.job_id
                WHERE p.tenant_id = ?
                  AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
                  AND (p.deleted_at IS NULL OR p.deleted_at != d.deleted_at)
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {
            str(row["job_id"] if not isinstance(row, tuple) else row[0])
            for row in rows
            if (row["job_id"] if not isinstance(row, tuple) else row[0])
        }

    def _stale_artifact_projection_jobs(self) -> set[str]:
        try:
            rows = self._conn.execute(
                """
                SELECT DISTINCT p.job_id
                  FROM artifact_list_projections p
                 WHERE p.tenant_id = ?
                   AND NOT EXISTS (
                     SELECT 1
                       FROM job_materials_artifacts a
                      WHERE a.tenant_id = p.tenant_id
                        AND a.job_id = p.job_id
                        AND COALESCE(
                              NULLIF(a.artifact_id, ''),
                              a.artifact_type || ':' || a.path
                            ) = p.artifact_id
                        AND COALESCE(
                              NULLIF(a.artifact_type, ''), 'artifact'
                            ) = p.artifact_type
                        AND a.path = p.local_path
                   )
                   AND NOT EXISTS (
                     SELECT 1
                       FROM job_artifacts a
                      WHERE a.tenant_id = p.tenant_id
                        AND a.job_id = p.job_id
                        AND CAST(a.artifact_id AS TEXT) = p.artifact_id
                        AND COALESCE(
                              NULLIF(a.artifact_type, ''), 'artifact'
                            ) = p.artifact_type
                        AND a.path = p.local_path
                        AND NOT EXISTS (
                          SELECT 1
                            FROM job_materials_artifacts m
                           WHERE m.tenant_id = a.tenant_id
                             AND m.job_id = a.job_id
                             AND COALESCE(
                                   NULLIF(m.artifact_type, ''), 'artifact'
                                 ) = COALESCE(
                                   NULLIF(a.artifact_type, ''), 'artifact'
                                 )
                             AND m.path = a.path
                        )
                   )
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {
            str(row["job_id"] if not isinstance(row, tuple) else row[0])
            for row in rows
            if (row["job_id"] if not isinstance(row, tuple) else row[0])
        }

    def _stale_stage_projection_jobs(self) -> set[str]:
        try:
            rows = self._conn.execute(
                """
                SELECT DISTINCT s.job_id
                  FROM job_stage_states s
                  LEFT JOIN job_list_projections p
                    ON p.tenant_id = s.tenant_id
                   AND p.job_id = s.job_id
                 WHERE s.tenant_id = ?
                   AND TRIM(s.job_id) != ''
                   AND (
                     p.job_id IS NULL
                     OR (
                       s.updated_at IS NOT NULL
                       AND TRIM(s.updated_at) != ''
                       AND (
                         p.last_updated_at IS NULL
                         OR TRIM(p.last_updated_at) = ''
                         OR julianday(s.updated_at) > COALESCE(julianday(p.last_updated_at), -1)
                       )
                     )
                   )
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {
            str(row["job_id"] if not isinstance(row, tuple) else row[0])
            for row in rows
            if (row["job_id"] if not isinstance(row, tuple) else row[0])
        }

    def _stale_compensation_projection_jobs(self) -> set[str]:
        """Return settled jobs whose compensation read model predates v2.

        Compensation v2 enforces the posted-versus-market authority boundary.
        Event watermarks cannot invalidate projections that were fully folded
        before that rule shipped, so the embedded version is a one-time,
        deterministic rebuild marker shared with the TypeScript projection
        owner.
        """

        version_expr = """
            CASE
              WHEN json_valid({column})
              THEN CAST(json_extract({column}, '$.projectionVersion') AS INTEGER)
            END
        """
        list_version = version_expr.format(column="p.compensation_summary_json")
        detail_summary_version = version_expr.format(column="d.compensation_summary_json")
        detail_audit_version = version_expr.format(column="d.compensation_audit_json")
        try:
            rows = self._conn.execute(
                f"""
                SELECT p.job_id
                  FROM job_list_projections p
                  LEFT JOIN job_detail_projections d
                    ON d.tenant_id = p.tenant_id
                   AND d.job_id = p.job_id
                 WHERE p.tenant_id = ?
                   AND (
                     ({list_version} >= 1 AND {list_version} < ?)
                     OR ({detail_summary_version} >= 1 AND {detail_summary_version} < ?)
                     OR ({detail_audit_version} >= 1 AND {detail_audit_version} < ?)
                   )
                """,
                (
                    str(self._tenant_id),
                    COMPENSATION_PROJECTION_VERSION,
                    COMPENSATION_PROJECTION_VERSION,
                    COMPENSATION_PROJECTION_VERSION,
                ),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {
            str(row["job_id"] if not isinstance(row, tuple) else row[0])
            for row in rows
            if (row["job_id"] if not isinstance(row, tuple) else row[0])
        }

    @property
    def _score_audit_backfill_marker(self) -> str:
        # Per-tenant marker so a shared multi-tenant DB backfills each tenant's
        # scored rows exactly once, matching the per-tenant scan below.
        return f"{SCORE_AUDIT_BACKFILL}:{self._tenant_id}"

    def _score_audit_backfill_done(self) -> bool:
        try:
            row = self._conn.execute(
                "SELECT 1 FROM projection_backfills WHERE name = ?",
                (self._score_audit_backfill_marker,),
            ).fetchone()
        except sqlite3.OperationalError:
            return False
        return row is not None

    def _mark_score_audit_backfill_done(self) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO projection_backfills (name, completed_at) VALUES (?, ?)",
            (self._score_audit_backfill_marker, _utc_now()),
        )

    def _jobs_missing_score_audit_projection(self) -> set[str]:
        try:
            rows = self._conn.execute(
                """
                SELECT p.job_id
                FROM job_list_projections p
                JOIN job_scores s
                  ON s.tenant_id = p.tenant_id
                 AND s.job_id = p.job_id
                WHERE p.tenant_id = ?
                  AND p.score_criteria_json IS NULL
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {
            str(row["job_id"] if not isinstance(row, tuple) else row[0])
            for row in rows
            if (row["job_id"] if not isinstance(row, tuple) else row[0])
        }

    def _closed_projection_jobs(self) -> set[str]:
        try:
            rows = self._conn.execute(
                """
                SELECT job_id
                FROM posting_snapshot_sets
                WHERE tenant_id = ?
                  AND latest_active_state IN (
                    'closed', 'expired', 'removed', 'location_incompatible'
                  )
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {
            str(row["job_id"] if not isinstance(row, tuple) else row[0])
            for row in rows
            if (row["job_id"] if not isinstance(row, tuple) else row[0])
        }

    def _hidden_projection_jobs(self) -> set[str]:
        # Mirror TS rebuildDashboardProjection: jobs hidden via
        # jobctrl_hidden_jobs (unhidden_at IS NULL) are excluded from every
        # dashboard total. The table is owned by the TS write-model, so on a DB
        # where it does not exist yet this excludes nothing.
        try:
            rows = self._conn.execute(
                """
                SELECT job_id
                FROM jobctrl_hidden_jobs
                WHERE tenant_id = ? AND unhidden_at IS NULL
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {
            str(row["job_id"] if not isinstance(row, tuple) else row[0])
            for row in rows
            if (row["job_id"] if not isinstance(row, tuple) else row[0])
        }

    def _load_artifacts(self, job_id: str) -> list[dict]:
        artifacts: list[dict] = []
        seen: set[tuple[str, str]] = set()
        try:
            for row in self._conn.execute(
                """
                SELECT artifact_id, artifact_type, status, path, created_at,
                       size_bytes, generation, metadata_json
                FROM job_materials_artifacts
                WHERE tenant_id = ? AND job_id = ?
                """,
                (str(self._tenant_id), job_id),
            ).fetchall():
                local_path = _row_nullable_str(row, "path") or ""
                atype = _row_nullable_str(row, "artifact_type") or ""
                if not local_path:
                    continue
                key = (atype, local_path)
                if key in seen:
                    continue
                seen.add(key)
                aid = _row_nullable_str(row, "artifact_id") or f"{atype}:{local_path}"
                artifacts.append(
                    {
                        "artifact_id": aid,
                        "artifact_type": atype,
                        "status": _row_nullable_str(row, "status") or "active",
                        "local_path": local_path,
                        "created_at": _row_nullable_str(row, "created_at"),
                        "size_bytes": _row_nullable_int(row, "size_bytes"),
                        "generation": _row_nullable_int(row, "generation"),
                        "metadata_json": _row_nullable_str(row, "metadata_json"),
                    }
                )
        except sqlite3.OperationalError:
            pass
        try:
            for row in self._conn.execute(
                """
                SELECT rowid AS row_id, job_id, stage, artifact_type, status,
                       path, created_at, size_bytes
                FROM job_artifacts
                WHERE tenant_id = ? AND job_id = ?
                """,
                (str(self._tenant_id), job_id),
            ).fetchall():
                local_path = _row_nullable_str(row, "path") or ""
                atype = _row_nullable_str(row, "artifact_type") or "artifact"
                if not local_path:
                    continue
                key = (atype, local_path)
                if key in seen:
                    continue
                seen.add(key)
                row_id = _row_nullable_str(row, "row_id") or f"{atype}:{local_path}"
                artifacts.append(
                    {
                        "artifact_id": row_id,
                        "artifact_type": atype,
                        "status": _row_nullable_str(row, "status") or "active",
                        "local_path": local_path,
                        "created_at": _row_nullable_str(row, "created_at"),
                        "size_bytes": _row_nullable_int(row, "size_bytes"),
                        "generation": None,
                    }
                )
        except sqlite3.OperationalError:
            pass
        return artifacts

    def _load_layout_boxes_by_artifact(self, job_id: str) -> dict[str, str]:
        try:
            rows = self._conn.execute(
                """
                SELECT artifact_id, semantic_id, page_number, line_number,
                       text_excerpt, left_pct, top_pct, width_pct, height_pct
                FROM job_material_layout_boxes
                WHERE tenant_id = ? AND job_id = ?
                ORDER BY artifact_id, page_number, box_index
                """,
                (str(self._tenant_id), job_id),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}

        by_artifact: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            artifact_id = _row_str(row, "artifact_id")
            if not artifact_id:
                continue
            by_artifact.setdefault(artifact_id, []).append(
                {
                    "semanticId": _row_str(row, "semantic_id"),
                    "pageNumber": _row_int(row, "page_number"),
                    "lineNumber": _row_nullable_int(row, "line_number"),
                    "textExcerpt": _row_str(row, "text_excerpt"),
                    "leftPct": _row_float(row, "left_pct"),
                    "topPct": _row_float(row, "top_pct"),
                    "widthPct": _row_float(row, "width_pct"),
                    "heightPct": _row_float(row, "height_pct"),
                }
            )
        return {artifact_id: json.dumps(boxes, sort_keys=True) for artifact_id, boxes in by_artifact.items()}

    # ------------------------------------------------------------- dashboard

    def _rebuild_dashboard(self) -> None:
        rows = self._store.fetch_job_list(str(self._tenant_id))
        closed_jobs = self._closed_projection_jobs()
        hidden_jobs = self._hidden_projection_jobs()
        # Filter out soft-deleted, closed/removed, and hidden jobs from active
        # dashboard counts (mirrors TS rebuildDashboardProjection).
        active_rows = [
            row
            for row in rows
            if not _row_nullable_str(row, "deleted_at")
            and _row_str(row, "job_id") not in closed_jobs
            and _row_str(row, "job_id") not in hidden_jobs
        ]

        total_jobs = len(active_rows)
        failures = sum(1 for row in active_rows if _row_str(row, "current_state") in {"failed", "exhausted"})
        blocked = sum(1 for row in active_rows if _row_str(row, "current_state") == "blocked")
        # Mirror TS: a job is "ready" only when it has a resume (has_resume == 1).
        ready = sum(
            1
            for row in active_rows
            if _row_str(row, "current_stage") == "apply"
            and _row_str(row, "current_state") == "pending"
            and _row_nullable_int(row, "has_resume") == 1
        )
        applied = sum(
            1
            for row in active_rows
            if _row_nullable_str(row, "applied_at") or _row_nullable_str(row, "apply_status") == "applied"
        )
        # Mirror the TS counter (apps/api/src/projections.ts):
        # exclude dry runs whose underlying job is soft-deleted via
        # ``jobctrl_deleted_jobs`` so the user-visible value agrees
        # regardless of which writer (Python or TS) ran last.
        try:
            dry_runs = int(
                self._conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM apply_run_projections arp
                    LEFT JOIN jobctrl_deleted_jobs d
                        ON d.tenant_id = arp.tenant_id
                       AND d.job_id = arp.job_id
                       AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
                    LEFT JOIN posting_snapshot_sets pss
                        ON pss.tenant_id = arp.tenant_id
                       AND pss.job_id = arp.job_id
                    WHERE arp.tenant_id = ?
                      AND arp.dry_run = 1
                      AND d.job_id IS NULL
                      AND (
                        pss.latest_active_state IS NULL
                        OR pss.latest_active_state NOT IN (
                          'closed', 'expired', 'removed', 'location_incompatible'
                        )
                      )
                    """,
                    (str(self._tenant_id),),
                ).fetchone()[0]
            )
        except sqlite3.OperationalError:
            dry_runs = 0

        # Funnel per stage.
        funnel_counts: dict[str, dict[str, int]] = {
            stage: {
                "total": 0,
                "succeeded": 0,
                "running": 0,
                "pending": 0,
                "blocked": 0,
                "failed": 0,
            }
            for stage in STAGE_ORDER
        }
        # Per-stage funnel uses the per-job stage rows (not just the
        # current stage) so a funnel shows downstream stages too.  We
        # fan out by reading job_detail_projections.stages_json — those
        # were just rebuilt by ``_rebuild_job``.
        for row in active_rows:
            job_id = _row_str(row, "job_id")
            detail = self._store.fetch_job_detail(str(self._tenant_id), job_id)
            if detail is None:
                continue
            stages_json = _row_str(detail, "stages_json") or "[]"
            try:
                stages_list = json.loads(stages_json)
            except json.JSONDecodeError:
                stages_list = []
            for stage_dict in stages_list:
                stage = stage_dict.get("stage")
                state = stage_dict.get("state", "pending")
                if stage not in funnel_counts:
                    continue
                if state == "skipped":
                    continue
                funnel_counts[stage]["total"] += 1
                if state in {"failed", "exhausted"}:
                    funnel_counts[stage]["failed"] += 1
                elif state in {"running", "queued"}:
                    funnel_counts[stage]["running"] += 1
                elif state == "blocked":
                    funnel_counts[stage]["blocked"] += 1
                elif state == "succeeded":
                    funnel_counts[stage]["succeeded"] += 1
                else:
                    funnel_counts[stage]["pending"] += 1

        funnel = tuple(
            DashboardFunnelStage(
                stage=stage,
                total=counts["total"],
                succeeded=counts["succeeded"],
                running=counts["running"],
                pending=counts["pending"],
                blocked=counts["blocked"],
                failed=counts["failed"],
            )
            for stage, counts in funnel_counts.items()
        )

        # by_source — group by the projected source (board) column.
        source_counts: dict[str, int] = {}
        for row in active_rows:
            source = _row_str(row, "source") or "unknown"
            source_counts[source] = source_counts.get(source, 0) + 1
        by_source = tuple(sorted(source_counts.items(), key=lambda kv: (-kv[1], kv[0])))

        # score_distribution — group by fit_score.
        score_counts: dict[int, int] = {}
        for row in active_rows:
            fit = _row_nullable_int(row, "fit_score")
            if fit is None:
                continue
            score_counts[fit] = score_counts.get(fit, 0) + 1
        score_distribution = tuple(sorted(score_counts.items(), key=lambda kv: kv[0], reverse=True))

        dashboard = DashboardProjection(
            tenant_id=self._tenant_id,
            total_jobs=total_jobs,
            failures=failures,
            blocked=blocked,
            ready=ready,
            applied=applied,
            dry_runs=dry_runs,
            funnel=funnel,
            by_source=by_source,
            score_distribution=score_distribution,
            outcome_conversion=self._build_outcome_conversion(active_rows),
            generated_at=_utc_now(),
        )
        self._store.upsert_dashboard(dashboard)

    def _build_outcome_conversion(self, active_rows: list) -> dict[str, Any]:
        """Roll Gmail/manual application outcomes into a funnel by source + bands + mode.

        The denominator is the applied jobs (same predicate as the ``applied``
        counter); each applied job's ``application_outcomes`` decide which funnel
        stages it reached. Only counts are materialised — the read model derives
        rates so there is no cross-runtime float drift.

        Dual-writer parity: this builder and its TypeScript twin
        (``buildOutcomeConversion`` in ``apps/api/src/projections.ts``) must emit
        identical raw counts, so neither ever drops a bucket for a small sample.
        The minimum-sample suppression (``MIN_CONVERSION_SAMPLE`` in
        ``read-model.ts``) is a read-time rate concern only: the counts stay
        visible here regardless of sample size.
        """
        applied_rows = [
            row
            for row in active_rows
            if _row_nullable_str(row, "applied_at") or _row_nullable_str(row, "apply_status") == "applied"
        ]
        outcomes_by_job = self._load_outcomes_by_job()
        suggestion_accuracy = self._load_suggestion_accuracy()

        def blank() -> dict[str, int]:
            return {"applied": 0, "reply": 0, "interview": 0, "offer": 0, "rejection": 0}

        totals = blank()
        by_source: dict[str, dict[str, int]] = {}
        by_band: dict[str, dict[str, int]] = {}
        by_fit_band: dict[str, dict[str, int]] = {}
        by_apply_mode: dict[str, dict[str, int]] = {}
        by_template: dict[str, dict[str, object]] = {}
        by_policy: dict[str, dict[str, int]] = {}
        time_to_response_minutes: list[int] = []
        for row in applied_rows:
            source = _row_str(row, "source") or "unknown"
            band = _score_band(_row_nullable_int(row, "fit_score"))
            fit_band = _fit_band(_row_nullable_str(row, "fit_band"))
            apply_mode = _apply_mode(_row_nullable_str(row, "apply_mode"))
            template_id = _template_key(_row_nullable_str(row, "resume_template_id"))
            template_name = (
                None
                if template_id == "unreported"
                else _projection_text(_row_nullable_str(row, "resume_template_name"))
            )
            policy = _policy_key(_row_nullable_int(row, "tailoring_policy_version"))
            outcomes = outcomes_by_job.get(_row_str(row, "job_id"), ())
            response_minutes = _first_response_minutes(
                _row_nullable_str(row, "applied_at"),
                outcomes,
            )
            if response_minutes is not None:
                time_to_response_minutes.append(response_minutes)
            template_bucket = by_template.setdefault(
                template_id,
                {"templateName": template_name, "counts": blank()},
            )
            if not template_bucket.get("templateName") and template_name:
                template_bucket["templateName"] = template_name
            for bucket in (
                totals,
                by_source.setdefault(source, blank()),
                by_band.setdefault(band, blank()),
                by_fit_band.setdefault(fit_band, blank()),
                by_apply_mode.setdefault(apply_mode, blank()),
                template_bucket["counts"],
                by_policy.setdefault(policy, blank()),
            ):
                assert isinstance(bucket, dict)
                bucket["applied"] += 1
                if _has_any_kind(outcomes, _REPLY_OUTCOME_KINDS):
                    bucket["reply"] += 1
                if _has_any_kind(outcomes, _INTERVIEW_OUTCOME_KINDS):
                    bucket["interview"] += 1
                if _has_any_kind(outcomes, _OFFER_OUTCOME_KINDS):
                    bucket["offer"] += 1
                if _has_any_kind(outcomes, _REJECTION_OUTCOME_KINDS):
                    bucket["rejection"] += 1

        by_source_list = [
            {"source": source, **counts}
            for source, counts in sorted(by_source.items(), key=lambda kv: (-kv[1]["applied"], kv[0]))
        ]
        by_band_list = [{"band": band, **by_band[band]} for band in SCORE_BAND_ORDER if band in by_band]
        by_fit_band_list = [{"fitBand": band, **by_fit_band[band]} for band in FIT_BAND_ORDER if band in by_fit_band]
        by_apply_mode_list = [
            {"applyMode": mode, **by_apply_mode[mode]} for mode in APPLY_MODE_ORDER if mode in by_apply_mode
        ]
        by_template_list = [
            {
                "templateId": template_id,
                "templateName": bucket.get("templateName"),
                **bucket["counts"],  # type: ignore[arg-type]
            }
            for template_id, bucket in sorted(
                by_template.items(),
                key=_template_conversion_sort_key,
            )
        ]
        by_policy_list = []
        for key, counts in sorted(
            by_policy.items(),
            key=lambda item: (
                -item[1]["applied"],
                _policy_version_from_key(item[0])
                if _policy_version_from_key(item[0]) is not None
                else 9007199254740991,
            ),
        ):
            version = _policy_version_from_key(key)
            by_policy_list.append(
                {
                    "tailoringPolicyVersion": version,
                    "policyLabel": _policy_label(version),
                    **counts,
                }
            )
        return {
            "version": 2,
            "totals": totals,
            "bySource": by_source_list,
            "byBand": by_band_list,
            "byFitBand": by_fit_band_list,
            "byApplyMode": by_apply_mode_list,
            "byTemplate": by_template_list,
            "byPolicy": by_policy_list,
            "timeToResponseMinutes": sorted(time_to_response_minutes),
            "suggestionAccuracy": suggestion_accuracy,
        }

    def _load_outcomes_by_job(self) -> dict[str, tuple[dict[str, str | None], ...]]:
        try:
            rows = self._conn.execute(
                "SELECT job_id, kind, occurred_at FROM application_outcomes WHERE tenant_id = ?",
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        grouped: dict[str, list[dict[str, str | None]]] = {}
        for row in rows:
            job_id = _row_str(row, "job_id")
            kind = _row_str(row, "kind")
            if not job_id or not kind:
                continue
            grouped.setdefault(job_id, []).append({"kind": kind, "occurredAt": _row_nullable_str(row, "occurred_at")})
        return {job_id: tuple(outcomes) for job_id, outcomes in grouped.items()}

    def _load_suggestion_accuracy(self) -> dict[str, int]:
        counts = {"decided": 0, "accepted": 0, "corrected": 0, "ignored": 0}
        try:
            rows = self._conn.execute(
                """
                SELECT status
                FROM application_outcome_suggestions
                WHERE tenant_id = ?
                  AND status IN ('accepted', 'corrected', 'ignored')
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return counts
        for row in rows:
            status = _row_str(row, "status").strip().lower()
            if status in {"accepted", "corrected", "ignored"}:
                counts["decided"] += 1
                counts[status] += 1
        return counts

    def _rebuild_source_quality(self) -> None:
        placeholders = ", ".join("?" for _ in SOURCE_QUALITY_EVENT_TYPES)
        rows = self._conn.execute(
            f"""
            SELECT event_id, job_id, event_type,
                   occurred_at, payload_json
            FROM job_events
            WHERE tenant_id = ?
              AND event_type IN ({placeholders})
            ORDER BY event_id ASC
            """,
            (str(self._tenant_id), *sorted(SOURCE_QUALITY_EVENT_TYPES)),
        ).fetchall()
        result = project_source_quality(
            tenant_id=self._tenant_id,
            events=(event_row_from_sql(row) for row in rows),
            updated_at=_utc_now(),
        )
        self._store.replace_source_quality(str(self._tenant_id), result.stats)

    def _has_source_quality_history(self) -> bool:
        placeholders = ", ".join("?" for _ in SOURCE_QUALITY_EVENT_TYPES)
        row = self._conn.execute(
            f"""
            SELECT COUNT(*)
            FROM job_events
            WHERE tenant_id = ?
              AND event_type IN ({placeholders})
            """,
            (str(self._tenant_id), *sorted(SOURCE_QUALITY_EVENT_TYPES)),
        ).fetchone()
        return bool(row and int(row[0]) > 0)

    def _pipeline_steps_backfill_pending(self) -> bool:
        """Detect step rows missed after either runtime advanced the watermark."""

        placeholders = ", ".join("?" for _ in PIPELINE_STEP_EVENT_TYPES)
        try:
            event_row = self._conn.execute(
                f"""
                SELECT COUNT(DISTINCT
                    JSON_EXTRACT(payload_json, '$.execution.workflowId') || char(31) ||
                    JSON_EXTRACT(payload_json, '$.execution.temporalRunId') || char(31) ||
                    JSON_EXTRACT(payload_json, '$.stepKind') || char(31) ||
                    JSON_EXTRACT(payload_json, '$.itemKey')
                )
                FROM job_events
                WHERE tenant_id = ?
                  AND event_type IN ({placeholders})
                  AND payload_json IS NOT NULL
                  AND json_valid(payload_json)
                  AND JSON_EXTRACT(payload_json, '$.execution.tenantId') = ?
                """,
                (
                    str(self._tenant_id),
                    *sorted(PIPELINE_STEP_EVENT_TYPES),
                    str(self._tenant_id),
                ),
            ).fetchone()
            projection_row = self._conn.execute(
                "SELECT COUNT(*) FROM pipeline_step_projections WHERE tenant_id = ?",
                (str(self._tenant_id),),
            ).fetchone()
        except sqlite3.OperationalError:
            return False
        event_count = int(event_row[0] or 0) if event_row else 0
        projection_count = int(projection_row[0] or 0) if projection_row else 0
        return event_count > projection_count

    def _rebuild_pipeline_steps(self) -> None:
        """Fold orchestration-step facts before advancing the shared watermark.

        The fold is attempt-aware and first-terminal-wins within an attempt.
        A higher attempt replaces the current row; late events from an older
        attempt and duplicate start/terminal facts are idempotent. Re-reading
        the complete event family makes either the Python worker or TypeScript
        API safe to win the shared ``operations_projections`` watermark race.
        """

        placeholders = ", ".join("?" for _ in PIPELINE_STEP_EVENT_TYPES)
        rows = self._conn.execute(
            f"""
            SELECT event_id, event_type, occurred_at, payload_json
            FROM job_events
            WHERE tenant_id = ?
              AND event_type IN ({placeholders})
            ORDER BY event_id ASC
            """,
            (str(self._tenant_id), *sorted(PIPELINE_STEP_EVENT_TYPES)),
        ).fetchall()

        folded: dict[tuple[str, str, str, str], _PipelineStepFold] = {}
        for row in rows:
            event = self._parse_pipeline_step_event(row)
            if event is None:
                continue
            key = (
                event["workflow_id"],
                event["temporal_run_id"],
                event["step_kind"],
                event["item_key"],
            )
            current = folded.get(key)
            if current is None or event["attempt"] > current.attempt:
                folded[key] = self._new_pipeline_step_fold(event)
                continue
            if event["attempt"] < current.attempt:
                continue
            if current.state in {"succeeded", "failed"}:
                continue

            next_state = event["state"]
            if next_state == "queued":
                # Duplicate or late queue facts cannot regress a running step.
                continue
            if next_state == "running" and current.state == "running":
                continue

            detail_code = event["detail_code"] or current.detail_code
            detail_count = event["detail_count"] if event["detail_code"] is not None else current.detail_count
            if next_state == "running":
                folded[key] = _PipelineStepFold(
                    tenant_id=current.tenant_id,
                    workflow_id=current.workflow_id,
                    temporal_run_id=current.temporal_run_id,
                    step_kind=current.step_kind,
                    item_key=current.item_key,
                    state="running",
                    attempt=current.attempt,
                    queued_at=current.queued_at,
                    started_at=event["lifecycle_at"],
                    finished_at=None,
                    duration_ms=None,
                    error_code=None,
                    retryable=False,
                    detail_code=detail_code,
                    detail_count=detail_count,
                    last_event_id=event["event_id"],
                    last_updated_at=event["occurred_at"],
                )
                continue

            folded[key] = _PipelineStepFold(
                tenant_id=current.tenant_id,
                workflow_id=current.workflow_id,
                temporal_run_id=current.temporal_run_id,
                step_kind=current.step_kind,
                item_key=current.item_key,
                state=next_state,
                attempt=current.attempt,
                queued_at=current.queued_at,
                started_at=current.started_at,
                finished_at=event["lifecycle_at"],
                duration_ms=event["duration_ms"],
                error_code=event["error_code"],
                retryable=event["retryable"],
                detail_code=detail_code,
                detail_count=detail_count,
                last_event_id=event["event_id"],
                last_updated_at=event["occurred_at"],
            )

        self._conn.execute(
            "DELETE FROM pipeline_step_projections WHERE tenant_id = ?",
            (str(self._tenant_id),),
        )
        insert = self._conn.execute
        for projection in sorted(
            folded.values(),
            key=lambda item: (
                item.workflow_id,
                item.temporal_run_id,
                item.step_kind,
                item.item_key,
            ),
        ):
            insert(
                """
                INSERT INTO pipeline_step_projections (
                    tenant_id, discover_workflow_id, discover_run_id, step_kind,
                    item_key, state, attempt, queued_at, started_at, finished_at,
                    duration_ms, error_code, retryable, detail_code, detail_count,
                    last_event_id, last_updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    projection.tenant_id,
                    projection.workflow_id,
                    projection.temporal_run_id,
                    projection.step_kind,
                    projection.item_key,
                    projection.state,
                    projection.attempt,
                    projection.queued_at,
                    projection.started_at,
                    projection.finished_at,
                    projection.duration_ms,
                    projection.error_code,
                    1 if projection.retryable else 0,
                    projection.detail_code,
                    projection.detail_count,
                    projection.last_event_id,
                    projection.last_updated_at,
                ),
            )

    def _parse_pipeline_step_event(self, row: object) -> dict[str, Any] | None:
        if isinstance(row, tuple):
            event_id, event_type, occurred_at, payload_json = row
        else:
            event_id = _row_get(row, "event_id")
            event_type = _row_get(row, "event_type")
            occurred_at = _row_get(row, "occurred_at")
            payload_json = _row_get(row, "payload_json")
        payload = _json_loads(str(payload_json) if payload_json else None, {})
        if not isinstance(payload, dict) or event_type not in PIPELINE_STEP_EVENT_TYPES:
            return None
        execution = payload.get("execution")
        if not isinstance(execution, dict):
            return None
        tenant_id = execution.get("tenantId")
        workflow_id = execution.get("workflowId")
        temporal_run_id = execution.get("temporalRunId")
        if (
            tenant_id != str(self._tenant_id)
            or not isinstance(workflow_id, str)
            or not workflow_id.strip()
            or not isinstance(temporal_run_id, str)
            or not temporal_run_id.strip()
        ):
            return None
        step_kind = payload.get("stepKind")
        item_key = payload.get("itemKey")
        attempt = payload.get("attempt")
        if (
            step_kind not in _PIPELINE_STEP_KINDS
            or not isinstance(item_key, str)
            or not _SAFE_PIPELINE_ITEM_KEY.fullmatch(item_key)
            or isinstance(attempt, bool)
            or not isinstance(attempt, int)
            or attempt < 1
            or attempt > _MAX_SAFE_PIPELINE_INTEGER
        ):
            return None

        detail_code: str | None = None
        detail_count: int | None = None
        detail = payload.get("detail")
        if detail is not None:
            if not isinstance(detail, dict) or detail.get("code") not in _PIPELINE_STEP_DETAIL_CODES:
                return None
            raw_count = detail.get("itemCount")
            if raw_count is not None and (
                isinstance(raw_count, bool)
                or not isinstance(raw_count, int)
                or raw_count < 0
                or raw_count > _MAX_SAFE_PIPELINE_INTEGER
            ):
                return None
            detail_code = str(detail["code"])
            detail_count = raw_count

        state = _PIPELINE_STEP_EVENT_STATES[str(event_type)]
        time_field = {
            "queued": "queuedAt",
            "running": "startedAt",
            "succeeded": "completedAt",
            "failed": "failedAt",
        }[state]
        lifecycle_at = payload.get(time_field)
        if not isinstance(lifecycle_at, str) or not lifecycle_at.strip():
            return None
        occurred_at_text = str(occurred_at) if occurred_at else lifecycle_at

        duration_ms: int | None = None
        if state in {"succeeded", "failed"}:
            raw_duration = payload.get("durationMs")
            if raw_duration is not None and (
                isinstance(raw_duration, bool)
                or not isinstance(raw_duration, int)
                or raw_duration < 0
                or raw_duration > _MAX_SAFE_PIPELINE_INTEGER
            ):
                return None
            duration_ms = raw_duration

        error_code: str | None = None
        retryable = False
        if state == "failed":
            raw_error_code = payload.get("errorCode")
            raw_retryable = payload.get("retryable")
            if (
                not isinstance(raw_error_code, str)
                or not _SAFE_PIPELINE_ERROR_CODE.fullmatch(raw_error_code)
                or not isinstance(raw_retryable, bool)
            ):
                return None
            error_code = raw_error_code
            retryable = raw_retryable

        try:
            parsed_event_id = int(event_id)
        except (TypeError, ValueError):
            return None
        if parsed_event_id < 1 or parsed_event_id > _MAX_SAFE_PIPELINE_INTEGER:
            return None
        return {
            "event_id": parsed_event_id,
            "occurred_at": occurred_at_text,
            "tenant_id": str(tenant_id),
            "workflow_id": workflow_id,
            "temporal_run_id": temporal_run_id,
            "step_kind": str(step_kind),
            "item_key": item_key,
            "state": state,
            "attempt": attempt,
            "lifecycle_at": lifecycle_at,
            "duration_ms": duration_ms,
            "error_code": error_code,
            "retryable": retryable,
            "detail_code": detail_code,
            "detail_count": detail_count,
        }

    @staticmethod
    def _new_pipeline_step_fold(event: dict[str, Any]) -> _PipelineStepFold:
        state = event["state"]
        return _PipelineStepFold(
            tenant_id=event["tenant_id"],
            workflow_id=event["workflow_id"],
            temporal_run_id=event["temporal_run_id"],
            step_kind=event["step_kind"],
            item_key=event["item_key"],
            state=state,
            attempt=event["attempt"],
            queued_at=event["lifecycle_at"] if state == "queued" else None,
            started_at=event["lifecycle_at"] if state == "running" else None,
            finished_at=(event["lifecycle_at"] if state in {"succeeded", "failed"} else None),
            duration_ms=event["duration_ms"],
            error_code=event["error_code"],
            retryable=event["retryable"],
            detail_code=event["detail_code"],
            detail_count=event["detail_count"],
            last_event_id=event["event_id"],
            last_updated_at=event["occurred_at"],
        )

    def _workflow_runs_backfill_pending(self) -> bool:
        """Detect workflow-run rows missed by the incremental watermark.

        ``workflow_run_projections`` is folded from canonical ``Workflow*``
        events. The TypeScript API refresher shares the operations watermark but
        does not write this Python-owned table, so an existing local DB can have
        the watermark past workflow events while the workflow-run table is still
        empty. A count mismatch is enough to trigger a deterministic rebuild.
        """
        # Count state-bearing events only: an audit-only group (e.g. a lone
        # ``WorkflowCancellationRequested``) never materialises a row, so it
        # must not keep the backfill detector permanently pending.
        placeholders = ", ".join("?" for _ in WORKFLOW_STATE_EVENT_TYPES)
        try:
            event_row = self._conn.execute(
                f"""
                SELECT COUNT(DISTINCT COALESCE(
                    JSON_EXTRACT(payload_json, '$.workflowId'),
                    JSON_EXTRACT(payload_json, '$.workflow_id')
                ))
                FROM job_events
                WHERE tenant_id = ?
                  AND event_type IN ({placeholders})
                  AND payload_json IS NOT NULL
                  AND json_valid(payload_json)
                """,
                (str(self._tenant_id), *WORKFLOW_STATE_EVENT_TYPES),
            ).fetchone()
            projection_row = self._conn.execute(
                "SELECT COUNT(*) FROM workflow_run_projections WHERE tenant_id = ?",
                (str(self._tenant_id),),
            ).fetchone()
        except sqlite3.OperationalError:
            return False
        event_count = int(event_row[0] or 0) if event_row else 0
        projection_count = int(projection_row[0] or 0) if projection_row else 0
        return event_count > projection_count

    # ----------------------------------------------------------- apply runs

    def _rebuild_workflow_runs(self) -> None:
        """Materialise ``workflow_run_projections`` from ``Workflow*`` events.

        Each Temporal workflow run is a ``WorkflowStarted`` marker plus one
        terminal event, keyed by ``workflowId`` in the event payload. This is
        the unified list source across all workflow types; the apply-specific
        detail stays in ``apply_run_projections``.
        """
        events_by_workflow = self._collect_workflow_events()
        if not events_by_workflow:
            return
        for workflow_id, events in events_by_workflow.items():
            projection = self._project_workflow_run(workflow_id, events)
            if projection is None:
                continue
            self._store.upsert_workflow_run(projection)

    def _collect_workflow_events(self) -> dict[str, list[dict]]:
        placeholders = ",".join("?" for _ in WORKFLOW_EVENT_TYPES)
        try:
            rows = self._conn.execute(
                f"""
                SELECT event_type, occurred_at, payload_json
                FROM job_events
                WHERE tenant_id = ?
                  AND event_type IN ({placeholders})
                ORDER BY event_id ASC
                """,
                (str(self._tenant_id), *WORKFLOW_EVENT_TYPES),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        out: dict[str, list[dict]] = {}
        for row in rows:
            payload = _json_loads(_row_nullable_str(row, "payload_json"), {})
            if not isinstance(payload, dict):
                continue
            workflow_id = payload.get("workflowId") or payload.get("workflow_id")
            if not workflow_id:
                continue
            out.setdefault(str(workflow_id), []).append(
                {
                    "event_type": _row_str(row, "event_type"),
                    "occurred_at": _row_nullable_str(row, "occurred_at"),
                    "payload": payload,
                }
            )
        return out

    def _project_workflow_run(self, workflow_id: str, events: list[dict]) -> WorkflowRunProjection | None:
        if not events:
            return None
        # An audit-only group (no ``WorkflowStarted`` and no terminal event —
        # e.g. a ``WorkflowCancellationRequested`` fact recorded for a legacy
        # run whose lifecycle predates the event log) carries no lifecycle
        # state. Materialising the seed fold here would full-row-overwrite the
        # stored projection (a canceled run would flip to ``in_progress`` and
        # lose ``started_at``/``finished_at``/``input_summary`` — PR #750
        # review, reproduced). Return ``None`` so the stored row is preserved.
        if not any(event["event_type"] in WORKFLOW_STATE_EVENT_TYPES for event in events):
            return None
        workflow_type = ""
        status = "in_progress"
        input_summary: dict[str, Any] = {}
        error_code: str | None = None
        error_message: str | None = None
        retryable = False
        started_at: str | None = None
        finished_at: str | None = None
        duration_ms: int | None = None
        temporal_run_id: str | None = None
        timeline: list[dict[str, Any]] = []

        for event in events:
            payload = event["payload"]
            event_type = event["event_type"]
            workflow_type = str(payload.get("workflowType") or payload.get("workflow_type") or workflow_type)
            event_run_id = payload.get("temporalRunId") or payload.get("temporal_run_id")
            event_run_id = str(event_run_id) if event_run_id else None
            occurred_at = event.get("occurred_at")
            timeline.append(
                {
                    "eventType": event_type,
                    "occurredAt": occurred_at,
                    "status": payload.get("status"),
                    "message": payload.get("errorMessage") or payload.get("message"),
                }
            )

            if event_type == "WorkflowStarted":
                # Run-scoped fold: a WorkflowStarted for a NEW Temporal execution
                # that reuses this workflow_id (a restart after the reconciler
                # closed the prior run) reopens the row so the new run's own
                # terminal can apply. A stale/duplicate WorkflowStarted for the
                # run that already folded a terminal is idempotent and preserves
                # that terminal (the reconciler-describe vs finalize backstop).
                recovers_missing_history = (
                    status == "terminated"
                    and error_code == "reconciled_not_found"
                    and payload.get("recoveredFromMissingHistory") is True
                    and bool(event_run_id)
                    and event_run_id == temporal_run_id
                )
                if (
                    status in _WORKFLOW_TERMINAL_STATUSES
                    and not recovers_missing_history
                    and not _starts_new_execution(
                        folded_run_id=temporal_run_id,
                        folded_finished_at=finished_at,
                        event_run_id=event_run_id,
                        event_occurred_at=occurred_at,
                    )
                ):
                    continue
                status = "in_progress"
                error_code = None
                error_message = None
                retryable = False
                finished_at = None
                duration_ms = None
                started_at = payload.get("startedAt") or occurred_at or started_at
                summary = payload.get("inputSummary")
                if isinstance(summary, dict):
                    input_summary = summary
                if event_run_id:
                    temporal_run_id = event_run_id
            elif event_type in _WORKFLOW_TERMINAL_STATUS:
                # First-terminal-wins WITHIN a run: once this run folded a
                # terminal, a later terminal for the SAME run stays in the
                # timeline (above) but must NOT replace the outcome. This is the
                # backstop for a reconciler describe (COMPLETED) racing a
                # finalize WorkflowFailed, which would otherwise flip
                # failed -> succeeded (M-1 review).
                if status in _WORKFLOW_TERMINAL_STATUSES:
                    continue
                # Run-scoped in the terminal direction too: a late terminal
                # from a superseded execution (the reconciler closing a dead
                # run after a newer WorkflowStarted already folded) must not
                # clobber the live run.
                if event_run_id and temporal_run_id and event_run_id != temporal_run_id:
                    continue
                if event_run_id:
                    temporal_run_id = event_run_id
                status = _WORKFLOW_TERMINAL_STATUS[event_type]
                finished_at = payload.get("finishedAt") or occurred_at or finished_at
                duration = payload.get("durationMs")
                if isinstance(duration, (int, float)):
                    duration_ms = int(duration)
                code = payload.get("errorCode")
                error_code = str(code) if code else error_code
                message = payload.get("errorMessage")
                error_message = str(message) if message else error_message
                if "retryable" in payload:
                    retryable = bool(payload.get("retryable"))

        return WorkflowRunProjection(
            workflow_id=workflow_id,
            tenant_id=self._tenant_id,
            workflow_type=workflow_type,
            status=status,
            input_summary=input_summary,
            error_code=error_code,
            error_message=error_message,
            retryable=retryable,
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=duration_ms,
            temporal_run_id=temporal_run_id,
            events=tuple(timeline),
        )

    def _rebuild_apply_runs(self) -> None:
        """Materialise ``apply_run_projections`` from ``job_events``.

        PR 4 of the Temporal stack collapsed the bespoke ``apply_runs``
        table into the workflow run history. Each apply lifecycle is now
        a sequence of ``job_events`` rows keyed by ``run_id`` in the
        event payload:

          * ``ApplyRunStarted``      — opens a row.
          * ``ApplicationSubmitted`` — terminal: succeeded.
          * ``ApplicationFailed``    — terminal: failed (or another
                                       non-applied SubmissionResult kind).
          * ``DryRunCompleted``      — terminal: dry_run_complete.
          * Any other apply-stage event with a ``run_id`` — appended to
            the per-run ``events_json`` timeline.
        """
        events_by_run = self._collect_apply_events_by_run()
        if not events_by_run:
            return
        for run_id, events in events_by_run.items():
            projection = self._project_run_from_events(run_id, events)
            if projection is None:
                continue
            self._store.upsert_apply_run(projection)

    def _collect_apply_events_by_run(self) -> dict[str, list[dict]]:
        try:
            rows = self._conn.execute(
                """
                SELECT events.job_id, events.event_type, events.level,
                       events.message, events.occurred_at, events.payload_json
                FROM job_events AS events
                WHERE events.tenant_id = ?
                  AND events.stage = 'apply'
                ORDER BY events.event_id ASC
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        out: dict[str, list[dict]] = {}
        for row in rows:
            payload = _json_loads(_row_nullable_str(row, "payload_json"), {})
            if not isinstance(payload, dict):
                continue
            run_id = payload.get("run_id")
            if not run_id:
                continue
            run_id_str = str(run_id)
            out.setdefault(run_id_str, []).append(
                {
                    "job_id": _row_nullable_str(row, "job_id"),
                    "event_type": _row_str(row, "event_type"),
                    "level": _row_nullable_str(row, "level") or "info",
                    "message": _row_nullable_str(row, "message"),
                    "occurred_at": _row_nullable_str(row, "occurred_at"),
                    "payload": payload,
                }
            )
        return out

    _TERMINAL_EVENT_STATUS: dict[str, tuple[str, str | None]] = {
        "ApplicationSubmitted": ("succeeded", "applied"),
        "DryRunCompleted": ("dry_run_complete", "dry_run_complete"),
        "ApplyManualSkip": ("manual", "manual"),
        # ``LockReleased`` is a legacy fallback terminal: only treat it as
        # failure when no prior terminal event for the run was observed. The
        # event itself carries no result; preserving the prior result keeps
        # captcha / login_issue / expired distinct from generic 'failed'.
        "LockReleased": ("failed", "failed"),
    }

    # Event types that carry a real terminal verdict (used to gate the
    # LockReleased fallback so it doesn't clobber more-specific results).
    _AUTHORITATIVE_TERMINAL_EVENTS: frozenset[str] = frozenset(
        {"ApplicationSubmitted", "DryRunCompleted", "ApplyManualSkip", "ApplicationFailed"}
    )

    _STATUS_FROM_RESULT: dict[str, str] = {
        "applied": "succeeded",
        "failed": "failed",
        "captcha": "captcha",
        "login_issue": "login_issue",
        "expired": "expired",
        "manual": "manual",
        "dry_run_complete": "dry_run_complete",
    }

    def _project_run_from_events(self, run_id: str, events: list[dict]) -> ApplyRunProjection | None:
        if not events:
            return None
        job_id = ""
        title = ""
        status = "starting"
        result: str | None = None
        started_at: str | None = None
        finished_at: str | None = None
        duration_ms: int | None = None
        worker_id: int | None = None
        model: str | None = None
        dry_run = False

        for event in events:
            payload = event["payload"]
            event_type = event["event_type"]
            if event["job_id"]:
                job_id = event["job_id"]

            if event_type == "ApplyRunStarted":
                started_at = (
                    str(payload.get("started_at"))
                    if payload.get("started_at") is not None
                    else event.get("occurred_at")
                )
                model = (
                    str(payload["model"]) if isinstance(payload.get("model"), str) and payload.get("model") else model
                )
                worker = payload.get("worker_id")
                if isinstance(worker, (int, float)):
                    worker_id = int(worker)
                elif isinstance(worker, str) and worker.isdigit():
                    worker_id = int(worker)
                if "dry_run" in payload:
                    dry_run = bool(payload.get("dry_run"))
                status = "starting"
            elif event_type == "ApplyRunInProgress":
                if status == "starting":
                    status = "in_progress"
            elif event_type in self._TERMINAL_EVENT_STATUS:
                # LockReleased is only a fallback: when an authoritative
                # terminal event already fired (Submitted / DryRunCompleted /
                # ApplyManualSkip / ApplicationFailed), do NOT overwrite its
                # more-specific result.
                if event_type == "LockReleased" and result is not None:
                    continue
                term_status, term_result = self._TERMINAL_EVENT_STATUS[event_type]
                status = term_status
                result = str(payload.get("result")) if isinstance(payload.get("result"), str) else term_result
                finished_at = (
                    str(payload.get("finished_at"))
                    if payload.get("finished_at") is not None
                    else event.get("occurred_at")
                )
                if "duration_ms" in payload:
                    try:
                        duration_ms = int(payload["duration_ms"])
                    except (TypeError, ValueError):
                        pass
                if event_type == "DryRunCompleted":
                    dry_run = True
            elif event_type == "ApplicationFailed":
                # Payload may carry the SubmissionResult kind explicitly.
                kind = (
                    payload.get("result", {}).get("kind")
                    if isinstance(payload.get("result"), dict)
                    else (payload.get("result") if isinstance(payload.get("result"), str) else None)
                )
                status = self._STATUS_FROM_RESULT.get(str(kind), "failed") if kind else "failed"
                result = str(kind) if kind else "failed"
                finished_at = (
                    str(payload.get("finished_at"))
                    if payload.get("finished_at") is not None
                    else event.get("occurred_at")
                )
                if "duration_ms" in payload:
                    try:
                        duration_ms = int(payload["duration_ms"])
                    except (TypeError, ValueError):
                        pass

        if not job_id:
            return None

        # Hydrate denormalised job columns from the parent ``jobs`` row
        # so the read-side widgets render real values rather than
        # "Untitled" / "Unknown company".
        try:
            meta = self._conn.execute(
                """
                SELECT title, company FROM jobs
                WHERE tenant_id = ? AND job_id = ?
                LIMIT 1
                """,
                (str(self._tenant_id), job_id),
            ).fetchone()
        except sqlite3.OperationalError:
            meta = None
        if meta is not None:
            title = _row_str(meta, "title") or title

        employer = _canonical_employer(meta)

        events_payload: list[dict] = []
        for event in events:
            entry = {
                "event_type": event["event_type"],
                "level": event["level"],
                "occurred_at": event["occurred_at"],
            }
            if event["message"]:
                entry["message"] = event["message"]
            if event["payload"]:
                entry["payload"] = event["payload"]
            events_payload.append(entry)

        return ApplyRunProjection(
            run_id=run_id,
            tenant_id=self._tenant_id,
            job_id=job_id,
            job_title=title or "Untitled",
            job_employer=employer,
            status=status,
            result=result,
            dry_run=dry_run,
            worker_id=worker_id,
            model=model,
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=duration_ms,
            events=tuple(events_payload),
        )


# ============================================================== helpers


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        is not None
    )


def _has_column(conn: sqlite3.Connection, table_name: str, column_name: str) -> bool:
    return any(
        (row["name"] if isinstance(row, sqlite3.Row) else row[1]) == column_name
        for row in conn.execute(f"PRAGMA table_info({table_name})")
    )


def _column_or_literal(
    conn: sqlite3.Connection,
    table_name: str,
    column_name: str,
    fallback_sql: str,
    alias: str,
) -> str:
    return f"{alias}.{column_name}" if _has_column(conn, table_name, column_name) else fallback_sql


def _job_metadata_join_sql(
    conn: sqlite3.Connection,
    tenant_id_expression: str,
    job_id_expression: str,
) -> dict[str, str]:
    if not _table_exists(conn, "jobs"):
        return {"select_sql": "NULL AS job_title, NULL AS employer", "join_sql": ""}
    title_sql = _column_or_literal(conn, "jobs", "title", "NULL", "jobs")
    if _has_column(conn, "jobs", "company"):
        employer_sql = f"COALESCE(NULLIF(TRIM(jobs.company), ''), '{_UNKNOWN_EMPLOYER}')"
    else:
        employer_sql = f"'{_UNKNOWN_EMPLOYER}'"
    return {
        "select_sql": f"{title_sql} AS job_title, {employer_sql} AS employer",
        "join_sql": (
            f"LEFT JOIN jobs ON jobs.tenant_id = {tenant_id_expression} AND jobs.job_id = {job_id_expression}"
        ),
    }


def _job_lifecycle_exclusion_sql(
    conn: sqlite3.Connection,
    tenant_id_expression: str,
    job_id_expression: str,
) -> dict[str, str]:
    """Anti-join fragments excluding soft-deleted and hidden jobs from a
    tenant-wide read, mirroring the TS ``jobLifecycleExclusionSql``. Guarded by
    ``_table_exists`` so it excludes nothing on a DB where the TS write-model has
    not created the lifecycle tables yet.
    """
    joins: list[str] = []
    wheres: list[str] = []
    if _table_exists(conn, "jobctrl_deleted_jobs"):
        joins.append(
            "LEFT JOIN jobctrl_deleted_jobs d "
            f"ON d.tenant_id = {tenant_id_expression} "
            f"AND d.job_id = {job_id_expression} "
            "AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))"
        )
        wheres.append("d.job_id IS NULL")
    if _table_exists(conn, "jobctrl_hidden_jobs"):
        joins.append(
            "LEFT JOIN jobctrl_hidden_jobs h "
            f"ON h.tenant_id = {tenant_id_expression} "
            f"AND h.job_id = {job_id_expression} AND h.unhidden_at IS NULL"
        )
        wheres.append("h.job_id IS NULL")
    return {
        "join_sql": (" " + " ".join(joins)) if joins else "",
        "where_sql": (" AND " + " AND ".join(wheres)) if wheres else "",
    }


def _row_str(row: object, key: str) -> str:
    value = _row_get(row, key)
    return "" if value is None else str(value)


def _row_nullable_str(row: object, key: str) -> str | None:
    value = _row_get(row, key)
    if value is None or value == "":
        return None
    return str(value)


def _canonical_employer(job_row: object) -> str:
    return _row_str(job_row, "company").strip() or _UNKNOWN_EMPLOYER


def _row_nullable_int(row: object, key: str) -> int | None:
    value = _row_get(row, key)
    if value is None or value == "":
        return None
    if not isinstance(value, (int, str, float, bytes)):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _row_int(row: object, key: str) -> int:
    return _row_nullable_int(row, key) or 0


def _row_float(row: object, key: str) -> float:
    value = _row_get(row, key)
    if value is None or value == "":
        return 0.0
    if not isinstance(value, (int, str, float, bytes)):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _posted_fact_from_row(row: object, job_id: str) -> dict[str, Any]:
    warnings = _warnings(_row_str(row, "warnings_json"), POSTED_COMPENSATION_WARNING_MESSAGES)
    base: dict[str, Any] = {
        "tenantId": _row_str(row, "tenant_id"),
        "jobId": job_id,
        "sourceField": _row_str(row, "source_field"),
        "legacyRawSalary": _nullable_text(_row_get(row, "legacy_raw_salary")),
        "parserVersion": _row_str(row, "parser_version"),
        "sourceHash": _row_str(row, "source_hash"),
        "parsedAt": _row_str(row, "parsed_at"),
        "warnings": warnings,
    }
    parse_state = _row_str(row, "parse_state")
    if parse_state == "missing":
        return {
            **base,
            "parseState": "missing",
            "sourceText": None,
            "confidence": "none",
        }
    if parse_state == "unparseable":
        return {
            **base,
            "parseState": "unparseable",
            "sourceText": _row_str(row, "source_text"),
            "confidence": "low",
        }
    if parse_state == "ambiguous":
        confidence = "medium" if _row_str(row, "confidence") == "medium" else "low"
        return {
            **base,
            "parseState": "ambiguous",
            "sourceText": _row_str(row, "source_text"),
            "confidence": confidence,
        }
    confidence = _row_str(row, "confidence")
    return {
        **base,
        "parseState": "parsed_range",
        "sourceText": _row_str(row, "source_text"),
        "currency": _nullable_text(_row_get(row, "currency")),
        "period": _row_str(row, "period"),
        "component": _row_str(row, "component"),
        "minimumAmount": _nullable_int(_row_get(row, "minimum_amount")),
        "maximumAmount": _nullable_int(_row_get(row, "maximum_amount")),
        "annualizedMinimumAmount": _nullable_int(_row_get(row, "annualized_minimum_amount")),
        "annualizedMaximumAmount": _nullable_int(_row_get(row, "annualized_maximum_amount")),
        "annualizationAssumption": _nullable_text(_row_get(row, "annualization_assumption")),
        "confidence": confidence if confidence in {"high", "medium"} else "low",
    }


def _market_estimate_from_row(
    row: object,
    job_id: str,
    *,
    benchmark_lineage: dict[str, Any] | None,
) -> dict[str, Any]:
    sources = _market_sources(_row_str(row, "source_snapshot_json"))
    estimate_state = _row_str(row, "estimate_state")
    confidence_band = _confidence_band(_row_get(row, "confidence_band"))
    base: dict[str, Any] = {
        "tenantId": _row_str(row, "tenant_id"),
        "jobId": job_id,
        "estimateState": estimate_state,
        "confidenceBand": confidence_band,
        "confidenceScore": _number(_row_get(row, "confidence_score")),
        "sourceCount": int(_number(_row_get(row, "source_count"))),
        "sampleCount": _nullable_int(_row_get(row, "sample_count")),
        "aggregateBucket": _safe_market_aggregate_bucket(_row_get(row, "aggregate_bucket"), sources),
        "geographyScope": _safe_market_geography_scope(_row_get(row, "geography_scope")),
        "occupationCode": _nullable_text(_row_get(row, "occupation_code")),
        "occupationLabel": _nullable_text(_row_get(row, "occupation_label")),
        "seniorityLabel": _nullable_text(_row_get(row, "seniority_label")),
        "companyName": _nullable_text(_row_get(row, "company_name")),
        "normalizedCompany": _nullable_text(_row_get(row, "normalized_company")),
        "roleTitle": _nullable_text(_row_get(row, "role_title")),
        "normalizedRole": _nullable_text(_row_get(row, "normalized_role")),
        "companyTier": _company_tier(_row_get(row, "company_tier")),
        "matchScope": _market_match_scope(_row_get(row, "match_scope")),
        "sources": sources,
        "factors": _market_factors(_row_str(row, "factor_reasons_json")),
        "evidence": _market_evidence(_row_str(row, "selected_evidence_json")),
        "warnings": _warnings(_row_str(row, "warnings_json"), MARKET_COMPENSATION_WARNING_MESSAGES),
        "benchmarkLineage": benchmark_lineage,
        "estimatorVersion": _row_str(row, "estimator_version"),
        "estimatedAt": _row_str(row, "estimated_at"),
    }
    if estimate_state == "unsupported":
        return {
            **base,
            "estimateState": "unsupported",
            "unsupportedReasons": _reasons(
                _row_str(row, "unsupported_reasons_json"),
                MARKET_COMPENSATION_REASON_MESSAGES,
            ),
        }
    if estimate_state == "source_unavailable":
        return {
            **base,
            "estimateState": "source_unavailable",
            "sourceUnavailableReasons": _reasons(
                _row_str(row, "source_unavailable_reasons_json"),
                MARKET_COMPENSATION_REASON_MESSAGES,
            ),
        }
    if estimate_state == "insufficient_evidence":
        return {
            **base,
            "estimateState": "insufficient_evidence",
            "insufficientReasons": _reasons(
                _row_str(row, "insufficient_reasons_json"),
                MARKET_COMPENSATION_REASON_MESSAGES,
            ),
        }
    return {
        **base,
        "estimateState": "estimated_range",
        "currency": _nullable_text(_row_get(row, "currency")) or "EUR",
        "period": _row_str(row, "period"),
        "component": _row_str(row, "component"),
        "minimumAmount": _nullable_int(_row_get(row, "minimum_amount")) or 0,
        "maximumAmount": _nullable_int(_row_get(row, "maximum_amount")) or 0,
        "confidenceInterval": {
            "minimumAmount": _nullable_int(_row_get(row, "confidence_interval_minimum_amount"))
            or _nullable_int(_row_get(row, "minimum_amount"))
            or 0,
            "maximumAmount": _nullable_int(_row_get(row, "confidence_interval_maximum_amount"))
            or _nullable_int(_row_get(row, "maximum_amount"))
            or 0,
        },
    }


def _posted_range_summary(fact: dict[str, Any]) -> dict[str, Any] | None:
    if fact.get("parseState") != "parsed_range":
        return None
    return {
        "currency": fact.get("currency"),
        "period": fact.get("period"),
        "component": fact.get("component"),
        "minimumAmount": fact.get("minimumAmount"),
        "maximumAmount": fact.get("maximumAmount"),
        "annualizedMinimumAmount": fact.get("annualizedMinimumAmount"),
        "annualizedMaximumAmount": fact.get("annualizedMaximumAmount"),
        "annualizedMinimumEur": _normalize_annualized_eur(
            fact.get("annualizedMinimumAmount"),
            fact.get("currency"),
        ),
        "annualizedMaximumEur": _normalize_annualized_eur(
            fact.get("annualizedMaximumAmount"),
            fact.get("currency"),
        ),
        "displayRange": _format_compensation_range(
            fact.get("currency"),
            fact.get("minimumAmount"),
            fact.get("maximumAmount"),
            fact.get("period"),
        ),
    }


def _market_range_summary(estimate: dict[str, Any]) -> dict[str, Any] | None:
    if estimate.get("estimateState") != "estimated_range":
        return None
    return {
        "currency": estimate.get("currency"),
        "period": estimate.get("period"),
        "component": estimate.get("component"),
        "minimumAmount": estimate.get("minimumAmount"),
        "maximumAmount": estimate.get("maximumAmount"),
        "annualizedMinimumAmount": _annualize_compensation_amount(
            estimate.get("minimumAmount"),
            estimate.get("period"),
        ),
        "annualizedMaximumAmount": _annualize_compensation_amount(
            estimate.get("maximumAmount"),
            estimate.get("period"),
        ),
        "annualizedMinimumEur": _normalize_annualized_eur(
            _annualize_compensation_amount(estimate.get("minimumAmount"), estimate.get("period")),
            estimate.get("currency"),
        ),
        "annualizedMaximumEur": _normalize_annualized_eur(
            _annualize_compensation_amount(estimate.get("maximumAmount"), estimate.get("period")),
            estimate.get("currency"),
        ),
        "displayRange": _format_compensation_range(
            estimate.get("currency"),
            estimate.get("minimumAmount"),
            estimate.get("maximumAmount"),
            estimate.get("period"),
        ),
    }


def _market_confidence_interval_summary(estimate: dict[str, Any]) -> dict[str, Any] | None:
    if estimate.get("estimateState") != "estimated_range":
        return None
    interval = estimate.get("confidenceInterval")
    if not isinstance(interval, dict):
        return None
    minimum = interval.get("minimumAmount")
    maximum = interval.get("maximumAmount")
    return {
        "currency": estimate.get("currency"),
        "period": estimate.get("period"),
        "component": estimate.get("component"),
        "minimumAmount": minimum,
        "maximumAmount": maximum,
        "annualizedMinimumAmount": _annualize_compensation_amount(minimum, estimate.get("period")),
        "annualizedMaximumAmount": _annualize_compensation_amount(maximum, estimate.get("period")),
        "annualizedMinimumEur": _normalize_annualized_eur(
            _annualize_compensation_amount(minimum, estimate.get("period")),
            estimate.get("currency"),
        ),
        "annualizedMaximumEur": _normalize_annualized_eur(
            _annualize_compensation_amount(maximum, estimate.get("period")),
            estimate.get("currency"),
        ),
        "displayRange": _format_compensation_range(
            estimate.get("currency"),
            minimum,
            maximum,
            estimate.get("period"),
        ),
    }


EUR_NORMALIZATION_RATES: dict[str, float] = {
    "EUR": 1,
    "USD": 0.92,
    "GBP": 1.17,
    "CHF": 1.06,
    "SEK": 0.09,
    "NOK": 0.087,
    "DKK": 0.134,
    "PLN": 0.235,
    "CZK": 0.041,
}


def _normalize_annualized_eur(amount: object, currency: object) -> int | None:
    annualized = _nullable_int(amount)
    if annualized is None:
        return None
    rate = EUR_NORMALIZATION_RATES.get(str(currency).upper()) if currency else None
    if rate is None:
        return None
    return round(annualized * rate)


def _annualize_compensation_amount(amount: object, period: object) -> int | None:
    value = _nullable_int(amount)
    if value is None:
        return None
    if period == "year":
        return value
    if period == "month":
        return value * 12
    if period == "hour":
        return value * 2080
    return None


def _format_compensation_range(
    currency: object,
    minimum_amount: object,
    maximum_amount: object,
    period: object,
) -> str | None:
    minimum = _nullable_int(minimum_amount)
    maximum = _nullable_int(maximum_amount)
    if minimum is None and maximum is None:
        return None
    prefix = f"{currency} " if currency else ""
    suffix = f"/{period}" if period else ""
    if minimum is not None and maximum is not None:
        return f"{prefix}{minimum}{suffix}" if minimum == maximum else f"{prefix}{minimum}-{maximum}{suffix}"
    if minimum is not None:
        return f"{prefix}{minimum}+{suffix}"
    return f"{prefix}up to {maximum}{suffix}"


def _warnings(value: str, messages: dict[str, str]) -> list[dict[str, str]]:
    return [{"code": code, "message": messages[code]} for code in _json_strings(value) if code in messages]


def _reasons(value: str, messages: dict[str, str]) -> list[dict[str, str]]:
    return [{"code": code, "message": messages[code]} for code in _json_strings(value) if code in messages]


def _market_factors(value: str) -> list[dict[str, Any]]:
    factors: list[dict[str, Any]] = []
    for item in _json_records(value):
        name = str(item.get("name") or "")
        if name not in MARKET_SAFE_FACTOR_NAMES:
            continue
        factors.append(
            {
                "name": name,
                "score": _number(item.get("score")),
                "band": _confidence_band(item.get("band")),
                "reason": _safe_market_factor_reason(item.get("reason")),
            }
        )
    return factors


def _safe_market_factor_reason(value: object) -> str:
    if not isinstance(value, str):
        return MARKET_DEFAULT_FACTOR_REASON
    text = " ".join(value.split())
    if not text:
        return MARKET_DEFAULT_FACTOR_REASON
    lowered = text.casefold()
    if any(term in lowered for term in MARKET_UNSAFE_FACTOR_REASON_TERMS):
        return MARKET_DEFAULT_FACTOR_REASON
    if len(text) > MARKET_MAX_FACTOR_REASON_LENGTH:
        return text[: MARKET_MAX_FACTOR_REASON_LENGTH - 3].rstrip() + "..."
    return text


def _market_sources(value: str) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for item in _json_records(value):
        source_id = str(item.get("source_id") or "")
        source_type = str(item.get("source_type") or "")
        defaults = MARKET_SOURCE_DEFAULTS.get(source_id)
        if defaults is None or source_type != defaults["sourceType"]:
            continue
        provenance = _market_source_provenance(item.get("source_provenance"), source_id)
        release_year = _nullable_int(item.get("release_year"))
        sources.append(
            {
                "sourceId": source_id,
                "provenance": provenance,
                "displayName": defaults["displayName"],
                "sourceType": defaults["sourceType"],
                "releaseYear": release_year,
                "snapshotVersion": _market_source_snapshot_version(
                    item.get("snapshot_version"),
                    source_id,
                    provenance,
                    release_year,
                ),
                "geographyScope": (
                    _safe_market_geography_scope(item.get("geography_scope")) or defaults["geographyScope"]
                ),
                "aggregateBucket": defaults["aggregateBucket"],
                "attribution": _market_source_attribution(item.get("attribution"), source_id, provenance),
                "sampleCount": _nullable_int(item.get("sample_count")),
            }
        )
    return sources


def _market_uses_employer_posted_authority(value: str) -> bool:
    return any(
        str(item.get("source_id") or "") == "posted_salary_text"
        or str(item.get("source_type") or "") == "posted_salary"
        or str(item.get("source_provenance") or "") == "employer_posted"
        for item in _json_records(value)
    )


def _market_source_provenance(value: object, source_id: str) -> str:
    text = str(value or "").strip().casefold()
    if source_id == "levels_fyi" and text in {"public", "licensed"}:
        return text
    return str(MARKET_SOURCE_DEFAULTS[source_id]["provenance"])


def _market_source_snapshot_version(
    value: object,
    source_id: str,
    provenance: str,
    release_year: int | None,
) -> str:
    stored = _safe_market_evidence_text(value)
    if stored:
        return stored
    if source_id == "levels_fyi" and provenance == "public":
        return f"levels-fyi-public-{release_year}" if release_year is not None else "levels-fyi-public"
    return str(MARKET_SOURCE_DEFAULTS[source_id]["snapshotVersion"])


def _market_source_attribution(value: object, source_id: str, provenance: str) -> str:
    if source_id == "levels_fyi" and provenance == "public":
        return "Data source: Levels.fyi (https://www.levels.fyi)"
    return _safe_market_evidence_text(value) or str(MARKET_SOURCE_DEFAULTS[source_id]["attribution"])


def _market_evidence(value: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in _json_records(value):
        source_id = str(item.get("source_id") or "")
        defaults = MARKET_SOURCE_DEFAULTS.get(source_id)
        if defaults is None:
            continue
        minimum_amount = _nullable_int(item.get("minimum_amount"))
        maximum_amount = _nullable_int(item.get("maximum_amount"))
        if minimum_amount is None and maximum_amount is None:
            continue
        rows.append(
            {
                "sourceId": source_id,
                "displayName": defaults["displayName"],
                "sourceUrl": _safe_market_evidence_url(item.get("source_url")),
                "companyName": _safe_market_evidence_text(item.get("company_name")) or "unknown company",
                "roleTitle": _safe_market_evidence_text(item.get("role_title")) or "unknown role",
                "location": _safe_market_evidence_text(item.get("location")),
                "levelLabel": _safe_market_evidence_text(item.get("level_label")),
                "companyTier": _company_tier(item.get("company_tier")),
                "component": _market_component(item.get("component")),
                "currency": _market_currency(item.get("currency")),
                "period": _market_period(item.get("period")),
                "minimumAmount": minimum_amount if minimum_amount is not None else maximum_amount or 0,
                "maximumAmount": maximum_amount if maximum_amount is not None else minimum_amount or 0,
                "sampleCount": _nullable_int(item.get("sample_count")),
                "releaseYear": _nullable_int(item.get("release_year")),
                "companyScore": _market_score(item.get("company_score")),
                "roleScore": _market_score(item.get("role_score")),
                "levelScore": _market_score(item.get("level_score")),
                "locationScore": _market_score(item.get("location_score")),
                "freshnessScore": _market_score(item.get("freshness_score")),
            }
        )
    return rows


def _safe_market_evidence_text(value: object) -> str | None:
    text = _nullable_text(value)
    if text is None:
        return None
    compact = " ".join(text.split())
    lowered = compact.casefold()
    if any(term in lowered for term in MARKET_UNSAFE_FACTOR_REASON_TERMS):
        return None
    return compact[:160] if compact else None


def _safe_market_evidence_url(value: object) -> str | None:
    text = _nullable_text(value)
    if text is None:
        return None
    compact = text.strip()
    if not compact:
        return None
    lowered = compact.casefold()
    if any(term in lowered for term in MARKET_UNSAFE_FACTOR_REASON_TERMS):
        return None
    parsed = urllib.parse.urlsplit(compact)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        return None
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def _market_component(value: object) -> str:
    text = _nullable_text(value)
    return text if text in {"base_salary", "total_compensation"} else "total_compensation"


def _market_period(value: object) -> str:
    text = _nullable_text(value)
    return text if text in {"year", "month"} else "year"


def _market_currency(value: object) -> str:
    text = str(value or "EUR").strip().upper()
    return text if re.fullmatch(r"[A-Z]{3}", text) else "EUR"


def _market_score(value: object) -> float:
    return round(max(0.0, min(1.0, _number(value))), 2)


def _safe_market_aggregate_bucket(value: object, sources: list[dict[str, Any]]) -> str | None:
    text = _nullable_text(value)
    if text in MARKET_SAFE_AGGREGATE_BUCKETS:
        return text
    buckets = list(dict.fromkeys(str(source["aggregateBucket"]) for source in sources))
    return ", ".join(buckets) if buckets else None


def _safe_market_geography_scope(value: object) -> str | None:
    text = _nullable_text(value)
    return text if text in MARKET_SAFE_GEOGRAPHY_SCOPES else None


def _company_tier(value: object) -> str:
    text = _nullable_text(value)
    if text in {"tier_1_local", "tier_2_ambitious", "tier_3_top_of_market"}:
        return text
    return "unknown"


def _market_match_scope(value: object) -> str:
    text = _nullable_text(value)
    if text in {
        "exact_company_role",
        "same_location_role_fallback",
        "company_adjacent_role",
        "tier_role_fallback",
        "market_baseline_fallback",
    }:
        return text
    return "none"


def _json_strings(value: str) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


def _strings_from_unknown(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = str(item).strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _json_records(value: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def _nullable_text(value: object) -> str | None:
    if value is None or value == "":
        return None
    text = str(value).strip()
    return text if text else None


def _nullable_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _number(value: object) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def _confidence_band(value: object) -> str:
    text = str(value or "none")
    return text if text in MARKET_CONFIDENCE_BANDS else "none"


def _row_get(row: object, key: str) -> object:
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[key]  # type: ignore[index]
    except (KeyError, IndexError, TypeError):
        return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_loads(value: str | None, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _fit_band_from_report_json(value: str | None) -> str | None:
    data = _json_loads(value, {})
    if not isinstance(data, dict):
        return None
    return _fit_band(data.get("fitBand") or data.get("fit_band"))


def _preview_text(value: str, limit: int) -> str:
    if not value:
        return ""
    return value if len(value) <= limit else f"{value[:limit]}..."


def _requirement_fit_status_to_read_model(value: dict[str, Any]) -> dict[str, Any]:
    kind = str(value.get("kind") or "not_assessed")
    if kind == "matched":
        return {
            "kind": kind,
            "evidenceIds": _strings_from_unknown(value.get("evidence_ids") or value.get("evidenceIds")),
            "strength": str(value.get("strength") or "direct"),
        }
    if kind == "transferable":
        return {
            "kind": kind,
            "evidenceIds": _strings_from_unknown(value.get("evidence_ids") or value.get("evidenceIds")),
            "gap": str(value.get("gap") or ""),
            "bridge": str(value.get("bridge") or ""),
        }
    if kind == "missing":
        return {"kind": kind, "reason": str(value.get("reason") or "")}
    if kind == "blocked":
        return {"kind": kind, "blocker": str(value.get("blocker") or "")}
    return {"kind": "not_assessed", "reason": str(value.get("reason") or "")}


def _requirement_artifact_coverage_to_read_model(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": str(value.get("state") or "not_recorded"),
        "source": str(value.get("source") or "tailored_resume_bullet_provenance"),
        "bulletCount": int(value.get("bullet_count") or value.get("bulletCount") or 0),
        "examples": _strings_from_unknown(value.get("examples")),
    }


def _skill_coverage_usage(row: object, keyword: str, state: str) -> dict[str, Any]:
    return {
        "kind": "skill_coverage",
        "jobId": _row_str(row, "job_id"),
        "jobTitle": _row_nullable_str(row, "job_title"),
        "employer": _row_nullable_str(row, "job_employer"),
        "artifactId": _row_nullable_str(row, "artifact_id"),
        "bulletId": None,
        "generation": _row_nullable_int(row, "generation"),
        "generatedTextPreview": None,
        "scoreVersion": None,
        "requirementId": None,
        "requirementText": None,
        "requirementFitKind": None,
        "artifactCoverageState": None,
        "keyword": keyword,
        "coverageState": state,
        "occurredAt": _row_nullable_str(row, "created_at"),
    }


def _camel_score_breakdown(value) -> dict:
    data = value if isinstance(value, dict) else {}
    return {
        "technicalFit": _score_dimension(data.get("technical_fit", data.get("technicalFit"))),
        "experienceFit": _score_dimension(data.get("experience_fit", data.get("experienceFit"))),
        "roleFit": _score_dimension(data.get("role_fit", data.get("roleFit"))),
        "reasoning": data.get("reasoning") if isinstance(data.get("reasoning"), str) else "",
        "fitBand": _string_choice(data.get("fit_band", data.get("fitBand")), "plausible"),
        "confidence": _string_choice(data.get("confidence"), "medium"),
        "eligibility": _camel_score_eligibility(data.get("eligibility")),
        "matchedSignals": _string_list(data.get("matched_signals", data.get("matchedSignals"))),
        "missingSignals": _string_list(data.get("missing_signals", data.get("missingSignals"))),
        "transferableSignals": _string_list(data.get("transferable_signals", data.get("transferableSignals"))),
    }


def _camel_score_eligibility(value) -> dict:
    data = value if isinstance(value, dict) else {}
    return {
        "status": _string_choice(data.get("status"), "unknown"),
        "hardBlockers": _string_list(data.get("hard_blockers", data.get("hardBlockers"))),
        "warnings": _string_list(data.get("warnings")),
    }


def _score_dimension(value) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return 0
    if number < 0:
        return 0
    if number > 10:
        return 10
    return number


def _string_choice(value, default: str) -> str:
    candidate = str(value or "").strip()
    return candidate or default


def _string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for raw in value:
        text = str(raw or "").strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _normalize_keywords(value) -> list[str]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    keywords: list[str] = []
    for raw in value:
        keyword = str(raw or "").strip()
        key = keyword.lower()
        if not keyword or key in seen:
            continue
        seen.add(key)
        keywords.append(keyword)
    return keywords


def _company_name(_site: str, _posting_url: str) -> str:
    """Return the explicit unknown state for callers lacking canonical company data.

    The arguments remain only for the v7 migration serializer's existing helper
    call.  Source boards and locator URLs are not employer evidence.
    """

    return _UNKNOWN_EMPLOYER


def _derive_apply_status(ar_status: str | None, legacy_status: str | None) -> str | None:
    if ar_status:
        if ar_status == "succeeded":
            return "applied"
        if ar_status in {"starting", "in_progress"}:
            return "in_progress"
        if ar_status == "dry_run_complete":
            return "dry_run"
        return ar_status
    return legacy_status


__all__ = [
    "PROJECTION_NAME",
    "ProjectionBuilder",
    "STAGE_ORDER",
]
