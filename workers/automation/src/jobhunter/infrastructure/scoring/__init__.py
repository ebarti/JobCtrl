"""Scoring adapters — drive the Phase-5 ``ScoreRepository`` port."""

from jobhunter.infrastructure.scoring.sqlite_repository import SqliteScoreRepository

__all__ = ["SqliteScoreRepository"]
