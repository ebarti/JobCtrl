"""Tests for the OTel bootstrap that wires JobHunter into Langfuse."""

from __future__ import annotations

import base64

import pytest


@pytest.fixture(autouse=True)
def reset_otel_state(monkeypatch):
    """Drop the cached provider so each test sees a fresh boot."""
    from opentelemetry import trace as trace_api
    from opentelemetry.util._once import Once

    from jobhunter.infrastructure.observability import otel as otel_mod

    monkeypatch.setattr(otel_mod, "_initialized", False)
    monkeypatch.setattr(otel_mod, "_provider", None)
    monkeypatch.setattr(otel_mod, "_exporter", None)
    # The global TracerProvider is gated by ``_TRACER_PROVIDER_SET_ONCE`` —
    # without resetting it between tests, the second ``set_tracer_provider``
    # call is silently dropped and downstream spans go to the proxy tracer.
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER", None)
    yield
    # Force shutdown so the BatchSpanProcessor thread doesn't outlive the test.
    if otel_mod._provider is not None:
        otel_mod.shutdown_otel()


def _set_creds(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test")
    monkeypatch.setenv("LANGFUSE_BASE_URL", "https://example.test")


def _header(exporter, name: str) -> str | None:
    """Case-insensitive lookup against the exporter's session headers."""
    headers = dict(exporter._session.headers)
    for key, value in headers.items():
        if key.lower() == name.lower():
            return value
    return None


def test_init_otel_with_full_creds_configures_provider(monkeypatch):
    _set_creds(monkeypatch)
    from jobhunter.infrastructure.observability import otel as otel_mod

    otel_mod.init_otel()

    assert otel_mod.is_otel_enabled() is True
    assert otel_mod._provider is not None
    assert otel_mod._exporter is not None
    # Endpoint must be the documented Langfuse OTLP path.
    assert otel_mod._exporter._endpoint.endswith("/api/public/otel/v1/traces")
    # Authorization header must be HTTP Basic with the base64 of pk:sk.
    expected = base64.b64encode(b"pk-test:sk-test").decode("ascii")
    assert _header(otel_mod._exporter, "Authorization") == f"Basic {expected}"
    assert _header(otel_mod._exporter, "x-langfuse-ingestion-version") == "4"


def test_init_otel_is_idempotent(monkeypatch):
    _set_creds(monkeypatch)
    from jobhunter.infrastructure.observability import otel as otel_mod

    otel_mod.init_otel()
    first_provider = otel_mod._provider
    otel_mod.init_otel()
    assert otel_mod._provider is first_provider


def test_init_otel_with_missing_creds_does_not_configure(monkeypatch, caplog):
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_BASE_URL", raising=False)
    from jobhunter.infrastructure.observability import otel as otel_mod

    with caplog.at_level("WARNING"):
        otel_mod.init_otel()

    assert otel_mod.is_otel_enabled() is False
    assert otel_mod._provider is None
    # Warn the user so they know exports are off.
    assert any("Langfuse" in rec.message or "LANGFUSE" in rec.message for rec in caplog.records)


def test_init_otel_disabled_when_disable_env_set(monkeypatch, caplog):
    _set_creds(monkeypatch)
    monkeypatch.setenv("LANGFUSE_DISABLE", "1")
    from jobhunter.infrastructure.observability import otel as otel_mod

    with caplog.at_level("INFO"):
        otel_mod.init_otel()

    assert otel_mod.is_otel_enabled() is False
    assert otel_mod._provider is None


def test_init_otel_warns_about_payload_export(monkeypatch, caplog):
    _set_creds(monkeypatch)
    from jobhunter.infrastructure.observability import otel as otel_mod

    with caplog.at_level("WARNING"):
        otel_mod.init_otel()

    # The user should know LLM prompts + completions are leaving the host.
    assert any(
        "prompts" in rec.message.lower() or "completion" in rec.message.lower()
        for rec in caplog.records
    )


def test_shutdown_otel_resets_state(monkeypatch):
    _set_creds(monkeypatch)
    from jobhunter.infrastructure.observability import otel as otel_mod

    otel_mod.init_otel()
    assert otel_mod._provider is not None
    otel_mod.shutdown_otel()
    assert otel_mod._provider is None
    assert otel_mod.is_otel_enabled() is False
