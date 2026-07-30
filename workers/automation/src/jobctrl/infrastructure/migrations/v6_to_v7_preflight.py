"""Bounded schema admission for stopped-runtime v6-to-v7 migration."""

from __future__ import annotations

import hashlib
import json
import sqlite3

from jobctrl.infrastructure.migrations.schema_manifest import schema_dump

_V6_CORE_MANIFESTS = frozenset(
    {
        (
            161,
            86,
            "1300bd3d3a5c86d385405570d5a703e51fe28df79355435802ec382b31316f7b",
        ),
        # A workspace created by v1.3 and upgraded in place through v2.0.8.
        # Seven additive ALTER TABLE paths preserve different raw CREATE SQL,
        # and the retired discovery_run_projections table remains present.
        (
            162,
            87,
            "ac7d39828e3ad9e0dd1983ed21180686b81fab9d62c7a75409e903ae44256e89",
        ),
    }
)

# These are the only durable tables that could be absent from fresh Python v6
# but present after their v6 owner paths ran.  Execute their shipped DDL in an
# isolated database and compare SQLite's raw schema inventory; do not relax
# whitespace, quotes, or defaults before checking it.
_V6_AUXILIARY_DDL = (
    """CREATE TABLE jobctrl_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT,
                restored_at TEXT
            )""",
    """CREATE TABLE jobctrl_hidden_jobs (
                job_url TEXT PRIMARY KEY,
                hidden_at TEXT NOT NULL,
                reason TEXT,
                unhidden_at TEXT
            )""",
    """CREATE TABLE worker_runtime_heartbeats (
              worker_id TEXT PRIMARY KEY,
              component TEXT NOT NULL,
              pid INTEGER NOT NULL,
              hostname TEXT NOT NULL,
              app_dir TEXT NOT NULL,
              db_path TEXT NOT NULL,
              task_queue TEXT NOT NULL,
              started_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              max_concurrent_activities INTEGER,
              activity_executor_max_workers INTEGER,
              active_activity_count INTEGER NOT NULL DEFAULT 0,
              active_activity_counts_json TEXT NOT NULL DEFAULT '{}',
              active_activity_details_json TEXT NOT NULL DEFAULT '[]',
              active_activity_details_total INTEGER NOT NULL DEFAULT 0,
              active_activity_details_truncated INTEGER NOT NULL DEFAULT 0,
              activity_duration_summary_json TEXT NOT NULL DEFAULT '{}',
              task_queue_observation_json TEXT,
              heartbeat_schema_version INTEGER NOT NULL DEFAULT 2
            )""",
    """CREATE TABLE discovery_execution_recoveries (
            tenant_id                   TEXT NOT NULL,
            discover_workflow_id        TEXT NOT NULL,
            discover_run_id             TEXT NOT NULL,
            state                       TEXT NOT NULL
                CHECK (state IN ('recovering', 'ready', 'retrying', 'incomplete')),
            mode                        TEXT NOT NULL
                CHECK (mode IN ('native', 'reconstructed')),
            decoder_version             INTEGER NOT NULL,
            history_event_id            INTEGER NOT NULL,
            expected_membership_count   INTEGER NOT NULL,
            persisted_membership_count  INTEGER NOT NULL,
            expected_step_count         INTEGER NOT NULL,
            persisted_step_count        INTEGER NOT NULL,
            key_digest                  TEXT NOT NULL,
            last_error_code             TEXT,
            updated_at                  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, discover_workflow_id, discover_run_id)
        )""",
    # v2.0.8's TypeScript feedback owner creates these exact tables lazily.
    # `application_outcomes` may additionally have the later ALTER TABLE
    # column listed below; the evidence and suggestion tables have one shipped
    # raw definition each.
    """CREATE TABLE application_outcomes (
      tenant_id     TEXT NOT NULL DEFAULT 'local',
      outcome_id    TEXT NOT NULL,
      job_key       TEXT NOT NULL,
      kind          TEXT NOT NULL,
      source        TEXT NOT NULL,
      note          TEXT,
      occurred_at   TEXT NOT NULL,
      recorded_at   TEXT NOT NULL,
      suggestion_id TEXT,
      evidence_id   TEXT,
      created_by    TEXT NOT NULL DEFAULT 'user',
      PRIMARY KEY (tenant_id, outcome_id)
    )""",
    """CREATE INDEX idx_application_outcomes_job
      ON application_outcomes(tenant_id, job_key, occurred_at DESC, recorded_at DESC)""",
    """CREATE TABLE application_email_evidence (
      tenant_id            TEXT NOT NULL DEFAULT 'local',
      evidence_id          TEXT NOT NULL,
      job_key              TEXT NOT NULL,
      provider             TEXT NOT NULL DEFAULT 'gmail',
      provider_message_id  TEXT NOT NULL,
      provider_thread_id   TEXT,
      from_address         TEXT,
      to_addresses_json    TEXT NOT NULL DEFAULT '[]',
      subject              TEXT,
      snippet              TEXT,
      received_at          TEXT,
      linked_at            TEXT NOT NULL,
      link_confidence      REAL NOT NULL DEFAULT 0,
      link_signals_json    TEXT NOT NULL DEFAULT '[]',
      body_text            TEXT,
      body_sha256          TEXT,
      body_stored_at       TEXT,
      PRIMARY KEY (tenant_id, evidence_id),
      UNIQUE (tenant_id, provider, provider_message_id)
    )""",
    """CREATE INDEX idx_application_email_evidence_job
      ON application_email_evidence(tenant_id, job_key, received_at DESC)""",
    """CREATE TABLE application_outcome_suggestions (
      tenant_id          TEXT NOT NULL DEFAULT 'local',
      suggestion_id      TEXT NOT NULL,
      job_key            TEXT NOT NULL,
      evidence_id        TEXT,
      suggested_kind     TEXT NOT NULL,
      confidence         REAL NOT NULL DEFAULT 0,
      rationale          TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'pending',
      created_at         TEXT NOT NULL,
      decided_at         TEXT,
      decision           TEXT,
      decision_reason    TEXT,
      decided_outcome_id TEXT,
      PRIMARY KEY (tenant_id, suggestion_id)
    )""",
    """CREATE INDEX idx_application_outcome_suggestions_job
      ON application_outcome_suggestions(tenant_id, job_key, status, created_at DESC)""",
    """CREATE INDEX idx_application_outcome_suggestions_status
      ON application_outcome_suggestions(tenant_id, status, created_at DESC)""",
    """CREATE TABLE role_match_feedback_suggestions (
      tenant_id       TEXT NOT NULL DEFAULT 'local',
      suggestion_id   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      rule_kind       TEXT NOT NULL,
      title_pattern   TEXT NOT NULL,
      title_display   TEXT NOT NULL,
      reason_code     TEXT NOT NULL,
      reason          TEXT NOT NULL,
      sample_count    INTEGER NOT NULL DEFAULT 0,
      source_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_json   TEXT NOT NULL DEFAULT '[]',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      decided_at      TEXT,
      decision_reason TEXT,
      PRIMARY KEY (tenant_id, suggestion_id)
    )""",
    """CREATE TABLE resume_review_drafts (
      tenant_id                    TEXT NOT NULL DEFAULT 'local',
      draft_id                     TEXT NOT NULL,
      job_key                      TEXT NOT NULL,
      base_generation              INTEGER NOT NULL,
      base_resume_text_artifact_id TEXT,
      base_resume_pdf_artifact_id  TEXT,
      renderer_format              TEXT NOT NULL DEFAULT 'unknown',
      state                        TEXT NOT NULL DEFAULT 'active',
      current_revision_id          TEXT,
      latest_revision_number       INTEGER NOT NULL DEFAULT 0,
      created_at                   TEXT NOT NULL,
      updated_at                   TEXT NOT NULL,
      PRIMARY KEY (tenant_id, draft_id)
    )""",
    """CREATE INDEX idx_resume_review_drafts_job
      ON resume_review_drafts(tenant_id, job_key, state, updated_at DESC)""",
    """CREATE TABLE resume_review_draft_revisions (
      tenant_id           TEXT NOT NULL DEFAULT 'local',
      revision_id         TEXT NOT NULL,
      draft_id            TEXT NOT NULL,
      job_key             TEXT NOT NULL,
      revision_number     INTEGER NOT NULL,
      plate_document_json TEXT,
      edited_text         TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      PRIMARY KEY (tenant_id, revision_id),
      UNIQUE (tenant_id, draft_id, revision_number)
    )""",
    """CREATE INDEX idx_resume_review_revisions_draft
      ON resume_review_draft_revisions(tenant_id, draft_id, revision_number DESC)""",
    """CREATE TABLE resume_review_edit_deltas (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      delta_id         TEXT NOT NULL,
      revision_id      TEXT NOT NULL,
      draft_id         TEXT NOT NULL,
      job_key          TEXT NOT NULL,
      kind             TEXT NOT NULL,
      section          TEXT,
      semantic_id      TEXT,
      line_anchor_json TEXT,
      before_text      TEXT NOT NULL DEFAULT '',
      after_text       TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      PRIMARY KEY (tenant_id, delta_id)
    )""",
    """CREATE INDEX idx_resume_review_edit_deltas_revision
      ON resume_review_edit_deltas(tenant_id, revision_id)""",
    """CREATE TABLE resume_review_comment_threads (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      thread_id        TEXT NOT NULL,
      draft_id         TEXT NOT NULL,
      job_key          TEXT NOT NULL,
      base_artifact_id TEXT,
      semantic_id      TEXT,
      line_anchor_json TEXT,
      source_pin_id    TEXT,
      risk_label       TEXT,
      comment_body     TEXT NOT NULL DEFAULT '',
      lifecycle_state  TEXT NOT NULL DEFAULT 'open',
      anchor_resolved  INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id)
    )""",
    """CREATE INDEX idx_resume_review_comment_threads_draft
      ON resume_review_comment_threads(tenant_id, draft_id, updated_at DESC)""",
    """CREATE TABLE resume_review_comment_replies (
      tenant_id         TEXT NOT NULL DEFAULT 'local',
      reply_id          TEXT NOT NULL,
      thread_id         TEXT NOT NULL,
      draft_revision_id TEXT,
      author            TEXT NOT NULL DEFAULT 'user',
      decision          TEXT NOT NULL,
      body              TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (tenant_id, reply_id)
    )""",
    """CREATE INDEX idx_resume_review_comment_replies_thread
      ON resume_review_comment_replies(tenant_id, thread_id, created_at ASC)""",
    """CREATE TABLE tailoring_feedback_signals (
      tenant_id         TEXT NOT NULL DEFAULT 'local',
      signal_id         TEXT NOT NULL,
      job_key           TEXT NOT NULL,
      draft_id          TEXT NOT NULL,
      draft_revision_id TEXT,
      source_kind       TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      signal_kind       TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'candidate',
      summary           TEXT NOT NULL DEFAULT '',
      section           TEXT,
      semantic_id       TEXT,
      created_at        TEXT NOT NULL,
      reviewed_at       TEXT,
      PRIMARY KEY (tenant_id, signal_id)
    )""",
    """CREATE INDEX idx_tailoring_feedback_signals_job
      ON tailoring_feedback_signals(tenant_id, job_key, created_at DESC)""",
    """CREATE INDEX idx_tailoring_feedback_signals_draft
      ON tailoring_feedback_signals(tenant_id, draft_id, created_at DESC)""",
)

# The lifecycle tables had two shipped owners. Python's workspace migration
# created the no-FK definitions above; the TypeScript write model created these
# exact FK-bearing definitions. Both are named, immutable v6 contracts.
_V6_AUXILIARY_TABLE_VARIANTS = {
    "jobctrl_deleted_jobs": (
        """CREATE TABLE jobctrl_deleted_jobs (
            job_url TEXT PRIMARY KEY,
            deleted_at TEXT NOT NULL,
            reason TEXT,
            restored_at TEXT,
            FOREIGN KEY(job_url) REFERENCES jobs(url)
        )""",
        """CREATE TABLE jobctrl_deleted_jobs (
                job_url TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL,
                reason TEXT,
                restored_at TEXT,
                FOREIGN KEY(job_url) REFERENCES jobs(url)
            )""",
        """CREATE TABLE jobctrl_deleted_jobs (
      job_url TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      reason TEXT,
      restored_at TEXT
    )""",
        """CREATE TABLE jobctrl_deleted_jobs (
      job_url TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      reason TEXT,
      restored_at TEXT,
      FOREIGN KEY(job_url) REFERENCES jobs(url)
    )""",
    ),
    "jobctrl_hidden_jobs": (
        """CREATE TABLE jobctrl_hidden_jobs (
      job_url TEXT PRIMARY KEY,
      hidden_at TEXT NOT NULL,
      reason TEXT,
      unhidden_at TEXT
    )""",
        """CREATE TABLE jobctrl_hidden_jobs (
      job_url TEXT PRIMARY KEY,
      hidden_at TEXT NOT NULL,
      reason TEXT,
      unhidden_at TEXT,
      FOREIGN KEY(job_url) REFERENCES jobs(url)
    )""",
    ),
    "worker_runtime_heartbeats": (
        """CREATE TABLE worker_runtime_heartbeats (
  worker_id TEXT PRIMARY KEY, component TEXT NOT NULL, pid INTEGER NOT NULL,
  hostname TEXT NOT NULL, app_dir TEXT NOT NULL, db_path TEXT NOT NULL,
  task_queue TEXT NOT NULL, started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
, max_concurrent_activities INTEGER, activity_executor_max_workers INTEGER, active_activity_count INTEGER NOT NULL DEFAULT 0, active_activity_counts_json TEXT NOT NULL DEFAULT '{}', active_activity_details_json TEXT NOT NULL DEFAULT '[]', active_activity_details_total INTEGER NOT NULL DEFAULT 0, active_activity_details_truncated INTEGER NOT NULL DEFAULT 0, activity_duration_summary_json TEXT NOT NULL DEFAULT '{}', task_queue_observation_json TEXT, heartbeat_schema_version INTEGER NOT NULL DEFAULT 1)""",
    ),
    "application_outcomes": (
        # The TypeScript owner first creates the baseline table and index, then
        # its column guard applies this ALTER TABLE. Keeping the operation
        # sequence preserves SQLite's raw CREATE SQL exactly.
        """CREATE TABLE application_outcomes (
      tenant_id     TEXT NOT NULL DEFAULT 'local',
      outcome_id    TEXT NOT NULL,
      job_key       TEXT NOT NULL,
      kind          TEXT NOT NULL,
      source        TEXT NOT NULL,
      note          TEXT,
      occurred_at   TEXT NOT NULL,
      recorded_at   TEXT NOT NULL,
      suggestion_id TEXT,
      evidence_id   TEXT,
      created_by    TEXT NOT NULL DEFAULT 'user',
      PRIMARY KEY (tenant_id, outcome_id)
    );
    CREATE INDEX idx_application_outcomes_job
      ON application_outcomes(tenant_id, job_key, occurred_at DESC, recorded_at DESC);
    ALTER TABLE application_outcomes ADD COLUMN interview_prep_generation INTEGER""",
    ),
}


class V6MigrationPreflightError(RuntimeError):
    """Raised before writes when a database is not an admitted v6 variant."""


def assert_v6_migration_preflight(conn: sqlite3.Connection) -> None:
    """Admit only shipped v6 core plus its named optional durable tables."""
    if int(conn.execute("PRAGMA user_version").fetchone()[0]) != 6:
        raise V6MigrationPreflightError("v6 migration requires schema version 6")

    dump = schema_dump(conn)
    expected_auxiliary = _expected_auxiliary_dump()
    admitted_auxiliary_rows = _assert_auxiliary_tables_exact(
        dump,
        expected_auxiliary,
    )
    core_dump = tuple(
        row
        for row in dump
        if row not in admitted_auxiliary_rows
    )
    observed_manifest = (
        len(core_dump),
        sum(1 for row in core_dump if row[0] == "table"),
        _schema_fingerprint(core_dump),
    )
    if observed_manifest not in _V6_CORE_MANIFESTS:
        raise V6MigrationPreflightError(
            "database does not match the admitted shipped v6 migration contract"
        )


def _expected_auxiliary_dump() -> tuple[tuple[str, str, str, str], ...]:
    reference = sqlite3.connect(":memory:")
    try:
        for ddl in _V6_AUXILIARY_DDL:
            reference.execute(ddl)
        return schema_dump(reference)
    finally:
        reference.close()


def _assert_auxiliary_tables_exact(
    dump: tuple[tuple[str, str, str, str], ...],
    expected: tuple[tuple[str, str, str, str], ...],
) -> frozenset[tuple[str, str, str, str]]:
    admitted: set[tuple[str, str, str, str]] = set()
    table_names = {row[1] for row in expected if row[0] == "table"}
    for table_name in table_names:
        observed = tuple(
            row for row in dump if row[1] == table_name or row[2] == table_name
        )
        if not observed:
            continue
        expected_rows = tuple(
            row for row in expected if row[1] == table_name or row[2] == table_name
        )
        allowed_rows = (expected_rows,) + tuple(
            _schema_rows_for_ddl(ddl)
            for ddl in _V6_AUXILIARY_TABLE_VARIANTS.get(table_name, ())
        )
        if observed not in allowed_rows:
            raise V6MigrationPreflightError(
                "database has an unsupported v6 optional durable-table variant"
            )
        admitted.update(observed)
    return frozenset(admitted)


def _schema_rows_for_ddl(
    ddl: str,
) -> tuple[tuple[str, str, str, str], ...]:
    reference = sqlite3.connect(":memory:")
    try:
        reference.executescript(ddl)
        return schema_dump(reference)
    finally:
        reference.close()


def _schema_fingerprint(
    dump: tuple[tuple[str, str, str, str], ...],
) -> str:
    encoded = json.dumps(
        dump,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


__all__ = ["V6MigrationPreflightError", "assert_v6_migration_preflight"]
