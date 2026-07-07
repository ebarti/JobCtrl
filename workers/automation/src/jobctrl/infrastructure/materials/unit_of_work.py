"""SqliteUnitOfWork — connection-scoped transaction boundary (local mode).

Local mode builds every per-aggregate repository over one thread-local SQLite
connection (see :func:`jobctrl.database.get_connection`). Each repository
``save`` commits eagerly, which is correct in isolation but not when a use case
must persist writes spanning several repositories as one atomic step (e.g. the
tailor generation flip: supersede the prior generation, save the new generation,
record its provenance). Three eager commits are three transactions, so a crash
or a write failure mid-flip can leave the job with no current approved resume or
an approved generation missing its provenance.

``SqliteUnitOfWork`` is the :class:`~jobctrl.domain.ports.materials.UnitOfWork`
local adapter. On entry it opens an explicit ``BEGIN IMMEDIATE`` on the shared
connection, taking SQLite's write lock upfront; while it is active, repositories
built with a reference to it stage their writes and skip their per-call commit.
The boundary commits once on a clean exit and rolls the whole block back on any
exception, so the staged writes are one transaction and the flip is
all-or-nothing. Making the transaction explicit (rather than relying on the
driver's implicit deferred ``BEGIN``) means the block no longer depends on the
unenforced assumption that nothing else commits, rolls back, or opens its own
transaction on the shared connection between the first staged write and the
boundary commit: a stray ``BEGIN`` from another writer now fails loudly instead
of silently splitting the flip, and holding the write lock for the whole block
also shrinks the ``SQLITE_BUSY`` race when workers > 1.
"""

from __future__ import annotations

import sqlite3


class SqliteUnitOfWork:
    """Atomic transaction boundary over a shared SQLite connection.

    Enrolled repositories call :attr:`active` to decide whether to defer their
    commit to the boundary. Re-entrant: only the outermost ``__enter__`` issues
    the ``BEGIN IMMEDIATE`` and only the outermost ``with`` commits or rolls back,
    so a use case that opens a unit of work around a block that itself opens one
    still starts one transaction and commits exactly once.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._depth = 0

    @property
    def active(self) -> bool:
        """True while inside the ``with`` block (repositories defer commit)."""
        return self._depth > 0

    def __enter__(self) -> "SqliteUnitOfWork":
        if self._depth == 0:
            self._conn.execute("BEGIN IMMEDIATE")
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
