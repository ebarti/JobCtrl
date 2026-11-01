"""Commit-bound local notifications for owned SQLite writes.

Callbacks check their exact durable row before notifying. This also discards
writes rolled back to a caller's savepoint, without interpreting caller SQL.
Durable events remain the replay authority if a process stops after commit.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import Any


class NotificationCursor(sqlite3.Cursor):
    def execute(self, *args: Any, **kwargs: Any):
        try:
            return super().execute(*args, **kwargs)
        finally:
            self.connection.flush_committed_notifications()

    def executemany(self, *args: Any, **kwargs: Any):
        try:
            return super().executemany(*args, **kwargs)
        finally:
            self.connection.flush_committed_notifications()

    def executescript(self, *args: Any, **kwargs: Any):
        # sqlite3 commits a pending transaction before starting a script.
        self.connection.commit()
        return super().executescript(*args, **kwargs)


class NotificationConnection(sqlite3.Connection):
    """SQLite connection that never publishes pending writes before commit."""

    def defer_notification(self, key: tuple, callback: Callable[[], None]) -> None:
        if not self.in_transaction:
            raise RuntimeError("Commit notification requires an active transaction")
        if not hasattr(self, "_notifications"):
            self._notifications: dict[tuple, Callable[[], None]] = {}
        self._notifications[key] = callback

    def flush_committed_notifications(self) -> None:
        if self.in_transaction:
            return
        callbacks = getattr(self, "_notifications", {})
        self._notifications = {}
        for callback in callbacks.values():
            callback()

    def cursor(self, factory=NotificationCursor):
        return super().cursor(factory)

    def execute(self, *args: Any, **kwargs: Any):
        return self.cursor().execute(*args, **kwargs)

    def executemany(self, *args: Any, **kwargs: Any):
        return self.cursor().executemany(*args, **kwargs)

    def executescript(self, *args: Any, **kwargs: Any):
        return self.cursor().executescript(*args, **kwargs)

    def commit(self) -> None:
        super().commit()
        self.flush_committed_notifications()

    def rollback(self) -> None:
        super().rollback()
        self._notifications = {}

    def close(self) -> None:
        self._notifications = {}
        super().close()

    def __exit__(self, *args: Any):
        try:
            return super().__exit__(*args)
        finally:
            self.flush_committed_notifications()
