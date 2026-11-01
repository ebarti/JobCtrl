"""Tests for the OTel bootstrap that wires JobCtrl into Langfuse."""

from __future__ import annotations

import base64
import http.server
import threading

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


@pytest.fixture
def observed_otlp(monkeypatch):
    """Observe real OTLP requests without depending on SDK transport internals."""
    from jobctrl.infrastructure.observability import otel as otel_mod

    _set_creds(monkeypatch)
    monkeypatch.setenv("LANGFUSE_DISABLE", "0")
    for name in ("OTEL_EXPORTER_OTLP_COMPRESSION", "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION"):
        monkeypatch.delenv(name, raising=False)
    observed = {"requests": [], "configuration": None}

    class Receiver(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            observed["requests"].append({
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "ingestion_version": self.headers.get("x-langfuse-ingestion-version"),
                "content_type": self.headers.get("Content-Type"),
                "body": body,
            })
            self.send_response(200)
            self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("LANGFUSE_BASE_URL", base_url)
    exporter_type = otel_mod.OTLPSpanExporter

    def construct_exporter(**kwargs):
        observed["configuration"] = kwargs
        return exporter_type(**kwargs)

    monkeypatch.setattr(otel_mod, "OTLPSpanExporter", construct_exporter)
    try:
        yield observed
    finally:
        otel_mod.shutdown_otel()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _observe_export(otel_mod, observed):
    with otel_mod._provider.get_tracer("owned.otel-check").start_as_current_span("owned-dependency-export"):
        pass
    assert otel_mod._provider.force_flush(timeout_millis=3000)
    assert len(observed["requests"]) == 1
    request = observed["requests"][0]
    assert request["path"] == "/api/public/otel/v1/traces"
    assert request["content_type"] == "application/x-protobuf"
    assert b"owned-dependency-export" in request["body"]
    return request


def test_init_otel_with_full_creds_configures_provider(observed_otlp):
    from jobctrl.infrastructure.observability import otel as otel_mod

    otel_mod.init_otel()

    assert otel_mod.is_otel_enabled() is True
    assert otel_mod._provider is not None
    assert otel_mod._exporter is not None
    request = _observe_export(otel_mod, observed_otlp)
    expected = base64.b64encode(b"pk-test:sk-test").decode("ascii")
    assert request["authorization"] == f"Basic {expected}"
    assert request["ingestion_version"] == "4"
    assert observed_otlp["configuration"]["timeout"] == 5.0


def test_init_otel_honors_export_timeout_env(monkeypatch, observed_otlp):
    monkeypatch.setenv("LANGFUSE_OTEL_TIMEOUT_SECONDS", "1.5")
    from jobctrl.infrastructure.observability import otel as otel_mod

    otel_mod.init_otel()

    assert otel_mod._exporter is not None
    _observe_export(otel_mod, observed_otlp)
    assert observed_otlp["configuration"]["timeout"] == 1.5


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
