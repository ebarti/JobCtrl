"""Security regressions for the path-free browser capability RPC boundary."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.infrastructure.rpc import handlers


PROFILE_ID = "profile-0123456789abcdef0123456789abcdef"


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
    monkeypatch.setattr(
        browser_capabilities,
        "detect_browser_profiles",
        lambda browser_id: (
            (
                SimpleNamespace(
                    id=PROFILE_ID,
                    label="Signed in",
                    directory_name="Profile 1",
                    user_data_root="/secret/detected/profile/path",
                ),
            )
            if browser_id == "google-chrome"
            else ()
        ),
    )

    result = handlers.browser_capabilities_list({})

    assert result["detectedBrowsers"] == [
        {
            "id": "google-chrome",
            "label": "Google Chrome",
            "defaultProfileAvailable": False,
            "profiles": [{"id": PROFILE_ID, "label": "Signed in"}],
        }
    ]
    assert "executable" not in json.dumps(result)
    assert "/secret/host/path" not in json.dumps(result)
    assert "/secret/detected/browser/path" not in json.dumps(result)
    assert "/secret/detected/profile/path" not in json.dumps(result)


def test_capability_list_disambiguates_duplicate_signed_in_labels_without_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome"
    (profile_root / "Default").mkdir(parents=True)
    (profile_root / "Profile 1").mkdir()
    (profile_root / "Profile 2").mkdir()
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "profile": {
                    "profiles_order": ["Default", "Profile 1", "Profile 2"],
                    "info_cache": {
                        "Default": {
                            "name": "Your Chrome",
                            "gaia_name": "E",
                            "user_name": "private@example.test",
                            "is_using_default_name": True,
                        },
                        "Profile 1": {
                            "name": "Chrome Person 1",
                            "gaia_name": "E",
                            "user_name": "other-private@example.test",
                            "is_using_default_name": True,
                        },
                        "Profile 2": {
                            "name": "E (1)",
                            "gaia_name": "Unused identity",
                            "user_name": "third-private@example.test",
                            "is_using_default_name": False,
                        },
                    },
                }
            }
        ),
        encoding="utf-8",
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
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            browser_capabilities.DetectedBrowser(
                "google-chrome",
                "Google Chrome",
                tmp_path / "Chrome executable",
            ),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda _browser_id: (profile_root,),
    )

    result = handlers.browser_capabilities_list({})
    serialized = json.dumps(result)

    assert [
        profile["label"]
        for profile in result["detectedBrowsers"][0]["profiles"]
    ] == ["E (2)", "E (3)", "E (1)"]
    assert len(
        {
            profile["label"]
            for profile in result["detectedBrowsers"][0]["profiles"]
        }
    ) == 3
    assert "Default" not in serialized
    assert "Profile 1" not in serialized
    assert "private@example.test" not in serialized
    assert "other-private@example.test" not in serialized
    assert "third-private@example.test" not in serialized
    assert str(profile_root) not in serialized


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


def test_profile_copy_accepts_a_detected_browser_without_crossing_a_host_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import browser_capabilities

    called: list[tuple[str, str | None, bool, str, bool]] = []
    monkeypatch.setattr(
        browser_capabilities,
        "copy_detected_authenticated_linkedin_profile",
        lambda browser_id, *, detected_profile_id, consent, consent_method, replace_existing: called.append(
            (browser_id, detected_profile_id, consent, consent_method, replace_existing)
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "list_browser_capabilities",
        lambda: (
            _status("core-browser", "ready"),
            _status("auto-apply-browser"),
            _status("authenticated-linkedin-browser", "ready"),
        ),
    )
    monkeypatch.setattr(browser_capabilities, "detect_supported_browsers", lambda: ())

    response = handlers.browser_profile_copy(
        {
            "detectedBrowserId": "google-chrome",
            "detectedProfileId": PROFILE_ID,
            "consent": True,
            "consentMethod": "explicit-ui-v1",
        }
    )

    assert called == [("google-chrome", PROFILE_ID, True, "explicit-ui-v1", True)]
    assert "sourceProfilePath" not in json.dumps(response)


def test_stale_detected_profile_error_does_not_expose_a_host_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import browser_capabilities

    secret_path = "/secret/browser/profile/path"

    def stale_profile(*_args, **_kwargs):
        raise browser_capabilities.DetectedBrowserProfileUnavailableError(
            f"missing: {secret_path}"
        )

    monkeypatch.setattr(
        browser_capabilities,
        "copy_detected_authenticated_linkedin_profile",
        stale_profile,
    )

    with pytest.raises(Exception) as caught:
        handlers.browser_profile_copy(
            {
                "detectedBrowserId": "google-chrome",
                "detectedProfileId": PROFILE_ID,
                "consent": True,
                "consentMethod": "explicit-ui-v1",
            }
        )

    assert "no longer available" in str(caught.value)
    assert secret_path not in str(caught.value)


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
