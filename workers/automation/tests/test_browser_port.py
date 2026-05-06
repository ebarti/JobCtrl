"""Phase 8 (S-29): BrowserPort contract — exercised via a fake adapter."""

from typing import Any

from jobhunter.domain.apply.value_objects import BrowserWorkerConfig
from jobhunter.domain.ports.apply import BrowserPort, BrowserSession


class _FakeBrowserAdapter:
    """In-memory ``BrowserPort`` implementation."""

    def __init__(self):
        self.sessions: list[BrowserSession] = []
        self.cleaned: list[BrowserSession] = []

    def launch(self, config: BrowserWorkerConfig) -> BrowserSession:
        session = BrowserSession(
            config=config,
            pid=1000 + config.worker_id,
            worker_dir=f"/tmp/worker-{config.worker_id}",
            handle={"fake": True},
        )
        self.sessions.append(session)
        return session

    def cleanup(self, session: BrowserSession) -> None:
        self.cleaned.append(session)


def _assert_implements_port(adapter: Any) -> None:
    """Static-style structural check: the adapter satisfies BrowserPort."""
    assert callable(getattr(adapter, "launch", None))
    assert callable(getattr(adapter, "cleanup", None))


def test_fake_adapter_satisfies_browser_port_contract():
    adapter = _FakeBrowserAdapter()
    _assert_implements_port(adapter)
    config = BrowserWorkerConfig(worker_id=2, cdp_port=9224, headless=True)
    session = adapter.launch(config)
    assert session.cdp_port == 9224
    assert session.worker_id == 2
    assert session.pid == 1002

    adapter.cleanup(session)
    assert adapter.cleaned == [session]


def test_browser_session_exposes_config_helpers():
    config = BrowserWorkerConfig(worker_id=0, cdp_port=9222, headless=False)
    session = BrowserSession(config=config, pid=42)
    assert session.cdp_port == 9222
    assert session.worker_id == 0
    assert session.config is config


def test_browser_port_is_a_protocol_type():
    """``isinstance(adapter, BrowserPort)`` is intentionally NOT supported
    (Protocols aren't runtime-checkable by default); but the type alias
    must at least be importable so adapters can declare conformance."""
    assert BrowserPort.__name__ == "BrowserPort"
