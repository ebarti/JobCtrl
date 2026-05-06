"""Phase 5 / S-17: LlmPort protocol + LlmAdapter wiring.

Verifies that:
  * The adapter satisfies the ``LlmPort`` protocol structurally.
  * Calling ``chat`` translates ``LlmMessage`` value objects into the
    underlying client's expected dict format.
  * ``temperature`` and ``max_tokens`` are forwarded as kwargs only when
    set (the protocol allows ``None`` to mean "use provider default").
  * ``ask`` collapses a single prompt string into a one-message chat call.
"""

from __future__ import annotations

from typing import Any

from jobhunter.domain.ports.llm import LlmMessage, LlmPort
from jobhunter.infrastructure.llm.llm_client import LlmAdapter


class _FakeClient:
    """Stand-in for ``jobhunter.llm.LLMClient``.

    Records every ``chat`` call so the adapter's translation layer is
    observable. ``model`` is exposed so the adapter's model-mismatch guard
    can fire.
    """

    def __init__(self, *, response: str = "ok", model: str = "test-model") -> None:
        self.response = response
        self.model = model
        self.calls: list[dict[str, Any]] = []

    def chat(self, messages: list[dict[str, Any]], **kwargs: Any) -> str:
        self.calls.append({"messages": messages, "kwargs": kwargs})
        return self.response


def test_llm_adapter_satisfies_port_protocol() -> None:
    adapter: LlmPort = LlmAdapter(client=_FakeClient())  # type: ignore[arg-type]
    assert callable(adapter.chat)
    assert callable(adapter.ask)


def test_llm_adapter_translates_messages_to_dict_format() -> None:
    fake = _FakeClient(response="42")
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]

    response = adapter.chat(
        [
            LlmMessage(role="system", content="be brief"),
            LlmMessage(role="user", content="hello"),
        ],
    )
    assert response == "42"
    assert len(fake.calls) == 1
    assert fake.calls[0]["messages"] == [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hello"},
    ]


def test_llm_adapter_omits_unset_kwargs() -> None:
    fake = _FakeClient()
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]
    adapter.chat([LlmMessage(role="user", content="hi")])
    assert fake.calls[0]["kwargs"] == {}


def test_llm_adapter_forwards_set_kwargs() -> None:
    fake = _FakeClient()
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]
    adapter.chat(
        [LlmMessage(role="user", content="hi")],
        temperature=0.5,
        max_tokens=128,
    )
    assert fake.calls[0]["kwargs"] == {"temperature": 0.5, "max_tokens": 128}


def test_llm_adapter_rejects_mismatched_model() -> None:
    fake = _FakeClient(model="real-model")
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]
    try:
        adapter.chat([LlmMessage(role="user", content="hi")], model="other")
    except ValueError as exc:
        assert "real-model" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("Expected ValueError on model mismatch")


def test_llm_adapter_ask_collapses_to_single_message_chat() -> None:
    fake = _FakeClient()
    adapter = LlmAdapter(client=fake)  # type: ignore[arg-type]
    adapter.ask("ping")
    assert fake.calls[0]["messages"] == [{"role": "user", "content": "ping"}]
