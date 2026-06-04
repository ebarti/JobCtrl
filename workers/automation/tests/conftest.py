"""Shared pytest guardrails for local worker tests."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest


_TEST_APP_DIR = Path(tempfile.mkdtemp(prefix="jobhunter-pytest-"))
os.environ["JOBHUNTER_DIR"] = str(_TEST_APP_DIR)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Remove the session-scoped user-data sandbox after pytest exits."""
    if os.environ.get("JOBHUNTER_DIR") == str(_TEST_APP_DIR):
        shutil.rmtree(_TEST_APP_DIR, ignore_errors=True)


@pytest.fixture(autouse=True)
def disable_langfuse_network_export_by_default(monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> None:
    """Keep routine tests from exporting spans to a real Langfuse project.

    The focused observability and doctor tests own their own environment setup;
    every other test should stay hermetic even when a developer shell has live
    Langfuse credentials loaded.
    """
    test_file = Path(str(request.fspath)).name
    if test_file in {"test_otel_init.py", "test_doctor_langfuse.py"}:
        return
    monkeypatch.setenv("LANGFUSE_DISABLE", "1")
