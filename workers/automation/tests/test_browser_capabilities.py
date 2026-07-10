"""Regression coverage for explicit, install-scoped browser capabilities."""

from __future__ import annotations

import json
import os
import stat
import sys
import threading
from pathlib import Path

import pytest

from jobctrl.browser_capabilities import (
    BrowserCapabilityDisabledError,
    BrowserCapabilityError,
    BrowserProfileConsentRequiredError,
    browser_capability_status,
    capability_profile_dir,
    capability_state_path,
    copy_authenticated_linkedin_profile,
    disable_browser_capability,
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
    assert not capability_state_path(app_dir=tmp_path).exists()


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
        chrome.launch_chrome(worker_id=1, port=9922)

    assert accessed == []


def test_enabled_auto_apply_launch_uses_a_clean_owned_profile_without_host_copy(
    tmp_path: Path, browser_executable: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl.apply import chrome

    class _FakeProcess:
        pid = 4242

        def poll(self) -> int:
            return 0

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
    monkeypatch.setattr(chrome.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        chrome,
        "install_public_destination_cdp_guard",
        lambda _port, **_ownership: None,
    )

    chrome.launch_chrome(worker_id=4, port=9994)

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
        return {"url": "https://example.com/job", "title": "Engineer", "site": "Example"}

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

    state_path = capability_state_path(app_dir=tmp_path)
    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert status.status == "ready"
    assert require_system_browser_capability("auto-apply-browser", app_dir=tmp_path) == Path(
        browser_executable
    ).resolve()
    assert persisted["capabilities"]["auto-apply-browser"] == {
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
    from jobctrl import browser_capabilities

    original_load = browser_capabilities.load_browser_capability_state
    enable_loaded = threading.Event()
    release_enable = threading.Event()
    paused = False
    errors: list[BaseException] = []

    def load_with_paused_enable(*args, **kwargs):
        nonlocal paused
        state = original_load(*args, **kwargs)
        if threading.current_thread().name == "capability-enable" and not paused:
            paused = True
            enable_loaded.set()
            if not release_enable.wait(timeout=5):
                raise AssertionError("timed out waiting to release capability enable")
        return state

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

    monkeypatch.setattr(browser_capabilities, "load_browser_capability_state", load_with_paused_enable)
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
    raw_state = capability_state_path(app_dir=tmp_path).read_text(encoding="utf-8")

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
