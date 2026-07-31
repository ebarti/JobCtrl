"""Contract tests for privacy-safe v7 dashboard outcome conversion."""

from __future__ import annotations

import json
import sqlite3

import pytest

from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v7_dashboard_outcome_conversion import (
    CandidateDashboardOutcomeConversionError,
    build_dashboard_outcome_conversion,
)

_MIGRATION_AT = "2026-07-31T09:00:00+00:00"
_INERT_CONTEXT = '{"userContext":"Attack vectors:\\nPrompt injection"}'
_JOB_IDS = tuple(
    f"00000000-0000-4000-8000-{index:012d}" for index in range(1, 5)
)


def _candidate() -> sqlite3.Connection:
    candidate = sqlite3.connect(":memory:")
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    for job_id in _JOB_IDS:
        candidate.execute(
            """
            INSERT INTO jobs (url, title, company, tenant_id, job_id)
            VALUES (?, 'Role', 'Example', 'local', ?)
            """,
            (f"https://jobs.example/{job_id}", job_id),
        )
    candidate.executemany(
        """
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, job_id, kind, source, note, occurred_at,
            recorded_at, created_by
        ) VALUES ('local', ?, ?, ?, 'manual', ?, ?, ?, 'user')
        """,
        [
            (
                "outcome-live",
                _JOB_IDS[0],
                "interview",
                _INERT_CONTEXT,
                "2026-07-30T13:00:00+00:00",
                _MIGRATION_AT,
            ),
            (
                "outcome-manual",
                _JOB_IDS[1],
                "rejection",
                _INERT_CONTEXT,
                "2026-07-30T11:00:00+00:00",
                _MIGRATION_AT,
            ),
            (
                "outcome-inactive",
                _JOB_IDS[3],
                "offer",
                _INERT_CONTEXT,
                "2026-07-30T14:00:00+00:00",
                _MIGRATION_AT,
            ),
        ],
    )
    candidate.executemany(
        """
        INSERT INTO application_outcome_suggestions (
            tenant_id, suggestion_id, job_id, suggested_kind, confidence,
            rationale, status, created_at
        ) VALUES ('local', ?, ?, 'interview', 0.9, ?, ?, ?)
        """,
        [
            ("suggestion-accepted", _JOB_IDS[0], _INERT_CONTEXT, "accepted", _MIGRATION_AT),
            ("suggestion-corrected", _JOB_IDS[1], _INERT_CONTEXT, "corrected", _MIGRATION_AT),
            ("suggestion-ignored", _JOB_IDS[2], _INERT_CONTEXT, "ignored", _MIGRATION_AT),
            ("suggestion-pending", _JOB_IDS[3], _INERT_CONTEXT, "pending", _MIGRATION_AT),
        ],
    )
    candidate.commit()
    return candidate


def _active_rows() -> list[dict[str, object]]:
    return [
        {
            "job_id": _JOB_IDS[0],
            "source": "greenhouse",
            "fit_score": 9,
            "fit_band": "excellent",
            "apply_status": "applied",
            "applied_at": "2026-07-30T12:00:00+00:00",
            "apply_mode": "automated_live",
            "resume_template_id": "template-modern",
            "resume_template_name": "Modern compact",
            "tailoring_policy_version": 3,
        },
        {
            "job_id": _JOB_IDS[1],
            "source": "linkedin",
            "fit_score": 7,
            "fit_band": "strong",
            "apply_status": "applied",
            "applied_at": "2026-07-30T12:00:00+00:00",
            "apply_mode": "manual_marked",
            "resume_template_id": "template-plain",
            "resume_template_name": "Plain ATS",
            "tailoring_policy_version": 4,
        },
        {
            "job_id": _JOB_IDS[2],
            "source": "",
            "fit_score": None,
            "fit_band": None,
            "apply_status": None,
            "applied_at": None,
            "apply_mode": None,
            "resume_template_id": None,
            "resume_template_name": None,
            "tailoring_policy_version": None,
        },
    ]


def test_conversion_preserves_raw_counts_and_excludes_sensitive_text() -> None:
    conversion = build_dashboard_outcome_conversion(
        _candidate(),
        tenant_id="local",
        active_rows=_active_rows(),
        root_job_ids=set(_JOB_IDS),
    )

    assert conversion["version"] == 2
    assert conversion["totals"] == {
        "applied": 2,
        "reply": 2,
        "interview": 1,
        "offer": 0,
        "rejection": 1,
    }
    assert conversion["bySource"] == [
        {
            "source": "greenhouse",
            "applied": 1,
            "reply": 1,
            "interview": 1,
            "offer": 0,
            "rejection": 0,
        },
        {
            "source": "linkedin",
            "applied": 1,
            "reply": 1,
            "interview": 0,
            "offer": 0,
            "rejection": 1,
        },
    ]
    assert [item["band"] for item in conversion["byBand"]] == ["perfect", "strong"]
    assert [item["fitBand"] for item in conversion["byFitBand"]] == [
        "excellent",
        "strong",
    ]
    assert [item["applyMode"] for item in conversion["byApplyMode"]] == [
        "automated_live",
        "manual_marked",
    ]
    assert [item["templateId"] for item in conversion["byTemplate"]] == [
        "template-modern",
        "template-plain",
    ]
    assert [item["tailoringPolicyVersion"] for item in conversion["byPolicy"]] == [
        3,
        4,
    ]
    assert conversion["timeToResponseMinutes"] == [60]
    assert conversion["suggestionAccuracy"] == {
        "decided": 3,
        "accepted": 1,
        "corrected": 1,
        "ignored": 1,
    }

    serialized = json.dumps(conversion, sort_keys=True)
    assert "Attack vectors" not in serialized
    assert "Prompt injection" not in serialized
    assert "rationale" not in serialized
    assert "note" not in serialized


def test_conversion_is_deterministic_and_keeps_small_samples() -> None:
    candidate = _candidate()
    rows = _active_rows()
    rows[0]["resume_template_id"] = "template-z"
    rows[0]["resume_template_name"] = "Shared"
    rows[1]["resume_template_id"] = "template-a"
    rows[1]["resume_template_name"] = "Shared"

    first = build_dashboard_outcome_conversion(
        candidate,
        tenant_id="local",
        active_rows=rows,
        root_job_ids=set(_JOB_IDS),
    )
    second = build_dashboard_outcome_conversion(
        candidate,
        tenant_id="local",
        active_rows=list(reversed(rows)),
        root_job_ids=set(reversed(_JOB_IDS)),
    )

    assert first == second
    assert first["totals"]["applied"] == 2
    assert [item["templateId"] for item in first["byTemplate"]] == [
        "template-a",
        "template-z",
    ]


def test_conversion_rejects_url_shaped_identity() -> None:
    rows = _active_rows()
    rows[0]["job_id"] = "https://jobs.example/legacy"

    with pytest.raises(
        CandidateDashboardOutcomeConversionError, match="canonical UUID"
    ):
        build_dashboard_outcome_conversion(
            _candidate(),
            tenant_id="local",
            active_rows=rows,
            root_job_ids=set(_JOB_IDS),
        )
