"""Security regressions for the path-free browser capability RPC boundary."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure.rpc import handlers


def _status(capability_id: str, status: str = "disabled") -> SimpleNamespace:
    return SimpleNamespace(
        id=capability_id,
        status=status,
        detail="Safe capability status.",
        executable="/secret/host/path/that-must-not-cross-rpc",
    )


def test_capability_list_never_returns_executable_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    from jobctrl import browser_capabilities

    monkeypatch.setattr(
        browser_capabilities,
        "list_browser_capabilities",
        lambda: (
            _status("core-browser", "ready"),
            _status("auto-apply-browser"),
            _status("authenticated-linkedin-browser"),
        ),
    )

    result = handlers.browser_capabilities_list({})

    assert "executable" not in json.dumps(result)
    assert "/secret/host/path" not in json.dumps(result)


def test_enable_rejects_invalid_executable_without_echo(monkeypatch: pytest.MonkeyPatch) -> None:
    from jobctrl import browser_capabilities

    selected = "/private/invalid-browser-path"

    def reject(_capability_id: str, _path: str) -> None:
        raise browser_capabilities.BrowserCapabilityError(f"invalid {selected}")

    monkeypatch.setattr(browser_capabilities, "enable_system_browser_capability", reject)

    with pytest.raises(Exception) as error:
        handlers.browser_capability_enable(
            {"capabilityId": "auto-apply-browser", "executablePath": selected}
        )

    assert selected not in str(error.value)


def test_profile_copy_requires_separate_versioned_ui_consent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import browser_capabilities

    copy = monkeypatch.setattr
    called: list[tuple[str, bool, str]] = []
    copy(
        browser_capabilities,
        "copy_authenticated_linkedin_profile",
        lambda source, *, consent, consent_method: called.append(
            (str(source), consent, consent_method)
        ),
    )
    copy(
        browser_capabilities,
        "list_browser_capabilities",
        lambda: (
            _status("core-browser", "ready"),
            _status("auto-apply-browser"),
            _status("authenticated-linkedin-browser", "ready"),
        ),
    )

    with pytest.raises(Exception):
        handlers.browser_profile_copy(
            {
                "sourceProfilePath": "/private/profile",
                "consent": True,
                "consentMethod": "explicit-cli",
            }
        )
    assert called == []

    response = handlers.browser_profile_copy(
        {
            "sourceProfilePath": "/private/profile",
            "consent": True,
            "consentMethod": "explicit-ui-v1",
        }
    )
    assert called == [("/private/profile", True, "explicit-ui-v1")]
    assert "/private/profile" not in json.dumps(response)


def test_disable_hot_revokes_without_returning_adopted_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import browser_capabilities

    disabled: list[str] = []
    monkeypatch.setattr(
        browser_capabilities,
        "disable_browser_capability",
        lambda capability_id: disabled.append(capability_id),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "list_browser_capabilities",
        lambda: (
            _status("core-browser", "ready"),
            _status("auto-apply-browser"),
            _status("authenticated-linkedin-browser"),
        ),
    )

    response = handlers.browser_capability_disable(
        {"capabilityId": "auto-apply-browser"}
    )

    assert disabled == ["auto-apply-browser"]
    assert response["capabilities"][1]["enabled"] is False
