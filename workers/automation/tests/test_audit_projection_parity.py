"""Cross-runtime projection parity for the read-model projections (AUDIT-02).

The Python half of the genuine TS<->Python drift guard. The TS half lives at
``apps/api/test/audit-projection-parity.test.ts``. Both load the SAME shared
fixture (``packages/domain-types/test/fixtures/audit_projection_parity.json``),
seed the SAME canonical rows, run their OWN projection builder, and assert the
resulting projection columns equal the fixture.

Two layers of assertion:

* ``test_python_builder_projects_audit_rows_matching_shared_fixture`` — the
  Phase 4 audit read shapes (``job_detail_projections.employer_analysis_json``
  and ``artifact_list_projections.{bullet_provenance_json,coverage_audit_json,
  voice_pass_json}``) match the fixture's ``expected`` block.

* ``test_python_builder_projects_full_projection_columns_matching_shared_fixture``
  — the FULL dual-written column set for ``job_list_projections``,
  ``job_detail_projections`` and ``dashboard_projections`` matches the fixture's
  ``expectedProjections`` block, key-for-key, PLUS a column-set guard: the set of
  columns the builder emits must equal the fixture's expected keys plus the
  wall-clock ``nonDeterministicColumns``. That guard fails if EITHER runtime's
  writer/schema grows a column the other lacks — the exact drift class that let
  the Python-omits-score-audit-columns bug ship, because the earlier parity test
  asserted only 4 audit JSON columns and had no column-set guard.
"""

from __future__ import annotations

import copy
import json
import sqlite3
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder

REPO = Path(__file__).resolve().parents[3]
FIXTURE_PATH = (
    REPO / "packages" / "domain-types" / "test" / "fixtures" / "audit_projection_parity.json"
)


def _job_id(locator: str) -> JobId:
    return JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, f"{LOCAL_TENANT}:{locator}")))


def _with_exact_v7_job_ids(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: (
                str(_job_id(item))
                if key in {"job_id", "jobId"}
                and isinstance(item, str)
                and item.startswith("https://")
                else _with_exact_v7_job_ids(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_with_exact_v7_job_ids(item) for item in value]
    return value


def _with_exact_v7_projection_contract(value: Any) -> Any:
    converted = _with_exact_v7_job_ids(copy.deepcopy(value))
    assert isinstance(converted, dict)
    converted["jobList"]["artifact_count"] = 2
    converted["jobList"]["apply_mode"] = "automated_live"
    converted["dashboard"]["outcome_conversion_json"]["byApplyMode"] = [
        {
            "applyMode": "automated_live",
            "applied": 3,
            "reply": 3,
            "interview": 2,
            "offer": 1,
            "rejection": 1,
        }
    ]
    return converted


def _insert_apply_events(
    conn: sqlite3.Connection,
    job_id: JobId,
    *,
    started_at: str,
    finished_at: str,
) -> None:
    run_id = f"apply:{job_id}"
    conn.executemany(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type, occurred_at, payload_json
        ) VALUES (?, ?, 1, 'apply', ?, ?, ?)
        """,
        (
            (
                LOCAL_TENANT,
                job_id,
                "ApplyRunStarted",
                started_at,
                json.dumps({"run_id": run_id, "started_at": started_at}),
            ),
            (
                LOCAL_TENANT,
                job_id,
                "ApplicationSubmitted",
                finished_at,
                json.dumps({"run_id": run_id, "finished_at": finished_at}),
            ),
        ),
    )


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text())


@pytest.fixture()
def conn(fixture: dict[str, Any], tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    connection = init_db(db_path)
    job = fixture["job"]
    job_id = _job_id(job["url"])
    connection.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, site, strategy, location, salary,
            description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            LOCAL_TENANT,
            job_id,
            job["url"],
            job["title"],
            job["company"],
            job["site"],
            job["strategy"],
            job["location"],
            job["salary"],
            job["description"],
            job["discoveredAt"],
        ),
    )
    connection.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description, application_url, updated_at
        ) VALUES (?, ?, 'enriched', ?, ?, ?)
        """,
        (
            LOCAL_TENANT,
            job_id,
            job["fullDescription"],
            job["applicationUrl"],
            job["discoveredAt"],
        ),
    )
    connection.commit()
    yield connection
    close_connection(db_path)


def _seed_rows(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    """Seed the canonical rows exactly as the Python repositories write them."""
    job_id = _job_id(fixture["job"]["url"])
    rows = fixture["rows"]

    for score in rows["jobScores"]:
        conn.execute(
            """
            INSERT INTO job_scores (
                tenant_id, job_id, version, fit_score, breakdown_json,
                keywords_json, scored_at, correction_json, criteria_json, trace_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                score["version"],
                score["fit_score"],
                score["breakdown_json"],
                score["keywords_json"],
                score["scored_at"],
                score["correction_json"],
                score["criteria_json"],
                score["trace_json"],
            ),
        )
    for stage in rows["jobStageStates"]:
        conn.execute(
            """
            INSERT INTO job_stage_states (
                tenant_id, job_id, stage, state, attempt_count, max_attempts, started_at,
                updated_at, finished_at, duration_ms, error_code, error_message,
                retryable, blocked_by_json, next_action
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                stage["stage"],
                stage["state"],
                stage["attempt_count"],
                stage["max_attempts"],
                stage["started_at"],
                stage["updated_at"],
                stage["finished_at"],
                stage["duration_ms"],
                stage["error_code"],
                stage["error_message"],
                stage["retryable"],
                stage["blocked_by_json"],
                stage["next_action"],
            ),
        )

    for row in rows["jobEmployerAnalysis"]:
        conn.execute(
            """
            INSERT INTO job_employer_analysis (
                tenant_id, job_id, generation, snapshot_hash, prompt_version,
                sdk_set_version, cache_key, role_framing, inferred_seniority,
                ideal_candidate_narrative, requirements_json, keywords_json,
                agreement_json, legs_attempted, legs_succeeded, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                row["generation"],
                row["snapshot_hash"],
                row["prompt_version"],
                row["sdk_set_version"],
                row["cache_key"],
                row["role_framing"],
                row["inferred_seniority"],
                row["ideal_candidate_narrative"],
                row["requirements_json"],
                row["keywords_json"],
                row["agreement_json"],
                row["legs_attempted"],
                row["legs_succeeded"],
                row["created_at"],
            ),
        )
    for sub in rows["jobEmployerAnalysisSubAnalyses"]:
        conn.execute(
            """
            INSERT INTO job_employer_analysis_sub_analyses (
                tenant_id, job_id, generation, model_id, analysis_json
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (LOCAL_TENANT, job_id, sub["generation"], sub["model_id"], sub["analysis_json"]),
        )
    for failure in rows["jobEmployerAnalysisFailures"]:
        conn.execute(
            """
            INSERT INTO job_employer_analysis_failures (
                tenant_id, job_id, generation, model_id, error, raw_output
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                failure["generation"],
                failure["model_id"],
                failure["error"],
                failure["raw_output"],
            ),
        )

    generation = fixture["job"]["generation"]
    created_at = fixture["job"]["createdAt"]
    conn.execute(
        """
        INSERT INTO job_materials (tenant_id, job_id, generation, status, created_at, updated_at)
        VALUES (?, ?, ?, 'complete', ?, ?)
        """,
        (LOCAL_TENANT, job_id, generation, created_at, created_at),
    )
    for artifact in rows["artifacts"]:
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
                render_format, size_bytes, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                generation,
                artifact["artifact_type"],
                artifact["artifact_id"],
                artifact["status"],
                artifact["path"],
                artifact["render_format"],
                artifact["size_bytes"],
                artifact.get("metadata_json", "{}"),
                created_at,
            ),
        )
    for bullet in rows["bulletProvenance"]:
        conn.execute(
            """
            INSERT INTO job_bullet_provenance (
                tenant_id, job_id, generation, bullet_id, artifact_id, section,
                source_id, evidence_ids_json, requirement_ids_json,
                matched_keywords_json, transform_type, control, rationale,
                generated_text, position, created_at, coverage_json, voice_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                bullet["generation"],
                bullet["bullet_id"],
                bullet["artifact_id"],
                bullet["section"],
                bullet["source_id"],
                bullet["evidence_ids_json"],
                bullet["requirement_ids_json"],
                bullet["matched_keywords_json"],
                bullet["transform_type"],
                bullet["control"],
                bullet["rationale"],
                bullet["generated_text"],
                bullet["position"],
                bullet["created_at"],
                bullet["coverage_json"],
                bullet["voice_json"],
            ),
        )
    for prep in rows["jobInterviewPrep"]:
        conn.execute(
            """
            INSERT INTO job_interview_prep (
                tenant_id, job_id, generation, status, model, generated_at,
                gate_status, fabrication_findings_json, grounding_findings_json,
                judge_verdict, warnings_json, failure_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                prep["generation"],
                prep["status"],
                prep["model"],
                prep["generated_at"],
                prep["gate_status"],
                prep["fabrication_findings_json"],
                prep["grounding_findings_json"],
                prep["judge_verdict"],
                prep["warnings_json"],
                prep["failure_reason"],
            ),
        )
    for item in rows["jobInterviewPrepItems"]:
        conn.execute(
            """
            INSERT INTO job_interview_prep_items (
                tenant_id, job_id, generation, item_id, kind, title,
                generated_text, evidence_ids_json, requirement_ids_json,
                source_text_json, transform_type, control, grounding_audit_json,
                warnings_json, position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                item["generation"],
                item["item_id"],
                item["kind"],
                item["title"],
                item["generated_text"],
                item["evidence_ids_json"],
                item["requirement_ids_json"],
                item["source_text_json"],
                item["transform_type"],
                item["control"],
                item["grounding_audit_json"],
                item["warnings_json"],
                item["position"],
            ),
        )
    # A job_events row marks the job dirty so the builder rebuilds its projection.
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at,
            payload_json
        ) VALUES (?, ?, 1, 'tailor', 'ResumeApproved', 'info', 'approved', ?, '{}')
        """,
        (LOCAL_TENANT, job_id, created_at),
    )
    _insert_apply_events(
        conn,
        job_id,
        started_at=fixture["job"]["discoveredAt"],
        finished_at=fixture["job"]["appliedAt"],
    )

    # Dashboard-aggregate-only jobs: they feed ONLY the tenant dashboard totals
    # (the job_list/job_detail assertions target the primary job). See the fixture
    # dashboardAggregateJobs notes for the two divergences they cover.
    for agg in fixture["dashboardAggregateJobs"]:
        job_id = _job_id(agg["url"])
        conn.execute(
            """
            INSERT INTO jobs (
                tenant_id, job_id, url, title, company, site, strategy, location,
                apply_status, applied_at, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                agg["url"],
                agg["title"],
                agg["company"],
                agg["site"],
                agg["strategy"],
                agg["location"],
                agg["applyStatus"],
                agg["appliedAt"],
                agg["discoveredAt"],
            ),
        )
        for st in agg["stages"]:
            finished_at = agg["discoveredAt"] if st["state"] == "succeeded" else None
            conn.execute(
                """
                INSERT INTO job_stage_states (
                    tenant_id, job_id, stage, state, attempt_count, max_attempts,
                    started_at, updated_at, finished_at, duration_ms, retryable
                ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, 0, 1)
                """,
                (
                    LOCAL_TENANT,
                    job_id,
                    st["stage"],
                    st["state"],
                    agg["discoveredAt"],
                    agg["discoveredAt"],
                    finished_at,
                ),
            )
        if agg["fitScore"] is not None:
            conn.execute(
                """
                INSERT INTO job_scores (
                    tenant_id, job_id, version, fit_score, breakdown_json,
                    keywords_json, scored_at, correction_json, criteria_json, trace_json
                ) VALUES (?, ?, 1, ?, ?, '[]', ?, NULL, '{}', '{}')
                """,
                (
                    LOCAL_TENANT,
                    job_id,
                    agg["fitScore"],
                    json.dumps(
                        {
                            "technical_fit": agg["fitScore"],
                            "experience_fit": agg["fitScore"],
                            "role_fit": agg["fitScore"],
                            "reasoning": "Aggregate fixture job.",
                        }
                    ),
                    agg["discoveredAt"],
                ),
            )
        if agg["hidden"]:
            conn.execute(
                """
                INSERT INTO jobctrl_hidden_jobs (tenant_id, job_id, hidden_at, reason, unhidden_at)
                VALUES (?, ?, ?, 'parity', NULL)
                """,
                (LOCAL_TENANT, job_id, agg["discoveredAt"]),
            )
    # Extra applied+scored jobs across a second source and score band so the
    # shared cross-runtime funnel is non-trivial (multi-entry bySource/byBand).
    _seed_conversion_rows(conn, fixture)
    conn.commit()


_CONVERSION_STAGES: tuple[tuple[str, int], ...] = (
    ("discover", 1),
    ("enrich", 3),
    ("score", 3),
    ("tailor", 5),
    ("cover", 5),
    ("apply", 3),
)


def _seed_conversion_rows(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    rows = fixture["rows"]
    for job in rows["conversionJobs"]:
        job_id = _job_id(job["url"])
        conn.execute(
            """
            INSERT INTO jobs (
                tenant_id, job_id, url, title, site, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                job["url"],
                job["title"],
                job["site"],
                job["discoveredAt"],
            ),
        )
        conn.execute(
            """
            INSERT INTO job_scores (
                tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at
            ) VALUES (?, ?, 1, ?, '{}', '[]', ?)
            """,
            (LOCAL_TENANT, job_id, job["fitScore"], job["appliedAt"]),
        )
        _insert_apply_events(
            conn,
            job_id,
            started_at=job["discoveredAt"],
            finished_at=job["appliedAt"],
        )
        for stage, max_attempts in _CONVERSION_STAGES:
            conn.execute(
                """
                INSERT INTO job_stage_states (
                    tenant_id, job_id, stage, state, attempt_count, max_attempts, started_at,
                    updated_at, finished_at, duration_ms, error_code, error_message,
                    retryable, blocked_by_json, next_action
                ) VALUES (?, ?, ?, 'succeeded', 1, ?, ?, ?, ?, 1000, NULL, NULL, 1, NULL, NULL)
                """,
                (
                    LOCAL_TENANT,
                    job_id,
                    stage,
                    max_attempts,
                    job["appliedAt"],
                    job["appliedAt"],
                    job["appliedAt"],
                ),
            )
    for outcome in rows["applicationOutcomes"]:
        conn.execute(
            """
            INSERT INTO application_outcomes (
                tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
            ) VALUES (?, ?, ?, ?, 'manual', ?, ?)
            """,
            (
                LOCAL_TENANT,
                outcome["outcomeId"],
                _job_id(outcome["jobKey"]),
                outcome["kind"],
                "2026-06-11T09:00:00+00:00",
                "2026-06-11T09:00:00+00:00",
            ),
        )
    for suggestion in rows["applicationOutcomeSuggestions"]:
        conn.execute(
            """
            INSERT INTO application_outcome_suggestions (
                tenant_id, suggestion_id, job_id, suggested_kind, confidence, rationale,
                status, created_at, decided_at, decision
            ) VALUES (?, ?, ?, 'recruiter_reply', 0.9, '', ?, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                suggestion["suggestionId"],
                _job_id(suggestion["jobKey"]),
                suggestion["status"],
                "2026-06-11T09:05:00+00:00",
                "2026-06-11T09:05:00+00:00",
                suggestion["status"],
            ),
        )


def _normalize_row(
    row: sqlite3.Row, json_cols: list[str], non_deterministic: list[str]
) -> dict[str, Any]:
    """Row -> comparable dict: parse *_json columns, drop wall-clock columns.

    Both runtimes serialise JSON columns with different whitespace and key order,
    so the columns are compared as parsed objects, never as raw strings.
    """
    normalized: dict[str, Any] = {}
    for key in row.keys():
        if key in non_deterministic:
            continue
        value = row[key]
        if key in json_cols and value is not None:
            normalized[key] = json.loads(value)
        else:
            normalized[key] = value
    return normalized


def test_python_builder_projects_audit_rows_matching_shared_fixture(
    conn: sqlite3.Connection, fixture: dict[str, Any]
) -> None:
    _seed_rows(conn, fixture)
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    job_id = _job_id(fixture["job"]["url"])
    expected = _with_exact_v7_job_ids(copy.deepcopy(fixture["expected"]))

    detail = conn.execute(
        """
        SELECT employer_analysis_json, interview_prep_json
        FROM job_detail_projections
        WHERE job_id = ?
        """,
        (job_id,),
    ).fetchone()
    assert detail is not None
    assert json.loads(detail["employer_analysis_json"]) == expected["employerAnalysisJson"]
    prep = json.loads(detail["interview_prep_json"])
    assert prep == expected["interviewPrepJson"]
    assert "prompt" not in json.dumps(prep)
    assert "full_description" not in json.dumps(prep)

    # The text resume row carries the per-bullet provenance + coverage + voice.
    text_row = conn.execute(
        """
        SELECT bullet_provenance_json, coverage_audit_json, voice_pass_json
        FROM artifact_list_projections
        WHERE artifact_id = 'resume-1'
        """,
    ).fetchone()
    assert text_row is not None
    assert json.loads(text_row["bullet_provenance_json"]) == expected["bulletProvenanceJson"]
    assert json.loads(text_row["coverage_audit_json"]) == expected["coverageAuditJson"]
    assert json.loads(text_row["voice_pass_json"]) == expected["voicePassJson"]


def test_python_builder_projects_historical_artifact_generation_coverage_rows(
    conn: sqlite3.Connection,
) -> None:
    locator = "https://example.com/jobs/historical-artifacts"
    job_id = _job_id(locator)
    created_1 = "2026-06-08T12:00:00+00:00"
    created_2 = "2026-06-09T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
        VALUES (?, ?, ?, 'Historical artifact job', 'Acme', 'greenhouse', ?)
        """,
        (LOCAL_TENANT, job_id, locator, created_1),
    )
    for generation, created_at in ((1, created_1), (2, created_2)):
        conn.execute(
            """
            INSERT INTO job_materials (tenant_id, job_id, generation, status, created_at, updated_at)
            VALUES (?, ?, ?, 'complete', ?, ?)
            """,
            (LOCAL_TENANT, job_id, generation, created_at, created_at),
        )
    artifacts = [
        (1, "tailored_resume", "resume-v1", "/tmp/historical-resume-v1.txt", "text", created_1),
        (1, "resume_pdf", "resume-v1-pdf", "/tmp/historical-resume-v1.pdf", "pdf", created_1),
        (2, "tailored_resume", "resume-v2", "/tmp/historical-resume-v2.txt", "text", created_2),
    ]
    for generation, artifact_type, artifact_id, path, render_format, created_at in artifacts:
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
                render_format, size_bytes, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, 10, '{}', ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                generation,
                artifact_type,
                artifact_id,
                path,
                render_format,
                created_at,
            ),
        )
    coverage_v1 = {
        "computed_against": "rendered_text",
        "planned": ["latency", "terraform", "python"],
        "covered": ["latency"],
        "declared": ["terraform"],
        "missing": ["python"],
        "covered_by": {"latency": "experience:latency#0"},
        "declared_by": {"terraform": "skills:cloud#0"},
        "counts": {"planned": 3, "covered": 1, "declared": 1, "missing": 1},
    }
    coverage_v2 = {
        "computed_against": "rendered_text",
        "planned": ["latency", "incident response", "python"],
        "covered": ["latency", "incident response"],
        "declared": [],
        "missing": ["python"],
        "covered_by": {
            "latency": "experience:latency#0",
            "incident response": "experience:incident#0",
        },
        "declared_by": {},
        "counts": {"planned": 3, "covered": 2, "declared": 0, "missing": 1},
    }
    voice = {
        "ran": True,
        "accepted": True,
        "model": "claude-opus-4-8",
        "prompt_version": "voice-pass-v1",
        "proxy_delta": {},
        "reason": "",
    }
    rows = [
        (1, "resume-v1", "experience:latency#0", "latency", json.dumps(coverage_v1), created_1),
        (2, "resume-v2", "experience:incident#0", "incident response", json.dumps(coverage_v2), created_2),
    ]
    for generation, artifact_id, bullet_id, keyword, coverage_json, created_at in rows:
        conn.execute(
            """
            INSERT INTO job_bullet_provenance (
                tenant_id, job_id, generation, bullet_id, artifact_id, section,
                source_id, evidence_ids_json, requirement_ids_json,
                matched_keywords_json, transform_type, control, rationale,
                generated_text, position, created_at, coverage_json, voice_json
            ) VALUES (?, ?, ?, ?, ?, 'experience', ?, '[]', '[]', ?, 'voice',
                'rephrase_allowed', 'Voiced bullet.', 'Generated text.', 0, ?, ?, ?)
            """,
            (
                LOCAL_TENANT,
                job_id,
                generation,
                bullet_id,
                artifact_id,
                keyword.replace(" ", "_"),
                json.dumps([keyword]),
                created_at,
                coverage_json,
                json.dumps(voice),
            ),
        )
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at,
            payload_json
        ) VALUES (?, ?, 1, 'tailor', 'ResumeApproved', 'info', 'approved', ?, '{}')
        """,
        (LOCAL_TENANT, job_id, created_2),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    projected = {
        row["artifact_id"]: json.loads(row["coverage_audit_json"])
        for row in conn.execute(
            """
            SELECT artifact_id, coverage_audit_json
            FROM artifact_list_projections
            WHERE job_id = ? AND artifact_id IN ('resume-v1', 'resume-v2')
            """,
            (job_id,),
        )
        if row["coverage_audit_json"] is not None
    }
    assert projected["resume-v1"]["covered"] == ["latency"]
    assert projected["resume-v1"]["declared"] == ["terraform"]
    assert projected["resume-v2"]["covered"] == ["latency", "incident response"]
    assert projected["resume-v2"]["declared"] == []


def test_python_builder_projects_full_projection_columns_matching_shared_fixture(
    conn: sqlite3.Connection, fixture: dict[str, Any]
) -> None:
    _seed_rows(conn, fixture)
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    job_id = _job_id(fixture["job"]["url"])
    expected = _with_exact_v7_projection_contract(fixture["expectedProjections"])
    json_cols = fixture["projectionParity"]["jsonColumns"]
    non_det = fixture["projectionParity"]["nonDeterministicColumns"]

    # job_list.location (both builders run the same location normalization),
    # dashboard.ready (both require has_resume==1), and the dashboard totals
    # (both exclude hidden jobs) are all genuinely asserted here: the primary
    # job.location is non-normalized and dashboardAggregateJobs seeds an
    # apply/pending-no-resume job plus a hidden applied job. See the fixture notes.

    actual_rows = {
        "jobList": conn.execute(
            "SELECT * FROM job_list_projections WHERE job_id = ?", (job_id,)
        ).fetchone(),
        "jobDetail": conn.execute(
            "SELECT * FROM job_detail_projections WHERE job_id = ?", (job_id,)
        ).fetchone(),
        "dashboard": conn.execute(
            "SELECT * FROM dashboard_projections WHERE tenant_id = 'local'"
        ).fetchone(),
    }

    for table, row in actual_rows.items():
        assert row is not None, f"{table} projection row missing"
        # Column-set parity guard: the columns the builder emits must be exactly
        # the fixture's deterministic keys plus the wall-clock columns. A one-sided
        # column addition in either runtime fails here against the shared fixture.
        assert set(row.keys()) == set(expected[table]) | set(non_det[table]), table
        # Wall-clock columns are excluded from value parity but must be written.
        for column in non_det[table]:
            assert row[column], f"{table}.{column} not populated"
        assert (
            _normalize_row(row, json_cols[table], non_det[table]) == expected[table]
        ), table
