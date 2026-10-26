"""A failed score replacement must not become an accepted partial version."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.scoring import (
    SqliteRequirementFitReportRepository,
    SqliteScoreRepository,
)
from tests.test_score_repository import _seed_job
from tests.test_score_profile_impact import conn as conn
from tests.test_score_profile_impact import env as env
from tests.test_score_profile_impact import profile_snapshot as profile_snapshot
from tests.test_score_use_cases import (
    _ScriptedLlm,
    _employer_analysis,
    _job,
    _profile_snapshot_with_evidence,
    _score_case,
    _strong_llm_response,
)


def _published_state(db_path: Path, job_id: str) -> dict[str, list[tuple]]:
    """Read committed publication state through an independent connection."""
    db = sqlite3.connect(db_path)
    try:
        statements = {
            "scores": "SELECT * FROM job_scores WHERE tenant_id='local' AND job_id=? ORDER BY version",
            "reports": "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
            "items": "SELECT * FROM job_requirement_fit_items WHERE tenant_id='local' AND job_id=? ORDER BY score_version, position",
            "staleness": "SELECT * FROM job_score_staleness WHERE tenant_id='local' AND job_id=? ORDER BY rowid",
            "bindings": "SELECT * FROM semantic_entity_bindings WHERE tenant_id='local' AND entity_kind='score' AND entity_id=? ORDER BY entity_version",
            "events": "SELECT * FROM job_events WHERE tenant_id='local' AND job_id=? ORDER BY event_id",
        }
        return {name: [tuple(row) for row in db.execute(sql, (job_id,))] for name, sql in statements.items()}
    finally:
        db.close()


@pytest.mark.parametrize(
    ("trigger", "table", "when"),
    [
        ("fail_score_publication", "job_scores", "NEW.version = 2"),
        ("fail_score_binding", "semantic_entity_bindings", "NEW.entity_kind = 'score' AND NEW.entity_version = '2'"),
        ("fail_fit_report", "job_requirement_fit_reports", "NEW.score_version = 2"),
        ("fail_fit_item", "job_requirement_fit_items", "NEW.score_version = 2"),
    ],
)
def test_failed_refresh_keeps_the_accepted_score_report_and_binding(tmp_path: Path, trigger: str, table: str, when: str):
    db_path = tmp_path / "owned.db"
    conn = init_db(db_path)
    try:
        job = _job("https://example.test/synthetic-atomic-score")
        job_id = JobId(job["job_id"])
        _seed_job(conn, job_id=job_id, url=job["url"])
        snapshot = _profile_snapshot_with_evidence(tmp_path)
        analysis = _employer_analysis(job_id)
        scores = SqliteScoreRepository(conn)
        reports = SqliteRequirementFitReportRepository(conn)
        determination_repository = SqliteDeterminationRepository(conn)

        def score():
            llm = _ScriptedLlm(_strong_llm_response())
            use_case = _score_case(
                repository=scores,
                llm=llm,
                requirements=analysis.canonical.requirements,
                requirement_fit_repository=reports,
            )
            # Use the production durable binding repository, not a fake port.
            use_case._determination_dependencies["repository"] = determination_repository
            return use_case.score(job=job, profile_snapshot=snapshot, employer_analysis=analysis)

        first = score()
        assert first.ok and first.score is not None and first.score.version == 1
        assert reports.load(LOCAL_TENANT, job_id).score_version == 1
        # A replacement must not clear an unresolved stale marker until its
        # matching score and fit report have both been published.
        conn.execute(
            """INSERT INTO job_score_staleness (
                tenant_id, job_id, stale_reason, old_policy_id, old_policy_version,
                new_policy_id, new_policy_version, marked_at, resolved
            ) VALUES ('local', ?, 'synthetic-policy-change', 'old', 0, 'new', 1,
                      '2026-01-01T00:00:00Z', 0)""",
            (str(job_id),),
        )
        conn.commit()
        accepted = _published_state(db_path, str(job_id))
        assert len(accepted["scores"]) == len(accepted["reports"]) == len(accepted["bindings"]) == 1
        assert accepted["items"] and len(accepted["staleness"]) == 1

        conn.execute(f"CREATE TRIGGER {trigger} BEFORE INSERT ON {table} WHEN {when} BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END")
        conn.commit()
        with pytest.raises((sqlite3.IntegrityError, RuntimeError), match="synthetic publication failure"):
            score()

        assert _published_state(db_path, str(job_id)) == accepted
        assert scores.load(LOCAL_TENANT, job_id).version == 1
        assert reports.load(LOCAL_TENANT, job_id).score_version == 1

        # After the injected fault is removed, the same public use case must
        # publish exactly one complete replacement and resolve that marker.
        conn.execute(f"DROP TRIGGER {trigger}")
        conn.commit()
        replacement = score()
        assert replacement.ok and replacement.score is not None and replacement.score.version == 2
        assert reports.load(LOCAL_TENANT, job_id).score_version == 2
        final = _published_state(db_path, str(job_id))
        assert len(final["scores"]) == len(final["reports"]) == len(final["bindings"]) == 2
        assert tuple(conn.execute(
            "SELECT resolved, resolved_by_score_version FROM job_score_staleness WHERE job_id = ?",
            (str(job_id),),
        ).fetchone()) == (1, 2)
    finally:
        conn.close()


def test_actual_score_job_entry_preserves_prior_publication_on_report_failure(env):
    """The production per-job entry preserves accepted publication on failure."""
    from tests.test_score_profile_impact import URL, _job_id, score, update

    first = score(env)
    assert first.ok and first.score is not None
    job_id = str(_job_id(URL))
    assert env.conn.execute("SELECT COUNT(*) FROM job_requirement_fit_reports WHERE job_id=?", (job_id,)).fetchone()[0] == 1
    update(env)
    env.model.verdict = "significant"
    env.conn.execute(
        "CREATE TRIGGER fail_score_activity_report BEFORE INSERT ON job_requirement_fit_reports "
        "WHEN NEW.score_version = 2 BEGIN SELECT RAISE(ABORT, 'synthetic report failure'); END"
    )
    env.conn.commit()
    accepted = _published_state(env.path, job_id)

    with pytest.raises(sqlite3.IntegrityError, match="synthetic report failure"):
        score(env, rescore=True)

    observed = _published_state(env.path, job_id)
    # Attempt lifecycle/failure events are allowed; a partial score publication
    # and its score binding or fit report are not.
    for name in ("scores", "reports", "items", "staleness", "bindings"):
        assert observed[name] == accepted[name]


def test_publication_inside_caller_transaction_does_not_commit_caller_work(tmp_path: Path):
    """A caller-owned transaction retains its own commit and rollback boundary."""
    db_path = tmp_path / "owned.db"
    conn = init_db(db_path)
    try:
        job = _job("https://example.test/synthetic-caller-transaction")
        job_id = JobId(job["job_id"])
        _seed_job(conn, job_id=job_id, url=job["url"])
        snapshot = _profile_snapshot_with_evidence(tmp_path)
        analysis = _employer_analysis(job_id)
        scores = SqliteScoreRepository(conn)
        reports = SqliteRequirementFitReportRepository(conn)
        determination_repository = SqliteDeterminationRepository(conn)
        emitted = []

        class Publisher:
            def publish(self, event):
                emitted.append(event)

        def score(with_publisher=True):
            llm = _ScriptedLlm(_strong_llm_response())
            case = _score_case(
                repository=scores,
                llm=llm,
                requirements=analysis.canonical.requirements,
                requirement_fit_repository=reports,
                publisher=Publisher() if with_publisher else None,
            )
            case._determination_dependencies["repository"] = determination_repository
            return case.score(job=job, profile_snapshot=snapshot, employer_analysis=analysis)

        assert score().ok
        accepted = _published_state(db_path, str(job_id))
        assert len(emitted) == 1
        # No in-process success event may escape before an external caller's
        # commit; without a post-commit callback, refuse this combination.
        conn.execute("BEGIN")
        with pytest.raises(RuntimeError, match="transaction"):
            score()
        assert len(emitted) == 1
        assert _published_state(db_path, str(job_id)) == accepted
        assert conn.in_transaction
        conn.rollback()

        # Without a publisher the caller can compose the publication with
        # its own work and retains both commit and rollback authority.
        conn.execute("BEGIN")
        assert score(with_publisher=False).score.version == 2
        assert _published_state(db_path, str(job_id)) == accepted
        assert conn.in_transaction
        conn.rollback()
        assert _published_state(db_path, str(job_id)) == accepted
        assert scores.load(LOCAL_TENANT, job_id).version == 1
    finally:
        conn.close()


def test_staleness_notification_is_not_emitted_until_complete_score_is_committed(tmp_path: Path):
    """The real default bus must not observe a rolled-back or incomplete score."""
    from jobctrl.infrastructure.events import get_default_publisher

    db_path = tmp_path / "owned.db"
    conn = init_db(db_path)
    subscription = None
    try:
        job = _job("https://example.test/synthetic-commit-notification")
        job_id = JobId(job["job_id"])
        _seed_job(conn, job_id=job_id, url=job["url"])
        snapshot = _profile_snapshot_with_evidence(tmp_path)
        analysis = _employer_analysis(job_id)
        scores = SqliteScoreRepository(conn)
        reports = SqliteRequirementFitReportRepository(conn)
        determination_repository = SqliteDeterminationRepository(conn)

        def score():
            llm = _ScriptedLlm(_strong_llm_response())
            case = _score_case(
                repository=scores,
                llm=llm,
                requirements=analysis.canonical.requirements,
                requirement_fit_repository=reports,
            )
            case._determination_dependencies["repository"] = determination_repository
            return case.score(job=job, profile_snapshot=snapshot, employer_analysis=analysis)

        assert score().ok
        conn.execute(
            """INSERT INTO job_score_staleness (
                tenant_id, job_id, stale_reason, old_policy_id, old_policy_version,
                new_policy_id, new_policy_version, marked_at, resolved
            ) VALUES ('local', ?, 'synthetic-policy-change', 'old', 0, 'new', 1,
                      '2026-01-01T00:00:00Z', 0)""",
            (str(job_id),),
        )
        conn.execute(
            "CREATE TRIGGER fail_score_notification_report BEFORE INSERT ON job_requirement_fit_reports "
            "WHEN NEW.score_version = 2 BEGIN SELECT RAISE(ABORT, 'synthetic report failure'); END"
        )
        conn.commit()
        accepted = _published_state(db_path, str(job_id))
        seen = []
        subscription = get_default_publisher().subscribe(
            "ScoreStalenessResolved", lambda event: seen.append((event, _published_state(db_path, str(job_id))))
        )

        with pytest.raises(sqlite3.IntegrityError, match="synthetic report failure"):
            score()
        assert _published_state(db_path, str(job_id)) == accepted
        assert seen == []

        conn.execute("DROP TRIGGER fail_score_notification_report")
        conn.commit()
        assert score().ok
        assert len(seen) == 1
        observed = seen[0][1]
        assert [row[2] for row in observed["scores"]] == [1, 2]
        assert [row[2] for row in observed["reports"]] == [1, 2]
        assert (observed["staleness"][0][8], observed["staleness"][0][10]) == (1, 2)
    finally:
        if subscription is not None:
            subscription.unsubscribe()
        conn.close()


class _CommitFailureConnection(sqlite3.Connection):
    """Inject one storage failure at the actual SQLite commit boundary."""

    fail_next_commit = False

    def commit(self):
        if self.fail_next_commit:
            self.fail_next_commit = False
            raise sqlite3.OperationalError("synthetic commit failure")
        return super().commit()


def _owned_fixture(conn, tmp_path):
    import json
    from threading import Event

    from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader
    from jobctrl.scoring.scorer import _OwnedScoreRepository
    from jobctrl.state import ensure_job_stage_rows

    source = _job("https://example.test/synthetic-owned-publication")
    job_id = JobId(source["job_id"])
    _seed_job(conn, job_id=job_id, url=source["url"])
    ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
    conn.execute(
        "UPDATE job_stage_states SET state='running', metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='score'",
        (json.dumps({"activityOwner": "synthetic-owner"}), str(job_id)),
    )
    conn.commit()
    job = SqlitePreparationTargetReader(conn).load(LOCAL_TENANT, job_id)
    assert job is not None
    snapshot = _profile_snapshot_with_evidence(tmp_path)
    analysis = _employer_analysis(job_id)
    scores = SqliteScoreRepository(conn)
    reports = SqliteRequirementFitReportRepository(conn)
    determinations = SqliteDeterminationRepository(conn)
    canceled = Event()
    owned = _OwnedScoreRepository(scores, conn, "synthetic-owner", canceled)

    def score(*, use_owner):
        llm = _ScriptedLlm(_strong_llm_response())
        case = _score_case(
            repository=owned if use_owner else scores,
            llm=llm,
            requirements=analysis.canonical.requirements,
            requirement_fit_repository=reports,
        )
        case._determination_dependencies["repository"] = determinations
        publication_job = {**job, "_score_publication_inputs": owned.capture_scoring_inputs(job)} if use_owner else job
        return case.score(job=publication_job, profile_snapshot=snapshot, employer_analysis=analysis)

    return job_id, reports, canceled, score


@pytest.mark.parametrize("use_owner", [False, True])
def test_commit_failure_rolls_back_complete_score_publication(tmp_path: Path, use_owner: bool):
    from jobctrl.database import close_connection

    db_path = tmp_path / "owned.db"
    init_db(db_path)
    close_connection(db_path)
    conn = sqlite3.connect(db_path, factory=_CommitFailureConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        job_id, _, _, score = _owned_fixture(conn, tmp_path)
        assert score(use_owner=False).ok
        accepted = _published_state(db_path, str(job_id))
        assert len(accepted["scores"]) == len(accepted["reports"]) == len(accepted["bindings"]) == 1
        conn.fail_next_commit = True
        with pytest.raises(sqlite3.OperationalError, match="synthetic commit failure"):
            score(use_owner=use_owner)
        assert not conn.in_transaction
        assert _published_state(db_path, str(job_id)) == accepted
    finally:
        conn.close()


def test_cancel_during_report_publication_rolls_back_owner_and_suppresses_notification(tmp_path: Path, monkeypatch):
    from jobctrl.infrastructure.events import get_default_publisher
    from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost

    db_path = tmp_path / "owned.db"
    conn = init_db(db_path)
    subscription = None
    try:
        job_id, reports, canceled, score = _owned_fixture(conn, tmp_path)
        assert score(use_owner=False).ok
        conn.execute(
            """INSERT INTO job_score_staleness (
                tenant_id, job_id, stale_reason, old_policy_id, old_policy_version,
                new_policy_id, new_policy_version, marked_at, resolved
            ) VALUES ('local', ?, 'synthetic-policy-change', 'old', 0, 'new', 1,
                      '2026-01-01T00:00:00Z', 0)""",
            (str(job_id),),
        )
        conn.commit()
        accepted = _published_state(db_path, str(job_id))
        notifications = []
        subscription = get_default_publisher().subscribe("ScoreStalenessResolved", notifications.append)
        original_save = reports.save

        def cancel_after_report(*args, **kwargs):
            original_save(*args, **kwargs)
            canceled.set()

        monkeypatch.setattr(reports, "save", cancel_after_report)
        with pytest.raises(PreparationReservationLost):
            score(use_owner=True)
        assert not conn.in_transaction
        assert _published_state(db_path, str(job_id)) == accepted
        assert notifications == []
    finally:
        if subscription is not None:
            subscription.unsubscribe()
        conn.close()


def test_missing_policy_initialization_respects_caller_transaction(tmp_path: Path):
    """Lazy default creation must not commit unrelated caller-owned edits."""
    from jobctrl.infrastructure.scoring import SqliteScoringPolicyRepository

    db_path = tmp_path / "owned.db"
    conn = init_db(db_path)
    try:
        job_id = JobId(_job("https://example.test/synthetic-caller-policy")["job_id"])
        _seed_job(conn, job_id=job_id, url="https://example.test/synthetic-caller-policy")
        assert conn.execute("SELECT COUNT(*) FROM scoring_policies").fetchone()[0] == 0
        original = conn.execute("SELECT title FROM jobs WHERE job_id=?", (str(job_id),)).fetchone()[0]
        conn.execute("BEGIN")
        conn.execute("UPDATE jobs SET title='Uncommitted synthetic edit' WHERE job_id=?", (str(job_id),))
        assert SqliteScoringPolicyRepository(conn).get_current(LOCAL_TENANT).version == 1
        assert conn.in_transaction
        other = sqlite3.connect(db_path)
        try:
            assert other.execute("SELECT title FROM jobs WHERE job_id=?", (str(job_id),)).fetchone()[0] == original
            assert other.execute("SELECT COUNT(*) FROM scoring_policies").fetchone()[0] == 0
        finally:
            other.close()
        conn.rollback()
        assert conn.execute("SELECT title FROM jobs WHERE job_id=?", (str(job_id),)).fetchone()[0] == original
        assert conn.execute("SELECT COUNT(*) FROM scoring_policies").fetchone()[0] == 0
    finally:
        conn.close()


@pytest.mark.parametrize("with_publisher", [False, True])
def test_caller_transaction_with_missing_policy_fails_without_committing_edits(tmp_path: Path, with_publisher: bool):
    """Publication refusal or failure cannot commit caller edits or replace the score."""
    from jobctrl.infrastructure.scoring import SqliteScoringPolicyRepository

    db_path = tmp_path / "owned.db"
    conn = init_db(db_path)
    try:
        job = _job("https://example.test/synthetic-caller-policy-publication")
        job_id = JobId(job["job_id"])
        _seed_job(conn, job_id=job_id, url=job["url"])
        snapshot = _profile_snapshot_with_evidence(tmp_path)
        analysis = _employer_analysis(job_id)
        scores = SqliteScoreRepository(conn)
        reports = SqliteRequirementFitReportRepository(conn)
        determinations = SqliteDeterminationRepository(conn)
        emitted = []

        class Publisher:
            def publish(self, event):
                emitted.append(event)

        def make_case(*, policy=False):
            llm = _ScriptedLlm(_strong_llm_response())
            case = _score_case(
                repository=scores,
                llm=llm,
                requirements=analysis.canonical.requirements,
                requirement_fit_repository=reports,
                policy_repository=SqliteScoringPolicyRepository(conn) if policy else None,
                publisher=Publisher() if policy and with_publisher else None,
            )
            case._determination_dependencies["repository"] = determinations
            return case

        assert make_case().score(job=job, profile_snapshot=snapshot, employer_analysis=analysis).ok
        case = make_case(policy=True)
        parsed = case.compute(job=job, profile_snapshot=snapshot, employer_analysis=analysis)
        assert parsed.ok
        conn.execute(
            "CREATE TRIGGER fail_policy_transaction_report BEFORE INSERT ON job_requirement_fit_reports "
            "WHEN NEW.score_version = 2 BEGIN SELECT RAISE(ABORT, 'synthetic report failure'); END"
        )
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM scoring_policies").fetchone()[0] == 0
        accepted = _published_state(db_path, str(job_id))
        original = conn.execute("SELECT title FROM jobs WHERE job_id=?", (str(job_id),)).fetchone()[0]
        conn.execute("BEGIN")
        conn.execute("UPDATE jobs SET title='Uncommitted synthetic edit' WHERE job_id=?", (str(job_id),))

        if with_publisher:
            with pytest.raises(RuntimeError, match="caller-owned transaction"):
                case.persist_outcome(job=job, parse=parsed)
            # Fail before lazy policy initialization, not merely before score writes.
            assert conn.execute("SELECT COUNT(*) FROM scoring_policies").fetchone()[0] == 0
        else:
            with pytest.raises(sqlite3.IntegrityError, match="synthetic report failure"):
                case.persist_outcome(job=job, parse=parsed)
        assert conn.in_transaction
        assert conn.execute("SELECT title FROM jobs WHERE job_id=?", (str(job_id),)).fetchone()[0] == "Uncommitted synthetic edit"
        assert _published_state(db_path, str(job_id)) == accepted
        assert emitted == []
        conn.rollback()
        assert conn.execute("SELECT title FROM jobs WHERE job_id=?", (str(job_id),)).fetchone()[0] == original
        assert conn.execute("SELECT COUNT(*) FROM scoring_policies").fetchone()[0] == 0
        assert _published_state(db_path, str(job_id)) == accepted
    finally:
        conn.close()


class _SavepointFailureConnection(sqlite3.Connection):
    """Inject failure immediately after the publisher starts a transaction."""

    fail_next_score_savepoint = False

    def execute(self, sql, *args, **kwargs):
        if self.fail_next_score_savepoint and sql.strip().lower() == "savepoint score_publication":
            self.fail_next_score_savepoint = False
            raise sqlite3.OperationalError("synthetic savepoint failure")
        return super().execute(sql, *args, **kwargs)


@pytest.mark.parametrize("use_owner", [False, True])
def test_publication_savepoint_failure_releases_new_writer_and_preserves_accepted_score(tmp_path: Path, use_owner: bool):
    from jobctrl.database import close_connection

    db_path = tmp_path / "owned.db"
    init_db(db_path)
    close_connection(db_path)
    conn = sqlite3.connect(db_path, factory=_SavepointFailureConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        job_id, _, _, score = _owned_fixture(conn, tmp_path)
        assert score(use_owner=False).ok
        accepted = _published_state(db_path, str(job_id))
        assert len(accepted["scores"]) == len(accepted["reports"]) == len(accepted["bindings"]) == 1
        conn.fail_next_score_savepoint = True
        with pytest.raises(sqlite3.OperationalError, match="synthetic savepoint failure"):
            score(use_owner=use_owner)
        assert not conn.in_transaction
        assert _published_state(db_path, str(job_id)) == accepted
        # A separate writer is not left blocked by the failed transaction.
        other = sqlite3.connect(db_path, timeout=0.1)
        try:
            other.execute("BEGIN IMMEDIATE")
            other.rollback()
        finally:
            other.close()
    finally:
        conn.close()
