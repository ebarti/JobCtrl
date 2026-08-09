"""Install-scoped policy for JobCtrl's browser capabilities.

The distribution policy is immutable and ships with the signed payload.  This
module keeps the user's *choices* separately in ``JOBCTRL_DIR``.  In
particular, a system browser executable or an existing browser profile is never
implicitly adopted merely because it can be discovered on the host.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import stat
import subprocess
import sys
from contextlib import ExitStack, contextmanager
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
_PROFILE_COPY_LOCK_NAME = ".linkedin-profile-copy.lock"
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


class DetectedBrowserUnavailableError(BrowserCapabilityError):
    """Raised when an explicitly selected transient browser is no longer installed."""


class DetectedBrowserProfileUnavailableError(BrowserCapabilityError):
    """Raised when an explicitly selected detected profile is no longer available."""


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


@dataclass(frozen=True)
class DetectedBrowser:
    """One transient supported browser installation; paths stay worker-local."""

    id: Literal["google-chrome", "chromium"]
    label: str
    executable: Path


@dataclass(frozen=True)
class DetectedBrowserProfile:
    """One transient browser profile; host paths stay worker-local."""

    id: str
    browser_id: Literal["google-chrome", "chromium"]
    label: str
    user_data_root: Path
    directory_name: str


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


def _browser_candidate_locations() -> tuple[DetectedBrowser, ...]:
    """Return known installation locations in user-facing preference order."""

    if sys.platform == "darwin":
        application_roots = (Path("/Applications"), Path.home() / "Applications")
        return tuple(
            [
                DetectedBrowser(
                    id="google-chrome",
                    label="Google Chrome",
                    executable=root / "Google Chrome.app" / "Contents" / "MacOS" / "Google Chrome",
                )
                for root in application_roots
            ]
            + [
                DetectedBrowser(
                    id="chromium",
                    label="Chromium",
                    executable=root / "Chromium.app" / "Contents" / "MacOS" / "Chromium",
                )
                for root in application_roots
            ]
        )
    if sys.platform == "win32":
        roots = tuple(
            Path(value)
            for name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")
            if (value := os.environ.get(name))
        )
        return tuple(
            [
                DetectedBrowser(
                    id="google-chrome",
                    label="Google Chrome",
                    executable=root / "Google" / "Chrome" / "Application" / "chrome.exe",
                )
                for root in roots
            ]
            + [
                DetectedBrowser(
                    id="chromium",
                    label="Chromium",
                    executable=root / "Chromium" / "Application" / "chrome.exe",
                )
                for root in roots
            ]
        )

    candidates: list[DetectedBrowser] = []
    for browser_id, label, command_names in (
        ("google-chrome", "Google Chrome", ("google-chrome", "google-chrome-stable")),
        ("chromium", "Chromium", ("chromium", "chromium-browser")),
    ):
        for command_name in command_names:
            if executable := shutil.which(command_name):
                candidates.append(
                    DetectedBrowser(id=browser_id, label=label, executable=Path(executable))
                )
    return tuple(candidates)


def detect_supported_browsers() -> tuple[DetectedBrowser, ...]:
    """Discover supported installations without adopting, launching, or persisting them."""

    detected: list[DetectedBrowser] = []
    seen_ids: set[str] = set()
    seen_paths: set[Path] = set()
    for candidate in _browser_candidate_locations():
        if candidate.id in seen_ids:
            continue
        try:
            executable = candidate.executable.expanduser().resolve(strict=True)
        except OSError:
            continue
        if executable in seen_paths or not executable.is_file() or not os.access(executable, os.X_OK):
            continue
        detected.append(
            DetectedBrowser(id=candidate.id, label=candidate.label, executable=executable)
        )
        seen_ids.add(candidate.id)
        seen_paths.add(executable)
    return tuple(detected)


def _default_browser_profile_locations(browser_id: str) -> tuple[Path, ...]:
    """Return known user-data roots without reading browser profile contents."""

    if browser_id not in {"google-chrome", "chromium"}:
        return ()
    if sys.platform == "darwin":
        relative = (
            Path("Library/Application Support/Google/Chrome")
            if browser_id == "google-chrome"
            else Path("Library/Application Support/Chromium")
        )
        return (Path.home() / relative,)
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if not local_app_data:
            return ()
        relative = (
            Path("Google/Chrome/User Data")
            if browser_id == "google-chrome"
            else Path("Chromium/User Data")
        )
        return (Path(local_app_data) / relative,)
    relative = (
        Path(".config/google-chrome")
        if browser_id == "google-chrome"
        else Path(".config/chromium")
    )
    return (Path.home() / relative,)


def _detected_profile_id(browser_id: str, root: Path, directory_name: str) -> str:
    """Build a stable opaque ID without returning a host path or directory name."""

    identity = "\0".join(
        (
            browser_id,
            os.path.abspath(os.fspath(root.expanduser())),
            directory_name,
        )
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
    return f"profile-{digest}"


def _safe_profile_label(value: object, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    label = "".join(character for character in value.strip() if character.isprintable())
    if not label:
        return fallback
    result: list[str] = []
    utf16_units = 0
    for character in label:
        character_units = 2 if ord(character) > 0xFFFF else 1
        if utf16_units + character_units > 80:
            break
        result.append(character)
        utf16_units += character_units
    return "".join(result) or fallback


def _profile_display_label(record: object, fallback: str) -> str:
    """Choose Chrome's recognizable display label without exposing account IDs."""

    if not isinstance(record, dict):
        return fallback
    configured_name = _safe_profile_label(record.get("name"), fallback)
    if record.get("is_using_default_name") is True:
        return _safe_profile_label(record.get("gaia_name"), configured_name)
    return configured_name


def _profile_metadata(root: Path) -> tuple[dict[str, object], tuple[str, ...]]:
    """Read bounded Chrome display metadata without following a Local State symlink."""

    root_descriptor = -1
    source_file = -1
    try:
        root_descriptor = _open_directory_no_symlinks(root)
        status = os.stat("Local State", dir_fd=root_descriptor, follow_symlinks=False)
    except OSError:
        if root_descriptor >= 0:
            os.close(root_descriptor)
        return {}, ()
    if not stat.S_ISREG(status.st_mode) or status.st_size > 16 * 1024 * 1024:
        os.close(root_descriptor)
        return {}, ()
    try:
        source_file = os.open(
            "Local State",
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=root_descriptor,
        )
        if not _same_entry(status, os.fstat(source_file)):
            return {}, ()
        chunks: list[bytes] = []
        size = 0
        while chunk := os.read(source_file, 1024 * 1024):
            size += len(chunk)
            if size > 16 * 1024 * 1024:
                return {}, ()
            chunks.append(chunk)
        payload = json.loads(b"".join(chunks).decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}, ()
    finally:
        if source_file >= 0:
            os.close(source_file)
        if root_descriptor >= 0:
            os.close(root_descriptor)
    if not isinstance(payload, dict):
        return {}, ()
    profile = payload.get("profile")
    if not isinstance(profile, dict):
        return {}, ()
    info_cache = profile.get("info_cache")
    metadata = info_cache if isinstance(info_cache, dict) else {}
    ordered_names: list[str] = []
    last_used = profile.get("last_used")
    if isinstance(last_used, str):
        ordered_names.append(last_used)
    profiles_order = profile.get("profiles_order")
    if isinstance(profiles_order, list):
        ordered_names.extend(name for name in profiles_order if isinstance(name, str))
    ordered_names.extend(name for name in metadata if isinstance(name, str))
    return metadata, tuple(dict.fromkeys(ordered_names))


def _is_profile_directory_name(name: str) -> bool:
    return (
        name == "Default"
        or name.startswith("Profile ")
    ) and name not in {"Guest Profile", "System Profile"}


def detect_browser_profiles(browser_id: str) -> tuple[DetectedBrowserProfile, ...]:
    """Discover selectable profiles without adopting, launching, or returning paths."""

    browser = next(
        (candidate for candidate in detect_supported_browsers() if candidate.id == browser_id),
        None,
    )
    if browser is None:
        return ()
    detected: list[DetectedBrowserProfile] = []
    for root in _default_browser_profile_locations(browser_id):
        if not root.is_dir() or root.is_symlink():
            continue
        metadata, metadata_order = _profile_metadata(root)
        names = list(metadata_order)
        try:
            names.extend(
                entry.name
                for entry in sorted(root.iterdir(), key=lambda item: item.name)
                if _is_profile_directory_name(entry.name)
            )
        except OSError:
            continue
        for directory_name in dict.fromkeys(names):
            if not _is_profile_directory_name(directory_name):
                continue
            profile_directory = root / directory_name
            if not profile_directory.is_dir() or profile_directory.is_symlink():
                continue
            record = metadata.get(directory_name)
            fallback = "Default" if directory_name == "Default" else directory_name
            detected.append(
                DetectedBrowserProfile(
                    id=_detected_profile_id(browser.id, root, directory_name),
                    browser_id=browser.id,
                    label=_profile_display_label(record, fallback),
                    user_data_root=root,
                    directory_name=directory_name,
                )
            )

    label_counts: dict[str, int] = {}
    for profile in detected:
        label_counts[profile.label] = label_counts.get(profile.label, 0) + 1
    return tuple(
        profile
        if label_counts[profile.label] == 1
        else DetectedBrowserProfile(
            id=profile.id,
            browser_id=profile.browser_id,
            label=_safe_profile_label(
                f"{profile.label} ({profile.directory_name})",
                profile.label,
            ),
            user_data_root=profile.user_data_root,
            directory_name=profile.directory_name,
        )
        for profile in detected
    )


def detect_default_browser_profile(browser_id: str) -> Path | None:
    """Resolve the legacy default-profile source without returning it over RPC."""

    profile = next(
        (
            candidate
            for candidate in detect_browser_profiles(browser_id)
            if candidate.directory_name == "Default"
        ),
        None,
    )
    return profile.user_data_root if profile is not None else None


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


def enable_detected_browser_capability(
    capability_id: str,
    detected_browser_id: str,
    *,
    app_dir: Path | None = None,
    catalog: BrowserCapabilityCatalog | None = None,
) -> BrowserCapabilityStatus:
    """Resolve a transient candidate ID at enable time, then explicitly adopt it."""

    candidate = next(
        (browser for browser in detect_supported_browsers() if browser.id == detected_browser_id),
        None,
    )
    if candidate is None:
        raise DetectedBrowserUnavailableError("the selected detected browser is no longer available")
    return enable_system_browser_capability(
        capability_id,
        candidate.executable,
        app_dir=app_dir,
        catalog=catalog,
    )


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
    _root_entries: frozenset[str] | None = None,
    _root_entry_renames: dict[str, str] | None = None,
    _sanitize_default_local_state: bool = False,
    _sanitize_profile_name: str = "Default",
    _replace_existing: bool = False,
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

    # The dedicated OS lock has no stale timeout, so a large profile copy cannot
    # overlap another request or be mistaken for an abandoned lock. Config
    # transactions remain short and retain their normal stale-lock behavior.
    with _browser_profile_copy_lock(app_dir=app_dir):
        return _copy_authenticated_linkedin_profile_locked(
            source_profile,
            consent_method=consent_method,
            app_dir=app_dir,
            catalog=resolved_catalog,
            root_entries=_root_entries,
            root_entry_renames=_root_entry_renames,
            sanitize_default_local_state=_sanitize_default_local_state,
            sanitize_profile_name=_sanitize_profile_name,
            replace_existing=_replace_existing,
        )


def _copy_authenticated_linkedin_profile_locked(
    source_profile: Path | str,
    *,
    consent_method: str,
    app_dir: Path | None,
    catalog: BrowserCapabilityCatalog,
    root_entries: frozenset[str] | None,
    root_entry_renames: dict[str, str] | None,
    sanitize_default_local_state: bool,
    sanitize_profile_name: str,
    replace_existing: bool,
) -> Path:
    """Copy and commit one profile while the dedicated copy lock is held."""

    # A profile can be large enough that copying it takes longer than the
    # config-lock stale threshold.  Keep the config transaction limited to
    # inspecting and later recording capability state; the no-follow copy has
    # its own filesystem safety boundary below.
    source = Path(source_profile).expanduser()
    if not source.is_dir() or source.is_symlink():
        raise BrowserCapabilityError("the selected browser profile cannot be copied")
    destination = capability_profile_dir("authenticated-linkedin-browser", app_dir=app_dir)
    _owned_profile_path(destination, app_dir=app_dir, require_existing=False)

    with _browser_capability_state_transaction(app_dir=app_dir, catalog=catalog) as state:
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
            _owned_profile_path(destination, app_dir=app_dir, require_existing=True)
            if not replace_existing:
                return destination

    replaced_profile_name = _copy_profile_tree(
        source,
        destination,
        app_dir=app_dir,
        root_entries=root_entries,
        root_entry_renames=root_entry_renames,
        sanitize_default_local_state=sanitize_default_local_state,
        sanitize_profile_name=sanitize_profile_name,
        replace_existing=replace_existing,
    )
    try:
        with _browser_capability_state_transaction(app_dir=app_dir, catalog=catalog) as state:
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
        if replaced_profile_name is None:
            _discard_owned_profile_copy(destination, app_dir=app_dir)
        else:
            _restore_replaced_profile_copy(
                destination,
                replaced_profile_name,
                app_dir=app_dir,
            )
        raise
    if replaced_profile_name is not None:
        _discard_replaced_profile_copy(
            destination,
            replaced_profile_name,
            app_dir=app_dir,
        )
    return destination


def copy_detected_authenticated_linkedin_profile(
    detected_browser_id: str,
    *,
    detected_profile_id: str | None = None,
    consent: bool,
    consent_method: str = "explicit-cli",
    app_dir: Path | None = None,
    catalog: BrowserCapabilityCatalog | None = None,
    replace_existing: bool = False,
) -> Path:
    """Copy one detected profile while keeping its host path worker-local."""

    profiles = detect_browser_profiles(detected_browser_id)
    selected = next(
        (
            profile
            for profile in profiles
            if (
                profile.id == detected_profile_id
                if detected_profile_id is not None
                else profile.directory_name == "Default"
            )
        ),
        None,
    )
    if selected is None:
        raise DetectedBrowserProfileUnavailableError(
            "the selected detected browser profile is no longer available"
        )
    return copy_authenticated_linkedin_profile(
        selected.user_data_root,
        consent=consent,
        consent_method=consent_method,
        app_dir=app_dir,
        catalog=catalog,
        # The detected-profile contract names exactly one profile. Chrome's
        # root Local State is needed for platform encryption metadata, but
        # sibling profile directories and their sessions are outside consent.
        _root_entries=frozenset({selected.directory_name, "Local State"}),
        _root_entry_renames={selected.directory_name: "Default"},
        _sanitize_default_local_state=True,
        _sanitize_profile_name=selected.directory_name,
        _replace_existing=replace_existing,
    )


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


@contextmanager
def _browser_profile_copy_lock(*, app_dir: Path | None):
    """Serialize profile copies with a crash-releasing OS advisory lock."""

    with ExitStack() as stack:
        try:
            parent_descriptor = stack.enter_context(
                _open_owned_profile_parent(app_dir=app_dir)
            )
        except OSError as exc:
            raise BrowserCapabilityError(
                "JobCtrl browser-profile storage must not use symlinks or invalid ancestors"
            ) from exc
        lock_descriptor = -1
        try:
            lock_descriptor = os.open(
                _PROFILE_COPY_LOCK_NAME,
                os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
                stat.S_IRUSR | stat.S_IWUSR,
                dir_fd=parent_descriptor,
            )
            lock_status = os.stat(
                _PROFILE_COPY_LOCK_NAME,
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
            if not stat.S_ISREG(lock_status.st_mode) or not _same_entry(
                lock_status,
                os.fstat(lock_descriptor),
            ):
                raise OSError("profile-copy lock is not a regular owned file")
            os.fchmod(lock_descriptor, 0o600)
            if sys.platform == "win32":
                import msvcrt

                if os.fstat(lock_descriptor).st_size == 0:
                    os.write(lock_descriptor, b"\0")
                    os.fsync(lock_descriptor)
                os.lseek(lock_descriptor, 0, os.SEEK_SET)
                msvcrt.locking(lock_descriptor, msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_descriptor, fcntl.LOCK_EX)
        except OSError as exc:
            if lock_descriptor >= 0:
                os.close(lock_descriptor)
            raise BrowserCapabilityError(
                "the browser profile copy lock is unavailable"
            ) from exc

        try:
            yield
        finally:
            try:
                if sys.platform == "win32":
                    import msvcrt

                    os.lseek(lock_descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(lock_descriptor, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
            except OSError:
                # Closing the descriptor releases the process-owned lock.
                pass
            os.close(lock_descriptor)


def _same_entry(first: os.stat_result, second: os.stat_result) -> bool:
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


def _copy_profile_directory(
    source_descriptor: int,
    destination_descriptor: int,
    *,
    root_entries: frozenset[str] | None = None,
    root_entry_renames: dict[str, str] | None = None,
) -> None:
    for name in os.listdir(source_descriptor):
        if name in _PROFILE_COPY_SKIP or (
            root_entries is not None and name not in root_entries
        ):
            continue
        destination_name = (
            root_entry_renames.get(name, name) if root_entry_renames else name
        )
        source_status = os.stat(name, dir_fd=source_descriptor, follow_symlinks=False)
        if stat.S_ISDIR(source_status.st_mode):
            child_source = os.open(name, _directory_open_flags(), dir_fd=source_descriptor)
            try:
                if not _same_entry(source_status, os.fstat(child_source)):
                    raise BrowserCapabilityError("the selected browser profile changed while being copied")
                os.mkdir(destination_name, mode=0o700, dir_fd=destination_descriptor)
                child_destination = os.open(
                    destination_name,
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
                destination_name,
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


def _restore_replaced_profile_copy(
    destination: Path,
    replaced_name: str,
    *,
    app_dir: Path | None,
) -> None:
    """Restore the prior owned copy when post-publish state validation fails."""

    expected_prefix = f".{destination.name}.replaced-"
    if (
        not replaced_name.startswith(expected_prefix)
        or Path(replaced_name).name != replaced_name
    ):
        raise BrowserCapabilityError("the previous browser profile copy could not be restored")
    _owned_profile_path(destination, app_dir=app_dir, require_existing=True)
    try:
        with _open_owned_profile_parent(app_dir=app_dir) as parent_descriptor:
            _remove_profile_tree_at(parent_descriptor, destination.name)
            os.rename(
                replaced_name,
                destination.name,
                src_dir_fd=parent_descriptor,
                dst_dir_fd=parent_descriptor,
            )
    except OSError as exc:
        raise BrowserCapabilityError("the previous browser profile copy could not be restored") from exc
    _owned_profile_path(destination, app_dir=app_dir, require_existing=True)


def _discard_replaced_profile_copy(
    destination: Path,
    replaced_name: str,
    *,
    app_dir: Path | None,
) -> None:
    """Remove the prior copy after the replacement and state transaction succeed."""

    expected_prefix = f".{destination.name}.replaced-"
    if (
        not replaced_name.startswith(expected_prefix)
        or Path(replaced_name).name != replaced_name
    ):
        return
    try:
        with _open_owned_profile_parent(app_dir=app_dir) as parent_descriptor:
            _remove_profile_tree_at(parent_descriptor, replaced_name)
    except OSError:
        # The active copy is already committed. Preserve the inactive owned
        # recovery copy instead of risking damage to the working profile.
        pass


def _sanitize_detected_profile_local_state_at(
    directory_descriptor: int,
    source_profile_name: str,
) -> None:
    """Sanitize Local State inside an unpublished single-profile staging tree."""

    source_file = -1
    replacement_file = -1
    replacement_name = f".Local State.sanitized-{secrets.token_hex(8)}"
    try:
        try:
            source_status = os.stat(
                "Local State",
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return
        if not stat.S_ISREG(source_status.st_mode):
            raise BrowserCapabilityError(
                "the detected browser metadata could not be copied safely"
            )
        source_file = os.open(
            "Local State",
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory_descriptor,
        )
        if not _same_entry(source_status, os.fstat(source_file)):
            raise BrowserCapabilityError(
                "the detected browser metadata changed while being copied"
            )
        chunks: list[bytes] = []
        size = 0
        while chunk := os.read(source_file, 1024 * 1024):
            size += len(chunk)
            if size > 16 * 1024 * 1024:
                raise BrowserCapabilityError("the detected browser metadata is too large")
            chunks.append(chunk)
        payload = json.loads(b"".join(chunks).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Local State must be an object")
        sanitized: dict[str, object] = {}
        os_crypt = payload.get("os_crypt")
        if isinstance(os_crypt, dict):
            sanitized["os_crypt"] = os_crypt
        profile = payload.get("profile")
        if isinstance(profile, dict):
            sanitized_profile: dict[str, object] = {
                "last_used": "Default",
                "last_active_profiles": ["Default"],
                "profiles_order": ["Default"],
            }
            info_cache = profile.get("info_cache")
            selected_info = (
                info_cache.get(source_profile_name)
                if isinstance(info_cache, dict)
                else None
            )
            if isinstance(selected_info, dict):
                sanitized_profile["info_cache"] = {"Default": selected_info}
            sanitized["profile"] = sanitized_profile
        encoded = json.dumps(
            sanitized,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        replacement_file = os.open(
            replacement_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            stat.S_IRUSR | stat.S_IWUSR,
            dir_fd=directory_descriptor,
        )
        remaining = memoryview(encoded)
        while remaining:
            written = os.write(replacement_file, remaining)
            remaining = remaining[written:]
        os.fsync(replacement_file)
        os.close(replacement_file)
        replacement_file = -1
        os.rename(
            replacement_name,
            "Local State",
            src_dir_fd=directory_descriptor,
            dst_dir_fd=directory_descriptor,
        )
    except Exception as exc:
        raise BrowserCapabilityError(
            "the detected browser metadata could not be copied safely"
        ) from exc
    finally:
        if replacement_file >= 0:
            os.close(replacement_file)
        try:
            os.unlink(replacement_name, dir_fd=directory_descriptor)
        except FileNotFoundError:
            pass
        if source_file >= 0:
            os.close(source_file)


def _copy_profile_tree(
    source: Path,
    destination: Path,
    *,
    app_dir: Path | None,
    root_entries: frozenset[str] | None = None,
    root_entry_renames: dict[str, str] | None = None,
    sanitize_default_local_state: bool = False,
    sanitize_profile_name: str = "Default",
    replace_existing: bool = False,
) -> str | None:
    """Copy through no-follow directory FDs and publish with an anchored rename."""

    _owned_profile_path(destination, app_dir=app_dir, require_existing=False)
    source_descriptor = -1
    parent_descriptor = -1
    staging_name = f".{destination.name}.copy-{secrets.token_hex(12)}"
    replaced_name = f".{destination.name}.replaced-{secrets.token_hex(12)}"
    published = False
    replaced_existing = False
    try:
        source_descriptor = _open_directory_no_symlinks(source)
        with _open_owned_profile_parent(app_dir=app_dir) as opened_parent:
            parent_descriptor = os.dup(opened_parent)
            destination_exists = False
            try:
                destination_status = os.stat(
                    destination.name,
                    dir_fd=parent_descriptor,
                    follow_symlinks=False,
                )
                destination_exists = True
            except FileNotFoundError:
                destination_status = None
            if destination_exists and (
                not replace_existing
                or destination_status is None
                or not stat.S_ISDIR(destination_status.st_mode)
            ):
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
                _copy_profile_directory(
                    source_descriptor,
                    staging_descriptor,
                    root_entries=root_entries,
                    root_entry_renames=root_entry_renames,
                )
                if sanitize_default_local_state:
                    _sanitize_detected_profile_local_state_at(
                        staging_descriptor,
                        sanitize_profile_name,
                    )
            finally:
                os.close(staging_descriptor)
            if destination_exists:
                os.rename(
                    destination.name,
                    replaced_name,
                    src_dir_fd=parent_descriptor,
                    dst_dir_fd=parent_descriptor,
                )
                replaced_existing = True
            os.rename(
                staging_name,
                destination.name,
                src_dir_fd=parent_descriptor,
                dst_dir_fd=parent_descriptor,
            )
            published = True
            _owned_profile_path(destination, app_dir=app_dir, require_existing=True)
            return replaced_name if replaced_existing else None
    except Exception as exc:
        if parent_descriptor >= 0:
            if replaced_existing:
                try:
                    if published:
                        _remove_profile_tree_at(parent_descriptor, destination.name)
                    os.rename(
                        replaced_name,
                        destination.name,
                        src_dir_fd=parent_descriptor,
                        dst_dir_fd=parent_descriptor,
                    )
                    replaced_existing = False
                    published = False
                except OSError:
                    pass
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
    "DetectedBrowser",
    "DetectedBrowserProfile",
    "DetectedBrowserProfileUnavailableError",
    "DetectedBrowserUnavailableError",
    "BROWSER_CAPABILITIES_CONFIG_KEY",
    "browser_capability_status",
    "capability_policy_path",
    "capability_profile_dir",
    "browser_capability_config_path",
    "copy_authenticated_linkedin_profile",
    "copy_detected_authenticated_linkedin_profile",
    "detect_browser_profiles",
    "detect_default_browser_profile",
    "detect_supported_browsers",
    "disable_browser_capability",
    "enable_detected_browser_capability",
    "enable_system_browser_capability",
    "list_browser_capabilities",
    "load_browser_capability_catalog",
    "load_browser_capability_state",
    "managed_optional_browser_pack_unavailable",
    "require_system_browser_capability",
    "require_authenticated_linkedin_profile",
    "system_browser_capability_is_enabled",
]
