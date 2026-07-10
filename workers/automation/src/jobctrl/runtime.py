"""Runtime boundary for source checkouts and the installed JobCtrl payload.

The native launcher sets ``JOBCTRL_RUNTIME_MODE=bundled`` before it invokes the
private Python runtime.  Bundled mode deliberately has no repository fallback:
all mutable state belongs to ``JOBCTRL_DIR`` and all immutable runtime paths are
resolved below the absolute ``JOBCTRL_PAYLOAD_DIR`` supplied by the launcher.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

RUNTIME_MODE_ENV = "JOBCTRL_RUNTIME_MODE"
PAYLOAD_DIR_ENV = "JOBCTRL_PAYLOAD_DIR"
ENV_FILE_ENV = "JOBCTRL_ENV_FILE"
PROVIDER_PACKS_DIR_ENV = "JOBCTRL_PROVIDER_PACKS_DIR"

RuntimeMode = Literal["source", "bundled"]
_PACK_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")


class RuntimeConfigurationError(RuntimeError):
    """Raised when launcher-owned runtime settings are missing or unsafe."""


def _env(env: Mapping[str, str] | None = None) -> Mapping[str, str]:
    return os.environ if env is None else env


def runtime_mode(env: Mapping[str, str] | None = None) -> RuntimeMode:
    """Return the explicit runtime mode, defaulting to source compatibility."""

    raw = _env(env).get(RUNTIME_MODE_ENV, "source").strip().lower()
    if raw not in {"source", "bundled"}:
        raise RuntimeConfigurationError(
            f"{RUNTIME_MODE_ENV} must be 'source' or 'bundled', got {raw!r}"
        )
    return raw  # type: ignore[return-value]


def is_bundled_runtime(env: Mapping[str, str] | None = None) -> bool:
    return runtime_mode(env) == "bundled"


def _absolute_path(raw: str, *, variable: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise RuntimeConfigurationError(f"{variable} must be an absolute path")
    return path.resolve(strict=False)


def _require_owned_path(path: Path, owner: Path, *, variable: str) -> Path:
    owner = owner.expanduser().resolve(strict=False)
    try:
        path.relative_to(owner)
    except ValueError as exc:
        raise RuntimeConfigurationError(
            f"{variable} must resolve inside the JobCtrl state directory {owner}"
        ) from exc
    return path


def payload_dir(
    env: Mapping[str, str] | None = None,
    *,
    require_exists: bool = True,
) -> Path:
    """Return the immutable bundled payload root supplied by the launcher."""

    values = _env(env)
    if not is_bundled_runtime(values):
        raise RuntimeConfigurationError(f"{PAYLOAD_DIR_ENV} is only defined in bundled mode")
    raw = values.get(PAYLOAD_DIR_ENV, "").strip()
    if not raw:
        raise RuntimeConfigurationError(f"bundled mode requires {PAYLOAD_DIR_ENV}")
    path = _absolute_path(raw, variable=PAYLOAD_DIR_ENV)
    if require_exists and not path.is_dir():
        raise RuntimeConfigurationError(f"bundled payload directory does not exist: {path}")
    return path


def payload_path(
    relative: str | Path,
    env: Mapping[str, str] | None = None,
    *,
    require_exists: bool = True,
) -> Path:
    """Resolve one immutable payload path without permitting traversal."""

    root = payload_dir(env, require_exists=require_exists)
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise RuntimeConfigurationError("payload component paths must be safe relative paths")
    resolved = (root / candidate).resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise RuntimeConfigurationError("payload component path escapes the payload root") from exc
    if require_exists and not resolved.exists():
        raise RuntimeConfigurationError(f"bundled payload component does not exist: {resolved}")
    return resolved


def owned_env_path(
    env: Mapping[str, str] | None = None,
    *,
    app_dir: Path,
) -> Path:
    """Resolve the only dotenv file bundled mode may read.

    The launcher may select a state-owned file with ``JOBCTRL_ENV_FILE``.  It
    cannot point JobCtrl at a checkout, the current directory, or another
    user's file.
    """

    values = _env(env)
    raw = values.get(ENV_FILE_ENV, "").strip()
    if not raw:
        path = (app_dir / ".env").resolve(strict=False)
        return _require_owned_path(path, app_dir, variable=ENV_FILE_ENV)
    path = _absolute_path(raw, variable=ENV_FILE_ENV)
    return _require_owned_path(path, app_dir, variable=ENV_FILE_ENV)


def provider_packs_dir(
    env: Mapping[str, str] | None = None,
    *,
    app_dir: Path,
) -> Path:
    """Return the state-owned root for separately acquired provider packs."""

    values = _env(env)
    raw = values.get(PROVIDER_PACKS_DIR_ENV, "").strip()
    if not raw:
        path = (app_dir / "provider-packs").resolve(strict=False)
        return _require_owned_path(path, app_dir, variable=PROVIDER_PACKS_DIR_ENV)
    path = _absolute_path(raw, variable=PROVIDER_PACKS_DIR_ENV)
    return _require_owned_path(path, app_dir, variable=PROVIDER_PACKS_DIR_ENV)


def provider_runtime_home(provider: str, *, app_dir: Path) -> Path:
    """Return an isolated HOME/config root for one bundled provider runtime."""

    if not _PACK_ID_RE.fullmatch(provider):
        raise RuntimeConfigurationError(f"invalid provider id: {provider!r}")
    path = app_dir.resolve(strict=False) / "provider-runtime" / provider
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def activate_provider_pack(pack_id: str, *, app_dir: Path) -> Path | None:
    """Put the active managed pack on ``sys.path`` in bundled mode.

    Source installs keep normal package resolution.  Bundled mode requires an
    installer-written ``active.json`` and never searches a checkout or a user
    Python environment.
    """

    if not is_bundled_runtime():
        return None
    if not _PACK_ID_RE.fullmatch(pack_id):
        raise RuntimeConfigurationError(f"invalid provider pack id: {pack_id!r}")
    # Provider trees are integrity-checked executable state. The native/API
    # launch paths also use `-B`, but enforce the invariant at activation so a
    # missed wrapper cannot add __pycache__ files and invalidate an already
    # active pack before the next provider is loaded.
    sys.dont_write_bytecode = True
    from jobctrl.provider_packs import (
        ProviderPackError,
        expected_provider_tree_sha256,
        load_provider_pack_spec,
        provider_tree_sha256,
    )

    root = provider_packs_dir(app_dir=app_dir)
    pack_parent = root / pack_id
    if pack_parent.is_symlink():
        raise RuntimeConfigurationError(f"provider pack parent cannot be a symlink: {pack_parent}")
    try:
        # The native launcher verifies the payload manifest/signature before it
        # starts Python. This immutable lock, not mutable state metadata, is the
        # authority for every executable byte admitted by a provider pack.
        lock_path = payload_path("release/provider-packs.lock.json", require_exists=True)
        signed_spec = load_provider_pack_spec(lock_path, pack_id=pack_id)
    except (ProviderPackError, RuntimeConfigurationError) as exc:
        raise RuntimeConfigurationError(
            f"provider pack {pack_id!r} is absent from the signed payload lock"
        ) from exc
    resolved_parent = pack_parent.resolve(strict=False)
    _require_owned_path(resolved_parent, root, variable=PROVIDER_PACKS_DIR_ENV)
    active_path = resolved_parent / "active.json"
    if active_path.is_symlink():
        raise RuntimeConfigurationError(f"provider pack activation file cannot be a symlink: {active_path}")
    try:
        active = json.loads(active_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeConfigurationError(
            f"provider pack {pack_id!r} is not installed; enable/install it with jobctrl"
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeConfigurationError(f"invalid provider pack activation file: {active_path}") from exc
    if not isinstance(active, dict) or set(active) != {"schemaVersion", "version", "treeSha256"}:
        raise RuntimeConfigurationError(f"invalid provider pack activation metadata: {active_path}")
    if active.get("schemaVersion") != 1:
        raise RuntimeConfigurationError(f"unsupported provider pack activation schema: {active_path}")
    version = active.get("version")
    digest = active.get("treeSha256")
    if not isinstance(version, str) or not version or any(part in version for part in ("/", "\\", "..")):
        raise RuntimeConfigurationError(f"invalid provider pack version in {active_path}")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise RuntimeConfigurationError(f"invalid provider pack digest in {active_path}")
    if version != signed_spec.version:
        raise RuntimeConfigurationError(
            f"provider pack activation version is not authorized by the signed lock: {active_path}"
        )
    pack_root = (root / pack_id / version).resolve(strict=False)
    _require_owned_path(pack_root, root, variable=PROVIDER_PACKS_DIR_ENV)
    if (root / pack_id / version).is_symlink():
        raise RuntimeConfigurationError(f"provider pack root cannot be a symlink: {pack_root}")
    metadata_path = pack_root / "pack.json"
    if metadata_path.is_symlink():
        raise RuntimeConfigurationError(f"provider pack metadata cannot be a symlink: {metadata_path}")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeConfigurationError(f"provider pack metadata is unreadable: {metadata_path}") from exc
    site_packages = pack_root / "site-packages"
    if site_packages.is_symlink() or not site_packages.is_dir():
        raise RuntimeConfigurationError(f"provider pack site-packages is missing: {site_packages}")
    try:
        expected_digest = expected_provider_tree_sha256(signed_spec, pack_root / "wheels")
        actual_digest = provider_tree_sha256(site_packages)
    except ProviderPackError as exc:
        raise RuntimeConfigurationError(
            f"provider pack cannot be reproduced from signed retained wheels: {pack_root}"
        ) from exc
    authorized_metadata = signed_spec.to_metadata(tree_sha256=expected_digest)
    if metadata != authorized_metadata or digest != expected_digest:
        raise RuntimeConfigurationError(
            f"provider pack metadata is not authorized by the signed payload lock: {metadata_path}"
        )
    if actual_digest != expected_digest:
        raise RuntimeConfigurationError(
            f"provider pack tree differs from its signed retained wheels: {site_packages}"
        )

    resolved = str(site_packages.resolve())
    managed_sites: dict[str, str] = {}
    root_resolved = root.resolve(strict=False)
    for entry in sys.path:
        try:
            candidate = Path(entry or os.getcwd()).resolve(strict=False)
            relative = candidate.relative_to(root_resolved)
        except (OSError, ValueError):
            continue
        if len(relative.parts) == 3 and relative.parts[-1] == "site-packages":
            other_pack_id = relative.parts[0]
            if _PACK_ID_RE.fullmatch(other_pack_id):
                managed_sites[str(candidate)] = other_pack_id

    # A provider closure may not replace a core distribution. Provider packs
    # are appended rather than prepended, and signed-identical shared wheels are
    # the only overlap allowed between two active packs.
    core_paths = [
        entry
        for entry in sys.path
        if str(Path(entry or os.getcwd()).resolve(strict=False)) not in managed_sites
    ]
    core_distributions = {
        re.sub(r"[-_.]+", "-", name.lower())
        for distribution in importlib.metadata.distributions(path=core_paths)
        if (name := distribution.metadata.get("Name"))
    }
    core_overlap = sorted(set(signed_spec.exact_packages) & core_distributions)
    if core_overlap:
        raise RuntimeConfigurationError(
            f"provider pack {pack_id!r} overlaps core distributions: {', '.join(core_overlap)}"
        )
    signed_wheels = {wheel.package: wheel for wheel in signed_spec.wheels}
    for other_path, other_pack_id in managed_sites.items():
        if other_path == resolved:
            continue
        try:
            other_spec = load_provider_pack_spec(lock_path, pack_id=other_pack_id)
            other_site = Path(other_path)
            other_root = other_site.parent
            if (
                other_root.name != other_spec.version
                or other_root.is_symlink()
                or other_site.is_symlink()
            ):
                raise ProviderPackError("active provider path does not match the signed version")
            other_expected_digest = expected_provider_tree_sha256(
                other_spec,
                other_root / "wheels",
            )
            other_actual_digest = provider_tree_sha256(other_site)
            other_metadata_path = other_root / "pack.json"
            if other_metadata_path.is_symlink():
                raise ProviderPackError("active provider metadata cannot be a symlink")
            other_metadata = json.loads(other_metadata_path.read_text(encoding="utf-8"))
            other_active_path = root_resolved / other_pack_id / "active.json"
            if other_active_path.is_symlink():
                raise ProviderPackError("active provider selection cannot be a symlink")
            other_active = json.loads(other_active_path.read_text(encoding="utf-8"))
            if (
                other_expected_digest != other_actual_digest
                or other_metadata
                != other_spec.to_metadata(tree_sha256=other_expected_digest)
                or other_active
                != {
                    "schemaVersion": 1,
                    "version": other_spec.version,
                    "treeSha256": other_expected_digest,
                }
            ):
                raise ProviderPackError("active provider state differs from its signed wheels")
        except ProviderPackError as exc:
            raise RuntimeConfigurationError(
                f"active provider pack {other_pack_id!r} is not authorized by the signed payload lock"
            ) from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeConfigurationError(
                f"active provider pack {other_pack_id!r} has unreadable activation state"
            ) from exc
        other_wheels = {wheel.package: wheel for wheel in other_spec.wheels}
        overlap = set(signed_wheels) & set(other_wheels)
        incompatible = sorted(
            package for package in overlap if signed_wheels[package] != other_wheels[package]
        )
        if incompatible:
            raise RuntimeConfigurationError(
                f"provider packs {other_pack_id!r} and {pack_id!r} have incompatible overlap: "
                f"{', '.join(incompatible)}"
            )
    if resolved not in sys.path:
        sys.path.append(resolved)
    return site_packages


__all__ = [
    "ENV_FILE_ENV",
    "PAYLOAD_DIR_ENV",
    "PROVIDER_PACKS_DIR_ENV",
    "RUNTIME_MODE_ENV",
    "RuntimeConfigurationError",
    "activate_provider_pack",
    "is_bundled_runtime",
    "owned_env_path",
    "payload_dir",
    "payload_path",
    "provider_packs_dir",
    "provider_runtime_home",
    "runtime_mode",
]
