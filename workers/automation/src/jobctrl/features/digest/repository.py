"""SQLite adapter for Digest watermark and committed event persistence."""

from contextlib import contextmanager
from datetime import datetime, timezone

from jobctrl.app.errors import AppError
from jobctrl.features.digest.domain import is_later, parse_time
from jobctrl.features.digest.ports import DigestReadScope


class SqliteDigestRepository:
    def __init__(self, database, events):
        self.database, self.events = database, events

    @staticmethod
    def _state(connection):
        row = connection.execute("SELECT last_acknowledged_at,updated_at FROM digest_review_state WHERE id=1").fetchone()
        return {"lastAcknowledgedAt": row[0] if row else None, "updatedAt": row[1] if row else None}

    @contextmanager
    def read_scope(self):
        with self.database.connect() as connection:
            connection.execute("BEGIN")
            since = self._state(connection)["lastAcknowledgedAt"]
            if since is not None and parse_time(since) is None:
                raise AppError("invalid_watermark", "The saved digest watermark is invalid.", status_code=409)
            yield DigestReadScope(since=since, source_context=connection)

    def acknowledge(self, requested=None):
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        candidate = requested if parse_time(requested) is not None and not is_later(requested, now) else now
        with self.database.transaction() as connection:
            previous = self._state(connection)["lastAcknowledgedAt"]
            if previous is not None and parse_time(previous) is None:
                raise AppError("invalid_watermark", "The saved digest watermark is invalid.", status_code=409)
            effective = previous if previous and is_later(previous, candidate) else candidate
            connection.execute("INSERT INTO digest_review_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET last_acknowledged_at=excluded.last_acknowledged_at,updated_at=excluded.updated_at", (effective, now))
            self.events.append(connection, "DigestReviewed", {"acknowledgedAt": effective}, feature="digest", aggregate_id="daily")
            state = self._state(connection)
        return {"ok": True, "state": state}
