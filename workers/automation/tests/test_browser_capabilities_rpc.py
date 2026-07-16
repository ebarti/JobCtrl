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
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            SimpleNamespace(
                id="google-chrome",
                label="Google Chrome",
                executable="/secret/detected/browser/path",
            ),
        ),
    )

    result = handlers.browser_capabilities_list({})

    assert result["detectedBrowsers"] == [{"id": "google-chrome", "label": "Google Chrome"}]
    assert "executable" not in json.dumps(result)
    assert "/secret/host/path" not in json.dumps(result)
    assert "/secret/detected/browser/path" not in json.dumps(result)


def test_enable_accepts_an_explicit_detected_browser_id(monkeypatch: pytest.MonkeyPatch) -> None:
    from jobctrl import browser_capabilities

    enabled: list[tuple[str, str]] = []
    monkeypatch.setattr(
        browser_capabilities,
        "enable_detected_browser_capability",
        lambda capability_id, browser_id: enabled.append((capability_id, browser_id)),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "list_browser_capabilities",
        lambda: (
            _status("core-browser", "ready"),
            _status("auto-apply-browser", "ready"),
            _status("authenticated-linkedin-browser"),
        ),
    )
    monkeypatch.setattr(browser_capabilities, "detect_supported_browsers", lambda: ())

    response = handlers.browser_capability_enable(
        {"capabilityId": "auto-apply-browser", "detectedBrowserId": "google-chrome"}
    )

    assert enabled == [("auto-apply-browser", "google-chrome")]
    assert response["capabilities"][1]["enabled"] is True


def test_stale_detected_browser_returns_a_sanitized_validation_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import browser_capabilities

    def reject(_capability_id: str, _browser_id: str) -> None:
        raise browser_capabilities.DetectedBrowserUnavailableError(
            "private candidate details must not cross RPC"
        )

    monkeypatch.setattr(browser_capabilities, "enable_detected_browser_capability", reject)

    with pytest.raises(Exception) as error:
        handlers.browser_capability_enable(
            {"capabilityId": "auto-apply-browser", "detectedBrowserId": "google-chrome"}
        )

    assert str(error.value) == "The selected detected browser is no longer available."
    assert "private candidate details" not in str(error.value)


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
