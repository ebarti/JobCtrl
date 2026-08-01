from __future__ import annotations

from dataclasses import asdict
import json
import sqlite3
from pathlib import Path

from jobctrl.database import close_connection, init_db
from jobctrl.domain.operations.feedback import (
    DiscoveryFeedbackSignal,
    RoleMatchApprovalFeedbackSignal,
    ScoreCorrectionFeedbackSignal,
    TailoringFeedbackSignal,
)
from jobctrl.domain.operations.learning import derive_tailoring_recommendations
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.projections.sqlite_feedback_signals import (
    SqliteFeedbackSignalReader,
)


_JOB_A = "10000000-0000-4000-8000-000000000001"
_JOB_B = "10000000-0000-4000-8000-000000000002"
_JOB_C = "10000000-0000-4000-8000-000000000003"
_PRIVATE_SENTINELS = (
    "private correction rationale",
    "private discovery note",
    "private role reason",
    "private decision reason",
    "private job title",
    "private employer",
    "private outcome note",
    "private mail body",
    "/Users/private/resume.pdf",
)
_PRIVATE_TAILORING_SUMMARY = "private tailoring edit and generated resume text"


def test_reads_only_explicit_reviewed_feedback_as_closed_typed_facts(
    tmp_path: Path,
) -> None:
    conn = _exact_v7_connection(tmp_path)
    _seed_jobs(conn)
    _seed_score_correction(conn)
    _seed_discovery_feedback(conn)
    _seed_role_suggestions(conn)
    _seed_tailoring_feedback(conn, tenant_id="local", job_id=_JOB_C)
    conn.commit()

    signals = SqliteFeedbackSignalReader(conn).list_accepted(LOCAL_TENANT)

    assert [type(signal) for signal in signals] == [
        ScoreCorrectionFeedbackSignal,
        DiscoveryFeedbackSignal,
        RoleMatchApprovalFeedbackSignal,
        TailoringFeedbackSignal,
    ]
    score = signals[0]
    assert isinstance(score, ScoreCorrectionFeedbackSignal)
    assert score.job_ids == (_JOB_A,)
    assert score.source_id == f"{_JOB_A}:2"
    assert score.source_revision == 2
    assert (score.original_fit_score, score.corrected_fit_score) == (6, 9)
    assert score.direction == "increase"

    discovery = signals[1]
    assert isinstance(discovery, DiscoveryFeedbackSignal)
    assert discovery.job_ids == (_JOB_B,)
    assert discovery.source_id == "feedback-reviewed"
    assert discovery.discovery_source_id == "source-jobstreaming"
    assert discovery.feedback_kind == "useful"

    role = signals[2]
    assert isinstance(role, RoleMatchApprovalFeedbackSignal)
    assert role.source_id == "suggestion-approved"
    assert role.job_ids == (_JOB_A, _JOB_B)
    assert role.rule_kind == "exact_title_exclusion"
    assert role.rule_value == "account executive"
    assert role.source_ids == ("source-a", "source-b")

    tailoring = signals[3]
    assert isinstance(tailoring, TailoringFeedbackSignal)
    assert tailoring.job_ids == (_JOB_C,)
    assert tailoring.source_id == "tailoring-signal"
    assert tailoring.source_revision == 1
    assert tailoring.signal_kind == "factual_correction"
    assert tailoring.rule_key == "fact_handling"
    assert tailoring.rule_value == "require_source_match"
    assert tailoring.allowlist_version == 1

    close_connection(tmp_path / "jobctrl.db")


def test_private_source_text_and_outcomes_never_enter_the_signal_union(
    tmp_path: Path,
) -> None:
    conn = _exact_v7_connection(tmp_path)
    _seed_jobs(conn)
    _seed_score_correction(conn)
    _seed_discovery_feedback(conn)
    _seed_role_suggestions(conn)
    _seed_tailoring_feedback(conn, tenant_id="local", job_id=_JOB_C)
    _seed_outcome_and_mail(conn)
    conn.commit()

    signals = SqliteFeedbackSignalReader(conn).list_accepted(LOCAL_TENANT)
    serialized = json.dumps([asdict(signal) for signal in signals], sort_keys=True)

    assert len(signals) == 4
    for sentinel in (*_PRIVATE_SENTINELS, _PRIVATE_TAILORING_SUMMARY):
        assert sentinel not in serialized
    assert "application_outcome" not in serialized
    assert "application_email_evidence" not in serialized

    close_connection(tmp_path / "jobctrl.db")


def test_application_outcomes_alone_never_create_a_feedback_signal(
    tmp_path: Path,
) -> None:
    conn = _exact_v7_connection(tmp_path)
    _seed_jobs(conn)
    _seed_outcome_and_mail(conn)
    conn.commit()

    assert SqliteFeedbackSignalReader(conn).list_accepted(LOCAL_TENANT) == ()

    close_connection(tmp_path / "jobctrl.db")


def test_latest_tailoring_review_must_be_accepted(tmp_path: Path) -> None:
    conn = _exact_v7_connection(tmp_path)
    _seed_jobs(conn)
    _seed_tailoring_feedback(conn, tenant_id="local", job_id=_JOB_C)
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signal_reviews (
            tenant_id, review_id, signal_id, revision, decision, signal_kind,
            rule_key, rule_value, allowlist_version, reviewed_at
        ) VALUES (
            'local', 'tailoring-review-rejected', 'tailoring-signal', 2,
            'rejected', 'factual_correction', NULL, NULL, 1,
            '2026-08-01T12:01:00Z'
        )
        """
    )
    conn.commit()

    assert SqliteFeedbackSignalReader(conn).list_accepted(LOCAL_TENANT) == ()

    close_connection(tmp_path / "jobctrl.db")


def test_reviewed_tailoring_signals_feed_thresholded_recommendation_derivation(
    tmp_path: Path,
) -> None:
    conn = _exact_v7_connection(tmp_path)
    _seed_jobs(conn)
    _seed_tailoring_feedback(
        conn, tenant_id="local", job_id=_JOB_A, signal_id="tailoring-signal-1"
    )
    _seed_tailoring_feedback(
        conn, tenant_id="local", job_id=_JOB_A, signal_id="tailoring-signal-2"
    )
    _seed_tailoring_feedback(
        conn, tenant_id="local", job_id=_JOB_B, signal_id="tailoring-signal-3"
    )
    conn.commit()

    recommendation = derive_tailoring_recommendations(
        SqliteFeedbackSignalReader(conn).list_accepted(LOCAL_TENANT),
        contradictions={},
    )[0]

    assert recommendation.observed_signal_count == 3
    assert recommendation.job_ids == (_JOB_A, _JOB_B)
    assert recommendation.status == "pending"

    close_connection(tmp_path / "jobctrl.db")


def test_signal_reads_are_tenant_scoped_and_deterministic(tmp_path: Path) -> None:
    conn = _exact_v7_connection(tmp_path)
    _insert_job(conn, tenant_id="tenant-a", job_id=_JOB_A, suffix="tenant-a")
    _insert_job(conn, tenant_id="tenant-b", job_id=_JOB_A, suffix="tenant-b")
    _insert_job(conn, tenant_id="tenant-b", job_id=_JOB_B, suffix="tenant-b-only")
    for tenant_id, score in (("tenant-a", 8), ("tenant-b", 4)):
        conn.execute(
            """
            INSERT INTO job_scores (
                tenant_id, job_id, version, fit_score, breakdown_json,
                keywords_json, scored_at, correction_json, trace_json
            ) VALUES (?, ?, 1, 6, '{}', '[]', ?, NULL, '{}')
            """,
            (tenant_id, _JOB_A, "2026-08-01T08:00:00Z"),
        )
        conn.execute(
            """
            INSERT INTO job_scores (
                tenant_id, job_id, version, fit_score, breakdown_json,
                keywords_json, scored_at, correction_json, trace_json
            ) VALUES (?, ?, 2, ?, '{}', '[]', ?, ?, ?)
            """,
            (
                tenant_id,
                _JOB_A,
                score,
                "2026-08-01T09:00:00Z",
                json.dumps({"rationale": f"private {tenant_id}"}),
                json.dumps({"correction_history": [{"rationale": f"private {tenant_id}"}]}),
            ),
        )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, trace_json
        ) VALUES ('tenant-a', ?, 1, 6, '{}', '[]', ?, NULL, '{}')
        """,
        (_JOB_B, "2026-08-01T08:00:00Z"),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, trace_json
        ) VALUES ('tenant-a', ?, 2, 9, '{}', '[]', ?, ?, '{}')
        """,
        (
            _JOB_B,
            "2026-08-01T09:00:00Z",
            json.dumps({"rationale": "private tenant-b-only score"}),
        ),
    )
    conn.execute(
        """
        INSERT INTO discovery_feedback (
            tenant_id, feedback_id, job_id, source_id, kind, note, recorded_at
        ) VALUES (
            'tenant-a', 'cross-tenant-discovery', ?, 'source-private',
            'useful', 'private tenant-b-only discovery', ?
        )
        """,
        (_JOB_B, "2026-08-01T09:00:00Z"),
    )
    conn.execute(
        """
        INSERT INTO role_match_feedback_suggestions (
            tenant_id, suggestion_id, status, rule_kind, title_pattern,
            title_display, reason_code, reason, sample_count,
            source_ids_json, evidence_json, created_at, updated_at, decided_at
        ) VALUES (
            'tenant-a', 'cross-tenant-role', 'approved',
            'exact_title_exclusion', 'account executive', 'Account Executive',
            'low_role_fit', 'private role reason', 1, '[]', ?, ?, ?, ?
        )
        """,
        (
            json.dumps([{"jobKey": _JOB_B, "reason": "private tenant-b evidence"}]),
            "2026-08-01T08:00:00Z",
            "2026-08-01T09:00:00Z",
            "2026-08-01T09:00:00Z",
        ),
    )
    _seed_tailoring_feedback(
        conn,
        tenant_id="tenant-a",
        job_id=_JOB_A,
        signal_id="shared-tailoring-signal",
        reviewed_at="2026-08-01T10:00:00Z",
    )
    _seed_tailoring_feedback(
        conn,
        tenant_id="tenant-b",
        job_id=_JOB_A,
        signal_id="shared-tailoring-signal",
        reviewed_at="2026-08-01T10:00:01Z",
    )
    conn.commit()

    reader = SqliteFeedbackSignalReader(conn)
    tenant_a = reader.list_accepted(TenantId("tenant-a"))
    tenant_b = reader.list_accepted(TenantId("tenant-b"))

    assert len(tenant_a) == len(tenant_b) == 2
    assert tenant_a == reader.list_accepted(TenantId("tenant-a"))
    assert isinstance(tenant_a[0], ScoreCorrectionFeedbackSignal)
    assert isinstance(tenant_b[0], ScoreCorrectionFeedbackSignal)
    assert tenant_a[0].corrected_fit_score == 8
    assert tenant_b[0].corrected_fit_score == 4
    assert isinstance(tenant_a[1], TailoringFeedbackSignal)
    assert isinstance(tenant_b[1], TailoringFeedbackSignal)
    assert tenant_a[1].tenant_id == TenantId("tenant-a")
    assert tenant_b[1].tenant_id == TenantId("tenant-b")

    close_connection(tmp_path / "jobctrl.db")


def _exact_v7_connection(tmp_path: Path) -> sqlite3.Connection:
    path = tmp_path / "jobctrl.db"
    conn = init_db(path)
    conn.row_factory = sqlite3.Row
    return conn


def _seed_jobs(conn: sqlite3.Connection) -> None:
    for index, job_id in enumerate((_JOB_A, _JOB_B, _JOB_C), start=1):
        _insert_job(conn, tenant_id="local", job_id=job_id, suffix=str(index))


def _insert_job(
    conn: sqlite3.Connection, *, tenant_id: str, job_id: str, suffix: str
) -> None:
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
        (tenant_id, job_id, f"https://jobs.example.test/{suffix}"),
    )


def _seed_score_correction(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, trace_json
        ) VALUES ('local', ?, 1, 6, '{}', '[]', ?, NULL, '{}')
        """,
        (_JOB_A, "2026-08-01T08:00:00Z"),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, trace_json
        ) VALUES ('local', ?, 2, 9, '{}', '[]', ?, ?, ?)
        """,
        (
            _JOB_A,
            "2026-08-01T09:00:00Z",
            json.dumps(
                {
                    "corrected_fit_score": 9,
                    "rationale": _PRIVATE_SENTINELS[0],
                    "local_path": _PRIVATE_SENTINELS[-1],
                }
            ),
            json.dumps(
                {
                    "correction_history": [
                        {"original_score": 6, "rationale": _PRIVATE_SENTINELS[0]}
                    ]
                }
            ),
        ),
    )


def _seed_discovery_feedback(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT INTO discovery_feedback (
            tenant_id, feedback_id, job_id, source_id, kind, note, recorded_at
        ) VALUES ('local', 'feedback-reviewed', ?, 'source-jobstreaming',
                  'useful', ?, '2026-08-01T10:00:00Z')
        """,
        (_JOB_B, _PRIVATE_SENTINELS[1]),
    )


def _seed_role_suggestions(conn: sqlite3.Connection) -> None:
    for suggestion_id, status, decided_at in (
        ("suggestion-approved", "approved", "2026-08-01T11:00:00Z"),
        ("suggestion-pending", "pending", None),
        ("suggestion-declined", "declined", "2026-08-01T11:05:00Z"),
    ):
        conn.execute(
            """
            INSERT INTO role_match_feedback_suggestions (
                tenant_id, suggestion_id, status, rule_kind, title_pattern,
                title_display, reason_code, reason, sample_count,
                source_ids_json, evidence_json, created_at, updated_at,
                decided_at, decision_reason
            ) VALUES (
                'local', ?, ?, 'exact_title_exclusion', 'account executive',
                ?, 'low_role_fit', ?, 2, ?, ?,
                '2026-08-01T10:30:00Z', '2026-08-01T11:00:00Z', ?, ?
            )
            """,
            (
                suggestion_id,
                status,
                _PRIVATE_SENTINELS[4],
                _PRIVATE_SENTINELS[2],
                json.dumps(["source-b", "source-a", "source-a"]),
                json.dumps(
                    [
                        {
                            "jobKey": _JOB_B,
                            "title": _PRIVATE_SENTINELS[4],
                            "company": _PRIVATE_SENTINELS[5],
                            "reason": _PRIVATE_SENTINELS[2],
                        },
                        {
                            "jobKey": _JOB_A,
                            "title": _PRIVATE_SENTINELS[4],
                            "company": _PRIVATE_SENTINELS[5],
                            "reason": _PRIVATE_SENTINELS[2],
                        },
                    ]
                ),
                decided_at,
                _PRIVATE_SENTINELS[3],
            ),
        )


def _seed_tailoring_feedback(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    job_id: str,
    signal_id: str = "tailoring-signal",
    reviewed_at: str = "2026-08-01T12:00:00Z",
) -> None:
    draft_id = f"tailoring-draft-{tenant_id}-{signal_id}"
    conn.execute(
        """
        INSERT INTO resume_review_drafts (
            tenant_id, draft_id, job_id, base_generation, renderer_format,
            state, latest_revision_number, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 'text', 'active', 0, ?, ?)
        """,
        (tenant_id, draft_id, job_id, reviewed_at, reviewed_at),
    )
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signals (
            tenant_id, signal_id, job_id, draft_id, source_kind, source_id,
            signal_kind, status, summary, created_at, reviewed_at
        ) VALUES (
            ?, ?, ?, ?, 'edit_delta', 'private-delta',
            'factual_correction', 'accepted', ?, ?, ?
        )
        """,
        (
            tenant_id,
            signal_id,
            job_id,
            draft_id,
            _PRIVATE_TAILORING_SUMMARY,
            reviewed_at,
            reviewed_at,
        ),
    )
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signal_reviews (
            tenant_id, review_id, signal_id, revision, decision, signal_kind,
            rule_key, rule_value, allowlist_version, reviewed_at
        ) VALUES (
            ?, ?, ?, 1, 'accepted', 'factual_correction',
            'fact_handling', 'require_source_match', 1, ?
        )
        """,
        (tenant_id, f"tailoring-review-{tenant_id}-{signal_id}", signal_id, reviewed_at),
    )


def _seed_outcome_and_mail(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT INTO application_email_evidence (
            tenant_id, evidence_id, job_id, provider_message_id, linked_at,
            body_text
        ) VALUES ('local', 'mail-1', ?, 'provider-1', ?, ?)
        """,
        (_JOB_C, "2026-08-01T12:00:00Z", _PRIVATE_SENTINELS[7]),
    )
    conn.execute(
        """
        INSERT INTO application_outcomes (
            tenant_id, outcome_id, job_id, kind, source, note,
            occurred_at, recorded_at, evidence_id
        ) VALUES (
            'local', 'outcome-1', ?, 'interview', 'manual', ?, ?, ?, 'mail-1'
        )
        """,
        (
            _JOB_C,
            _PRIVATE_SENTINELS[6],
            "2026-08-01T12:00:00Z",
            "2026-08-01T12:01:00Z",
        ),
    )
