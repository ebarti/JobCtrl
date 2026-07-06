from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from jobhunter.digest import acknowledge_digest, build_digest, read_digest_state
from jobhunter.llm import SpendBudgetStatus


FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "domain-types"
    / "test"
    / "fixtures"
    / "daily_digest_parity.json"
)


def test_build_digest_matches_shared_fixture_without_acknowledging(tmp_path: Path) -> None:
    fixture = json.loads(FIXTURE_PATH.read_text())
    conn = sqlite3.connect(tmp_path / "jobhunter.db")
    conn.row_factory = sqlite3.Row
    _create_schema(conn)
    _seed_fixture(conn, fixture)

    before = read_digest_state(conn)
    digest = build_digest(
        conn,
        budget=SpendBudgetStatus(
            day=fixture["budget"]["day"],
            input_tokens=fixture["budget"]["inputTokens"],
            output_tokens=fixture["budget"]["outputTokens"],
            estimated_usd=fixture["budget"]["estimatedUsd"],
            daily_budget_usd=fixture["budget"]["dailyBudgetUsd"],
            exceeded=True,
        ),
        min_fit_score=fixture["minFitScore"],
        now=_parse_utc(fixture["now"]),
    )

    expected = fixture["expected"]
    assert digest["ok"] is True
    assert digest["generatedAt"] == expected["generatedAt"]
    assert digest["since"] == expected["since"]
    assert digest["highFitThreshold"] == expected["highFitThreshold"]
    assert digest["newMatches"] == expected["newMatches"]
    assert digest["blockedSources"] == expected["blockedSources"]
    assert digest["reviewNeededMaterials"] == expected["reviewNeededMaterials"]
    assert digest["staleScores"] == expected["staleScores"]
    assert digest["pendingApprovals"] == expected["pendingApprovals"]
    assert digest["followUpsDue"] == {
        **expected["followUpsDue"],
        "derived": True,
    }
    assert digest["budget"] == expected["budget"]
    assert "discoveredSince=2026-07-01T00%3A00%3A00.000Z" in digest["deepLinks"]["newMatches"]
    assert "scoredSince=2026-07-01T00%3A00%3A00.000Z" in digest["deepLinks"]["newMatches"]
    assert digest["deepLinks"]["budget"] == "/settings"
    assert read_digest_state(conn) == before


def test_acknowledge_digest_updates_watermark_and_records_event(tmp_path: Path) -> None:
    fixture = json.loads(FIXTURE_PATH.read_text())
    conn = sqlite3.connect(tmp_path / "jobhunter.db")
    conn.row_factory = sqlite3.Row
    _create_schema(conn)
    _seed_fixture(conn, fixture)

    result = acknowledge_digest(
        conn,
        acknowledged_at=fixture["expected"]["generatedAt"],
        now=_parse_utc(fixture["now"]),
    )

    assert result == {
        "ok": True,
        "state": {
            "lastAcknowledgedAt": fixture["expected"]["generatedAt"],
            "updatedAt": fixture["expected"]["generatedAt"],
        },
    }
    event = conn.execute(
        """
        SELECT event_type, payload_json
        FROM job_events
        WHERE event_type = 'DigestReviewed'
        ORDER BY event_id DESC
        LIMIT 1
        """
    ).fetchone()
    assert event is not None
    assert event["event_type"] == "DigestReviewed"
    assert json.loads(event["payload_json"]) == {
        "tenantId": "local",
        "acknowledgedAt": fixture["expected"]["generatedAt"],
        "previousAcknowledgedAt": fixture["since"],
        "reviewedAt": fixture["expected"]["generatedAt"],
    }

    stale = acknowledge_digest(
        conn,
        acknowledged_at=fixture["since"],
        now=_parse_utc(fixture["now"]),
    )

    assert stale["state"]["lastAcknowledgedAt"] == fixture["expected"]["generatedAt"]


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE digest_state (
            tenant_id              TEXT PRIMARY KEY DEFAULT 'local',
            last_acknowledged_at   TEXT,
            updated_at             TEXT NOT NULL
        );
        CREATE TABLE job_list_projections (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            title                  TEXT NOT NULL DEFAULT '',
            employer               TEXT NOT NULL DEFAULT '',
            source                 TEXT NOT NULL DEFAULT '',
            strategy               TEXT NOT NULL DEFAULT '',
            location               TEXT NOT NULL DEFAULT '',
            salary                 TEXT NOT NULL DEFAULT '',
            application_url        TEXT,
            discovered_at          TEXT,
            description            TEXT NOT NULL DEFAULT '',
            full_description       TEXT NOT NULL DEFAULT '',
            fit_score              INTEGER,
            compensation_summary_json TEXT,
            score_breakdown_json   TEXT,
            score_keywords_json    TEXT NOT NULL DEFAULT '[]',
            score_reasoning        TEXT NOT NULL DEFAULT '',
            score_version          INTEGER,
            scored_at              TEXT,
            score_criteria_json    TEXT,
            score_trace_json       TEXT,
            score_correction_json  TEXT,
            current_stage          TEXT NOT NULL DEFAULT 'discover',
            current_substage       TEXT NOT NULL DEFAULT 'discover',
            current_state          TEXT NOT NULL DEFAULT 'pending',
            current_error_code     TEXT,
            current_error_message  TEXT,
            current_next_action    TEXT,
            has_resume             INTEGER NOT NULL DEFAULT 0,
            has_cover_letter       INTEGER NOT NULL DEFAULT 0,
            has_pdf                INTEGER NOT NULL DEFAULT 0,
            apply_status           TEXT,
            applied_at             TEXT,
            artifact_count         INTEGER NOT NULL DEFAULT 0,
            deleted_at             TEXT,
            last_updated_at        TEXT,
            PRIMARY KEY (tenant_id, job_id)
        );
        CREATE TABLE source_quality_stats (
            tenant_id                         TEXT NOT NULL DEFAULT 'local',
            source_id                         TEXT NOT NULL,
            window_start                      TEXT NOT NULL,
            window_end                        TEXT NOT NULL,
            run_count                         INTEGER NOT NULL DEFAULT 0,
            failed_run_count                  INTEGER NOT NULL DEFAULT 0,
            consecutive_failures              INTEGER NOT NULL DEFAULT 0,
            observed_jobs                     INTEGER NOT NULL DEFAULT 0,
            new_jobs                          INTEGER NOT NULL DEFAULT 0,
            existing_jobs                     INTEGER NOT NULL DEFAULT 0,
            duplicate_jobs                    INTEGER NOT NULL DEFAULT 0,
            active_jobs                       INTEGER NOT NULL DEFAULT 0,
            stale_jobs                        INTEGER NOT NULL DEFAULT 0,
            detail_success_count              INTEGER NOT NULL DEFAULT 0,
            detail_failure_count              INTEGER NOT NULL DEFAULT 0,
            recommended_state                 TEXT NOT NULL DEFAULT 'normal',
            updated_at                        TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, source_id, window_start, window_end)
        );
        CREATE TABLE job_stage_states (
            job_url             TEXT NOT NULL,
            stage               TEXT NOT NULL,
            state               TEXT NOT NULL DEFAULT 'pending',
            updated_at          TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (job_url, stage)
        );
        CREATE TABLE application_review_decisions (
            tenant_id    TEXT NOT NULL DEFAULT 'local',
            decision_id  TEXT NOT NULL,
            job_key      TEXT NOT NULL,
            decision     TEXT NOT NULL,
            reason       TEXT,
            decided_by   TEXT NOT NULL DEFAULT 'user',
            decided_at   TEXT NOT NULL,
            PRIMARY KEY (tenant_id, decision_id)
        );
        CREATE TABLE application_outcomes (
            tenant_id     TEXT NOT NULL DEFAULT 'local',
            outcome_id    TEXT NOT NULL,
            job_key       TEXT NOT NULL,
            kind          TEXT NOT NULL,
            source        TEXT NOT NULL,
            note          TEXT,
            occurred_at   TEXT NOT NULL,
            recorded_at   TEXT NOT NULL,
            PRIMARY KEY (tenant_id, outcome_id)
        );
        CREATE TABLE job_scores (
            job_url TEXT NOT NULL,
            version INTEGER NOT NULL,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            fit_score INTEGER NOT NULL,
            breakdown_json TEXT NOT NULL,
            keywords_json TEXT NOT NULL,
            scored_at TEXT NOT NULL,
            correction_json TEXT,
            criteria_json TEXT NOT NULL DEFAULT '{}',
            trace_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (job_url, version)
        );
        CREATE TABLE job_score_staleness (
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_url TEXT NOT NULL,
            stale_reason TEXT NOT NULL,
            old_policy_id TEXT NOT NULL DEFAULT '',
            old_policy_version INTEGER NOT NULL,
            new_policy_id TEXT NOT NULL DEFAULT '',
            new_policy_version INTEGER NOT NULL,
            marked_at TEXT NOT NULL,
            resolved INTEGER NOT NULL DEFAULT 0,
            resolved_at TEXT,
            resolved_by_score_version INTEGER,
            PRIMARY KEY (
                tenant_id, job_url, stale_reason,
                old_policy_version, new_policy_version
            )
        );
        CREATE TABLE apply_run_projections (
            run_id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            job_title TEXT NOT NULL DEFAULT '',
            job_employer TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            result TEXT,
            dry_run INTEGER NOT NULL DEFAULT 0,
            worker_id INTEGER,
            model TEXT,
            started_at TEXT,
            finished_at TEXT,
            duration_ms INTEGER,
            events_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE jobhunter_hidden_jobs (
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_url TEXT NOT NULL,
            hidden_at TEXT NOT NULL,
            unhidden_at TEXT
        );
        CREATE TABLE posting_snapshot_sets (
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_url TEXT NOT NULL,
            latest_active_state TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url)
        );
        CREATE TABLE operational_attempt_metrics (
            metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            occurred_at TEXT NOT NULL,
            stage TEXT NOT NULL,
            source_id TEXT,
            source_kind TEXT,
            source_priority TEXT,
            source_role TEXT,
            adapter TEXT,
            attempt_kind TEXT NOT NULL,
            outcome TEXT NOT NULL,
            failure_category TEXT,
            is_operational_failure INTEGER NOT NULL DEFAULT 0,
            is_scrape_failure INTEGER NOT NULL DEFAULT 0,
            is_retryable INTEGER NOT NULL DEFAULT 1,
            run_id TEXT,
            duration_ms INTEGER,
            error_class TEXT
        );
        CREATE TABLE job_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_url TEXT,
            stage TEXT,
            event_type TEXT NOT NULL DEFAULT '',
            level TEXT NOT NULL DEFAULT 'info',
            message TEXT,
            occurred_at TEXT NOT NULL,
            payload_json TEXT
        );
        """
    )


def _seed_fixture(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO digest_state (tenant_id, last_acknowledged_at, updated_at) VALUES ('local', ?, ?)",
        (fixture["since"], fixture["since"]),
    )
    for job in fixture["jobs"]:
        score_breakdown = _score_breakdown_for_job(job)
        conn.execute(
            """
            INSERT INTO job_list_projections (
                tenant_id, job_id, title, employer, source, strategy, location, salary,
                application_url, discovered_at, description, full_description, fit_score,
                score_breakdown_json, score_keywords_json, score_reasoning, score_version,
                scored_at, score_criteria_json, score_trace_json, current_stage,
                current_substage, current_state, has_resume, has_cover_letter, has_pdf,
                deleted_at, last_updated_at
            ) VALUES (
                'local', ?, ?, ?, ?, 'digest-fixture', 'Remote', '', ?, ?, '', '', ?,
                ?, '["typescript"]', 'Digest fixture score.', 1, ?, '{}', '{}',
                ?, ?, ?, ?, ?, ?, NULL, ?
            )
            """,
            (
                job["jobId"],
                job["title"],
                job["employer"],
                job["source"],
                job["applicationUrl"],
                job["discoveredAt"],
                job["fitScore"],
                json.dumps(score_breakdown),
                job["scoredAt"],
                job["currentStage"],
                job["currentStage"],
                job["currentState"],
                int(job["hasResume"]),
                int(job["hasCoverLetter"]),
                int(job["hasPdf"]),
                fixture["now"],
            ),
        )
        conn.execute(
            """
            INSERT INTO job_scores (
                job_url, version, tenant_id, fit_score, breakdown_json,
                keywords_json, scored_at, correction_json, criteria_json, trace_json
            ) VALUES (?, 1, 'local', ?, ?, '["typescript"]', ?, NULL, '{}', '{}')
            """,
            (job["jobId"], job["fitScore"], json.dumps(score_breakdown), job["scoredAt"]),
        )
        if job.get("hidden"):
            conn.execute(
                "INSERT INTO jobhunter_hidden_jobs (tenant_id, job_url, hidden_at, unhidden_at) VALUES ('local', ?, ?, NULL)",
                (job["jobId"], fixture["now"]),
            )
        if job.get("activeState"):
            conn.execute(
                "INSERT INTO posting_snapshot_sets (tenant_id, job_url, latest_active_state, updated_at) VALUES ('local', ?, ?, ?)",
                (job["jobId"], job["activeState"], fixture["now"]),
            )
        if job["currentStage"] == "apply":
            conn.execute(
                "INSERT INTO job_stage_states (job_url, stage, state, updated_at) VALUES (?, 'apply', ?, ?)",
                (job["jobId"], job["currentState"], fixture["now"]),
            )

    for source in fixture["sourceQuality"]:
        conn.execute(
            """
            INSERT INTO source_quality_stats (
                tenant_id, source_id, window_start, window_end, run_count,
                failed_run_count, consecutive_failures, observed_jobs, detail_failure_count,
                recommended_state, updated_at
            ) VALUES ('local', ?, ?, ?, 3, 3, ?, 3, 3, ?, ?)
            """,
            (
                source["sourceId"],
                fixture["since"],
                fixture["now"],
                source["consecutiveFailures"],
                source["recommendedState"],
                fixture["now"],
            ),
        )

    for attempt in fixture["operationalAttempts"]:
        conn.execute(
            """
            INSERT INTO operational_attempt_metrics (
                tenant_id, occurred_at, stage, source_id, source_kind,
                source_priority, source_role, adapter, attempt_kind, outcome,
                failure_category, is_operational_failure, is_scrape_failure,
                is_retryable, run_id, duration_ms, error_class
            ) VALUES (
                'local', ?, ?, ?, 'ats', 'primary', 'discovery', 'fixture',
                'digest_fixture', ?, 'fixture_failure', 1, 1, 1,
                'digest-fixture-run', 100, 'FixtureError'
            )
            """,
            (
                attempt["occurredAt"],
                attempt["stage"],
                attempt["sourceId"],
                attempt["outcome"],
            ),
        )

    for decision in fixture["applicationReviewDecisions"]:
        conn.execute(
            """
            INSERT INTO application_review_decisions (
                tenant_id, decision_id, job_key, decision, reason, decided_by, decided_at
            ) VALUES ('local', ?, ?, ?, NULL, 'user', ?)
            """,
            (
                decision["decisionId"],
                decision["jobKey"],
                decision["decision"],
                decision["decidedAt"],
            ),
        )

    for run in fixture["applyRuns"]:
        conn.execute(
            """
            INSERT INTO apply_run_projections (
                run_id, tenant_id, job_id, job_title, job_employer, status, result,
                dry_run, started_at, finished_at, events_json
            ) VALUES (?, 'local', ?, '', '', ?, ?, ?, ?, ?, '[]')
            """,
            (
                run["runId"],
                run["jobId"],
                run["status"],
                run["result"],
                int(run["dryRun"]),
                run["startedAt"],
                run["finishedAt"],
            ),
        )

    for stale in fixture["scoreStaleness"]:
        conn.execute(
            """
            INSERT INTO job_score_staleness (
                tenant_id, job_url, stale_reason, old_policy_id, old_policy_version,
                new_policy_id, new_policy_version, marked_at, resolved
            ) VALUES (
                'local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', ?,
                'local:scoring-policy-v2', ?, ?, 0
            )
            """,
            (
                stale["jobUrl"],
                stale["scoreVersion"],
                stale["scoreVersion"] + 1,
                fixture["now"],
            ),
        )

    for outcome in fixture["applicationOutcomes"]:
        conn.execute(
            """
            INSERT INTO application_outcomes (
                tenant_id, outcome_id, job_key, kind, source, note, occurred_at, recorded_at
            ) VALUES ('local', ?, ?, ?, 'manual', NULL, ?, ?)
            """,
            (
                outcome["outcomeId"],
                outcome["jobKey"],
                outcome["kind"],
                outcome["occurredAt"],
                outcome["occurredAt"],
            ),
        )
    conn.commit()


def _score_breakdown_for_job(job: dict[str, Any]) -> dict[str, Any]:
    eligibility_status = job.get("eligibilityStatus", "eligible")
    return {
        "technical_fit": job["fitScore"],
        "experience_fit": job["fitScore"],
        "role_fit": job["fitScore"],
        "reasoning": "Digest fixture score.",
        "eligibility": {
            "status": eligibility_status,
            "hardBlockers": (
                ["Fixture eligibility blocker."]
                if eligibility_status == "blocked"
                else []
            ),
            "warnings": (
                ["Fixture eligibility warning."]
                if eligibility_status == "warning"
                else []
            ),
        },
        "matched_signals": ["typescript"],
        "missing_signals": [],
        "transferable_signals": [],
    }


def _parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
