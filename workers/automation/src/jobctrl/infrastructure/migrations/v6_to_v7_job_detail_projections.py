"""Rebuild v7 job-detail projections from copied canonical candidate rows."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.interview.value_objects import InterviewPrep
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    AnalysisFailure,
    EmployerAnalysis,
    JobAnalysis,
    JobAnalysisDraft,
)
from jobctrl.domain.materials.analysis_eeo_screen import EeoScreenHit
from jobctrl.domain.scoring.value_objects import RequirementFitReport
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    CandidateCopyError,
    JobIdMap,
    build_job_id_map,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)
from jobctrl.infrastructure.projections import projection_builder

_TABLE = "job_detail_projections"
_COLUMNS = (
    "tenant_id",
    "job_id",
    "description_preview",
    "compensation_summary_json",
    "compensation_audit_json",
    "score_breakdown_json",
    "score_keywords_json",
    "score_reasoning",
    "score_version",
    "scored_at",
    "score_criteria_json",
    "score_trace_json",
    "score_correction_json",
    "stages_json",
    "employer_analysis_json",
    "requirement_fit_report_json",
    "interview_prep_json",
    "last_updated_at",
)
_STAGE_ORDER = ("discover", "enrich", "score", "tailor", "cover", "apply")
_DEFAULT_MAX_ATTEMPTS = {
    "discover": 1,
    "enrich": 3,
    "score": 3,
    "tailor": 5,
    "cover": 5,
    "apply": 3,
}
_POSTED_COMPENSATION_COLUMNS = (
    "tenant_id",
    "source_field",
    "source_text",
    "legacy_raw_salary",
    "parse_state",
    "currency",
    "period",
    "component",
    "minimum_amount",
    "maximum_amount",
    "annualized_minimum_amount",
    "annualized_maximum_amount",
    "annualization_assumption",
    "confidence",
    "warnings_json",
    "parser_version",
    "source_hash",
    "parsed_at",
)
_MARKET_COMPENSATION_COLUMNS = (
    "tenant_id",
    "estimate_state",
    "currency",
    "period",
    "component",
    "minimum_amount",
    "maximum_amount",
    "confidence_interval_minimum_amount",
    "confidence_interval_maximum_amount",
    "confidence_band",
    "confidence_score",
    "source_count",
    "sample_count",
    "aggregate_bucket",
    "geography_scope",
    "occupation_code",
    "occupation_label",
    "seniority_label",
    "source_snapshot_json",
    "factor_reasons_json",
    "selected_evidence_json",
    "insufficient_reasons_json",
    "unsupported_reasons_json",
    "source_unavailable_reasons_json",
    "warnings_json",
    "estimator_version",
    "estimated_at",
    "company_name",
    "normalized_company",
    "role_title",
    "normalized_role",
    "company_tier",
    "match_scope",
)


class CandidateJobDetailProjectionsError(RuntimeError):
    """Raised when v7 detail projections cannot be rebuilt safely."""


@dataclass(frozen=True)
class CandidateJobDetailProjectionsResult:
    """Verified candidate job-detail projection rebuild result."""

    rebuilt_job_detail_projections: int


def rebuild_job_detail_projections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
    migration_at: str,
) -> CandidateJobDetailProjectionsResult:
    """Rebuild v7 detail rows from canonical candidate state only.

    The v6 ``job_detail_projections`` table is a URL-keyed cache and is never
    read. ``migration_at`` is explicit so a retry produces an auditable,
    deterministic projection timestamp.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_columns(candidate)
    _assert_authoritative_roots(source, candidate, job_ids)
    _assert_empty_target(candidate)
    migration_at = _required_text(migration_at, "migration_at")

    canonical_snapshot = _canonical_snapshot(candidate)
    rows = _projection_rows(candidate, migration_at=migration_at)

    candidate.execute("SAVEPOINT v6_job_detail_projection_rebuild")
    try:
        _insert_rows(candidate, rows)
        _verify_candidate(
            candidate=candidate,
            expected_rows=rows,
            canonical_snapshot=canonical_snapshot,
        )
        candidate.execute("RELEASE SAVEPOINT v6_job_detail_projection_rebuild")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_job_detail_projection_rebuild")
        candidate.execute("RELEASE SAVEPOINT v6_job_detail_projection_rebuild")
        raise

    return CandidateJobDetailProjectionsResult(
        rebuilt_job_detail_projections=len(rows)
    )


def _assert_columns(candidate: sqlite3.Connection) -> None:
    columns = tuple(
        str(row[1]) for row in candidate.execute(f"PRAGMA table_info({_quote(_TABLE)})")
    )
    if columns != _COLUMNS:
        raise CandidateJobDetailProjectionsError(
            "job_detail_projections columns do not match the exact v7 schema"
        )


def _assert_authoritative_roots(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        hydrated = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateJobDetailProjectionsError(
            "job-detail projection rebuild requires hydrated candidate roots"
        ) from error
    if dict(hydrated.by_locator) != dict(job_ids.by_locator):
        raise CandidateJobDetailProjectionsError(
            "supplied JobIdMap does not match hydrated candidate roots"
        )

    locators = {
        (str(tenant_id), str(locator)): str(job_id)
        for tenant_id, locator, job_id in candidate.execute(
            """
            SELECT tenant_id, locator_value, job_id
            FROM job_locators
            WHERE locator_kind = 'posting_url'
              AND is_current = 1
              AND retired_at IS NULL
            """
        ).fetchall()
    }
    if locators != dict(job_ids.by_locator) or _row_count(candidate, "job_locators") != len(locators):
        raise CandidateJobDetailProjectionsError(
            "job-detail projection rebuild requires exactly one current root locator per JobId"
        )


def _assert_empty_target(candidate: sqlite3.Connection) -> None:
    if _row_count(candidate, _TABLE):
        raise CandidateJobDetailProjectionsError(
            "candidate job_detail_projections must be empty"
        )


def _projection_rows(
    candidate: sqlite3.Connection,
    *,
    migration_at: str,
) -> tuple[tuple[object, ...], ...]:
    rows: list[tuple[object, ...]] = []
    for tenant_id, job_id, description, full_description, salary in candidate.execute(
        """
        SELECT tenant_id, job_id, description, full_description, salary
        FROM jobs
        ORDER BY tenant_id, job_id
        """
    ).fetchall():
        tenant = _required_text(tenant_id, "candidate jobs.tenant_id")
        stable_job_id = _required_text(job_id, "candidate jobs.job_id")
        description_preview = _description_preview(
            candidate, tenant, stable_job_id, full_description, description
        )
        score = _score_projection(candidate, tenant, stable_job_id)
        summary, audit = _compensation_projection(
            candidate, tenant, stable_job_id, salary
        )
        rows.append(
            (
                tenant,
                stable_job_id,
                description_preview,
                summary,
                audit,
                score["breakdown_json"],
                score["keywords_json"],
                score["reasoning"],
                score["version"],
                score["scored_at"],
                score["criteria_json"],
                score["trace_json"],
                score["correction_json"],
                _json(_stages(candidate, tenant, stable_job_id)),
                _employer_analysis(candidate, tenant, stable_job_id),
                _requirement_fit(candidate, tenant, stable_job_id),
                _interview_prep(candidate, tenant, stable_job_id),
                migration_at,
            )
        )
    return tuple(rows)


def _description_preview(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    full_description: object,
    description: object,
) -> str:
    enrichment = candidate.execute(
        """
        SELECT full_description FROM job_enrichments
        WHERE tenant_id = ? AND job_id = ?
        """,
        (tenant_id, job_id),
    ).fetchone()
    text = enrichment[0] if enrichment is not None and enrichment[0] else full_description
    text = text or description or ""
    return str(text)[:6000]


def _score_projection(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
) -> dict[str, object]:
    row = candidate.execute(
        """
        SELECT version, fit_score, scored_at, breakdown_json, keywords_json,
               criteria_json, trace_json, correction_json
        FROM job_scores
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY version DESC
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return {
            "version": None,
            "fit_score": None,
            "scored_at": None,
            "breakdown_json": None,
            "keywords_json": "[]",
            "reasoning": "",
            "criteria_json": None,
            "trace_json": None,
            "correction_json": None,
        }
    breakdown = _json_value(row[3], default={})
    legacy = isinstance(breakdown, dict) and breakdown.get("legacy") is True
    reasoning = breakdown.get("reasoning", "") if isinstance(breakdown, dict) else ""
    keywords = _json_value(row[4], default=[])
    return {
        "version": row[0],
        "fit_score": row[1],
        "scored_at": row[2],
        "breakdown_json": (
            None
            if legacy
            else _json(projection_builder._camel_score_breakdown(breakdown))
        ),
        "keywords_json": _json([] if legacy and keywords == ["legacy"] else keywords),
        "reasoning": reasoning if isinstance(reasoning, str) else "",
        # Criteria, trace, and correction are opaque generation-time audit data.
        "criteria_json": row[5],
        "trace_json": row[6],
        "correction_json": row[7],
    }


def _stages(candidate: sqlite3.Connection, tenant_id: str, job_id: str) -> list[dict[str, object]]:
    explicit = {
        str(row[0]): row
        for row in candidate.execute(
            """
            SELECT stage, state, attempt_count, max_attempts, started_at, updated_at,
                   finished_at, duration_ms, error_code, error_message, retryable,
                   blocked_by_json, next_action
            FROM job_stage_states
            WHERE tenant_id = ? AND job_id = ?
            """,
            (tenant_id, job_id),
        ).fetchall()
    }
    result: list[dict[str, object]] = []
    for stage in _STAGE_ORDER:
        row = explicit.get(stage)
        if row is None:
            result.append(
                {
                    "stage": stage,
                    "state": "pending",
                    "attempt_count": 0,
                    "max_attempts": _DEFAULT_MAX_ATTEMPTS[stage],
                    "started_at": None,
                    "updated_at": None,
                    "finished_at": None,
                    "duration_ms": None,
                    "error_code": None,
                    "error_message": None,
                    "retryable": True,
                    "blocked_by": [],
                    "next_action": None,
                }
            )
            continue
        blocked = _json_value(row[11], default=[])
        result.append(
            {
                "stage": stage,
                "state": str(row[1] or "pending"),
                "attempt_count": int(row[2] or 0),
                "max_attempts": int(row[3]) if row[3] is not None else _DEFAULT_MAX_ATTEMPTS[stage],
                "started_at": row[4],
                "updated_at": row[5],
                "finished_at": row[6],
                "duration_ms": row[7],
                "error_code": row[8],
                "error_message": row[9],
                "retryable": row[10] != 0,
                "blocked_by": [str(value) for value in blocked] if isinstance(blocked, list) else [],
                "next_action": row[12],
            }
        )
    return result


def _employer_analysis(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
) -> str | None:
    row = candidate.execute(
        """
        SELECT generation, snapshot_hash, prompt_version, sdk_set_version,
               role_framing, inferred_seniority, ideal_candidate_narrative,
               requirements_json, keywords_json, agreement_json, eeo_screen_json,
               legs_attempted, created_at
        FROM job_employer_analysis
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY generation DESC
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return None
    generation = int(row[0])
    canonical = JobAnalysis.model_validate(
        {
            "role_framing": row[4],
            "inferred_seniority": row[5],
            "ideal_candidate_narrative": row[6],
            "requirements": _json_value(row[7], default=[]),
            "keywords": _json_value(row[8], default=[]),
        }
    )
    sub_analyses = tuple(
        JobAnalysisDraft.model_validate({"model_id": model_id, **_json_object(analysis_json)})
        for model_id, analysis_json in candidate.execute(
            """
            SELECT model_id, analysis_json
            FROM job_employer_analysis_sub_analyses
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            ORDER BY model_id
            """,
            (tenant_id, job_id, generation),
        ).fetchall()
    )
    failures = tuple(
        AnalysisFailure(model_id=str(model_id), error=str(error), raw_output=raw_output)
        for model_id, error, raw_output in candidate.execute(
            """
            SELECT model_id, error, raw_output
            FROM job_employer_analysis_failures
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            ORDER BY model_id
            """,
            (tenant_id, job_id, generation),
        ).fetchall()
    )
    analysis = EmployerAnalysis.build(
        tenant_id=TenantId(tenant_id),
        job_id=JobId(job_id),
        generation=generation,
        snapshot_hash=str(row[1]),
        prompt_version=str(row[2]),
        sdk_set_version=str(row[3]),
        canonical=canonical,
        sub_analyses=sub_analyses,
        failures=failures,
        agreement=AnalysisAgreement.from_dict(_json_object(row[9])),
        legs_attempted=int(row[11]),
        eeo_screen_hits=tuple(
            EeoScreenHit.from_dict(value)
            for value in _json_value(row[10], default=[])
            if isinstance(value, dict)
        ),
        created_at=str(row[12]),
    )
    return _json(analysis.to_read_model())


def _requirement_fit(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
) -> str | None:
    row = candidate.execute(
        """
        SELECT score_version, employer_analysis_generation, profile_snapshot_version,
               scoring_policy_version, formula_version, resolved_fit_score,
               fit_band, confidence, summary_json
        FROM job_requirement_fit_reports
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY score_version DESC
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return None
    score_version = int(row[0])
    assessments = [
        {
            "requirementId": requirement_id,
            "requirementText": requirement_text,
            "tier": tier,
            "weight": weight,
            "jobEvidenceSpan": job_evidence_span,
            "fit": _json_object(fit_json),
            "contribution": _json_object(contribution_json),
            "tailoring": _json_object(tailoring_json),
            "artifactCoverage": _json_value(artifact_coverage_json, default=None),
        }
        for (
            requirement_id,
            requirement_text,
            tier,
            weight,
            job_evidence_span,
            fit_json,
            contribution_json,
            tailoring_json,
            artifact_coverage_json,
        ) in candidate.execute(
            """
            SELECT requirement_id, requirement_text, tier, weight, job_evidence_span,
                   fit_json, contribution_json, tailoring_json, artifact_coverage_json
            FROM job_requirement_fit_items
            WHERE tenant_id = ? AND job_id = ? AND score_version = ?
            ORDER BY position, requirement_id
            """,
            (tenant_id, job_id, score_version),
        ).fetchall()
    ]
    report = RequirementFitReport.from_dict(
        {
            "jobId": job_id,
            "scoreVersion": score_version,
            "employerAnalysisGeneration": row[1],
            "profileSnapshotVersion": row[2],
            "scoringPolicyVersion": row[3],
            "formulaVersion": row[4],
            "resolvedFitScore": row[5],
            "fitBand": row[6],
            "confidence": row[7],
            "summary": _json_object(row[8]),
            "assessments": assessments,
        }
    )
    return _json(report.to_read_model())


def _interview_prep(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
) -> str | None:
    row = candidate.execute(
        """
        SELECT generation, status, model, generated_at, gate_status,
               fabrication_findings_json, grounding_findings_json, judge_verdict,
               warnings_json
        FROM job_interview_prep
        WHERE tenant_id = ? AND job_id = ? AND status = 'accepted'
        ORDER BY generation DESC
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return None
    generation = int(row[0])
    items = [
        {
            "itemId": item_id,
            "kind": kind,
            "title": title,
            "generatedText": generated_text,
            "evidenceIds": _json_value(evidence_ids_json, default=[]),
            "requirementIds": _json_value(requirement_ids_json, default=[]),
            "sourceText": _json_value(source_text_json, default=[]),
            "transformType": transform_type,
            "control": control,
            "groundingAudit": _json_value(grounding_audit_json, default=[]),
            "warnings": _json_value(item_warnings_json, default=[]),
            "position": position,
        }
        for (
            item_id,
            kind,
            title,
            generated_text,
            evidence_ids_json,
            requirement_ids_json,
            source_text_json,
            transform_type,
            control,
            grounding_audit_json,
            item_warnings_json,
            position,
        ) in candidate.execute(
            """
            SELECT item_id, kind, title, generated_text, evidence_ids_json,
                   requirement_ids_json, source_text_json, transform_type, control,
                   grounding_audit_json, warnings_json, position
            FROM job_interview_prep_items
            WHERE tenant_id = ? AND job_id = ? AND generation = ?
            ORDER BY position, item_id
            """,
            (tenant_id, job_id, generation),
        ).fetchall()
    ]
    prep = InterviewPrep.from_dict(
        {
            "jobId": job_id,
            "generation": generation,
            "status": row[1],
            "model": row[2],
            "generatedAt": row[3],
            "gateAudit": {
                "status": row[4],
                "fabricationFindings": _json_value(row[5], default=[]),
                "groundingFindings": _json_value(row[6], default=[]),
                "judgeVerdict": row[7],
                "warnings": _json_value(row[8], default=[]),
            },
            "items": items,
        }
    )
    return _json(prep.to_read_model())


def _compensation_projection(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    legacy_raw_salary: object,
) -> tuple[str, str]:
    posted_row = candidate.execute(
        f"""
        SELECT {_identifiers(_POSTED_COMPENSATION_COLUMNS)}
        FROM job_posted_compensation_facts
        WHERE tenant_id = ? AND job_id = ?
        """,
        (tenant_id, job_id),
    ).fetchone()
    market_row = candidate.execute(
        f"""
        SELECT {_identifiers(_MARKET_COMPENSATION_COLUMNS)}
        FROM job_market_compensation_estimates
        WHERE tenant_id = ? AND job_id = ?
        """,
        (tenant_id, job_id),
    ).fetchone()
    posted: dict[str, object] = {
        "ok": True,
        "recordStatus": "not_recorded",
        "jobId": job_id,
        "legacyRawSalary": _optional_text(legacy_raw_salary),
    }
    if posted_row is not None:
        posted = {
            "ok": True,
            "recordStatus": "recorded",
            "fact": projection_builder._posted_fact_from_row(
                _mapped_row(_POSTED_COMPENSATION_COLUMNS, posted_row),
                job_id,
            ),
        }
    market: dict[str, object] = {
        "ok": True,
        "recordStatus": "not_requested",
        "jobId": job_id,
    }
    if market_row is not None:
        mapped_market = _mapped_row(_MARKET_COMPENSATION_COLUMNS, market_row)
        if (
            str(mapped_market["estimator_version"]).startswith(
                "company-role-reported-compensation-"
            )
            and mapped_market["estimate_state"]
            in projection_builder.MARKET_RECORDED_STATES
            and not projection_builder._market_uses_employer_posted_authority(
                str(mapped_market["source_snapshot_json"] or "")
            )
        ):
            market = {
                "ok": True,
                "recordStatus": "recorded",
                "estimate": projection_builder._market_estimate_from_row(
                    mapped_market,
                    job_id,
                    benchmark_lineage=None,
                ),
            }
    posted_fact = posted.get("fact") if posted["recordStatus"] == "recorded" else None
    market_estimate = market.get("estimate") if market["recordStatus"] == "recorded" else None
    posted_range = (
        projection_builder._posted_range_summary(posted_fact)
        if isinstance(posted_fact, dict)
        else None
    )
    market_range = (
        projection_builder._market_range_summary(market_estimate)
        if isinstance(market_estimate, dict)
        else None
    )
    interval = (
        projection_builder._market_confidence_interval_summary(market_estimate)
        if isinstance(market_estimate, dict)
        else None
    )
    summary = {
        "projectionVersion": projection_builder.COMPENSATION_PROJECTION_VERSION,
        "legacyRawSalary": posted_fact.get("legacyRawSalary") if isinstance(posted_fact, dict) else posted.get("legacyRawSalary"),
        "warningCount": len(posted_fact.get("warnings", [])) if isinstance(posted_fact, dict) else 0,
        "posted": {
            "sourceKind": "posted",
            "recordStatus": posted["recordStatus"],
            "parseState": posted_fact.get("parseState") if isinstance(posted_fact, dict) else None,
            "confidence": posted_fact.get("confidence", "none") if isinstance(posted_fact, dict) else "none",
            "warningCount": len(posted_fact.get("warnings", [])) if isinstance(posted_fact, dict) else 0,
            "range": posted_range,
            "displayRange": posted_range.get("displayRange") if posted_range else None,
        },
        "market": {
            "sourceKind": "reported_company_role_market",
            "recordStatus": market["recordStatus"],
            "benchmarkKind": None,
            "estimateState": market_estimate.get("estimateState", "not_requested") if isinstance(market_estimate, dict) else "not_requested",
            "confidenceBand": market_estimate.get("confidenceBand", "none") if isinstance(market_estimate, dict) else "none",
            "confidenceScore": market_estimate.get("confidenceScore") if isinstance(market_estimate, dict) else None,
            "sourceCount": market_estimate.get("sourceCount", 0) if isinstance(market_estimate, dict) else 0,
            "sampleCount": market_estimate.get("sampleCount") if isinstance(market_estimate, dict) else None,
            "warningCount": len(market_estimate.get("warnings", [])) if isinstance(market_estimate, dict) else 0,
            "range": market_range,
            "displayRange": market_range.get("displayRange") if market_range else None,
            "confidenceInterval": interval,
            "displayConfidenceInterval": interval.get("displayRange") if interval else None,
        },
    }
    summary["warningCount"] += summary["market"]["warningCount"]
    return _json(summary), _json(
        {
            "projectionVersion": (
                projection_builder.COMPENSATION_PROJECTION_VERSION
            ),
            "posted": posted,
            "market": market,
        }
    )


def _mapped_row(
    columns: tuple[str, ...],
    row: tuple[object, ...],
) -> dict[str, object]:
    if len(row) != len(columns):
        raise CandidateJobDetailProjectionsError(
            "candidate compensation row does not match its canonical columns"
        )
    return dict(zip(columns, row, strict=True))


def _insert_rows(candidate: sqlite3.Connection, rows: tuple[tuple[object, ...], ...]) -> None:
    if not rows:
        return
    candidate.executemany(
        f"INSERT INTO {_quote(_TABLE)} ({_identifiers(_COLUMNS)}) "
        f"VALUES ({', '.join('?' for _ in _COLUMNS)})",
        rows,
    )


def _verify_candidate(
    *,
    candidate: sqlite3.Connection,
    expected_rows: tuple[tuple[object, ...], ...],
    canonical_snapshot: tuple[tuple[str, tuple[tuple[object, ...], ...]], ...],
) -> None:
    actual = tuple(
        tuple(row)
        for row in candidate.execute(
            f"SELECT {_identifiers(_COLUMNS)} FROM {_quote(_TABLE)} ORDER BY tenant_id, job_id"
        ).fetchall()
    )
    if actual != expected_rows or _row_count(candidate, _TABLE) != len(expected_rows):
        raise CandidateJobDetailProjectionsError(
            "candidate rebuild changed job-detail projection rows or count"
        )
    if _canonical_snapshot(candidate) != canonical_snapshot:
        raise CandidateJobDetailProjectionsError(
            "candidate rebuild mutated canonical job-detail inputs"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateJobDetailProjectionsError(
            "candidate rebuild left a foreign-key violation"
        )
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)


def _canonical_snapshot(
    candidate: sqlite3.Connection,
) -> tuple[tuple[str, tuple[tuple[object, ...], ...]], ...]:
    tables = (
        "jobs", "job_locators", "job_enrichments", "job_scores", "job_stage_states",
        "job_posted_compensation_facts", "job_market_compensation_estimates",
        "job_employer_analysis", "job_employer_analysis_sub_analyses",
        "job_employer_analysis_failures", "job_requirement_fit_reports",
        "job_requirement_fit_items", "job_interview_prep", "job_interview_prep_items",
    )
    return tuple(
        (table, tuple(tuple(row) for row in candidate.execute(f"SELECT * FROM {_quote(table)} ORDER BY rowid").fetchall()))
        for table in tables
    )


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_quote(table)}").fetchone()[0])


def _json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _json_value(value: object, *, default: object) -> object:
    if not isinstance(value, str):
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _json_object(value: object) -> dict[str, Any]:
    parsed = _json_value(value, default={})
    return parsed if isinstance(parsed, dict) else {}


def _required_text(value: object, field: str) -> str:
    text = _optional_text(value)
    if text is None:
        raise CandidateJobDetailProjectionsError(f"{field} must be non-empty text")
    return text


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _quote(identifier: str) -> str:
    return f'"{identifier.replace(chr(34), chr(34) * 2)}"'


def _identifiers(values: tuple[str, ...]) -> str:
    return ", ".join(_quote(value) for value in values)


__all__ = [
    "CandidateJobDetailProjectionsError",
    "CandidateJobDetailProjectionsResult",
    "rebuild_job_detail_projections",
]
