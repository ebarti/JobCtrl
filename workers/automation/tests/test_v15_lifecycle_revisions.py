"""The durable lifecycle revision fences every canonical tombstone mutation."""

import sqlite3

import pytest

from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.infrastructure.migrations.schema_v15 import create_exact_v15_schema, upgrade_exact_v14_schema_to_v15


def _job(conn: sqlite3.Connection, job_id: str = "job-1") -> None:
    conn.execute(
        "INSERT INTO jobs(tenant_id,job_id,url,title,company,site,discovered_at) VALUES('local',?,?, 'test', 'test', 'test', '2026-01-01')",
        (job_id, f"https://example.test/{job_id}"),
    )


def _revision(conn: sqlite3.Connection, job_id: str = "job-1") -> int:
    row = conn.execute(
        "SELECT revision FROM job_lifecycle_revisions WHERE tenant_id='local' AND job_id=?", (job_id,)
    ).fetchone()
    assert row is not None
    return int(row[0])


@pytest.fixture
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    create_exact_v15_schema(conn)
    _job(conn)
    conn.commit()
    yield conn
    conn.close()


def test_migration_preserves_existing_job_and_seeds_revision() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    create_exact_v14_schema(conn)
    _job(conn)
    conn.execute("INSERT INTO jobctrl_deleted_jobs(tenant_id,job_id,deleted_at) VALUES('local','job-1','2026')")
    conn.commit()
    upgrade_exact_v14_schema_to_v15(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 15
    assert _revision(conn) == 0
    assert conn.execute("SELECT deleted_at FROM jobctrl_deleted_jobs WHERE job_id='job-1'").fetchone() == ("2026",)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()


def test_all_tombstone_writes_and_identical_aba_change_revision(db: sqlite3.Connection) -> None:
    revisions = [_revision(db)]
    operations = [
        "INSERT INTO jobctrl_deleted_jobs(tenant_id,job_id,deleted_at) VALUES('local','job-1','2026')",
        "UPDATE OR IGNORE jobctrl_deleted_jobs SET restored_at='2027' WHERE job_id='job-1'",
        "INSERT OR REPLACE INTO jobctrl_deleted_jobs(tenant_id,job_id,deleted_at) VALUES('local','job-1','2026')",
        "DELETE FROM jobctrl_deleted_jobs WHERE job_id='job-1'",
        "INSERT INTO jobctrl_hidden_jobs(tenant_id,job_id,hidden_at) VALUES('local','job-1','2026')",
        "UPDATE OR IGNORE jobctrl_hidden_jobs SET unhidden_at='2027' WHERE job_id='job-1'",
        "INSERT OR REPLACE INTO jobctrl_hidden_jobs(tenant_id,job_id,hidden_at) VALUES('local','job-1','2026')",
        "DELETE FROM jobctrl_hidden_jobs WHERE job_id='job-1'",
    ]
    for operation in operations:
        db.execute(operation)
        revisions.append(_revision(db))
    assert all(after > before for before, after in zip(revisions, revisions[1:], strict=False))


def test_rollback_and_unrelated_writes_do_not_change_lifecycle_revision(db: sqlite3.Connection) -> None:
    original = _revision(db)
    db.execute("INSERT INTO jobctrl_deleted_jobs(tenant_id,job_id,deleted_at) VALUES('local','job-1','2026')")
    assert _revision(db) > original
    db.rollback()
    assert _revision(db) == original
    db.execute("UPDATE jobs SET title='changed' WHERE job_id='job-1'")
    assert _revision(db) == original


@pytest.mark.parametrize("foreign_keys", [True, False])
def test_job_recreation_and_key_moves_never_reuse_revision(foreign_keys: bool) -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute(f"PRAGMA foreign_keys={'ON' if foreign_keys else 'OFF'}")
    create_exact_v15_schema(conn)
    _job(conn)
    conn.execute("INSERT INTO jobctrl_deleted_jobs(tenant_id,job_id,deleted_at) VALUES('local','job-1','2026')")
    old = _revision(conn)
    conn.execute("DELETE FROM jobs WHERE job_id='job-1'")
    _job(conn)
    assert _revision(conn) > old
    if foreign_keys:
        assert conn.execute("SELECT COUNT(*) FROM jobctrl_deleted_jobs").fetchone()[0] == 0
    conn.execute("UPDATE jobs SET job_id='job-2' WHERE job_id='job-1'")
    assert _revision(conn, "job-2") > old
    assert conn.execute("SELECT revision FROM job_lifecycle_revisions WHERE job_id='job-1'").fetchone() is None
    conn.close()


def test_key_movement_fences_both_jobs(db: sqlite3.Connection) -> None:
    _job(db, "job-2")
    db.execute("INSERT INTO jobctrl_deleted_jobs(tenant_id,job_id,deleted_at) VALUES('local','job-1','2026')")
    before = (_revision(db), _revision(db, "job-2"))
    db.execute("UPDATE jobctrl_deleted_jobs SET job_id='job-2' WHERE job_id='job-1'")
    assert _revision(db) > before[0]
    assert _revision(db, "job-2") > before[1]


def test_clock_is_monotonic_and_overflow_fails_closed_even_or_ignore(db: sqlite3.Connection) -> None:
    db.execute("INSERT INTO jobctrl_deleted_jobs(tenant_id,job_id,deleted_at) VALUES('local','job-1','2026')")
    db.execute("UPDATE job_lifecycle_clock SET revision=9007199254740992")
    db.execute("UPDATE jobctrl_deleted_jobs SET restored_at='2027' WHERE job_id='job-1'")
    assert _revision(db) == 9007199254740993
    db.execute("UPDATE job_lifecycle_clock SET revision=9223372036854775807")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE OR IGNORE jobctrl_deleted_jobs SET restored_at=NULL WHERE job_id='job-1'")
    assert db.execute("SELECT restored_at FROM jobctrl_deleted_jobs WHERE job_id='job-1'").fetchone() == ("2027",)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM job_lifecycle_clock")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT OR REPLACE INTO job_lifecycle_clock(singleton, revision) VALUES(1,0)")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE job_lifecycle_clock SET revision=0")
