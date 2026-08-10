"""Regression coverage for explicit, install-scoped browser capabilities."""

from __future__ import annotations

import json
import os
import stat
import sys
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest

from jobctrl.browser_capabilities import (
    BrowserCapabilityDisabledError,
    BrowserCapabilityError,
    BrowserProfileConsentRequiredError,
    DetectedBrowser,
    DetectedBrowserUnavailableError,
    browser_capability_status,
    capability_profile_dir,
    browser_capability_config_path,
    copy_authenticated_linkedin_profile,
    copy_detected_authenticated_linkedin_profile,
    detect_browser_profiles,
    detect_default_browser_profile,
    detect_supported_browsers,
    disable_browser_capability,
    enable_detected_browser_capability,
    enable_system_browser_capability,
    list_browser_capabilities,
    load_browser_capability_state,
    require_authenticated_linkedin_profile,
    require_system_browser_capability,
    system_browser_capability_is_enabled,
)


@pytest.fixture()
def browser_executable(tmp_path: Path) -> Path:
    executable = tmp_path / "Chromium"
    executable.write_text("#!/bin/sh\necho 'Chromium 145.0.0.0'\n", encoding="utf-8")
    executable.chmod(0o700)
    return executable


def test_new_install_keeps_optional_authenticated_browsers_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import config
    from jobctrl.infrastructure import preflight

    monkeypatch.setattr(preflight, "check_playwright_chromium", lambda: (True, "managed Chromium"))
    monkeypatch.setattr(
        config,
        "get_chrome_path",
        lambda: (_ for _ in ()).throw(AssertionError("system Chrome must not be probed")),
    )
    statuses = {item.id: item for item in list_browser_capabilities(app_dir=tmp_path)}

    assert statuses["core-browser"].status == "ready"
    assert statuses["auto-apply-browser"].status == "disabled"
    assert statuses["authenticated-linkedin-browser"].status == "disabled"
    assert not browser_capability_config_path(app_dir=tmp_path).exists()


def test_detection_is_preference_ordered_and_does_not_adopt_or_launch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    google = tmp_path / "Google Chrome"
    chromium = tmp_path / "Chromium"
    for executable in (google, chromium):
        executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        executable.chmod(0o700)
    monkeypatch.setattr(
        browser_capabilities,
        "_browser_candidate_locations",
        lambda: (
            DetectedBrowser("google-chrome", "Google Chrome", google),
            DetectedBrowser("chromium", "Chromium", chromium),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("detection must not launch a browser")
        ),
    )

    detected = detect_supported_browsers()

    assert [(browser.id, browser.label) for browser in detected] == [
        ("google-chrome", "Google Chrome"),
        ("chromium", "Chromium"),
    ]
    assert not browser_capability_config_path(app_dir=tmp_path).exists()


def test_macos_candidate_order_prefers_google_chrome(monkeypatch: pytest.MonkeyPatch) -> None:
    from jobctrl import browser_capabilities

    monkeypatch.setattr(browser_capabilities.sys, "platform", "darwin")

    candidates = browser_capabilities._browser_candidate_locations()
    ids = [candidate.id for candidate in candidates]

    assert ids[0] == "google-chrome"
    assert ids.index("chromium") > max(
        index for index, browser_id in enumerate(ids) if browser_id == "google-chrome"
    )


def test_default_profile_detection_requires_a_supported_browser_and_standard_default_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome"
    (profile_root / "Default").mkdir(parents=True)
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser(
                "google-chrome",
                "Google Chrome",
                tmp_path / "Chrome executable",
            ),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda browser_id: (profile_root,) if browser_id == "google-chrome" else (),
    )

    assert detect_default_browser_profile("google-chrome") == profile_root
    assert detect_default_browser_profile("chromium") is None


def test_profile_detection_lists_safe_labels_with_opaque_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome"
    (profile_root / "Default").mkdir(parents=True)
    (profile_root / "Profile 1").mkdir()
    (profile_root / "System Profile").mkdir()
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "profile": {
                    "last_used": "Profile 1",
                    "profiles_order": ["Profile 1", "Default"],
                    "info_cache": {
                        "Default": {"name": "Personal"},
                        "Profile 1": {"name": "Work"},
                        "System Profile": {"name": "Private system data"},
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser(
                "google-chrome",
                "Google Chrome",
                tmp_path / "Chrome executable",
            ),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda browser_id: (profile_root,) if browser_id == "google-chrome" else (),
    )

    profiles = detect_browser_profiles("google-chrome")

    assert [profile.label for profile in profiles] == ["Work", "Personal"]
    assert all(
        profile.id.startswith("profile-") and len(profile.id) == 40
        for profile in profiles
    )
    assert str(profile_root) not in repr(
        [(profile.id, profile.label) for profile in profiles]
    )


def test_profile_detection_uses_gaia_name_only_for_chrome_default_labels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome"
    (profile_root / "Default").mkdir(parents=True)
    (profile_root / "Profile 1").mkdir()
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "profile": {
                    "profiles_order": ["Default", "Profile 1"],
                    "info_cache": {
                        "Default": {
                            "name": "Your Chrome",
                            "gaia_name": "E",
                            "user_name": "private@example.test",
                            "is_using_default_name": True,
                        },
                        "Profile 1": {
                            "name": "Work",
                            "gaia_name": "Other identity",
                            "user_name": "other-private@example.test",
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
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser(
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

    profiles = detect_browser_profiles("google-chrome")

    assert [profile.label for profile in profiles] == ["E", "Work"]
    assert "private@example.test" not in repr(profiles)
    assert "other-private@example.test" not in repr(profiles)


def test_profile_detection_bounds_non_bmp_labels_to_the_rpc_contract(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome"
    (profile_root / "Default").mkdir(parents=True)
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "profile": {
                    "info_cache": {
                        "Default": {"name": "🚀" * 80},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser(
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

    (profile,) = detect_browser_profiles("google-chrome")

    assert len(profile.label.encode("utf-16-le")) // 2 == 80
    assert profile.label == "🚀" * 40


def test_detected_profile_copy_resolves_the_host_path_without_a_caller_path(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome profile"
    default_profile = profile_root / "Default"
    default_profile.mkdir(parents=True)
    (default_profile / "Preferences").write_text("{}", encoding="utf-8")
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "os_crypt": {"encrypted_key": "required"},
                "profile": {
                    "last_used": "Profile 1",
                    "info_cache": {
                        "Default": {"name": "Default"},
                        "Profile 1": {"name": "Private sibling"},
                    },
                },
                "unrelated_root_metadata": {"account": "outside consent"},
            }
        ),
        encoding="utf-8",
    )
    sibling_profile = profile_root / "Profile 1"
    sibling_profile.mkdir()
    (sibling_profile / "Cookies").write_text("sibling session", encoding="utf-8")
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser("google-chrome", "Google Chrome", browser_executable),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda _browser_id: (profile_root,),
    )
    enable_system_browser_capability(
        "authenticated-linkedin-browser", browser_executable, app_dir=tmp_path
    )

    destination = copy_detected_authenticated_linkedin_profile(
        "google-chrome", consent=True, app_dir=tmp_path
    )

    assert (destination / "Default" / "Preferences").read_text(encoding="utf-8") == "{}"
    copied_local_state = json.loads(
        (destination / "Local State").read_text(encoding="utf-8")
    )
    assert copied_local_state == {
        "os_crypt": {"encrypted_key": "required"},
        "profile": {
            "info_cache": {"Default": {"name": "Default"}},
            "last_active_profiles": ["Default"],
            "last_used": "Default",
            "profiles_order": ["Default"],
        },
    }
    assert not (destination / "Profile 1").exists()


def test_detected_profile_copy_normalizes_the_explicitly_selected_profile(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome profile"
    (profile_root / "Default").mkdir(parents=True)
    (profile_root / "Default" / "Cookies").write_text("default", encoding="utf-8")
    (profile_root / "Profile 1").mkdir()
    (profile_root / "Profile 1" / "Cookies").write_text("selected", encoding="utf-8")
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "os_crypt": {"encrypted_key": "required"},
                "profile": {
                    "last_used": "Profile 1",
                    "info_cache": {
                        "Default": {"name": "Default"},
                        "Profile 1": {"name": "Signed in"},
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser("google-chrome", "Google Chrome", browser_executable),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda _browser_id: (profile_root,),
    )
    enable_system_browser_capability(
        "authenticated-linkedin-browser", browser_executable, app_dir=tmp_path
    )
    selected = next(
        profile
        for profile in detect_browser_profiles("google-chrome")
        if profile.label == "Signed in"
    )

    destination = copy_detected_authenticated_linkedin_profile(
        "google-chrome",
        detected_profile_id=selected.id,
        consent=True,
        app_dir=tmp_path,
    )

    assert (destination / "Default" / "Cookies").read_text(encoding="utf-8") == "selected"
    assert not (destination / "Profile 1").exists()
    copied_local_state = json.loads(
        (destination / "Local State").read_text(encoding="utf-8")
    )
    assert copied_local_state["profile"]["info_cache"] == {
        "Default": {"name": "Signed in"}
    }


def test_detected_profile_metadata_is_sanitized_before_destination_publish(
    tmp_path: Path,
    browser_executable: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome profile"
    (profile_root / "Default").mkdir(parents=True)
    (profile_root / "Local State").write_text(
        '{"profile":{"info_cache":{"Profile 1":{"name":"Private"}}}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser("google-chrome", "Google Chrome", browser_executable),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda _browser_id: (profile_root,),
    )
    enable_system_browser_capability(
        "authenticated-linkedin-browser",
        browser_executable,
        app_dir=tmp_path,
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_sanitize_detected_profile_local_state_at",
        lambda _descriptor, _profile_name: (_ for _ in ()).throw(
            RuntimeError("interrupted")
        ),
    )

    with pytest.raises(BrowserCapabilityError):
        copy_detected_authenticated_linkedin_profile(
            "google-chrome",
            consent=True,
            app_dir=tmp_path,
        )

    assert not capability_profile_dir(
        "authenticated-linkedin-browser",
        app_dir=tmp_path,
    ).exists()
    assert list((tmp_path / "browser-profiles").glob(".*.copy-*")) == []


def test_explicit_detected_profile_replaces_an_existing_owned_copy_after_staging(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome profile"
    (profile_root / "Default").mkdir(parents=True)
    (profile_root / "Default" / "Cookies").write_text("old", encoding="utf-8")
    (profile_root / "Profile 1").mkdir()
    (profile_root / "Profile 1" / "Cookies").write_text("new", encoding="utf-8")
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "profile": {
                    "info_cache": {
                        "Default": {"name": "Old"},
                        "Profile 1": {"name": "New"},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser("google-chrome", "Google Chrome", browser_executable),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda _browser_id: (profile_root,),
    )
    enable_system_browser_capability(
        "authenticated-linkedin-browser", browser_executable, app_dir=tmp_path
    )
    copy_detected_authenticated_linkedin_profile(
        "google-chrome", consent=True, app_dir=tmp_path
    )
    selected = next(
        profile
        for profile in detect_browser_profiles("google-chrome")
        if profile.label == "New"
    )

    destination = copy_detected_authenticated_linkedin_profile(
        "google-chrome",
        detected_profile_id=selected.id,
        consent=True,
        app_dir=tmp_path,
        replace_existing=True,
    )

    assert (destination / "Default" / "Cookies").read_text(encoding="utf-8") == "new"
    assert list((tmp_path / "browser-profiles").glob(".*.replaced-*")) == []


def test_failed_detected_profile_replacement_preserves_the_existing_copy(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome profile"
    (profile_root / "Default").mkdir(parents=True)
    (profile_root / "Default" / "Cookies").write_text("old", encoding="utf-8")
    (profile_root / "Profile 1").mkdir()
    (profile_root / "Profile 1" / "Cookies").write_text("new", encoding="utf-8")
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "profile": {
                    "info_cache": {
                        "Default": {"name": "Old"},
                        "Profile 1": {"name": "New"},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser("google-chrome", "Google Chrome", browser_executable),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda _browser_id: (profile_root,),
    )
    enable_system_browser_capability(
        "authenticated-linkedin-browser", browser_executable, app_dir=tmp_path
    )
    destination = copy_detected_authenticated_linkedin_profile(
        "google-chrome", consent=True, app_dir=tmp_path
    )
    selected = next(
        profile
        for profile in detect_browser_profiles("google-chrome")
        if profile.label == "New"
    )
    original_copy_directory = browser_capabilities._copy_profile_directory

    def interrupted_copy(*args, **kwargs) -> None:
        original_copy_directory(*args, **kwargs)
        raise RuntimeError("interrupted before publish")

    monkeypatch.setattr(browser_capabilities, "_copy_profile_directory", interrupted_copy)

    with pytest.raises(BrowserCapabilityError):
        copy_detected_authenticated_linkedin_profile(
            "google-chrome",
            detected_profile_id=selected.id,
            consent=True,
            app_dir=tmp_path,
            replace_existing=True,
        )

    assert (destination / "Default" / "Cookies").read_text(encoding="utf-8") == "old"
    assert list((tmp_path / "browser-profiles").glob(".*.copy-*")) == []


def test_profile_replacement_restores_existing_copy_when_capability_changes_after_publish(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome profile"
    (profile_root / "Default").mkdir(parents=True)
    (profile_root / "Default" / "Cookies").write_text("old", encoding="utf-8")
    (profile_root / "Profile 1").mkdir()
    (profile_root / "Profile 1" / "Cookies").write_text("new", encoding="utf-8")
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "profile": {
                    "info_cache": {
                        "Default": {"name": "Old"},
                        "Profile 1": {"name": "New"},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser("google-chrome", "Google Chrome", browser_executable),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda _browser_id: (profile_root,),
    )
    enable_system_browser_capability(
        "authenticated-linkedin-browser", browser_executable, app_dir=tmp_path
    )
    destination = copy_detected_authenticated_linkedin_profile(
        "google-chrome", consent=True, app_dir=tmp_path
    )
    selected = next(
        profile
        for profile in detect_browser_profiles("google-chrome")
        if profile.label == "New"
    )
    original_copy_profile_tree = browser_capabilities._copy_profile_tree

    def copied_then_revoked(*args, **kwargs):
        replaced_name = original_copy_profile_tree(*args, **kwargs)
        disable_browser_capability(
            "authenticated-linkedin-browser",
            app_dir=tmp_path,
        )
        return replaced_name

    monkeypatch.setattr(browser_capabilities, "_copy_profile_tree", copied_then_revoked)

    with pytest.raises(
        BrowserCapabilityError,
        match="changed while the profile was copied",
    ):
        copy_detected_authenticated_linkedin_profile(
            "google-chrome",
            detected_profile_id=selected.id,
            consent=True,
            app_dir=tmp_path,
            replace_existing=True,
        )

    assert (destination / "Default" / "Cookies").read_text(encoding="utf-8") == "old"
    assert list((tmp_path / "browser-profiles").glob(".*.replaced-*")) == []


def test_concurrent_profile_replacement_waits_for_failed_rollback_before_publishing(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    profile_root = tmp_path / "Chrome profile"
    for directory_name, cookie in (
        ("Default", "old"),
        ("Profile 1", "replacement-a"),
        ("Profile 2", "replacement-b"),
    ):
        profile_directory = profile_root / directory_name
        profile_directory.mkdir(parents=True)
        (profile_directory / "Cookies").write_text(cookie, encoding="utf-8")
    (profile_root / "Local State").write_text(
        json.dumps(
            {
                "profile": {
                    "info_cache": {
                        "Default": {"name": "Old"},
                        "Profile 1": {"name": "Replacement A"},
                        "Profile 2": {"name": "Replacement B"},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        browser_capabilities,
        "detect_supported_browsers",
        lambda: (
            DetectedBrowser("google-chrome", "Google Chrome", browser_executable),
        ),
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_default_browser_profile_locations",
        lambda _browser_id: (profile_root,),
    )
    enable_system_browser_capability(
        "authenticated-linkedin-browser", browser_executable, app_dir=tmp_path
    )
    destination = copy_detected_authenticated_linkedin_profile(
        "google-chrome", consent=True, app_dir=tmp_path
    )
    profiles = detect_browser_profiles("google-chrome")
    selected_a = next(
        profile for profile in profiles if profile.label == "Replacement A"
    )
    selected_b = next(
        profile for profile in profiles if profile.label == "Replacement B"
    )

    a_validation_started = threading.Event()
    allow_a_failure = threading.Event()
    b_attempted = threading.Event()
    b_copy_started = threading.Event()
    errors: dict[str, Exception] = {}
    a_state_transactions = 0
    original_state_transaction = browser_capabilities._browser_capability_state_transaction
    original_copy_profile_tree = browser_capabilities._copy_profile_tree

    @contextmanager
    def controlled_state_transaction(*args, **kwargs):
        nonlocal a_state_transactions
        if threading.current_thread().name == "replacement-a":
            a_state_transactions += 1
            if a_state_transactions == 2:
                a_validation_started.set()
                assert allow_a_failure.wait(timeout=5)
                raise browser_capabilities.BrowserCapabilityStateError(
                    "forced post-publish validation failure"
                )
        with original_state_transaction(*args, **kwargs) as state:
            yield state

    def observed_copy_profile_tree(*args, **kwargs):
        if threading.current_thread().name == "replacement-b":
            b_copy_started.set()
        return original_copy_profile_tree(*args, **kwargs)

    monkeypatch.setattr(
        browser_capabilities,
        "_browser_capability_state_transaction",
        controlled_state_transaction,
    )
    monkeypatch.setattr(
        browser_capabilities,
        "_copy_profile_tree",
        observed_copy_profile_tree,
    )

    def replace(name: str, profile_id: str) -> None:
        if name == "replacement-b":
            b_attempted.set()
        try:
            copy_detected_authenticated_linkedin_profile(
                "google-chrome",
                detected_profile_id=profile_id,
                consent=True,
                app_dir=tmp_path,
                replace_existing=True,
            )
        except Exception as exc:
            errors[name] = exc

    replacement_a = threading.Thread(
        target=replace,
        args=("replacement-a", selected_a.id),
        name="replacement-a",
    )
    replacement_b = threading.Thread(
        target=replace,
        args=("replacement-b", selected_b.id),
        name="replacement-b",
    )

    replacement_a.start()
    assert a_validation_started.wait(timeout=5)
    replacement_b.start()
    assert b_attempted.wait(timeout=5)
    assert not b_copy_started.wait(timeout=0.2)
    allow_a_failure.set()
    replacement_a.join(timeout=5)
    replacement_b.join(timeout=5)

    assert not replacement_a.is_alive()
    assert not replacement_b.is_alive()
    assert isinstance(errors.get("replacement-a"), BrowserCapabilityError)
    assert "replacement-b" not in errors
    assert b_copy_started.is_set()
    assert (
        destination / "Default" / "Cookies"
    ).read_text(encoding="utf-8") == "replacement-b"
    assert list((tmp_path / "browser-profiles").glob(".*.copy-*")) == []
    assert list((tmp_path / "browser-profiles").glob(".*.replaced-*")) == []


def test_explicit_detected_browser_id_is_resolved_and_enabled(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    monkeypatch.setattr(
        browser_capabilities,
        "_browser_candidate_locations",
        lambda: (DetectedBrowser("google-chrome", "Google Chrome", browser_executable),),
    )

    status = enable_detected_browser_capability(
        "auto-apply-browser", "google-chrome", app_dir=tmp_path
    )

    assert status.status == "ready"
    assert require_system_browser_capability("auto-apply-browser", app_dir=tmp_path) == browser_executable.resolve()


def test_detected_browser_id_fails_closed_when_installation_disappears(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    monkeypatch.setattr(
        browser_capabilities,
        "_browser_candidate_locations",
        lambda: (DetectedBrowser("google-chrome", "Google Chrome", browser_executable),),
    )
    assert detect_supported_browsers()[0].id == "google-chrome"
    browser_executable.unlink()

    with pytest.raises(DetectedBrowserUnavailableError, match="no longer available"):
        enable_detected_browser_capability(
            "auto-apply-browser", "google-chrome", app_dir=tmp_path
        )

    assert not browser_capability_config_path(app_dir=tmp_path).exists()


def test_core_browser_reports_managed_chromium_unavailable_without_system_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import config
    from jobctrl.infrastructure import preflight

    monkeypatch.setattr(preflight, "check_playwright_chromium", lambda: (False, "not installed"))
    monkeypatch.setattr(
        config,
        "get_chrome_path",
        lambda: (_ for _ in ()).throw(AssertionError("system Chrome must not be probed")),
    )

    status = browser_capability_status("core-browser", app_dir=tmp_path)

    assert status.status == "unavailable"
    assert "not installed" in status.detail


def test_disabled_browser_cannot_be_read_or_launched(tmp_path: Path) -> None:
    with pytest.raises(BrowserCapabilityDisabledError, match="auto-apply-browser is disabled"):
        require_system_browser_capability("auto-apply-browser", app_dir=tmp_path)


def test_chrome_launch_checks_capability_before_creating_a_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl.apply import chrome

    accessed: list[int] = []
    monkeypatch.setattr(
        chrome,
        "require_system_browser_capability",
        lambda _capability: require_system_browser_capability("auto-apply-browser", app_dir=tmp_path),
    )
    monkeypatch.setattr(chrome, "setup_worker_profile", lambda worker_id: accessed.append(worker_id))

    with pytest.raises(BrowserCapabilityDisabledError):
        chrome.launch_chrome(
            worker_id=1,
            port=9922,
            approved_application_url="https://apply.example.com/job",
        )

    assert accessed == []


def test_enabled_auto_apply_launch_uses_a_clean_owned_profile_without_host_copy(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl.apply import chrome

    class _FakeProcess:
        pid = 4242

        def poll(self) -> None:
            return None

    enable_system_browser_capability("auto-apply-browser", browser_executable, app_dir=tmp_path)
    worker_root = tmp_path / "apply-workers"
    monkeypatch.setattr(chrome.config, "CHROME_WORKER_DIR", worker_root)
    monkeypatch.setattr(
        chrome,
        "require_system_browser_capability",
        lambda _capability: browser_executable,
    )
    monkeypatch.setattr(
        chrome.config,
        "get_chrome_user_data",
        lambda: (_ for _ in ()).throw(AssertionError("host profile must not be read")),
    )
    monkeypatch.setattr(chrome, "_kill_on_port", lambda _port: None)
    monkeypatch.setattr(chrome, "_suppress_restore_nag", lambda _profile: None)
    monkeypatch.setattr(chrome.subprocess, "Popen", lambda *_args, **_kwargs: _FakeProcess())
    monkeypatch.setattr(
        chrome,
        "_cdp_json",
        lambda _port, _path: {"webSocketDebuggerUrl": "ws://ready"},
    )
    monkeypatch.setattr(chrome.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        chrome,
        "install_public_destination_cdp_guard",
        lambda _port, **_ownership: None,
    )

    chrome.launch_chrome(
        worker_id=4,
        port=9994,
        approved_application_url="https://apply.example.com/job",
    )

    profile = worker_root / "worker-4"
    assert (profile / "Default").is_dir()
    assert list(profile.iterdir()) == [profile / "Default"]


def test_standing_apply_loop_rechecks_capability_before_the_next_candidate(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities
    from jobctrl.apply import launcher

    capability_checks: list[str] = []
    candidates: list[str] = []
    runs: list[str] = []

    def check_capability(_capability: str) -> Path:
        capability_checks.append(_capability)
        if len(capability_checks) > 1:
            raise BrowserCapabilityDisabledError("disabled between candidates")
        return Path("/test/Chromium")

    def acquire(*_args, **_kwargs):
        candidates.append("claimed")
        return {
            "job_id": str(uuid.uuid4()),
            "tenant_id": "local",
            "url": "https://example.com/job",
            "title": "Engineer",
            "site": "Example",
        }

    monkeypatch.setattr(browser_capabilities, "require_system_browser_capability", check_capability)
    monkeypatch.setattr(launcher, "acquire_job", acquire)
    monkeypatch.setattr(launcher, "run_job", lambda *_args, **_kwargs: runs.append("run") or ("dry_run", 1))
    monkeypatch.setattr(launcher, "mark_result", lambda *_args, **_kwargs: None)

    launcher.worker_loop(worker_id=7, limit=2, dry_run=True, snapshot=object())

    assert capability_checks == ["auto-apply-browser", "auto-apply-browser"]
    assert candidates == ["claimed"]
    assert runs == ["run"]


def test_enable_adopts_only_an_explicit_executable_and_writes_private_state(
    tmp_path: Path, browser_executable: Path
) -> None:
    status = enable_system_browser_capability(
        "auto-apply-browser", browser_executable, app_dir=tmp_path
    )

    state_path = browser_capability_config_path(app_dir=tmp_path)
    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert status.status == "ready"
    assert require_system_browser_capability("auto-apply-browser", app_dir=tmp_path) == Path(
        browser_executable
    ).resolve()
    assert persisted["browser_capabilities"]["capabilities"]["auto-apply-browser"] == {
        "enabled": True,
        "systemBrowser": {"executable": str(browser_executable.resolve())},
        "profileCopied": False,
        "profileCopyConsent": None,
    }
    assert stat.S_IMODE(state_path.stat().st_mode) == 0o600


def test_hot_revocation_predicate_does_not_probe_the_system_browser(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import browser_capabilities

    enable_system_browser_capability("auto-apply-browser", browser_executable, app_dir=tmp_path)
    monkeypatch.setattr(
        browser_capabilities,
        "_executable_status",
        lambda _path: (_ for _ in ()).throw(AssertionError("hot path must not run --version")),
    )

    assert system_browser_capability_is_enabled("auto-apply-browser", app_dir=tmp_path) is True
    disable_browser_capability("auto-apply-browser", app_dir=tmp_path)
    assert system_browser_capability_is_enabled("auto-apply-browser", app_dir=tmp_path) is False


def test_concurrent_enable_cannot_overwrite_a_completed_disable(
    tmp_path: Path,
    browser_executable: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl import config

    original_edit = config.edit_config_file
    enable_loaded = threading.Event()
    release_enable = threading.Event()
    paused = False
    errors: list[BaseException] = []

    @contextmanager
    def edit_with_paused_enable(*args, **kwargs):
        nonlocal paused
        with original_edit(*args, **kwargs) as state:
            if threading.current_thread().name == "capability-enable" and not paused:
                paused = True
                enable_loaded.set()
                if not release_enable.wait(timeout=5):
                    raise AssertionError("timed out waiting to release capability enable")
            yield state

    def run_enable() -> None:
        try:
            enable_system_browser_capability(
                "auto-apply-browser",
                browser_executable,
                app_dir=tmp_path,
            )
        except BaseException as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    def run_disable() -> None:
        try:
            disable_browser_capability("auto-apply-browser", app_dir=tmp_path)
        except BaseException as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    monkeypatch.setattr(config, "edit_config_file", edit_with_paused_enable)
    enable_thread = threading.Thread(target=run_enable, name="capability-enable")
    disable_thread = threading.Thread(target=run_disable, name="capability-disable")

    enable_thread.start()
    assert enable_loaded.wait(timeout=5)
    disable_thread.start()
    disable_thread.join(timeout=0.2)
    assert disable_thread.is_alive(), "disable must wait for the in-flight enable transaction"
    release_enable.set()
    enable_thread.join(timeout=5)
    disable_thread.join(timeout=5)

    assert not enable_thread.is_alive()
    assert not disable_thread.is_alive()
    assert errors == []
    assert browser_capability_status("auto-apply-browser", app_dir=tmp_path).status == "disabled"


def test_enable_missing_executable_leaves_capability_disabled(tmp_path: Path) -> None:
    with pytest.raises(BrowserCapabilityError, match="cannot enable"):
        enable_system_browser_capability(
            "auto-apply-browser", tmp_path / "missing-browser", app_dir=tmp_path
        )

    assert browser_capability_status("auto-apply-browser", app_dir=tmp_path).status == "disabled"


def test_enable_rejects_a_non_browser_executable(tmp_path: Path) -> None:
    with pytest.raises(BrowserCapabilityError, match="cannot enable"):
        enable_system_browser_capability("auto-apply-browser", sys.executable, app_dir=tmp_path)

    assert browser_capability_status("auto-apply-browser", app_dir=tmp_path).status == "disabled"


def test_linkedin_enable_without_profile_copy_stays_missing_and_never_starts_browser(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl.infrastructure.enrichment import linkedin_apply_resolver as resolver_module

    status = enable_system_browser_capability(
        "authenticated-linkedin-browser", browser_executable, app_dir=tmp_path
    )
    uncreated_profile = tmp_path / "uncreated-profile"
    resolver = resolver_module.LinkedInApplyUrlResolver(
        profile_dir=uncreated_profile,
        playwright=object(),
    )
    monkeypatch.setattr(
        resolver_module,
        "require_system_browser_capability",
        lambda _capability: require_system_browser_capability(
            "authenticated-linkedin-browser", app_dir=tmp_path
        ),
    )

    assert status.status == "missing"
    assert browser_capability_status("authenticated-linkedin-browser", app_dir=tmp_path).status == "missing"
    with pytest.raises(BrowserCapabilityError, match="not ready"):
        resolver.start()
    assert not uncreated_profile.exists()


def test_disabling_linkedin_capability_closes_an_already_open_context(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    from types import SimpleNamespace

    from jobctrl.infrastructure.enrichment import linkedin_apply_resolver as resolver_module

    closed: list[bool] = []
    resolver = resolver_module.LinkedInApplyUrlResolver(playwright=object())
    resolver._context = SimpleNamespace(close=lambda: closed.append(True))
    monkeypatch.setattr(
        resolver_module,
        "require_system_browser_capability",
        lambda _capability: (_ for _ in ()).throw(BrowserCapabilityDisabledError("disabled")),
    )

    with pytest.raises(BrowserCapabilityDisabledError):
        resolver.resolve_loaded_page(object(), "https://www.linkedin.com/jobs/view/123")

    assert closed == [True]
    assert resolver.started is False


def test_disable_removes_readiness_without_deleting_owned_profile(
    tmp_path: Path, browser_executable: Path
) -> None:
    enable_system_browser_capability("authenticated-linkedin-browser", browser_executable, app_dir=tmp_path)
    destination = capability_profile_dir("authenticated-linkedin-browser", app_dir=tmp_path)
    destination.mkdir(parents=True)
    (destination / "Cookies").write_text("synthetic", encoding="utf-8")

    status = disable_browser_capability("authenticated-linkedin-browser", app_dir=tmp_path)

    assert status.status == "disabled"
    assert destination.exists()
    assert (destination / "Cookies").read_text(encoding="utf-8") == "synthetic"


def test_core_browser_cannot_be_disabled(tmp_path: Path) -> None:
    with pytest.raises(BrowserCapabilityError, match="cannot be disabled"):
        disable_browser_capability("core-browser", app_dir=tmp_path)


def test_profile_copy_requires_separate_consent_and_never_persists_source_path(
    tmp_path: Path, browser_executable: Path
) -> None:
    enable_system_browser_capability("authenticated-linkedin-browser", browser_executable, app_dir=tmp_path)
    source = tmp_path / "outside-profile"
    source.mkdir()
    (source / "Cookies").write_text("synthetic-cookie", encoding="utf-8")

    with pytest.raises(BrowserProfileConsentRequiredError):
        copy_authenticated_linkedin_profile(source, consent=False, app_dir=tmp_path)
    assert not capability_profile_dir("authenticated-linkedin-browser", app_dir=tmp_path).exists()

    destination = copy_authenticated_linkedin_profile(source, consent=True, app_dir=tmp_path)
    raw_state = browser_capability_config_path(app_dir=tmp_path).read_text(encoding="utf-8")

    assert destination == capability_profile_dir("authenticated-linkedin-browser", app_dir=tmp_path)
    assert (destination / "Cookies").read_text(encoding="utf-8") == "synthetic-cookie"
    assert str(source) not in raw_state
    state = load_browser_capability_state(app_dir=tmp_path)["capabilities"][
        "authenticated-linkedin-browser"
    ]
    assert state["profileCopied"] is True
    consent = state["profileCopyConsent"]
    assert consent["method"] == "explicit-cli"
    assert consent["acceptedAt"]


def test_profile_copy_does_not_overwrite_a_concurrent_disable_after_a_stale_lock(
    tmp_path: Path,
    browser_executable: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A long copy cannot retain a stale config snapshot across another write."""

    from jobctrl import browser_capabilities, config

    enable_system_browser_capability("authenticated-linkedin-browser", browser_executable, app_dir=tmp_path)
    source = tmp_path / "outside-profile"
    source.mkdir()
    (source / "Cookies").write_text("synthetic-cookie", encoding="utf-8")
    destination = capability_profile_dir("authenticated-linkedin-browser", app_dir=tmp_path)
    original_copy = browser_capabilities._copy_profile_tree
    copy_started = threading.Event()
    release_copy = threading.Event()
    errors: list[BaseException] = []

    def paused_copy(*args, **kwargs) -> None:
        copy_started.set()
        if not release_copy.wait(timeout=5):
            raise AssertionError("timed out waiting to resume profile copy")
        original_copy(*args, **kwargs)

    def run_copy() -> None:
        try:
            copy_authenticated_linkedin_profile(source, consent=True, app_dir=tmp_path)
        except BaseException as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    monkeypatch.setattr(browser_capabilities, "_copy_profile_tree", paused_copy)
    # This represents a copy that outlives the stale-lock threshold.  The
    # capability writer must still win rather than be overwritten by a stale
    # snapshot when copying resumes.
    monkeypatch.setattr(config, "CONFIG_LOCK_STALE_SECONDS", -1)
    copy_thread = threading.Thread(target=run_copy, name="profile-copy")
    copy_thread.start()
    assert copy_started.wait(timeout=5)

    disable_browser_capability("authenticated-linkedin-browser", app_dir=tmp_path)
    release_copy.set()
    copy_thread.join(timeout=5)

    assert not copy_thread.is_alive()
    assert len(errors) == 1
    assert isinstance(errors[0], BrowserCapabilityError)
    assert "changed while the profile was copied" in str(errors[0])
    assert browser_capability_status("authenticated-linkedin-browser", app_dir=tmp_path).status == "disabled"
    assert not destination.exists()


def test_profile_copy_does_not_follow_source_symlinks(
    tmp_path: Path, browser_executable: Path
) -> None:
    if not hasattr(os, "symlink"):
        pytest.skip("symlinks are unavailable")
    enable_system_browser_capability("authenticated-linkedin-browser", browser_executable, app_dir=tmp_path)
    source = tmp_path / "outside-profile"
    source.mkdir()
    secret = tmp_path / "not-a-profile-file"
    secret.write_text("must-not-copy", encoding="utf-8")
    (source / "linked-secret").symlink_to(secret)

    destination = copy_authenticated_linkedin_profile(source, consent=True, app_dir=tmp_path)

    assert not (destination / "linked-secret").exists()


def test_profile_copy_rejects_preexisting_unconsented_destination(
    tmp_path: Path, browser_executable: Path
) -> None:
    enable_system_browser_capability("authenticated-linkedin-browser", browser_executable, app_dir=tmp_path)
    source = tmp_path / "outside-profile"
    source.mkdir()
    destination = capability_profile_dir("authenticated-linkedin-browser", app_dir=tmp_path)
    destination.mkdir(parents=True)

    with pytest.raises(BrowserCapabilityError, match="cannot be adopted"):
        copy_authenticated_linkedin_profile(source, consent=True, app_dir=tmp_path)

    state = load_browser_capability_state(app_dir=tmp_path)["capabilities"][
        "authenticated-linkedin-browser"
    ]
    assert state["profileCopied"] is False
    assert state["profileCopyConsent"] is None


def test_profile_copy_readiness_and_use_reject_symlinked_ancestry(
    tmp_path: Path, browser_executable: Path
) -> None:
    if not hasattr(os, "symlink"):
        pytest.skip("symlinks are unavailable")
    enable_system_browser_capability("authenticated-linkedin-browser", browser_executable, app_dir=tmp_path)
    source = tmp_path / "outside-profile"
    source.mkdir()
    destination = copy_authenticated_linkedin_profile(source, consent=True, app_dir=tmp_path)

    profile_parent = destination.parent
    profile_parent.rename(tmp_path / "original-browser-profiles")
    external_parent = tmp_path / "external-browser-profiles"
    external_destination = external_parent / destination.name
    external_destination.mkdir(parents=True)
    profile_parent.symlink_to(external_parent, target_is_directory=True)

    assert browser_capability_status("authenticated-linkedin-browser", app_dir=tmp_path).status == "failed"
    with pytest.raises(BrowserCapabilityError, match="not ready"):
        require_authenticated_linkedin_profile(app_dir=tmp_path)
    with pytest.raises(BrowserCapabilityError, match="symlinks"):
        copy_authenticated_linkedin_profile(source, consent=True, app_dir=tmp_path)


def test_profile_copy_parent_swap_stays_anchored_and_never_writes_external_data(
    tmp_path: Path,
    browser_executable: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not hasattr(os, "symlink") or not hasattr(os, "O_NOFOLLOW"):
        pytest.skip("descriptor-relative no-follow operations are unavailable")
    from jobctrl import browser_capabilities

    enable_system_browser_capability("authenticated-linkedin-browser", browser_executable, app_dir=tmp_path)
    source = tmp_path / "outside-profile"
    source.mkdir()
    (source / "Cookies").write_text("synthetic-cookie", encoding="utf-8")
    destination = capability_profile_dir("authenticated-linkedin-browser", app_dir=tmp_path)
    profile_parent = destination.parent
    displaced_parent = tmp_path / "displaced-browser-profiles"
    external_parent = tmp_path / "external-browser-profiles"
    external_parent.mkdir()
    original_rename = os.rename
    swapped = False

    def swap_parent_then_rename(
        source_name,
        destination_name,
        *,
        src_dir_fd=None,
        dst_dir_fd=None,
    ) -> None:
        nonlocal swapped
        assert src_dir_fd is not None
        assert dst_dir_fd == src_dir_fd
        if not swapped:
            swapped = True
            original_rename(profile_parent, displaced_parent)
            os.symlink(external_parent, profile_parent, target_is_directory=True)
        original_rename(
            source_name,
            destination_name,
            src_dir_fd=src_dir_fd,
            dst_dir_fd=dst_dir_fd,
        )

    monkeypatch.setattr(browser_capabilities.os, "rename", swap_parent_then_rename)

    with pytest.raises(BrowserCapabilityError, match="could not be copied"):
        copy_authenticated_linkedin_profile(source, consent=True, app_dir=tmp_path)

    assert swapped is True
    assert list(external_parent.iterdir()) == []
    assert not (displaced_parent / destination.name).exists()
    state = load_browser_capability_state(app_dir=tmp_path)["capabilities"][
        "authenticated-linkedin-browser"
    ]
    assert state["profileCopied"] is False
    assert state["profileCopyConsent"] is None
