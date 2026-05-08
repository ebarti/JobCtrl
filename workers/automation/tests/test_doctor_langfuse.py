"""Tests for the Langfuse row in ``jobhunter doctor``."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
from typer.testing import CliRunner

from jobhunter.cli import app


def _set_creds(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test")
    monkeypatch.setenv("LANGFUSE_BASE_URL", "https://example.test")


def _stub_temporal():
    """Pin Temporal to ``reachable`` so the test focuses on the Langfuse row.

    Patches ``get_temporal_client`` (the function the doctor awaits) rather
    than ``Client.connect`` so we never construct unawaited coroutines on
    the side_effect path. Earlier versions used a lambda that produced a
    fresh coroutine — pytest then warned ``coroutine '...' was never
    awaited`` because the Mock machinery wrapped the call in a way that
    occasionally dropped the coroutine before ``await`` consumed it.
    """
    # cli.py imports ``get_temporal_client`` lazily inside the doctor command,
    # so the patch target is the source module — not the cli namespace.
    return patch(
        "jobhunter.infrastructure.temporal.client.get_temporal_client",
        new=AsyncMock(return_value=object()),
    )


def test_doctor_reports_langfuse_reachable(monkeypatch):
    _set_creds(monkeypatch)
    response = httpx.Response(status_code=405, request=httpx.Request("HEAD", "https://example.test"))

    with _stub_temporal(), patch(
        "jobhunter.cli.httpx.head",
        return_value=response,
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Langfuse" in result.output
    assert "reachable" in result.output


def test_doctor_reports_langfuse_missing_when_creds_absent(monkeypatch):
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_BASE_URL", raising=False)

    with _stub_temporal():
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Langfuse" in result.output
    assert "MISSING" in result.output
    assert "LANGFUSE_PUBLIC_KEY" in result.output


def test_doctor_reports_langfuse_unreachable(monkeypatch):
    _set_creds(monkeypatch)

    with _stub_temporal(), patch(
        "jobhunter.cli.httpx.head",
        side_effect=httpx.ConnectError("refused"),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Langfuse" in result.output
    assert "unreachable" in result.output


def test_doctor_langfuse_row_when_disabled(monkeypatch):
    """LANGFUSE_DISABLE=1 should short-circuit to a "disabled" row, no network probe."""
    _set_creds(monkeypatch)
    monkeypatch.setenv("LANGFUSE_DISABLE", "1")

    # head() must not be called when disabled — patch to blow up if it is.
    with _stub_temporal(), patch(
        "jobhunter.cli.httpx.head",
        side_effect=AssertionError("network probe must not run when disabled"),
    ):
        result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0, result.output
    assert "Langfuse" in result.output
    assert "disabled" in result.output
    assert "LANGFUSE_DISABLE=1" in result.output
    # Confirm it doesn't also flag missing creds or unreachable.
    assert "MISSING" not in result.output or "Langfuse" not in result.output.split("MISSING")[0].splitlines()[-1]
    assert "unreachable" not in result.output
