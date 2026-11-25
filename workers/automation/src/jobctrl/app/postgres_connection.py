"""Small SQLAlchemy adapter for the feature repositories' positional SQL parameters."""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from functools import lru_cache

from sqlalchemy.engine import Connection as SAConnection


# Feature queries use one qmark per value. PostgreSQL handles every other part of
# the SQL, including DDL scripts. Quoted literals, identifiers and comments
# cannot contribute parameters. The driver requires doubled percent literals
# only in commands submitted with parameters.
_SQL_TOKENS = re.compile(
    r'''(?is)(?:\bE'(?:\\.|''|[^'\\])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|'''
    r'''--[^\n]*|/\*.*?\*/|\$(?P<tag>(?:[a-z_][a-z0-9_]*)?)\$.*?\$(?P=tag)\$|\?)'''
)


@lru_cache(maxsize=1024)
def _bind_qmarks(sql: str) -> tuple[str, int]:
    parts = []
    count = 0
    start = 0
    for match in _SQL_TOKENS.finditer(sql):
        parts.append(sql[start:match.start()].replace('%', '%%'))
        token = match[0]
        if token == '?':
            parts.append('%s')
            count += 1
        else:
            parts.append(token.replace('%', '%%'))
        start = match.end()
    parts.append(sql[start:].replace('%', '%%'))
    return ''.join(parts), count


class Row:
    """Feature readers use both tuple iteration and column-name access."""

    __slots__ = ('_row',)

    def __init__(self, row):
        self._row = row

    def __getitem__(self, index):
        return self._row._mapping[index] if isinstance(index, str) else self._row[index]

    def keys(self):
        return self._row._mapping.keys()

    def __iter__(self):
        return iter(self._row)

    def __len__(self):
        return len(self._row)


class Result:
    def __init__(self, result):
        self._result = result

    @property
    def rowcount(self):
        return self._result.rowcount

    def __iter__(self):
        return map(Row, self._result)

    def fetchone(self):
        row = self._result.fetchone()
        return None if row is None else Row(row)

    def fetchall(self):
        return [Row(row) for row in self._result.fetchall()]


class Connection:
    """Own one database transaction. DBOS enqueues on this exact SA connection."""

    def __init__(self, sa_connection: SAConnection):
        self.sa_connection = sa_connection

    @property
    def in_transaction(self) -> bool:
        return self.sa_connection.in_transaction()

    def execute(self, sql: str, parameters: Sequence = ()) -> Result:
        if not parameters:
            return Result(self.sa_connection.exec_driver_sql(sql, execution_options={'no_parameters': True}))
        bound, count = _bind_qmarks(sql)
        if count != len(parameters):
            raise ValueError('The number of SQL parameters does not match the query.')
        return Result(self.sa_connection.exec_driver_sql(bound, tuple(parameters)))

    def executemany(self, sql: str, parameters: Iterable[Sequence]) -> Result | None:
        rows = [tuple(record) for record in parameters]
        if not rows:
            return None
        bound, count = _bind_qmarks(sql)
        if any(len(row) != count for row in rows):
            raise ValueError('The number of SQL parameters does not match the query.')
        return Result(self.sa_connection.exec_driver_sql(bound, rows))

    def commit(self):
        self.sa_connection.commit()

    def rollback(self):
        self.sa_connection.rollback()

    def close(self):
        self.sa_connection.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            if exc_type is None:
                self.commit()
            else:
                self.rollback()
        finally:
            self.close()
