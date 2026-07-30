"""Self-contained shipped-v6 fixture loader for migration tests."""

from __future__ import annotations

import sqlite3
from pathlib import Path


_V6_SCHEMA_SQL = (
    Path(__file__).with_name("fixtures") / "shipped_v6_schema.sql"
).read_text(encoding="utf-8")


def create_shipped_v6_database(path: Path) -> None:
    """Create the exact shipped-v6 schema with deterministic synthetic data."""
    conn = sqlite3.connect(path)
    try:
        conn.executescript(_V6_SCHEMA_SQL)
        conn.execute(
            "INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, ?)",
            (
                "https://jobs.example/shipped-v6",
                "Shipped V6 fixture",
                "2026-07-30T09:00:00+00:00",
            ),
        )
        conn.commit()
    finally:
        conn.close()
