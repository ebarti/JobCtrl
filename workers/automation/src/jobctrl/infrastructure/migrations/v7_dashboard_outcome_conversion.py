"""Fold privacy-safe v7 application outcomes into dashboard conversion counts."""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Mapping

from jobctrl.infrastructure.projections import projection_builder


class CandidateDashboardOutcomeConversionError(RuntimeError):
    """Raised when v7 outcome conversion cannot be derived safely."""


def build_dashboard_outcome_conversion(
    candidate: sqlite3.Connection,
    *,
    tenant_id: str,
    active_rows: list[Mapping[str, object]],
    root_job_ids: set[str],
) -> dict[str, object]:
    """Return version-2 raw conversion counts for one tenant.

    Only outcome identity, kind, and occurrence time plus decided suggestion
    status are selected. Notes, evidence, rationale, and decision text never
    enter this derived dashboard shape.
    """
    tenant = _required_text(tenant_id, "tenant_id")
    roots = {_required_uuid(job_id, "root job_id") for job_id in root_job_ids}
    outcomes = _outcomes(candidate, tenant, roots)
    suggestion_accuracy = _suggestion_accuracy(candidate, tenant)
    applied_rows = [row for row in active_rows if _is_applied(row)]
    totals = _blank_conversion_counts()
    by_source: dict[str, dict[str, int]] = {}
    by_band: dict[str, dict[str, int]] = {}
    by_fit_band: dict[str, dict[str, int]] = {}
    by_apply_mode: dict[str, dict[str, int]] = {}
    by_template: dict[str, dict[str, object]] = {}
    by_policy: dict[str, dict[str, int]] = {}
    response_minutes: list[int] = []

    for row in applied_rows:
        job_id = _required_uuid(row.get("job_id"), "job-list job_id")
        if job_id not in roots:
            raise CandidateDashboardOutcomeConversionError(
                "active dashboard row must reference a canonical v7 job"
            )
        job_outcomes = outcomes.get(job_id, ())
        source = _optional_text(row.get("source")) or "unknown"
        band = projection_builder._score_band(
            _optional_integer(row.get("fit_score"), "job-list fit_score")
        )
        fit_band = projection_builder._fit_band(
            _optional_text(row.get("fit_band"))
        )
        apply_mode = projection_builder._apply_mode(
            _optional_text(row.get("apply_mode"))
        )
        template_id = projection_builder._template_key(
            _optional_text(row.get("resume_template_id"))
        )
        template_name = (
            None
            if template_id == "unreported"
            else projection_builder._projection_text(
                row.get("resume_template_name")
            )
        )
        policy = projection_builder._policy_key(
            _optional_integer(
                row.get("tailoring_policy_version"),
                "job-list tailoring_policy_version",
            )
        )
        first_response = projection_builder._first_response_minutes(
            _optional_text(row.get("applied_at")),
            job_outcomes,
        )
        if first_response is not None:
            response_minutes.append(first_response)
        template_bucket = by_template.setdefault(
            template_id,
            {"templateName": template_name, "counts": _blank_conversion_counts()},
        )
        if not template_bucket["templateName"] and template_name:
            template_bucket["templateName"] = template_name
        buckets: tuple[dict[str, int], ...] = (
            totals,
            by_source.setdefault(source, _blank_conversion_counts()),
            by_band.setdefault(band, _blank_conversion_counts()),
            by_fit_band.setdefault(fit_band, _blank_conversion_counts()),
            by_apply_mode.setdefault(apply_mode, _blank_conversion_counts()),
            _conversion_bucket(template_bucket),
            by_policy.setdefault(policy, _blank_conversion_counts()),
        )
        for bucket in buckets:
            bucket["applied"] += 1
            if projection_builder._has_any_kind(
                job_outcomes, projection_builder._REPLY_OUTCOME_KINDS
            ):
                bucket["reply"] += 1
            if projection_builder._has_any_kind(
                job_outcomes, projection_builder._INTERVIEW_OUTCOME_KINDS
            ):
                bucket["interview"] += 1
            if projection_builder._has_any_kind(
                job_outcomes, projection_builder._OFFER_OUTCOME_KINDS
            ):
                bucket["offer"] += 1
            if projection_builder._has_any_kind(
                job_outcomes, projection_builder._REJECTION_OUTCOME_KINDS
            ):
                bucket["rejection"] += 1

    return {
        "version": 2,
        "totals": totals,
        "bySource": [
            {"source": source, **counts}
            for source, counts in sorted(
                by_source.items(), key=lambda item: (-item[1]["applied"], item[0])
            )
        ],
        "byBand": [
            {"band": band, **by_band[band]}
            for band in projection_builder.SCORE_BAND_ORDER
            if band in by_band
        ],
        "byFitBand": [
            {"fitBand": band, **by_fit_band[band]}
            for band in projection_builder.FIT_BAND_ORDER
            if band in by_fit_band
        ],
        "byApplyMode": [
            {"applyMode": mode, **by_apply_mode[mode]}
            for mode in projection_builder.APPLY_MODE_ORDER
            if mode in by_apply_mode
        ],
        "byTemplate": [
            {
                "templateId": template_id,
                "templateName": bucket["templateName"],
                **_conversion_bucket(bucket),
            }
            for template_id, bucket in sorted(
                by_template.items(),
                key=lambda item: (
                    -_conversion_bucket(item[1])["applied"],
                    str(item[1]["templateName"] or item[0]),
                    item[0],
                ),
            )
        ],
        "byPolicy": [
            {
                "tailoringPolicyVersion": projection_builder._policy_version_from_key(
                    key
                ),
                "policyLabel": projection_builder._policy_label(
                    projection_builder._policy_version_from_key(key)
                ),
                **counts,
            }
            for key, counts in sorted(
                by_policy.items(),
                key=lambda item: (
                    -item[1]["applied"],
                    projection_builder._policy_version_from_key(item[0])
                    if projection_builder._policy_version_from_key(item[0])
                    is not None
                    else 9_007_199_254_740_991,
                ),
            )
        ],
        "timeToResponseMinutes": sorted(response_minutes),
        "suggestionAccuracy": suggestion_accuracy,
    }


def _outcomes(
    candidate: sqlite3.Connection,
    tenant_id: str,
    root_job_ids: set[str],
) -> dict[str, tuple[dict[str, str], ...]]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for job_id, kind, occurred_at in candidate.execute(
        """
        SELECT job_id, kind, occurred_at
        FROM application_outcomes
        WHERE tenant_id = ?
        ORDER BY job_id, occurred_at, outcome_id
        """,
        (tenant_id,),
    ).fetchall():
        stable_job_id = _required_uuid(job_id, "outcome job_id")
        if stable_job_id not in root_job_ids:
            raise CandidateDashboardOutcomeConversionError(
                "application outcome must reference a canonical v7 job"
            )
        grouped.setdefault(stable_job_id, []).append(
            {
                "kind": _required_text(kind, "outcome kind"),
                "occurredAt": _required_text(occurred_at, "outcome occurred_at"),
            }
        )
    return {job_id: tuple(values) for job_id, values in grouped.items()}


def _suggestion_accuracy(
    candidate: sqlite3.Connection,
    tenant_id: str,
) -> dict[str, int]:
    counts = _blank_suggestion_accuracy()
    for (status,) in candidate.execute(
        """
        SELECT status
        FROM application_outcome_suggestions
        WHERE tenant_id = ?
          AND status IN ('accepted', 'corrected', 'ignored')
        ORDER BY suggestion_id
        """,
        (tenant_id,),
    ).fetchall():
        normalized = _required_text(status, "outcome suggestion status").lower()
        counts["decided"] += 1
        counts[normalized] += 1
    return counts


def _conversion_bucket(bucket: Mapping[str, object]) -> dict[str, int]:
    counts = bucket.get("counts")
    if not isinstance(counts, dict):
        raise CandidateDashboardOutcomeConversionError(
            "dashboard template conversion bucket is malformed"
        )
    return counts


def _is_applied(row: Mapping[str, object]) -> bool:
    return bool(_optional_text(row.get("applied_at"))) or _text(
        row.get("apply_status")
    ) == "applied"


def _blank_conversion_counts() -> dict[str, int]:
    return {"applied": 0, "reply": 0, "interview": 0, "offer": 0, "rejection": 0}


def _blank_suggestion_accuracy() -> dict[str, int]:
    return {"decided": 0, "accepted": 0, "corrected": 0, "ignored": 0}


def _required_uuid(value: object, label: str) -> str:
    text = _required_text(value, label)
    try:
        parsed = uuid.UUID(text)
    except (ValueError, AttributeError) as exc:
        raise CandidateDashboardOutcomeConversionError(
            f"{label} must be a canonical UUID"
        ) from exc
    if str(parsed) != text or parsed.version != 4:
        raise CandidateDashboardOutcomeConversionError(
            f"{label} must be a canonical UUIDv4"
        )
    return text


def _required_text(value: object, label: str) -> str:
    text = _text(value).strip()
    if not text:
        raise CandidateDashboardOutcomeConversionError(
            f"{label} must not be empty"
        )
    return text


def _optional_text(value: object) -> str | None:
    text = _text(value).strip()
    return text or None


def _text(value: object) -> str:
    return "" if value is None else str(value)


def _optional_integer(value: object, label: str) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise CandidateDashboardOutcomeConversionError(
            f"{label} must be an integer"
        )
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise CandidateDashboardOutcomeConversionError(
            f"{label} must be an integer"
        ) from exc
