"""SqliteUnitOfWork — connection-scoped transaction boundary (local mode).

Local mode builds every per-aggregate repository over one thread-local SQLite
connection (see :func:`jobhunter.database.get_connection`). Each repository
``save`` commits eagerly, which is correct in isolation but not when a use case
must persist writes spanning several repositories as one atomic step (e.g. the
tailor generation flip: supersede the prior generation, save the new generation,
record its provenance). Three eager commits are three transactions, so a crash
or a write failure mid-flip can leave the job with no current approved resume or
an approved generation missing its provenance.

``SqliteUnitOfWork`` is the :class:`~jobhunter.domain.ports.materials.UnitOfWork`
local adapter. While it is active, repositories built with a reference to it
stage their writes and skip their per-call commit; the boundary commits once on a
clean exit and rolls the whole block back on any exception. Because SQLite in the
driver's default (deferred) mode auto-opens a single transaction on the first
statement of the block and holds it until commit, the staged writes are one
transaction and the flip is all-or-nothing.
"""

from __future__ import annotations

import sqlite3


class SqliteUnitOfWork:
    """Atomic transaction boundary over a shared SQLite connection.

    Enrolled repositories call :attr:`active` to decide whether to defer their
    commit to the boundary. Re-entrant: only the outermost ``with`` commits or
    rolls back, so a use case that opens a unit of work around a block that
    itself opens one still commits exactly once.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._depth = 0

    @property
    def active(self) -> bool:
        """True while inside the ``with`` block (repositories defer commit)."""
        return self._depth > 0

    def __enter__(self) -> "SqliteUnitOfWork":
        self._depth += 1
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        self._depth -= 1
        if self._depth > 0:
            return False
        if exc_type is None:
            self._conn.commit()
        else:
            self._conn.rollback()
        return False


__all__ = ["SqliteUnitOfWork"]
