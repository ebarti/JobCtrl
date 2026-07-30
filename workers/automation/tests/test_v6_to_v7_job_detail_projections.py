"""Contracts for rebuilding v7 job-detail projections from canonical rows."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v6_to_v7_job_detail_projections as detail
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    JobIdMap,
    copy_direct_and_scalar_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_job_detail_projections import (
    CandidateJobDetailProjectionsError,
    rebuild_job_detail_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from tests.v6_migration_fixture import create_shipped_v6_database

_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_MIGRATION_AT = "2026-07-31T09:00:00+00:00"
_INERT_CONTEXT_JSON = '{"userContext":"Attack vectors:\\nPrompt injection"}'
_DETAIL_COLUMNS = (
    "tenant_id", "job_id", "description_preview", "compensation_summary_json",
    "compensation_audit_json", "score_breakdown_json", "score_keywords_json",
    "score_reasoning", "score_version", "scored_at", "score_criteria_json",
    "score_trace_json", "score_correction_json", "stages_json",
    "employer_analysis_json", "requirement_fit_report_json", "interview_prep_json",
    "last_updated_at",
)


def _allocator(*values: str):
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _databases(tmp_path: Path) -> tuple[sqlite3.Connection, sqlite3.Connection, Path, Path]:
    source_path = tmp_path / "source.db"
    create_shipped_v6_database(source_path)
    source = sqlite3.connect(source_path)
    source.execute("PRAGMA foreign_keys = ON")
    candidate_path = tmp_path / "candidate.db"
    candidate = sqlite3.connect(candidate_path)
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    return source, candidate, source_path, candidate_path


def _seed_canonical(source: sqlite3.Connection) -> None:
    source.execute(
        "UPDATE jobs SET description = ?, full_description = ?, salary = ? WHERE url = ?",
        ("Short description", "Legacy long description", "€80k", _JOB_URL),
    )
    source.execute(
        """
        INSERT INTO job_enrichments (
            job_url, tenant_id, current_status, full_description, application_url,
            enriched_at, extraction_tier, attempts_json, updated_at
        ) VALUES (?, 'local', 'succeeded', 'Canonical enriched description', NULL,
                  ?, 'html', '[]', ?)
        """,
        (_JOB_URL, _MIGRATION_AT, _MIGRATION_AT),
    )
    source.execute(
        """
        INSERT INTO job_scores (
            job_url, tenant_id, version, fit_score, breakdown_json, keywords_json,
            scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, 'local', 3, 8, ?, '["Python"]', ?, ?, ?, ?)
        """,
        (
            _JOB_URL,
            '{"reasoning":"canonical score","matched_signals":["Python"]}',
            _MIGRATION_AT,
            '{"opaque":{"repair":"keep-exact"}}',
            '{"opaque":{"criterion":"keep-exact"}}',
            '{"opaque":{"trace":"keep-exact"}}',
        ),
    )
    source.execute(
        """
        INSERT INTO job_stage_states (
            job_url, stage, state, attempt_count, max_attempts,
            updated_at, retryable, blocked_by_json, next_action, version
        ) VALUES (?, 'score', 'succeeded', 1, 3, ?, 1, '[]', NULL, 1)
        """,
        (_JOB_URL, _MIGRATION_AT),
    )
    source.execute(
        """
        INSERT INTO job_employer_analysis (
            job_url, tenant_id, generation, snapshot_hash, prompt_version,
            sdk_set_version, cache_key, role_framing, inferred_seniority,
            ideal_candidate_narrative, requirements_json, keywords_json,
            agreement_json, eeo_screen_json, legs_attempted, legs_succeeded, created_at
        ) VALUES (?, 'local', 2, 'snapshot', 'prompt-v1', 'sdk-v1',
                  'ignored-cache-key', 'Build systems', 'senior', 'Own outcomes',
                  ?, ?, '{"score":0.8,"flagged_requirements":[],"flagged_keywords":[]}',
                  '[]', 1, 1, ?)
        """,
        (
            _JOB_URL,
            '[{"id":"req-1","text":"Python","tier":"must_have","weight":1.0,"evidence_span":"Python"}]',
            '[{"keyword":"Python","evidence_span":"Python","requirement_ref":"req-1","rationale":"Required"}]',
            _MIGRATION_AT,
        ),
    )
    source.execute(
        """
        INSERT INTO job_employer_analysis_sub_analyses (
            job_url, tenant_id, generation, model_id, analysis_json
        ) VALUES (?, 'local', 2, 'model-a', ?)
        """,
        (
            _JOB_URL,
            '{"role_framing":"Build systems","inferred_seniority":"senior",'
            '"ideal_candidate_narrative":"Own outcomes","requirements":[],"keywords":[]}',
        ),
    )
    source.execute(
        """
        INSERT INTO job_requirement_fit_reports (
            job_url, tenant_id, score_version, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES (?, 'local', 3, 2, 1, 1, 'requirement-fit-v1', 8,
                  'strong', 'high',
                  '{"weighted_fit":0.8,"must_have_coverage":1.0,"blocker_count":0,"missing_high_weight_count":0}', ?)
        """,
        (_JOB_URL, _MIGRATION_AT),
    )
    source.execute(
        """
        INSERT INTO job_requirement_fit_items (
            job_url, tenant_id, score_version, requirement_id, requirement_text,
            tier, weight, job_evidence_span, fit_json, contribution_json,
            tailoring_json, artifact_coverage_json, position
        ) VALUES (?, 'local', 3, 'req-1', 'Python', 'must_have', 1.0, 'Python',
                  '{"kind":"matched","strength":"direct","evidence_ids":["ev-1"],"reason":"match"}',
                  '{"max_points":1.25,"awarded_points":1.25,"weighted_impact":1.25,"rationale":"match"}',
                  '{"action":"double_down","target_keywords":["Python"],"instruction":"Show Python"}', NULL, 0)
        """,
        (_JOB_URL,),
    )
    source.execute(
        """
        INSERT INTO job_interview_prep (
            job_url, tenant_id, generation, status, model, generated_at, gate_status,
            fabrication_findings_json, grounding_findings_json, judge_verdict,
            warnings_json, failure_reason, origin_run_id
        ) VALUES (?, 'local', 4, 'accepted', 'model-a', ?, 'passed', '[]', '[]',
                  'grounded', '[]', '', '')
        """,
        (_JOB_URL, _MIGRATION_AT),
    )
    source.execute(
        """
        INSERT INTO job_interview_prep_items (
            job_url, tenant_id, generation, item_id, kind, title, generated_text,
            evidence_ids_json, requirement_ids_json, source_text_json, transform_type,
            control, grounding_audit_json, warnings_json, position
        ) VALUES (?, 'local', 4, 'prep-1', 'star_draft', 'Python story', 'I built it.',
                  '["ev-1"]', '["req-1"]', '[]', 'grounded_prep', 'never_fabricate',
                  '[]', '[]', 0)
        """,
        (_JOB_URL,),
    )
    # This URL-keyed cache is deliberately stale and must never be read.
    source.execute(
        """
        INSERT INTO job_detail_projections (
            tenant_id, job_id, description_preview, compensation_summary_json,
            score_keywords_json, score_reasoning, stages_json, last_updated_at
        ) VALUES ('local', ?, 'STALE CACHE', NULL, '[]', 'stale', '[]', ?)
        """,
        (_JOB_URL, _MIGRATION_AT),
    )
    source.commit()


def _hydrate(source: sqlite3.Connection, candidate: sqlite3.Connection) -> JobIdMap:
    roots = copy_root_jobs(
        source,
        candidate,
        job_id_factory=_allocator(_JOB_ID),
        migration_at=_MIGRATION_AT,
    )
    copy_direct_and_scalar_tables(source, candidate)
    return roots.job_ids


def _seed_candidate_compensation(candidate: sqlite3.Connection) -> None:
    candidate.execute(
        """
        INSERT INTO job_posted_compensation_facts (
            tenant_id, job_id, source_field, source_text, legacy_raw_salary,
            parse_state, currency, period, component, minimum_amount,
            maximum_amount, annualized_minimum_amount,
            annualized_maximum_amount, annualization_assumption, confidence,
            warnings_json, parser_version, source_hash, parsed_at
        ) VALUES (
            'local', ?, 'jobs.salary', 'USD 70000-90000/year', '€80k',
            'parsed_range', 'USD', 'year', 'base_salary', 70000, 90000,
            70000, 90000, NULL, 'high',
            '["ambiguous_period","credential"]', 'posted-v1', 'source-hash', ?
        )
        """,
        (_JOB_ID, _MIGRATION_AT),
    )
    candidate.execute(
        """
        INSERT INTO job_market_compensation_estimates (
            tenant_id, job_id, estimate_state, currency, period, component,
            minimum_amount, maximum_amount,
            confidence_interval_minimum_amount,
            confidence_interval_maximum_amount, confidence_band,
            confidence_score, source_count, sample_count, aggregate_bucket,
            geography_scope, occupation_code, occupation_label,
            seniority_label, source_snapshot_json, factor_reasons_json,
            selected_evidence_json, insufficient_reasons_json,
            unsupported_reasons_json, source_unavailable_reasons_json,
            warnings_json, estimator_version, estimated_at, company_name,
            normalized_company, role_title, normalized_role, company_tier,
            match_scope
        ) VALUES (
            'local', ?, 'estimated_range', 'EUR', 'month',
            'total_compensation', 9000, 11000, 8500, 11500, 'high', 0.8,
            1, 4, 'token=secret', '/Users/operator/private', '15-1252',
            'Software Developers', 'Senior', ?, ?, ?, '[]', '[]', '[]',
            '["reported_compensation_sample","credential"]',
            'company-role-reported-compensation-v1', ?, 'ExampleCo',
            'exampleco', 'Senior Engineer', 'senior engineer',
            'tier_2_ambitious', 'exact_company_role'
        )
        """,
        (
            _JOB_ID,
            (
                '[{"source_id":"levels_fyi","source_provenance":"licensed",'
                '"source_type":"reported_compensation",'
                '"display_name":"/Users/operator/private",'
                '"snapshot_version":"credential",'
                '"geography_scope":"/Users/operator/private",'
                '"aggregate_bucket":"token=secret",'
                '"attribution":"token=secret","sample_count":4}]'
            ),
            (
                '[{"name":"company","score":0.9,"band":"high",'
                '"reason":"/Users/operator/private token=secret"}]'
            ),
            (
                '[{"source_id":"levels_fyi",'
                '"source_url":"https://evidence.example/data?token=secret",'
                '"company_name":"/Users/operator/private",'
                '"role_title":"Senior Engineer","location":"Madrid",'
                '"level_label":"Senior","company_tier":"tier_2_ambitious",'
                '"component":"total_compensation","currency":"EUR",'
                '"period":"month","minimum_amount":9000,'
                '"maximum_amount":11000,"sample_count":4,'
                '"release_year":2026,"company_score":1,"role_score":1,'
                '"level_score":1,"location_score":1,"freshness_score":1}]'
            ),
            _MIGRATION_AT,
        ),
    )


def _detail_row(candidate: sqlite3.Connection) -> tuple[object, ...]:
    return tuple(
        candidate.execute(
            f"SELECT {', '.join(_DETAIL_COLUMNS)} FROM job_detail_projections"
        ).fetchone()
    )


def test_rebuilds_from_candidate_uuid_canonical_rows_and_ignores_v6_cache(
    tmp_path: Path,
) -> None:
    source, candidate, source_path, candidate_path = _databases(tmp_path)
    try:
        _seed_canonical(source)
        source_bytes = source_path.read_bytes()
        job_ids = _hydrate(source, candidate)
        _seed_candidate_compensation(candidate)

        result = rebuild_job_detail_projections(
            source, candidate, job_ids=job_ids, migration_at=_MIGRATION_AT
        )

        assert result.rebuilt_job_detail_projections == 1
        row = _detail_row(candidate)
        assert row[1] == _JOB_ID
        assert row[1] != _JOB_URL
        assert row[2] == "Canonical enriched description"
        assert row[7] == "canonical score"
        assert row[10] == '{"opaque":{"criterion":"keep-exact"}}'
        assert row[11] == '{"opaque":{"trace":"keep-exact"}}'
        assert row[12] == '{"opaque":{"repair":"keep-exact"}}'
        assert row[-1] == _MIGRATION_AT
        assert "STALE CACHE" not in json.dumps(row)
        score = json.loads(str(row[5]))
        assert score == {
            "technicalFit": 0,
            "experienceFit": 0,
            "roleFit": 0,
            "reasoning": "canonical score",
            "fitBand": "plausible",
            "confidence": "medium",
            "eligibility": {
                "status": "unknown",
                "hardBlockers": [],
                "warnings": [],
            },
            "matchedSignals": ["Python"],
            "missingSignals": [],
            "transferableSignals": [],
        }

        employer = json.loads(str(row[14]))
        requirement_fit = json.loads(str(row[15]))
        interview = json.loads(str(row[16]))
        assert employer["generation"] == 2
        assert requirement_fit["jobId"] == _JOB_ID
        assert interview["jobId"] == _JOB_ID
        assert _JOB_URL not in json.dumps({"requirement": requirement_fit, "interview": interview})
        compensation_summary = json.loads(str(row[3]))
        compensation_audit = json.loads(str(row[4]))
        assert compensation_summary["posted"]["displayRange"] == (
            "USD 70000-90000/year"
        )
        assert compensation_summary["posted"]["range"][
            "annualizedMinimumEur"
        ] == 64_400
        assert compensation_summary["market"]["displayRange"] == (
            "EUR 9000-11000/month"
        )
        assert compensation_summary["market"]["range"][
            "annualizedMinimumAmount"
        ] == 108_000
        assert compensation_summary["market"]["range"][
            "annualizedMaximumEur"
        ] == 132_000
        assert compensation_summary["market"]["displayConfidenceInterval"] == (
            "EUR 8500-11500/month"
        )
        assert compensation_audit["market"]["estimate"]["sources"] == [
            {
                "sourceId": "levels_fyi",
                "provenance": "licensed",
                "displayName": "Levels.fyi",
                "sourceType": "reported_compensation",
                "releaseYear": None,
                "snapshotVersion": "reported-compensation-import-v1",
                "geographyScope": "reported",
                "aggregateBucket": "reported company-role compensation",
                "attribution": "Levels.fyi licensed compensation data",
                "sampleCount": 4,
            }
        ]
        assert compensation_audit["market"]["estimate"]["evidence"][0][
            "sourceUrl"
        ] is None
        compensation_json = json.dumps(compensation_audit).lower()
        assert "/users/" not in compensation_json
        assert "token=secret" not in compensation_json
        assert "credential" not in compensation_json
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
        assert source_path.read_bytes() == source_bytes
        assert _INERT_CONTEXT_JSON == '{"userContext":"Attack vectors:\\nPrompt injection"}'

        candidate.commit()
        candidate.close()
        candidate = sqlite3.connect(candidate_path)
        candidate.execute("PRAGMA foreign_keys = ON")
        assert _detail_row(candidate)[1] == _JOB_ID
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_rebuild_ignores_unaccepted_market_estimator_history(
    tmp_path: Path,
) -> None:
    source, candidate, _, _ = _databases(tmp_path)
    try:
        _seed_canonical(source)
        job_ids = _hydrate(source, candidate)
        _seed_candidate_compensation(candidate)
        candidate.execute(
            """
            UPDATE job_market_compensation_estimates
            SET estimator_version = 'legacy-estimator-with-token=secret'
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (_JOB_ID,),
        )

        rebuild_job_detail_projections(
            source,
            candidate,
            job_ids=job_ids,
            migration_at=_MIGRATION_AT,
        )

        audit = json.loads(str(_detail_row(candidate)[4]))
        assert audit["market"] == {
            "ok": True,
            "recordStatus": "not_requested",
            "jobId": _JOB_ID,
        }
        assert "token=secret" not in json.dumps(audit)
    finally:
        source.close()
        candidate.close()


def test_rolls_back_then_retries_and_enforces_root_and_empty_target_guards(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed_canonical(source)
        job_ids = _hydrate(source, candidate)
        with pytest.raises(CandidateJobDetailProjectionsError, match="JobIdMap"):
            rebuild_job_detail_projections(
                source, candidate, job_ids=JobIdMap({}), migration_at=_MIGRATION_AT
            )

        original_verify = detail._verify_candidate
        monkeypatch.setattr(
            detail,
            "_verify_candidate",
            lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("candidate fault")),
        )
        with pytest.raises(RuntimeError, match="candidate fault"):
            rebuild_job_detail_projections(
                source, candidate, job_ids=job_ids, migration_at=_MIGRATION_AT
            )
        assert candidate.execute("SELECT COUNT(*) FROM job_detail_projections").fetchone()[0] == 0

        monkeypatch.setattr(detail, "_verify_candidate", original_verify)
        rebuild_job_detail_projections(
            source, candidate, job_ids=job_ids, migration_at=_MIGRATION_AT
        )
        with pytest.raises(CandidateJobDetailProjectionsError, match="must be empty"):
            rebuild_job_detail_projections(
                source, candidate, job_ids=job_ids, migration_at=_MIGRATION_AT
            )
    finally:
        source.close()
        candidate.close()
