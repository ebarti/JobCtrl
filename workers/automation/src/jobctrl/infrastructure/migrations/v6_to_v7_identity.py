"""Explicit v6-to-v7 transforms for root Job identity and job locators."""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone

from jobctrl.infrastructure.migrations.v6_to_v7_support import table_columns, table_exists


def transform_v6_root_identity(conn: sqlite3.Connection) -> list[str]:
    """Add canonical tenant-scoped JobIds and the temporary locator map."""
    migration_timestamp = datetime.now(timezone.utc).isoformat()
    created: list[str] = []

    conn.execute("SAVEPOINT v6_root_identity")
    try:
        before_count = int(conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])
        columns = table_columns(conn, "jobs")
        if "tenant_id" not in columns:
            conn.execute(
                "ALTER TABLE jobs ADD COLUMN tenant_id "
                "TEXT NOT NULL DEFAULT 'local'"
            )
            created.append("jobs.tenant_id")
        if "job_id" not in columns:
            conn.execute("ALTER TABLE jobs ADD COLUMN job_id TEXT")
            created.append("jobs.job_id")

        rows = conn.execute(
            "SELECT rowid, tenant_id, job_id FROM jobs ORDER BY rowid"
        ).fetchall()
        for row in rows:
            rowid = int(row[0])
            tenant_id = str(row[1] or "").strip() or "local"
            existing_job_id = str(row[2] or "").strip().lower()
            job_id = existing_job_id or str(uuid.uuid4())
            validate_canonical_job_id(job_id)
            conn.execute(
                "UPDATE jobs SET tenant_id = ?, job_id = ? WHERE rowid = ?",
                (tenant_id, job_id, rowid),
            )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS job_identity_aliases (
                tenant_id   TEXT NOT NULL,
                alias_kind  TEXT NOT NULL,
                alias_value TEXT NOT NULL,
                job_id      TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                retired_at  TEXT,
                PRIMARY KEY (tenant_id, alias_kind, alias_value),
                CHECK (alias_kind = 'posting_url')
            )
            """
        )
        created.append("job_identity_aliases")

        conflict = conn.execute(
            """
            SELECT aliases.tenant_id, aliases.alias_value
            FROM job_identity_aliases AS aliases
            JOIN jobs
              ON jobs.tenant_id = aliases.tenant_id
             AND jobs.url = aliases.alias_value
            WHERE aliases.alias_kind = 'posting_url'
              AND aliases.job_id != jobs.job_id
            LIMIT 1
            """
        ).fetchone()
        if conflict is not None:
            raise RuntimeError(
                "stable JobId migration found a posting URL alias owned by "
                "a different job"
            )

        conn.execute(
            """
            INSERT INTO job_identity_aliases (
                tenant_id, alias_kind, alias_value, job_id, created_at, retired_at
            )
            SELECT
                tenant_id,
                'posting_url',
                url,
                job_id,
                COALESCE(NULLIF(discovered_at, ''), ?),
                NULL
            FROM jobs
            WHERE 1
            ON CONFLICT(tenant_id, alias_kind, alias_value) DO UPDATE SET
                retired_at = NULL
            WHERE job_identity_aliases.job_id = excluded.job_id
            """,
            (migration_timestamp,),
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_tenant_job_id "
            "ON jobs(tenant_id, job_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_job_identity_aliases_job "
            "ON job_identity_aliases(tenant_id, job_id, alias_kind)"
        )
        verify_v6_root_identity(conn, expected_jobs=before_count)
        conn.execute("RELEASE SAVEPOINT v6_root_identity")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT v6_root_identity")
        conn.execute("RELEASE SAVEPOINT v6_root_identity")
        raise
    return created


def verify_v6_root_identity(
    conn: sqlite3.Connection,
    *,
    expected_jobs: int | None = None,
) -> None:
    """Verify the temporary v6 locator map preserves one canonical JobId."""
    columns = table_columns(conn, "jobs")
    if not {"tenant_id", "job_id"}.issubset(columns):
        raise RuntimeError("stable JobId migration is missing jobs identity columns")

    rows = conn.execute(
        "SELECT tenant_id, job_id FROM jobs ORDER BY rowid"
    ).fetchall()
    if expected_jobs is not None and len(rows) != expected_jobs:
        raise RuntimeError("stable JobId migration changed the canonical job count")
    for row in rows:
        if not str(row[0] or "").strip():
            raise RuntimeError("stable JobId migration produced an empty tenant")
        validate_canonical_job_id(str(row[1] or ""))

    duplicate = conn.execute(
        """
        SELECT tenant_id, job_id
        FROM jobs
        GROUP BY tenant_id, job_id
        HAVING COUNT(*) > 1
        LIMIT 1
        """
    ).fetchone()
    if duplicate is not None:
        raise RuntimeError("stable JobId migration produced duplicate job IDs")

    missing_storage_alias = conn.execute(
        """
        SELECT 1
        FROM jobs
        LEFT JOIN job_identity_aliases AS aliases
          ON aliases.tenant_id = jobs.tenant_id
         AND aliases.alias_kind = 'posting_url'
         AND aliases.alias_value = jobs.url
         AND aliases.job_id = jobs.job_id
        WHERE aliases.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if missing_storage_alias is not None:
        raise RuntimeError(
            "stable JobId migration left a job without its storage URL alias"
        )

    missing_active_alias = conn.execute(
        """
        SELECT 1
        FROM jobs
        LEFT JOIN job_identity_aliases AS aliases
          ON aliases.tenant_id = jobs.tenant_id
         AND aliases.alias_kind = 'posting_url'
         AND aliases.job_id = jobs.job_id
         AND aliases.retired_at IS NULL
        WHERE aliases.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if missing_active_alias is not None:
        raise RuntimeError(
            "stable JobId migration left a job without an active posting URL alias"
        )


def migrate_v6_lifecycle_rows(conn: sqlite3.Connection) -> list[str]:
    """Move optional v6 hide and delete lifecycle rows to canonical JobIds."""
    for table_name, active_at, inactive_at in (
        ("jobctrl_hidden_jobs", "hidden_at", "unhidden_at"),
        ("jobctrl_deleted_jobs", "deleted_at", "restored_at"),
    ):
        _migrate_v6_lifecycle_table(
            conn,
            table_name=table_name,
            active_at=active_at,
            inactive_at=inactive_at,
        )
    return ["jobctrl_hidden_jobs", "jobctrl_deleted_jobs"]


def _migrate_v6_lifecycle_table(
    conn: sqlite3.Connection,
    *,
    table_name: str,
    active_at: str,
    inactive_at: str,
) -> None:
    rows = (
        conn.execute(
            f"SELECT job_url, {active_at}, reason, {inactive_at} "
            f"FROM {table_name} ORDER BY job_url"
        ).fetchall()
        if table_exists(conn, table_name)
        else []
    )
    canonical_rows: list[tuple[str, str, str, str | None, str | None]] = []
    for row in rows:
        job_url = str(row[0])
        job_id = _resolve_v6_posting_locator(
            conn,
            tenant_id="local",
            job_url=job_url,
        )
        canonical_rows.append(
            ("local", job_id, str(row[1]), row[2], row[3])
        )

    rebuilt_table = f"{table_name}_rebuilt"
    conn.execute(f'DROP TABLE IF EXISTS "{rebuilt_table}"')
    conn.execute(
        f"""
            CREATE TABLE "{rebuilt_table}" (
                tenant_id   TEXT NOT NULL DEFAULT 'local',
                job_id      TEXT NOT NULL,
                {active_at:<11} TEXT NOT NULL,
                reason      TEXT,
                {inactive_at:<11} TEXT,
                PRIMARY KEY (tenant_id, job_id),
                FOREIGN KEY (tenant_id, job_id)
                    REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
            )
        """
    )
    conn.executemany(
        f"""
        INSERT INTO {rebuilt_table} (
            tenant_id, job_id, {active_at}, reason, {inactive_at}
        ) VALUES (?, ?, ?, ?, ?)
        """,
        canonical_rows,
    )
    if table_exists(conn, table_name):
        conn.execute(f'DROP TABLE "{table_name}"')
    conn.execute(f'ALTER TABLE "{rebuilt_table}" RENAME TO "{table_name}"')


def _resolve_v6_posting_locator(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    job_url: str,
) -> str:
    row = conn.execute(
        """
        SELECT job_id
        FROM jobs
        WHERE tenant_id = ? AND url = ?
        UNION ALL
        SELECT job_id
        FROM job_identity_aliases
        WHERE tenant_id = ?
          AND alias_kind = 'posting_url'
          AND alias_value = ?
        LIMIT 1
        """,
        (tenant_id, job_url, tenant_id, job_url),
    ).fetchone()
    if row is None:
        raise RuntimeError("lifecycle migration found an unresolved posting locator")
    job_id = str(row[0])
    validate_canonical_job_id(job_id)
    return job_id


def rebuild_v7_jobs_and_locators(conn: sqlite3.Connection) -> None:
    """Re-key jobs by JobId and persist current plus historical locators."""
    rows = conn.execute("PRAGMA table_info(jobs)").fetchall()
    columns = [str(row[1]) for row in rows]
    if not {"tenant_id", "job_id", "url"}.issubset(columns):
        raise RuntimeError("schema v7 requires jobs tenant_id, job_id, and url")

    definitions: list[str] = []
    for row in rows:
        name = str(row[1])
        sql_type = str(row[2] or "TEXT")
        default = row[4]
        not_null = bool(row[3])
        if name in {"tenant_id", "job_id", "url"}:
            definitions.append(f"{quote_identifier(name)} {sql_type} NOT NULL")
            continue
        definition = f"{quote_identifier(name)} {sql_type}"
        if not_null:
            definition += " NOT NULL"
        if default is not None:
            definition += f" DEFAULT {default}"
        definitions.append(definition)

    conn.execute('DROP TABLE IF EXISTS "jobs_rebuilt"')
    conn.execute(
        "CREATE TABLE jobs_rebuilt ("
        + ", ".join(definitions)
        + ", PRIMARY KEY (tenant_id, job_id)"
        + ", UNIQUE (tenant_id, url)"
        + ")"
    )
    column_sql = ", ".join(quote_identifier(column) for column in columns)
    conn.execute(f"INSERT INTO jobs_rebuilt ({column_sql}) SELECT {column_sql} FROM jobs")
    conn.execute('DROP TABLE "jobs"')
    conn.execute('ALTER TABLE "jobs_rebuilt" RENAME TO "jobs"')
    conn.execute(
        "CREATE UNIQUE INDEX idx_jobs_tenant_job_id ON jobs(tenant_id, job_id)"
    )
    conn.execute("CREATE UNIQUE INDEX idx_jobs_tenant_url ON jobs(tenant_id, url)")
    create_v7_job_locators(conn)
    conn.execute('DROP TABLE IF EXISTS "job_identity_aliases"')


def create_v7_job_locators(conn: sqlite3.Connection) -> None:
    """Persist the current and historical v6 posting locators in v7."""
    conn.execute('DROP TABLE IF EXISTS "job_locators"')
    conn.execute(
        """
        CREATE TABLE job_locators (
            tenant_id      TEXT NOT NULL,
            job_id         TEXT NOT NULL,
            locator_kind   TEXT NOT NULL CHECK (locator_kind = 'posting_url'),
            locator_value  TEXT NOT NULL,
            is_current     INTEGER NOT NULL CHECK (is_current IN (0, 1)),
            first_seen_at  TEXT NOT NULL,
            last_seen_at   TEXT NOT NULL,
            retired_at     TEXT,
            PRIMARY KEY (tenant_id, job_id, locator_kind, locator_value),
            UNIQUE (tenant_id, locator_kind, locator_value),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        )
        """
    )
    timestamp = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value, is_current,
            first_seen_at, last_seen_at, retired_at
        )
        SELECT
            aliases.tenant_id,
            aliases.job_id,
            'posting_url',
            aliases.alias_value,
            CASE WHEN aliases.alias_value = jobs.url THEN 1 ELSE 0 END,
            aliases.created_at,
            CASE
                WHEN aliases.alias_value = jobs.url THEN ?
                ELSE COALESCE(aliases.retired_at, ?)
            END,
            CASE
                WHEN aliases.alias_value = jobs.url THEN NULL
                ELSE COALESCE(aliases.retired_at, ?)
            END
        FROM job_identity_aliases AS aliases
        JOIN jobs
          ON jobs.tenant_id = aliases.tenant_id
         AND jobs.job_id = aliases.job_id
        WHERE aliases.alias_kind = 'posting_url'
        """,
        (timestamp, timestamp, timestamp),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value, is_current,
            first_seen_at, last_seen_at, retired_at
        )
        SELECT tenant_id, job_id, 'posting_url', url, 1, ?, ?, NULL
        FROM jobs
        WHERE NOT EXISTS (
            SELECT 1
            FROM job_locators AS locators
            WHERE locators.tenant_id = jobs.tenant_id
              AND locators.job_id = jobs.job_id
              AND locators.locator_kind = 'posting_url'
              AND locators.locator_value = jobs.url
        )
        """,
        (timestamp, timestamp),
    )
    conn.execute(
        "CREATE UNIQUE INDEX idx_job_locators_current "
        "ON job_locators(tenant_id, job_id, locator_kind) WHERE is_current = 1"
    )


def verify_v7_identity_schema(conn: sqlite3.Connection) -> None:
    """Prove final v7 identity, locator, and foreign-key invariants."""
    primary_key = [
        str(row[1])
        for row in sorted(
            conn.execute("PRAGMA table_info(jobs)").fetchall(),
            key=lambda row: int(row[5]),
        )
        if int(row[5]) > 0
    ]
    if primary_key != ["tenant_id", "job_id"]:
        raise RuntimeError("schema v7 jobs primary key must be (tenant_id, job_id)")
    missing_identity = conn.execute(
        """
        SELECT 1 FROM jobs
        WHERE trim(tenant_id) = '' OR trim(job_id) = ''
        LIMIT 1
        """
    ).fetchone()
    if missing_identity is not None:
        raise RuntimeError("schema v7 left a job without a stable identity")
    if table_exists(conn, "job_identity_aliases"):
        raise RuntimeError("schema v7 must not retain legacy URL identity aliases")
    if not table_exists(conn, "job_locators"):
        raise RuntimeError("schema v7 requires canonical job locators")
    missing_current_locator = conn.execute(
        """
        SELECT 1
        FROM jobs
        LEFT JOIN job_locators
          ON job_locators.tenant_id = jobs.tenant_id
         AND job_locators.job_id = jobs.job_id
         AND job_locators.locator_kind = 'posting_url'
         AND job_locators.locator_value = jobs.url
         AND job_locators.is_current = 1
        WHERE job_locators.job_id IS NULL
        LIMIT 1
        """
    ).fetchone()
    if missing_current_locator is not None:
        raise RuntimeError("schema v7 left a job without its current URL locator")
    triggers = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs'"
    ).fetchall()
    if triggers:
        raise RuntimeError("schema v7 must not retain jobs compatibility triggers")
    url_foreign_key = conn.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND sql LIKE '%REFERENCES jobs(url)%'
        LIMIT 1
        """
    ).fetchone()
    if url_foreign_key is not None:
        raise RuntimeError("schema v7 retained a URL-keyed job foreign key")
    foreign_key_error = conn.execute("PRAGMA foreign_key_check").fetchone()
    if foreign_key_error is not None:
        raise RuntimeError("schema v7 has a foreign-key violation")


def validate_canonical_job_id(value: str) -> None:
    """Reject any JobId that is not canonical lower-case UUID text."""
    candidate = value.strip().lower()
    try:
        parsed = uuid.UUID(candidate)
    except (AttributeError, ValueError) as exc:
        raise RuntimeError("stable JobId migration found a non-UUID job_id") from exc
    if str(parsed) != candidate:
        raise RuntimeError("stable JobId migration found a non-canonical UUID")


def quote_identifier(identifier: str) -> str:
    """Quote an exact SQLite identifier used by the jobs-table rebuild."""
    return f'"{identifier.replace(chr(34), chr(34) * 2)}"'


__all__ = [
    "create_v7_job_locators",
    "migrate_v6_lifecycle_rows",
    "rebuild_v7_jobs_and_locators",
    "transform_v6_root_identity",
    "validate_canonical_job_id",
    "verify_v6_root_identity",
    "verify_v7_identity_schema",
]
