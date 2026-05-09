"""Local-mode adapters for the Candidate Profile context."""

from jobhunter.infrastructure.profile.json_file import JsonFileProfileRepository
from jobhunter.infrastructure.profile.pdf_parser import PyPdfProfileParser
from jobhunter.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobhunter.infrastructure.profile.factory import (
    build_profile_repository,
    get_profile_repository,
    reset_profile_repository,
)

__all__ = [
    "JsonFileProfileRepository",
    "PyPdfProfileParser",
    "SqliteProfileRepository",
    "build_profile_repository",
    "get_profile_repository",
    "reset_profile_repository",
]
