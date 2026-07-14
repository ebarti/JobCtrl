"""Install-scoped policy for JobCtrl's browser capabilities.

The distribution policy is immutable and ships with the signed payload.  This
module keeps the user's *choices* separately in ``JOBCTRL_DIR``.  In
particular, a system browser executable or an existing browser profile is never
implicitly adopted merely because it can be discovered on the host.
"""

from __future__ import annotations

import json
import os
import secrets
import stat
import subprocess
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from jobctrl.runtime import is_bundled_runtime, payload_path

BROWSER_CAPABILITIES_CONFIG_KEY = "browser_capabilities"
CAPABILITY_STATE_SCHEMA_VERSION = 1
_CATALOG_SCHEMA_VERSION = 1
_CORE_BROWSER = "core-browser"
_OPTIONAL_SYSTEM_BROWSER_CAPABILITIES = frozenset(
    {"auto-apply-browser", "authenticated-linkedin-browser"}
)
_PROFILE_COPY_SKIP = frozenset(
    {
        "ShaderCache",
        "GrShaderCache",
        "Service Worker",
        "Cache",
        "Code Cache",
        "GPUCache",
        "CacheStorage",
        "Crashpad",
        "BrowserMetrics",
        "SafeBrowsing",
        "Crowd Deny",
        "MEIPreload",
        "SSLErrorAssistant",
        "recovery",
        "Temp",
        "SingletonLock",
        "SingletonSocket",
        "SingletonCookie",
    }
)


class BrowserCapabilityError(RuntimeError):
    """Base class for capability policy and state errors."""


class BrowserCapabilityDisabledError(BrowserCapabilityError):
    """Raised before an optional authenticated browser is touched."""


class BrowserCapabilityUnavailableError(BrowserCapabilityError):
    """Raised for an optional pack without a signed supply chain."""


class BrowserCapabilityStateError(BrowserCapabilityError):
    """Raised when install-scoped state is missing required integrity fields."""


class BrowserProfileConsentRequiredError(BrowserCapabilityError):
    """Raised when a caller tries to copy a profile without affirmative consent."""


@dataclass(frozen=True)
class BrowserCapabilityDefinition:
    """One immutable capability declared by the distribution catalog."""

    id: str
    default_enabled: bool
    component_ids: tuple[str, ...]


@dataclass(frozen=True)
class BrowserCapabilityCatalog:
    """Validated immutable browser capability catalog."""

    capabilities: tuple[BrowserCapabilityDefinition, ...]

    def get(self, capability_id: str) -> BrowserCapabilityDefinition:
        for capability in self.capabilities:
            if capability.id == capability_id:
                return capability
        raise BrowserCapabilityError(f"unknown browser capability: {capability_id}")


@dataclass(frozen=True)
class BrowserCapabilityStatus:
    """Read-only readiness view suitable for CLI and doctor output."""

    id: str
    status: Literal["ready", "disabled", "missing", "failed", "unavailable"]
    detail: str
    executable: Path | None = None


def browser_capability_config_path(*, app_dir: Path | None = None) -> Path:
    """Return config.json, the owner of browser capability choices."""

    from jobctrl.config import get_config_path

    return get_config_path(app_dir=app_dir)


def capability_profile_dir(capability_id: str, *, app_dir: Path | None = None) -> Path:
    """Return a JobCtrl-owned destination for an explicitly copied profile."""

    if capability_id != "authenticated-linkedin-browser":
        raise BrowserCapabilityError(f"{capability_id} does not use a copied browser profile")
    if app_dir is None:
        from jobctrl.config import APP_DIR

        app_dir = APP_DIR
    return Path(app_dir) / "browser-profiles" / "linkedin-apply-url-resolver"


def _owned_profile_path(
    profile_dir: Path,
    *,
    app_dir: Path | None,
    require_existing: bool,
) -> Path:
    """Validate the fixed profile destination without following symlinks.

    A copied browser profile is authenticated state.  It must remain beneath the
    JobCtrl data root even when an attacker (or a previous local mistake) has
    placed a symlink in an otherwise plausible ``browser-profiles`` path.
    ``Path.resolve`` alone is insufficient here because it silently follows the
    symlink we need to reject.
    """

    root = Path(os.path.abspath(os.fspath((app_dir or _app_dir()).expanduser())))
    candidate = Path(os.path.abspath(os.fspath(profile_dir.expanduser())))
    expected = Path(
        os.path.abspath(
            os.fspath(
                capability_profile_dir(
                    "authenticated-linkedin-browser",
                    app_dir=app_dir,
                ).expanduser()
            )
        )
    )
    if candidate != expected:
        raise BrowserCapabilityError("authenticated LinkedIn browser profile must be JobCtrl-owned")
    if root.is_symlink():
        raise BrowserCapabilityError("JobCtrl browser-profile storage must not use symlinks")
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise BrowserCapabilityError("authenticated LinkedIn browser profile must be JobCtrl-owned") from exc

    current = root
    for index, part in enumerate(relative.parts):
        current = current / part
        try:
            mode = os.lstat(current).st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            raise BrowserCapabilityError("JobCtrl browser-profile storage must not use symlinks")
        if index < len(relative.parts) - 1 and not stat.S_ISDIR(mode):
            raise BrowserCapabilityError("JobCtrl browser-profile storage is invalid")

    # Keep the lexical ownership check above and also reject a path that
    # canonicalises outside the data root through an ancestor race or mount.
    try:
        candidate.resolve(strict=False).relative_to(root.resolve(strict=False))
    except ValueError as exc:
        raise BrowserCapabilityError("authenticated LinkedIn browser profile must be JobCtrl-owned") from exc
    if require_existing:
        try:
            mode = os.lstat(candidate).st_mode
        except FileNotFoundError as exc:
            raise BrowserCapabilityError(
                "the consented JobCtrl-owned LinkedIn profile copy is unavailable"
            ) from exc
        if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
            raise BrowserCapabilityError("the consented JobCtrl-owned LinkedIn profile copy is unavailable")
    return candidate


def capability_policy_path() -> Path:
    """Locate the immutable catalog without consulting mutable user state."""

    if is_bundled_runtime():
        return payload_path("release/capability-policy.json", require_exists=True)
    # ``jobctrl`` lives at workers/automation/src/jobctrl in source mode.
    return Path(__file__).resolve().parents[4] / "packaging" / "distribution" / "capability-policy.json"


def load_browser_capability_catalog(*, path: Path | None = None) -> BrowserCapabilityCatalog:
    """Load and strictly validate the signed/source-controlled catalog."""

    policy_path = path or capability_policy_path()
    try:
        payload = json.loads(policy_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise BrowserCapabilityError("browser capability catalog is unavailable") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise BrowserCapabilityError("browser capability catalog is invalid") from exc
    if not isinstance(payload, dict) or set(payload) != {"schemaVersion", "capabilities"}:
        raise BrowserCapabilityError("browser capability catalog has an invalid shape")
    if payload.get("schemaVersion") != _CATALOG_SCHEMA_VERSION:
        raise BrowserCapabilityError("unsupported browser capability catalog schema")
    raw_capabilities = payload.get("capabilities")
    if not isinstance(raw_capabilities, list):
        raise BrowserCapabilityError("browser capability catalog has no capability list")

    capabilities: list[BrowserCapabilityDefinition] = []
    ids: set[str] = set()
    for item in raw_capabilities:
        if not isinstance(item, dict) or set(item) != {"id", "defaultEnabled", "componentIds"}:
            raise BrowserCapabilityError("browser capability catalog entry has an invalid shape")
        capability_id = item.get("id")
        default_enabled = item.get("defaultEnabled")
        component_ids = item.get("componentIds")
        if (
            not isinstance(capability_id, str)
            or not capability_id
            or capability_id in ids
            or not isinstance(default_enabled, bool)
            or not isinstance(component_ids, list)
            or not component_ids
            or not all(isinstance(component_id, str) and component_id for component_id in component_ids)
        ):
            raise BrowserCapabilityError("browser capability catalog entry is invalid")
        ids.add(capability_id)
        capabilities.append(
            BrowserCapabilityDefinition(
                id=capability_id,
                default_enabled=default_enabled,
                component_ids=tuple(component_ids),
            )
        )

    expected_ids = {_CORE_BROWSER, *_OPTIONAL_SYSTEM_BROWSER_CAPABILITIES}
    if ids != expected_ids:
        raise BrowserCapabilityError("browser capability catalog does not match the supported capability set")
    core = next(capability for capability in capabilities if capability.id == _CORE_BROWSER)
    if not core.default_enabled:
        raise BrowserCapabilityError("core-browser must be enabled by the immutable catalog")
    if any(next(capability for capability in capabilities if capability.id == item).default_enabled for item in _OPTIONAL_SYSTEM_BROWSER_CAPABILITIES):
        raise BrowserCapabilityError("authenticated browser capabilities must default to disabled")
    return BrowserCapabilityCatalog(capabilities=tuple(capabilities))


def _default_state() -> dict[str, object]:
    return {"schemaVersion": CAPABILITY_STATE_SCHEMA_VERSION, "capabilities": {}}


def _validate_state(payload: object, *, catalog: BrowserCapabilityCatalog) -> dict[str, object]:
    if not isinstance(payload, dict) or set(payload) != {"schemaVersion", "capabilities"}:
        raise BrowserCapabilityStateError("browser capability state has an invalid shape")
    if payload.get("schemaVersion") != CAPABILITY_STATE_SCHEMA_VERSION:
        raise BrowserCapabilityStateError("unsupported browser capability state schema")
    raw_capabilities = payload.get("capabilities")
    if not isinstance(raw_capabilities, dict):
        raise BrowserCapabilityStateError("browser capability state has invalid capabilities")
    known_ids = {capability.id for capability in catalog.capabilities}
    if any(not isinstance(capability_id, str) or capability_id not in known_ids for capability_id in raw_capabilities):
        raise BrowserCapabilityStateError("browser capability state contains an unknown capability")
    if _CORE_BROWSER in raw_capabilities:
        raise BrowserCapabilityStateError("core-browser cannot be changed in mutable state")
    for capability_id, record in raw_capabilities.items():
        if not isinstance(record, dict) or set(record) != {
            "enabled",
            "systemBrowser",
            "profileCopied",
            "profileCopyConsent",
        }:
            raise BrowserCapabilityStateError("browser capability state entry has an invalid shape")
        if not isinstance(record.get("enabled"), bool) or not isinstance(record.get("profileCopied"), bool):
            raise BrowserCapabilityStateError("browser capability state entry has invalid values")
        browser = record.get("systemBrowser")
        if browser is not None and (
            not isinstance(browser, dict)
            or set(browser) != {"executable"}
            or not isinstance(browser.get("executable"), str)
            or not browser["executable"].strip()
        ):
            raise BrowserCapabilityStateError("browser capability executable is invalid")
        profile_copy = record.get("profileCopyConsent")
        if profile_copy is not None and (
            capability_id != "authenticated-linkedin-browser"
            or not isinstance(profile_copy, dict)
            or set(profile_copy) != {"acceptedAt", "method"}
            or not isinstance(profile_copy.get("acceptedAt"), str)
            or not profile_copy["acceptedAt"].strip()
            or not isinstance(profile_copy.get("method"), str)
            or profile_copy["method"] not in {"explicit-cli", "explicit-ui-v1"}
        ):
            raise BrowserCapabilityStateError("browser profile-copy consent metadata is invalid")
        if bool(record.get("profileCopied")) != (profile_copy is not None):
            raise BrowserCapabilityStateError("browser profile-copy consent must match copied-profile state")
        if record.get("enabled") and browser is None:
            raise BrowserCapabilityStateError("an enabled authenticated browser capability needs an adopted executable")
    return payload


def load_browser_capability_state(
    *,
    app_dir: Path | None = None,
    catalog: BrowserCapabilityCatalog | None = None,
) -> dict[str, object]:
    """Read mutable state; absence intentionally means catalog defaults."""

    resolved_catalog = catalog or load_browser_capability_catalog()
    from jobctrl.config import ConfigFileError, load_config_file

    try:
        config = load_config_file(app_dir=app_dir, strict=True)
    except ConfigFileError as exc:
        raise BrowserCapabilityStateError("config.json cannot be read") from exc
    payload = config.get(BROWSER_CAPABILITIES_CONFIG_KEY)
    if payload is None:
        return _default_state()
    return _validate_state(payload, catalog=resolved_catalog)


@contextmanager
def _browser_capability_state_transaction(
    *,
    app_dir: Path | None = None,
    catalog: BrowserCapabilityCatalog | None = None,
):
    """Edit browser capability state inside the shared config.json transaction."""
    resolved_catalog = catalog or load_browser_capability_catalog()
    from jobctrl.config import ConfigFileError, edit_config_file

    try:
        with edit_config_file(app_dir=app_dir) as config:
            payload = config.get(BROWSER_CAPABILITIES_CONFIG_KEY)
            state = (
                _default_state()
                if payload is None
                else _validate_state(payload, catalog=resolved_catalog)
            )
            yield state
            config[BROWSER_CAPABILITIES_CONFIG_KEY] = _validate_state(
                state,
                catalog=resolved_catalog,
            )
    except ConfigFileError as exc:
        raise BrowserCapabilityStateError("config.json cannot be updated") from exc


def _record_for(state: dict[str, object], capability_id: str) -> dict[str, object] | None:
    capabilities = state["capabilities"]
    assert isinstance(capabilities, dict)
    record = capabilities.get(capability_id)
    assert record is None or isinstance(record, dict)
    return record


def _executable_status(executable: str) -> tuple[Literal["ready", "failed"], Path, str]:
    path = Path(executable).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        return "failed", path, "The adopted system browser executable is no longer available."
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        return "failed", resolved, "The adopted system browser executable is not executable."
    try:
        probe = subprocess.run(
            [str(resolved), "--version"],
            capture_output=True,
            check=False,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "failed", resolved, "The selected executable did not identify itself as Chrome or Chromium."
    identity = f"{probe.stdout}\n{probe.stderr}".casefold()
    if probe.returncode != 0 or not any(marker in identity for marker in ("chrome", "chromium")):
        return "failed", resolved, "The selected executable did not identify itself as Chrome or Chromium."
    return "ready", resolved, "Explicitly adopted system browser is ready."


def browser_capability_status(
    capability_id: str,
    *,
    app_dir: Path | None = None,
    catalog: BrowserCapabilityCatalog | None = None,
) -> BrowserCapabilityStatus:
    """Return a fail-closed status without probing or adopting host browsers."""

    resolved_catalog = catalog or load_browser_capability_catalog()
    definition = resolved_catalog.get(capability_id)
    if definition.id == _CORE_BROWSER:
        from jobctrl.infrastructure.preflight import check_playwright_chromium

        ready, detail = check_playwright_chromium()
        return BrowserCapabilityStatus(
            id=definition.id,
            status="ready" if ready else "unavailable",
            detail=(
                "Managed core Playwright Chromium is required and cannot be disabled. " + detail
                if ready
                else "Managed core Playwright Chromium is unavailable. " + detail
            ),
        )
    state = load_browser_capability_state(app_dir=app_dir, catalog=resolved_catalog)
    record = _record_for(state, definition.id)
    if record is None or not record["enabled"]:
        return BrowserCapabilityStatus(
            id=definition.id,
            status="disabled",
            detail="Disabled by default; JobCtrl will not read, copy, or launch an authenticated browser.",
        )
    browser = record["systemBrowser"]
    if browser is None:
        return BrowserCapabilityStatus(
            id=definition.id,
            status="missing",
            detail="Enabled without an adopted system browser. Adopt one explicitly with jobctrl capability enable.",
        )
    assert isinstance(browser, dict)
    executable = browser["executable"]
    assert isinstance(executable, str)
    status, executable_path, detail = _executable_status(executable)
    if status == "ready" and definition.id == "authenticated-linkedin-browser":
        profile_copied = bool(record.get("profileCopied"))
        consent = record.get("profileCopyConsent")
        if not profile_copied or consent is None:
            return BrowserCapabilityStatus(
                id=definition.id,
                status="missing",
                detail="Enabled, but no explicitly consented JobCtrl-owned LinkedIn profile copy is available.",
            )
        destination = capability_profile_dir(definition.id, app_dir=app_dir)
        try:
            _owned_profile_path(destination, app_dir=app_dir, require_existing=True)
        except BrowserCapabilityError:
            return BrowserCapabilityStatus(
                id=definition.id,
                status="failed",
                detail="The consented JobCtrl-owned LinkedIn profile copy is unavailable.",
            )
    return BrowserCapabilityStatus(id=definition.id, status=status, detail=detail, executable=executable_path)


def list_browser_capabilities(
    *,
    app_dir: Path | None = None,
    catalog: BrowserCapabilityCatalog | None = None,
) -> tuple[BrowserCapabilityStatus, ...]:
    resolved_catalog = catalog or load_browser_capability_catalog()
    return tuple(
        browser_capability_status(capability.id, app_dir=app_dir, catalog=resolved_catalog)
        for capability in resolved_catalog.capabilities
    )


def enable_system_browser_capability(
    capability_id: str,
    executable: Path | str,
    *,
    app_dir: Path | None = None,
    catalog: BrowserCapabilityCatalog | None = None,
) -> BrowserCapabilityStatus:
    """Persist an explicit executable choice for an optional browser capability."""

    resolved_catalog = catalog or load_browser_capability_catalog()
    if capability_id not in _OPTIONAL_SYSTEM_BROWSER_CAPABILITIES:
        if capability_id == _CORE_BROWSER:
            raise BrowserCapabilityError("core-browser is managed and cannot be enabled or disabled")
        raise BrowserCapabilityError(f"{capability_id} cannot adopt a system browser")
    status, executable_path, detail = _executable_status(str(executable))
    if status != "ready":
        raise BrowserCapabilityError(
            "cannot enable this capability because the selected browser executable is unavailable or not executable"
        )
    with _browser_capability_state_transaction(app_dir=app_dir, catalog=resolved_catalog) as state:
        records = state["capabilities"]
        assert isinstance(records, dict)
        previous = _record_for(state, capability_id)
        records[capability_id] = {
            "enabled": True,
            "systemBrowser": {"executable": str(executable_path)},
            "profileCopied": bool(previous and previous.get("profileCopied")),
            "profileCopyConsent": previous.get("profileCopyConsent") if previous else None,
        }
    return browser_capability_status(capability_id, app_dir=app_dir, catalog=resolved_catalog)


def disable_browser_capability(
    capability_id: str,
    *,
    app_dir: Path | None = None,
    catalog: BrowserCapabilityCatalog | None = None,
) -> BrowserCapabilityStatus:
    """Disable an optional capability without deleting the owned profile copy."""

    resolved_catalog = catalog or load_browser_capability_catalog()
    if capability_id == _CORE_BROWSER:
        raise BrowserCapabilityError("core-browser is managed and cannot be disabled")
    if capability_id not in _OPTIONAL_SYSTEM_BROWSER_CAPABILITIES:
        resolved_catalog.get(capability_id)
        raise BrowserCapabilityError(f"{capability_id} cannot be disabled")
    with _browser_capability_state_transaction(app_dir=app_dir, catalog=resolved_catalog) as state:
        records = state["capabilities"]
        assert isinstance(records, dict)
        previous = _record_for(state, capability_id)
        records[capability_id] = {
            "enabled": False,
            "systemBrowser": None,
            "profileCopied": bool(previous and previous.get("profileCopied")),
            "profileCopyConsent": previous.get("profileCopyConsent") if previous else None,
        }
    return browser_capability_status(capability_id, app_dir=app_dir, catalog=resolved_catalog)


def require_system_browser_capability(
    capability_id: str,
    *,
    app_dir: Path | None = None,
) -> Path:
    """Return an adopted executable or fail before any browser/profile access."""

    status = browser_capability_status(capability_id, app_dir=app_dir)
    if status.status == "ready" and status.executable is not None:
        return status.executable
    if status.status == "disabled":
        raise BrowserCapabilityDisabledError(
            f"{capability_id} is disabled; enable it with an explicit system browser choice before launching an authenticated browser"
        )
    raise BrowserCapabilityError(f"{capability_id} is not ready: {status.detail}")


def system_browser_capability_is_enabled(
    capability_id: str,
    *,
    app_dir: Path | None = None,
) -> bool:
    """Read only the mutable enabled bit for a hot revocation boundary.

    This intentionally validates the state shape but does *not* probe the
    adopted executable or profile.  CDP pauses every live HTTP request, where
    spawning ``Chrome --version`` would turn the revocation check itself into a
    denial-of-service.  Full readiness remains required at launch and before
    the saga records submit intent.
    """

    if capability_id not in _OPTIONAL_SYSTEM_BROWSER_CAPABILITIES:
        return False
    try:
        state = load_browser_capability_state(app_dir=app_dir)
    except BrowserCapabilityError:
        return False
    record = _record_for(state, capability_id)
    return bool(record and record.get("enabled") and record.get("systemBrowser"))


def require_authenticated_linkedin_profile(
    *,
    profile_dir: Path | None = None,
    app_dir: Path | None = None,
) -> Path:
    """Return the ready, consented LinkedIn profile after ownership revalidation."""

    status = browser_capability_status("authenticated-linkedin-browser", app_dir=app_dir)
    if status.status != "ready":
        raise BrowserCapabilityError(
            f"authenticated-linkedin-browser is not ready: {status.detail}"
        )
    destination = capability_profile_dir("authenticated-linkedin-browser", app_dir=app_dir)
    return _owned_profile_path(
        profile_dir or destination,
        app_dir=app_dir,
        require_existing=True,
    )


def managed_optional_browser_pack_unavailable(capability_id: str) -> None:
    """Make the no-unsigned-download policy explicit at the CLI boundary."""

    if capability_id not in _OPTIONAL_SYSTEM_BROWSER_CAPABILITIES:
        raise BrowserCapabilityError(f"{capability_id} does not support an optional browser pack")
    raise BrowserCapabilityUnavailableError(
        "Managed browser capability packs are unavailable until JobCtrl ships a signed pack supply chain. "
        "No browser was downloaded or enabled."
    )


def copy_authenticated_linkedin_profile(
    source_profile: Path | str,
    *,
    consent: bool,
    consent_method: str = "explicit-cli",
    app_dir: Path | None = None,
    catalog: BrowserCapabilityCatalog | None = None,
) -> Path:
    """Copy a profile only after separate affirmative consent.

    The source path is intentionally process-local: it is not logged, returned
    in errors, or persisted in mutable capability state.
    """

    if not consent:
        raise BrowserProfileConsentRequiredError(
            "Copying an existing browser profile requires separate affirmative consent."
        )
    if consent_method not in {"explicit-cli", "explicit-ui-v1"}:
        raise BrowserProfileConsentRequiredError("browser profile-copy consent must be explicit")
    resolved_catalog = catalog or load_browser_capability_catalog()

    # A profile can be large enough that copying it takes longer than the
    # config-lock stale threshold.  Keep the config transaction limited to
    # inspecting and later recording capability state; the no-follow copy has
    # its own filesystem safety boundary below.
    source = Path(source_profile).expanduser()
    if not source.is_dir() or source.is_symlink():
        raise BrowserCapabilityError("the selected browser profile cannot be copied")
    destination = capability_profile_dir("authenticated-linkedin-browser", app_dir=app_dir)
    _owned_profile_path(destination, app_dir=app_dir, require_existing=False)

    with _browser_capability_state_transaction(app_dir=app_dir, catalog=resolved_catalog) as state:
        record = _record_for(state, "authenticated-linkedin-browser")
        if record is None or not record["enabled"] or record["systemBrowser"] is None:
            raise BrowserCapabilityError("enable authenticated-linkedin-browser before copying a browser profile")
        browser = record["systemBrowser"]
        assert isinstance(browser, dict)
        executable = browser["executable"]
        assert isinstance(executable, str)
        executable_status, _path, _detail = _executable_status(executable)
        if executable_status != "ready":
            raise BrowserCapabilityError(
                "enable authenticated-linkedin-browser with an available browser before copying a profile"
            )
        expected_executable = executable
        existing_copy_is_consented = bool(record.get("profileCopied")) and record.get(
            "profileCopyConsent"
        ) is not None
        if destination.exists():
            if not existing_copy_is_consented:
                raise BrowserCapabilityError(
                    "an existing JobCtrl browser-profile destination cannot be adopted without a prior explicit copy"
                )
            return _owned_profile_path(destination, app_dir=app_dir, require_existing=True)

    _copy_profile_tree(source, destination, app_dir=app_dir)
    try:
        with _browser_capability_state_transaction(app_dir=app_dir, catalog=resolved_catalog) as state:
            record = _record_for(state, "authenticated-linkedin-browser")
            if (
                record is None
                or not record["enabled"]
                or record["systemBrowser"] is None
                or not isinstance(record["systemBrowser"], dict)
                or record["systemBrowser"].get("executable") != expected_executable
            ):
                raise BrowserCapabilityError(
                    "authenticated-linkedin-browser changed while the profile was copied"
                )
            _owned_profile_path(destination, app_dir=app_dir, require_existing=True)
            record["profileCopied"] = True
            record["profileCopyConsent"] = {
                "acceptedAt": datetime.now(timezone.utc).isoformat(),
                "method": consent_method,
            }
    except Exception:
        _discard_owned_profile_copy(destination, app_dir=app_dir)
        raise
    return destination


def _app_dir() -> Path:
    from jobctrl.config import APP_DIR

    return APP_DIR


def _directory_open_flags() -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    return flags


def _open_directory_no_symlinks(path: Path) -> int:
    """Open an absolute directory one no-follow component at a time."""

    absolute = Path(os.path.abspath(os.fspath(path.expanduser())))
    descriptor = os.open(absolute.anchor or os.curdir, _directory_open_flags())
    try:
        for part in absolute.parts[1:]:
            child = os.open(part, _directory_open_flags(), dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise NotADirectoryError(os.fspath(absolute))
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


@contextmanager
def _open_owned_profile_parent(*, app_dir: Path | None):
    """Yield the owned profile-parent FD, anchored beneath an opened app root."""

    root = Path(os.path.abspath(os.fspath((app_dir or _app_dir()).expanduser())))
    root_descriptor = _open_directory_no_symlinks(root)
    try:
        try:
            os.mkdir("browser-profiles", mode=0o700, dir_fd=root_descriptor)
        except FileExistsError:
            pass
        parent_descriptor = os.open(
            "browser-profiles",
            _directory_open_flags(),
            dir_fd=root_descriptor,
        )
        try:
            os.fchmod(parent_descriptor, 0o700)
            yield parent_descriptor
        finally:
            os.close(parent_descriptor)
    finally:
        os.close(root_descriptor)


def _same_entry(first: os.stat_result, second: os.stat_result) -> bool:
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


def _copy_profile_directory(source_descriptor: int, destination_descriptor: int) -> None:
    for name in os.listdir(source_descriptor):
        if name in _PROFILE_COPY_SKIP:
            continue
        source_status = os.stat(name, dir_fd=source_descriptor, follow_symlinks=False)
        if stat.S_ISDIR(source_status.st_mode):
            child_source = os.open(name, _directory_open_flags(), dir_fd=source_descriptor)
            try:
                if not _same_entry(source_status, os.fstat(child_source)):
                    raise BrowserCapabilityError("the selected browser profile changed while being copied")
                os.mkdir(name, mode=0o700, dir_fd=destination_descriptor)
                child_destination = os.open(
                    name,
                    _directory_open_flags(),
                    dir_fd=destination_descriptor,
                )
                try:
                    os.fchmod(child_destination, 0o700)
                    _copy_profile_directory(child_source, child_destination)
                finally:
                    os.close(child_destination)
            finally:
                os.close(child_source)
            continue
        if not stat.S_ISREG(source_status.st_mode):
            continue

        source_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        source_file = os.open(name, source_flags, dir_fd=source_descriptor)
        try:
            if not _same_entry(source_status, os.fstat(source_file)):
                raise BrowserCapabilityError("the selected browser profile changed while being copied")
            destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            destination_flags |= getattr(os, "O_NOFOLLOW", 0)
            destination_file = os.open(
                name,
                destination_flags,
                stat.S_IRUSR | stat.S_IWUSR,
                dir_fd=destination_descriptor,
            )
            try:
                while chunk := os.read(source_file, 1024 * 1024):
                    remaining = memoryview(chunk)
                    while remaining:
                        written = os.write(destination_file, remaining)
                        remaining = remaining[written:]
                os.fsync(destination_file)
            finally:
                os.close(destination_file)
        finally:
            os.close(source_file)


def _remove_profile_tree_at(parent_descriptor: int, name: str) -> None:
    try:
        entry_status = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(entry_status.st_mode):
        os.unlink(name, dir_fd=parent_descriptor)
        return
    child_descriptor = os.open(name, _directory_open_flags(), dir_fd=parent_descriptor)
    try:
        for child_name in os.listdir(child_descriptor):
            _remove_profile_tree_at(child_descriptor, child_name)
    finally:
        os.close(child_descriptor)
    os.rmdir(name, dir_fd=parent_descriptor)


def _discard_owned_profile_copy(destination: Path, *, app_dir: Path | None) -> None:
    """Remove a just-copied profile without following a changed profile path."""

    _owned_profile_path(destination, app_dir=app_dir, require_existing=False)
    try:
        with _open_owned_profile_parent(app_dir=app_dir) as parent_descriptor:
            _remove_profile_tree_at(parent_descriptor, destination.name)
    except OSError as exc:
        raise BrowserCapabilityError("the copied browser profile could not be discarded") from exc


def _copy_profile_tree(source: Path, destination: Path, *, app_dir: Path | None) -> None:
    """Copy through no-follow directory FDs and publish with an anchored rename."""

    _owned_profile_path(destination, app_dir=app_dir, require_existing=False)
    source_descriptor = -1
    parent_descriptor = -1
    staging_name = f".{destination.name}.copy-{secrets.token_hex(12)}"
    published = False
    try:
        source_descriptor = _open_directory_no_symlinks(source)
        with _open_owned_profile_parent(app_dir=app_dir) as opened_parent:
            parent_descriptor = os.dup(opened_parent)
            try:
                os.stat(destination.name, dir_fd=parent_descriptor, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise BrowserCapabilityError(
                    "an existing JobCtrl browser-profile destination cannot be adopted without a prior explicit copy"
                )
            os.mkdir(staging_name, mode=0o700, dir_fd=parent_descriptor)
            staging_descriptor = os.open(
                staging_name,
                _directory_open_flags(),
                dir_fd=parent_descriptor,
            )
            try:
                os.fchmod(staging_descriptor, 0o700)
                _copy_profile_directory(source_descriptor, staging_descriptor)
            finally:
                os.close(staging_descriptor)
            os.rename(
                staging_name,
                destination.name,
                src_dir_fd=parent_descriptor,
                dst_dir_fd=parent_descriptor,
            )
            published = True
            _owned_profile_path(destination, app_dir=app_dir, require_existing=True)
    except Exception as exc:
        if parent_descriptor >= 0:
            cleanup_name = destination.name if published else staging_name
            try:
                _remove_profile_tree_at(parent_descriptor, cleanup_name)
            except OSError:
                pass
        raise BrowserCapabilityError("the selected browser profile could not be copied") from exc
    finally:
        if parent_descriptor >= 0:
            os.close(parent_descriptor)
        if source_descriptor >= 0:
            os.close(source_descriptor)


__all__ = [
    "BrowserCapabilityCatalog",
    "BrowserCapabilityDefinition",
    "BrowserCapabilityDisabledError",
    "BrowserCapabilityError",
    "BrowserCapabilityStateError",
    "BrowserCapabilityStatus",
    "BrowserCapabilityUnavailableError",
    "BrowserProfileConsentRequiredError",
    "BROWSER_CAPABILITIES_CONFIG_KEY",
    "browser_capability_status",
    "capability_policy_path",
    "capability_profile_dir",
    "browser_capability_config_path",
    "copy_authenticated_linkedin_profile",
    "disable_browser_capability",
    "enable_system_browser_capability",
    "list_browser_capabilities",
    "load_browser_capability_catalog",
    "load_browser_capability_state",
    "managed_optional_browser_pack_unavailable",
    "require_system_browser_capability",
    "require_authenticated_linkedin_profile",
    "system_browser_capability_is_enabled",
]
