"""Tests for the OTel bootstrap that wires JobCtrl into Langfuse."""

from __future__ import annotations

import base64

import pytest


@pytest.fixture(autouse=True)
def reset_otel_state(monkeypatch):
    """Drop the cached provider so each test sees a fresh boot."""
    from opentelemetry import trace as trace_api
    from opentelemetry.util._once import Once

    from jobctrl.infrastructure.observability import otel as otel_mod

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
    from jobctrl.infrastructure.observability import otel as otel_mod

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
    assert otel_mod._exporter._timeout == 5.0


def test_init_otel_honors_export_timeout_env(monkeypatch):
    _set_creds(monkeypatch)
    monkeypatch.setenv("LANGFUSE_OTEL_TIMEOUT_SECONDS", "1.5")
    from jobctrl.infrastructure.observability import otel as otel_mod

    otel_mod.init_otel()

    assert otel_mod._exporter is not None
    assert otel_mod._exporter._timeout == 1.5


def test_init_otel_is_idempotent(monkeypatch):
    _set_creds(monkeypatch)
    from jobctrl.infrastructure.observability import otel as otel_mod

    otel_mod.init_otel()
    first_provider = otel_mod._provider
    otel_mod.init_otel()
    assert otel_mod._provider is first_provider


def test_init_otel_with_missing_creds_does_not_configure(monkeypatch, caplog):
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_BASE_URL", raising=False)
    from jobctrl.infrastructure.observability import otel as otel_mod

    with caplog.at_level("WARNING"):
        otel_mod.init_otel()

    assert otel_mod.is_otel_enabled() is False
    assert otel_mod._provider is None
    # Warn the user so they know exports are off.
    assert any("Langfuse" in rec.message or "LANGFUSE" in rec.message for rec in caplog.records)


def test_init_otel_disabled_when_disable_env_set(monkeypatch, caplog):
    _set_creds(monkeypatch)
    monkeypatch.setenv("LANGFUSE_DISABLE", "1")
    from jobctrl.infrastructure.observability import otel as otel_mod

    with caplog.at_level("INFO"):
        otel_mod.init_otel()

    assert otel_mod.is_otel_enabled() is False
    assert otel_mod._provider is None


def test_init_otel_reports_metadata_only_export_without_raw_content_claims(monkeypatch, caplog):
    _set_creds(monkeypatch)
    from jobctrl.infrastructure.observability import otel as otel_mod

    with caplog.at_level("WARNING"):
        otel_mod.init_otel()

    startup_text = " ".join(rec.getMessage() for rec in caplog.records).lower()
    assert "metadata-only" in startup_text
    assert "model inputs and outputs are excluded" in startup_text
    assert "prompt" not in startup_text
    assert "completion" not in startup_text
    assert "pk-test" not in startup_text
    assert "sk-test" not in startup_text


def test_shutdown_otel_resets_state(monkeypatch):
    _set_creds(monkeypatch)
    from jobctrl.infrastructure.observability import otel as otel_mod

    otel_mod.init_otel()
    assert otel_mod._provider is not None
    otel_mod.shutdown_otel()
    assert otel_mod._provider is None
    assert otel_mod.is_otel_enabled() is False


def test_init_otel_sets_resource_attributes(monkeypatch):
    """The TracerProvider's Resource must carry the service identity Langfuse keys on."""
    _set_creds(monkeypatch)
    monkeypatch.setenv("JOBCTRL_ENV", "test")

    from jobctrl import __version__ as JOBCTRL_VERSION
    from jobctrl.infrastructure.observability import otel as otel_mod

    otel_mod.init_otel()

    provider = otel_mod._provider
    assert provider is not None
    attrs = dict(provider.resource.attributes)
    assert attrs["service.name"] == "jobctrl"
    assert attrs["service.version"] == JOBCTRL_VERSION
    assert attrs["deployment.environment"] == "test"

    # Reset and re-init without JOBCTRL_ENV — defaults to "local".
    otel_mod.shutdown_otel()
    monkeypatch.delenv("JOBCTRL_ENV", raising=False)
    # Allow set_tracer_provider to succeed again.
    from opentelemetry import trace as trace_api
    from opentelemetry.util._once import Once

    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(trace_api, "_TRACER_PROVIDER", None)

    otel_mod.init_otel()
    provider = otel_mod._provider
    assert provider is not None
    assert dict(provider.resource.attributes)["deployment.environment"] == "local"
