"""Compensation audit identity contract across the Python projection builder."""

from __future__ import annotations

import json
from pathlib import Path

from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder


def test_compensation_audit_uses_explicit_job_id_without_legacy_job_key(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    job_id = "123e4567-e89b-12d3-a456-426614174000"
    try:
        builder = ProjectionBuilder(conn_factory=lambda: conn)
        _install_compensation_tables(conn)

        with builder._bind(conn):
            _summary, absent_audit_json = builder._build_compensation_projection(
                job_id=job_id,
                legacy_raw_salary="EUR 90000/year",
            )

            _insert_recorded_compensation(conn, job_id)
            _summary, recorded_audit_json = builder._build_compensation_projection(
                job_id=job_id,
                legacy_raw_salary="EUR 90000/year",
            )

        absent_audit = json.loads(absent_audit_json)
        assert absent_audit["posted"] == {
            "ok": True,
            "recordStatus": "not_recorded",
            "jobId": job_id,
            "legacyRawSalary": "EUR 90000/year",
        }
        assert absent_audit["market"] == {
            "ok": True,
            "recordStatus": "not_requested",
            "jobId": job_id,
        }

        recorded_audit = json.loads(recorded_audit_json)
        assert recorded_audit["posted"]["fact"]["jobId"] == job_id
        assert recorded_audit["market"]["estimate"]["jobId"] == job_id
        assert '"jobKey"' not in absent_audit_json
        assert '"jobKey"' not in recorded_audit_json
    finally:
        close_connection(db_path)


def _install_compensation_tables(conn) -> None:
    conn.executescript(
        """
        DROP TABLE job_posted_compensation_facts;
        DROP TABLE job_market_compensation_estimates;
        CREATE TABLE job_posted_compensation_facts (
            tenant_id TEXT, job_id TEXT, source_field TEXT, source_text TEXT,
            legacy_raw_salary TEXT, parse_state TEXT, currency TEXT, period TEXT,
            component TEXT, minimum_amount INTEGER, maximum_amount INTEGER,
            annualized_minimum_amount INTEGER, annualized_maximum_amount INTEGER,
            annualization_assumption TEXT, confidence TEXT, warnings_json TEXT,
            parser_version TEXT, source_hash TEXT, parsed_at TEXT
        );
        CREATE TABLE job_market_compensation_estimates (
            tenant_id TEXT, job_id TEXT, estimate_state TEXT, currency TEXT,
            period TEXT, component TEXT, minimum_amount INTEGER, maximum_amount INTEGER,
            confidence_interval_minimum_amount INTEGER,
            confidence_interval_maximum_amount INTEGER, confidence_band TEXT,
            confidence_score REAL, source_count INTEGER, sample_count INTEGER,
            aggregate_bucket TEXT, geography_scope TEXT, occupation_code TEXT,
            occupation_label TEXT, seniority_label TEXT, source_snapshot_json TEXT,
            factor_reasons_json TEXT, selected_evidence_json TEXT,
            insufficient_reasons_json TEXT, unsupported_reasons_json TEXT,
            source_unavailable_reasons_json TEXT, warnings_json TEXT,
            estimator_version TEXT, estimated_at TEXT, company_name TEXT,
            normalized_company TEXT, role_title TEXT, normalized_role TEXT,
            company_tier TEXT, match_scope TEXT
        );
        """
    )


def _insert_recorded_compensation(conn, job_id: str) -> None:
    conn.execute(
        """
        INSERT INTO job_posted_compensation_facts (
            tenant_id, job_id, source_field, source_text, legacy_raw_salary,
            parse_state, currency, period, component, confidence, warnings_json,
            parser_version, source_hash, parsed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            job_id,
            "jobs.salary",
            "EUR 90000/year",
            "EUR 90000/year",
            "parsed_range",
            "EUR",
            "year",
            "base_salary",
            "high",
            "[]",
            "posted-compensation-v1",
            "hash-posted",
            "2026-07-31T00:00:00Z",
        ),
    )
    conn.execute(
        """
        INSERT INTO job_market_compensation_estimates (
            tenant_id, job_id, estimate_state, currency, period, component,
            confidence_band, confidence_score, source_count, source_snapshot_json,
            factor_reasons_json, selected_evidence_json, insufficient_reasons_json,
            unsupported_reasons_json, source_unavailable_reasons_json, warnings_json,
            estimator_version, estimated_at, company_tier, match_scope
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            job_id,
            "estimated_range",
            "EUR",
            "year",
            "total_compensation",
            "medium",
            0.75,
            1,
            "[]",
            "[]",
            "[]",
            "[]",
            "[]",
            "[]",
            "[]",
            "company-role-reported-compensation-v1",
            "2026-07-31T00:00:00Z",
            "unknown",
            "none",
        ),
    )
