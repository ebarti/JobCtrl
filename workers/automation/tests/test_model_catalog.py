from __future__ import annotations

from types import SimpleNamespace

from jobctrl.infrastructure.llm.model_catalog import provider_model_catalog


class _FakeCodex:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def models(self, *, include_hidden: bool):
        assert include_hidden is False
        return SimpleNamespace(
            data=[
                SimpleNamespace(
                    model="gpt-test", display_name="GPT Test", hidden=False, is_default=True
                ),
                SimpleNamespace(
                    model="gpt-test", display_name="Duplicate", hidden=False, is_default=False
                ),
                SimpleNamespace(
                    model="hidden", display_name="Hidden", hidden=True, is_default=False
                ),
            ]
        )


class _FakeClaude:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get_server_info(self) -> dict[str, list[dict[str, str]]]:
        return {
            "models": [
                {"value": "claude-sonnet-5", "display_name": "Sonnet"},
                {"value": "claude-sonnet-4-6", "display_name": "Sonnet 4.6"},
                {
                    "value": "claude-sonnet-4-6[1m]",
                    "display_name": "Sonnet 4.6 (1M context)",
                },
                {"value": "claude-fable-5", "display_name": "Fable"},
                {"value": "opus", "display_name": "claude-opus-4-8"},
                {"value": "haiku", "display_name": "Haiku"},
                {"value": "default", "display_name": "Default"},
                {"value": "claude-sonnet-5", "display_name": "Duplicate"},
            ]
        }

class _FakeGoogleModels:
    def list(self, *, config):
        assert config == {"query_base": True}
        return [
            SimpleNamespace(
                name="models/gemini-test",
                display_name="Gemini Test",
                supported_actions=["generateContent"],
            ),
            SimpleNamespace(
                name="models/embedding-test",
                display_name="Embedding",
                supported_actions=["embedContent"],
            ),
            SimpleNamespace(
                name="models/gemini-test",
                display_name="Duplicate",
                supported_actions=["generateContent"],
            ),
        ]


class _FakeGoogleClient:
    def __init__(self):
        self.models = _FakeGoogleModels()
        self.closed = False

    def close(self):
        self.closed = True


def _ready_status(provider: str) -> dict[str, object]:
    return {"provider": provider, "configured": True, "ready": True}


def test_catalog_is_stable_secret_free_and_uses_live_or_alias_sources() -> None:
    google = _FakeGoogleClient()

    catalog = provider_model_catalog(
        status_loader=_ready_status,
        codex_factory=_FakeCodex,
        claude_factory=_FakeClaude,
        google_client_factory=lambda: google,
    )

    assert [item["provider"] for item in catalog["providers"]] == ["codex", "claude", "google"]
    assert catalog["providers"][0]["models"] == [
        {"id": "gpt-test", "displayName": "GPT Test", "isDefault": True}
    ]
    assert catalog["providers"][1]["source"] == "live"
    assert catalog["providers"][1]["models"] == [
        {"id": "claude-sonnet-5", "displayName": "Sonnet"},
        {"id": "claude-sonnet-4-6", "displayName": "Sonnet 4.6"},
        {"id": "claude-sonnet-4-6[1m]", "displayName": "Sonnet 4.6 (1M context)"},
        {"id": "claude-fable-5", "displayName": "Fable"},
        {"id": "opus", "displayName": "claude-opus-4-8"},
        {"id": "haiku", "displayName": "Haiku"},
    ]
    assert catalog["providers"][2]["models"] == [
        {"id": "gemini-test", "displayName": "Gemini Test"}
    ]
    assert google.closed is True
    assert "account" not in repr(catalog).lower()
    assert "token" not in repr(catalog).lower()


def test_unready_providers_do_not_construct_sdks_or_return_models() -> None:
    def fail_factory():
        raise AssertionError("SDK factory must not be called")

    catalog = provider_model_catalog(
        status_loader=lambda provider: {"provider": provider, "configured": False, "ready": False},
        codex_factory=fail_factory,
        claude_factory=fail_factory,
        google_client_factory=fail_factory,
    )

    assert all(item["models"] == [] for item in catalog["providers"])
    assert all(item["message"] == "Provider is not configured." for item in catalog["providers"])


def test_live_catalog_failures_are_sanitized() -> None:
    marker = "secret-account-token"

    def fail_factory():
        raise RuntimeError(marker)

    catalog = provider_model_catalog(
        status_loader=_ready_status,
        codex_factory=fail_factory,
        claude_factory=fail_factory,
        google_client_factory=fail_factory,
    )

    assert catalog["providers"][0]["models"] == []
    assert catalog["providers"][0]["message"] == "Live model catalog is temporarily unavailable."
    assert catalog["providers"][1]["message"] == "Live model catalog is temporarily unavailable."
    assert catalog["providers"][2]["message"] == "Live model catalog is temporarily unavailable."
    assert marker not in repr(catalog)
