"""The digest owns only its review watermark."""

SCHEMA = """
CREATE TABLE digest_review_state (
  id INTEGER PRIMARY KEY CHECK(id=1), last_acknowledged_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
"""
