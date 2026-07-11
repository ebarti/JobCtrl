"""Install hash-pinned provider wheels into a JobCtrl-managed runtime pack.

This is the private package-management boundary used by the native launcher.
It intentionally has no pip/uv subprocess path: the launcher supplies a signed
JSON spec containing official HTTPS wheel URLs and SHA-256 digests, and this
module downloads, verifies, safely extracts, and atomically activates the pack.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from jobctrl.runtime import provider_packs_dir

SPEC_SCHEMA_VERSION = 1
MAX_WHEEL_BYTES = 1024 * 1024 * 1024
MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024
_PACK_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
_VERSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+!-]{0,127}\Z")
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")


class ProviderPackError(RuntimeError):
    """Raised when provider metadata or a wheel fails closed."""


@dataclass(frozen=True)
class ProviderWheelSpec:
    package: str
    version: str
    filename: str
    url: str
    sha256: str
    size_bytes: int


@dataclass(frozen=True)
class ProviderPackSpec:
    platform: str
    python: str
    pack_id: str
    version: str
    owner: str
    source: str
    license: str
    redistribution: str
    isolation: str
    exact_packages: tuple[str, ...]
    wheels: tuple[ProviderWheelSpec, ...]

    def to_metadata(self, *, tree_sha256: str) -> dict[str, Any]:
        return {
            "schemaVersion": SPEC_SCHEMA_VERSION,
            "platform": self.platform,
            "python": self.python,
            "id": self.pack_id,
            "version": self.version,
            "owner": self.owner,
            "source": self.source,
            "license": self.license,
            "redistribution": self.redistribution,
            "isolation": self.isolation,
            "exactPackages": list(self.exact_packages),
            "wheels": [
                {
                    "package": wheel.package,
                    "version": wheel.version,
                    "url": wheel.url,
                    "sha256": wheel.sha256,
                    "sizeBytes": wheel.size_bytes,
                }
                for wheel in self.wheels
            ],
            "treeSha256": tree_sha256,
        }


@dataclass(frozen=True)
class ProviderTreeStats:
    """Deterministic logical-size evidence for an extracted provider tree."""

    tree_sha256: str
    file_count: int
    installed_bytes: int


WheelFetcher = Callable[[ProviderWheelSpec, Path], None]


def _require_exact_keys(value: Mapping[str, Any], expected: set[str], *, label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ProviderPackError(f"{label} fields mismatch; missing={missing}, extra={extra}")


def _required_string(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProviderPackError(f"{label} must be a non-empty string")
    return value.strip()


def _validate_https_url(value: Any, *, label: str) -> str:
    url = _required_string(value, label=label)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ProviderPackError(f"{label} must be an unauthenticated HTTPS URL")
    if parsed.fragment:
        raise ProviderPackError(f"{label} must not include a fragment")
    if parsed.hostname != "files.pythonhosted.org" and label.startswith("wheels["):
        raise ProviderPackError(f"{label} must use the locked PyPI wheel host")
    return url


def _canonical_package_name(value: str) -> str:
    return re.sub(r"[_.]+", "-", value.lower())


def parse_provider_pack_spec(
    payload: Mapping[str, Any],
    *,
    platform: str = "darwin-arm64",
    python: str = "cpython-3.12",
) -> ProviderPackSpec:
    """Parse one signed-lock pack entry with no permissive extension fields."""

    _require_exact_keys(
        payload,
        {
            "id",
            "version",
            "owner",
            "source",
            "license",
            "redistribution",
            "isolation",
            "exactPackages",
            "wheels",
        },
        label="provider pack spec",
    )
    if platform != "darwin-arm64":
        raise ProviderPackError(f"unsupported provider-pack platform: {platform!r}")
    if python != "cpython-3.12":
        raise ProviderPackError(f"unsupported provider-pack Python runtime: {python!r}")
    pack_id = _required_string(payload.get("id"), label="id")
    if not _PACK_ID_RE.fullmatch(pack_id):
        raise ProviderPackError(f"invalid provider pack id: {pack_id!r}")
    version = _required_string(payload.get("version"), label="version")
    if (
        not _VERSION_RE.fullmatch(version)
        or ".." in version
        or version.casefold() in {"active.json", "pack.json", "site-packages"}
    ):
        raise ProviderPackError(f"invalid provider pack version: {version!r}")
    owner = _required_string(payload.get("owner"), label="owner")
    source = _validate_https_url(payload.get("source"), label="source")
    license_name = _required_string(payload.get("license"), label="license")
    redistribution = _required_string(payload.get("redistribution"), label="redistribution")
    if redistribution != "official-download":
        raise ProviderPackError("provider packs must use redistribution=official-download")
    isolation = _required_string(payload.get("isolation"), label="isolation")
    if isolation != "independent-site-packages":
        raise ProviderPackError("provider packs must use isolation=independent-site-packages")
    raw_exact_packages = payload.get("exactPackages")
    if not isinstance(raw_exact_packages, list) or not raw_exact_packages:
        raise ProviderPackError("exactPackages must be a non-empty list")
    exact_packages = tuple(
        _required_string(value, label="exactPackages entry") for value in raw_exact_packages
    )
    if any(_canonical_package_name(value) != value for value in exact_packages):
        raise ProviderPackError("exactPackages must use canonical package names")
    if list(exact_packages) != sorted(exact_packages, key=lambda value: value.encode("utf-8")):
        raise ProviderPackError("exactPackages must be bytewise sorted")
    if len(set(exact_packages)) != len(exact_packages):
        raise ProviderPackError("exactPackages contains duplicates")
    wheel_payloads = payload.get("wheels")
    if not isinstance(wheel_payloads, list) or not wheel_payloads:
        raise ProviderPackError("wheels must be a non-empty list")
    wheels: list[ProviderWheelSpec] = []
    seen_filenames: set[str] = set()
    for index, raw_wheel in enumerate(wheel_payloads):
        if not isinstance(raw_wheel, Mapping):
            raise ProviderPackError(f"wheels[{index}] must be an object")
        _require_exact_keys(
            raw_wheel,
            {"package", "version", "url", "sha256", "sizeBytes"},
            label=f"wheels[{index}]",
        )
        package = _required_string(raw_wheel.get("package"), label=f"wheels[{index}].package")
        if _canonical_package_name(package) != package:
            raise ProviderPackError(f"wheel package name must be canonical: {package!r}")
        wheel_version = _required_string(
            raw_wheel.get("version"),
            label=f"wheels[{index}].version",
        )
        if not _VERSION_RE.fullmatch(wheel_version) or ".." in wheel_version:
            raise ProviderPackError(f"invalid wheel version: {wheel_version!r}")
        url = _validate_https_url(raw_wheel.get("url"), label=f"wheels[{index}].url")
        filename = urllib.parse.unquote(PurePosixPath(urllib.parse.urlsplit(url).path).name)
        if Path(filename).name != filename or not filename.endswith(".whl") or "\\" in filename:
            raise ProviderPackError(f"unsafe wheel filename: {filename!r}")
        folded = filename.casefold()
        if folded in seen_filenames:
            raise ProviderPackError(f"duplicate wheel filename: {filename}")
        seen_filenames.add(folded)
        digest = _required_string(raw_wheel.get("sha256"), label=f"wheels[{index}].sha256")
        if not _SHA256_RE.fullmatch(digest):
            raise ProviderPackError(f"invalid SHA-256 for wheel {filename}")
        size_bytes = raw_wheel.get("sizeBytes")
        if (
            not isinstance(size_bytes, int)
            or isinstance(size_bytes, bool)
            or size_bytes <= 0
            or size_bytes > MAX_WHEEL_BYTES
        ):
            raise ProviderPackError(f"invalid sizeBytes for wheel {filename}")
        wheels.append(
            ProviderWheelSpec(
                package=package,
                version=wheel_version,
                filename=filename,
                url=url,
                sha256=digest,
                size_bytes=size_bytes,
            )
        )
    wheel_packages = tuple(wheel.package for wheel in wheels)
    if wheel_packages != exact_packages:
        raise ProviderPackError(
            "exactPackages must exactly match the ordered full wheels closure"
        )
    return ProviderPackSpec(
        platform=platform,
        python=python,
        pack_id=pack_id,
        version=version,
        owner=owner,
        source=source,
        license=license_name,
        redistribution=redistribution,
        isolation=isolation,
        exact_packages=exact_packages,
        wheels=tuple(wheels),
    )


def parse_provider_pack_lock(
    payload: Mapping[str, Any],
    *,
    pack_id: str,
) -> ProviderPackSpec:
    """Validate the complete signed lock and return one selected pack."""

    _require_exact_keys(
        payload,
        {"schemaVersion", "platform", "python", "coreSelector", "packs"},
        label="provider pack lock",
    )
    if payload.get("schemaVersion") != SPEC_SCHEMA_VERSION:
        raise ProviderPackError("unsupported provider pack lock schema")
    platform = _required_string(payload.get("platform"), label="platform")
    python = _required_string(payload.get("python"), label="python")
    _required_string(payload.get("coreSelector"), label="coreSelector")
    raw_packs = payload.get("packs")
    if not isinstance(raw_packs, list) or not raw_packs:
        raise ProviderPackError("packs must be a non-empty list")
    parsed: dict[str, ProviderPackSpec] = {}
    for index, raw_pack in enumerate(raw_packs):
        if not isinstance(raw_pack, Mapping):
            raise ProviderPackError(f"packs[{index}] must be an object")
        pack = parse_provider_pack_spec(raw_pack, platform=platform, python=python)
        if pack.pack_id in parsed:
            raise ProviderPackError(f"duplicate provider pack id: {pack.pack_id}")
        parsed[pack.pack_id] = pack
    try:
        return parsed[pack_id]
    except KeyError as exc:
        raise ProviderPackError(f"provider pack is not present in the signed lock: {pack_id}") from exc


def load_provider_pack_spec(path: Path, *, pack_id: str) -> ProviderPackSpec:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProviderPackError(f"unable to read provider pack spec: {path}") from exc
    if not isinstance(payload, Mapping):
        raise ProviderPackError("provider pack lock must be a JSON object")
    return parse_provider_pack_lock(payload, pack_id=pack_id)


def validate_installed_pack_metadata(payload: Mapping[str, Any]) -> ProviderPackSpec:
    """Validate installer-written metadata before a pack is activated."""

    expected = {
        "schemaVersion",
        "platform",
        "python",
        "id",
        "version",
        "owner",
        "source",
        "license",
        "redistribution",
        "isolation",
        "exactPackages",
        "wheels",
        "treeSha256",
    }
    _require_exact_keys(payload, expected, label="installed provider pack metadata")
    if payload.get("schemaVersion") != SPEC_SCHEMA_VERSION:
        raise ProviderPackError("unsupported installed provider pack metadata schema")
    tree_sha256 = payload.get("treeSha256")
    if not isinstance(tree_sha256, str) or not _SHA256_RE.fullmatch(tree_sha256):
        raise ProviderPackError("installed provider pack has an invalid treeSha256")
    pack_payload = {
        key: value
        for key, value in payload.items()
        if key not in {"schemaVersion", "platform", "python", "treeSha256"}
    }
    return parse_provider_pack_spec(
        pack_payload,
        platform=str(payload["platform"]),
        python=str(payload["python"]),
    )


def _download_wheel(wheel: ProviderWheelSpec, destination: Path) -> None:
    request = urllib.request.Request(
        wheel.url,
        headers={"User-Agent": "JobCtrl provider-pack installer/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - HTTPS validated above
            final = urllib.parse.urlsplit(response.geturl())
            if (
                final.scheme != "https"
                or final.hostname != "files.pythonhosted.org"
                or final.username
                or final.password
                or final.fragment
            ):
                raise ProviderPackError(f"wheel download redirected outside HTTPS: {wheel.filename}")
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > MAX_WHEEL_BYTES:
                raise ProviderPackError(f"wheel exceeds size limit: {wheel.filename}")
            total = 0
            with destination.open("xb") as output:
                destination.chmod(0o600)
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_WHEEL_BYTES:
                        raise ProviderPackError(f"wheel exceeds size limit: {wheel.filename}")
                    output.write(chunk)
    except ProviderPackError:
        raise
    except (OSError, ValueError) as exc:
        raise ProviderPackError(f"failed to download provider wheel {wheel.filename}") from exc


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _wheel_target_path(name: str) -> PurePosixPath | None:
    if not name or "\\" in name or "\x00" in name:
        raise ProviderPackError(f"unsafe wheel member path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ProviderPackError(f"unsafe wheel member path: {name!r}")
    if name.endswith("/"):
        return None
    if path.parts[0].endswith(".data"):
        if len(path.parts) < 3:
            raise ProviderPackError(f"incomplete wheel install-scheme path: {name!r}")
        category = path.parts[1]
        if category not in {"purelib", "platlib"}:
            raise ProviderPackError(
                f"wheel member targets unsupported install scheme {category!r}: {name}"
            )
        path = PurePosixPath(*path.parts[2:])
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ProviderPackError(f"unsafe installed wheel path: {name!r}")
    return path


def _extract_wheel(
    wheel_path: Path,
    site_packages: Path,
    *,
    claimed_paths: set[str],
    extracted_bytes: int,
) -> int:
    try:
        archive = zipfile.ZipFile(wheel_path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ProviderPackError(f"invalid wheel archive: {wheel_path.name}") from exc
    with archive:
        for info in archive.infolist():
            target_path = _wheel_target_path(info.filename)
            if target_path is None:
                continue
            mode = info.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if file_type not in {0, stat.S_IFREG} or stat.S_ISLNK(mode):
                raise ProviderPackError(f"wheel contains non-regular file: {info.filename}")
            if info.flag_bits & 0x1:
                raise ProviderPackError(f"wheel contains encrypted member: {info.filename}")
            extracted_bytes += info.file_size
            if info.file_size > MAX_WHEEL_BYTES or extracted_bytes > MAX_PACK_BYTES:
                raise ProviderPackError("provider pack exceeds extracted size limit")
            key = unicodedata.normalize("NFC", target_path.as_posix()).casefold()
            if key in claimed_paths:
                raise ProviderPackError(f"provider wheels overlap at {target_path.as_posix()}")
            claimed_paths.add(key)
            destination = (site_packages / Path(*target_path.parts)).resolve(strict=False)
            try:
                destination.relative_to(site_packages)
            except ValueError as exc:
                raise ProviderPackError(f"wheel path escapes pack root: {info.filename}") from exc
            destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            try:
                source = archive.open(info, "r")
                target = destination.open("xb")
            except OSError as exc:
                raise ProviderPackError(f"failed to extract wheel member: {info.filename}") from exc
            with source, target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            destination.chmod(0o755 if mode & 0o111 else 0o644)
    return extracted_bytes


def provider_tree_stats(site_packages: Path) -> ProviderTreeStats:
    """Return canonical digest and logical-size evidence for one provider tree."""

    if site_packages.is_symlink() or not site_packages.is_dir():
        raise ProviderPackError(f"provider site-packages must be a real directory: {site_packages}")
    digest = hashlib.sha256()
    entries = list(site_packages.rglob("*"))
    symlink = next((path for path in entries if path.is_symlink()), None)
    if symlink is not None:
        raise ProviderPackError(
            f"provider pack tree contains a symlink: {symlink.relative_to(site_packages)}"
        )
    non_regular = next(
        (path for path in entries if not path.is_file() and not path.is_dir()),
        None,
    )
    if non_regular is not None:
        raise ProviderPackError(
            f"provider pack tree contains a non-regular entry: {non_regular.relative_to(site_packages)}"
        )
    files = sorted(
        (path for path in entries if path.is_file()),
        key=lambda path: path.relative_to(site_packages).as_posix().encode("utf-8"),
    )
    installed_bytes = 0
    for path in files:
        relative = path.relative_to(site_packages).as_posix()
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode not in {0o644, 0o755}:
            raise ProviderPackError(f"unsafe provider pack file mode {mode:o}: {relative}")
        file_digest = _sha256_file(path)
        size = path.stat().st_size
        installed_bytes += size
        digest.update(f"{relative}\0{file_digest}\0{size}\0{mode:04o}\n".encode())
    return ProviderTreeStats(
        tree_sha256=digest.hexdigest(),
        file_count=len(files),
        installed_bytes=installed_bytes,
    )


def provider_tree_sha256(site_packages: Path) -> str:
    """Return the canonical digest for one extracted provider site-packages tree."""

    return provider_tree_stats(site_packages).tree_sha256


def expected_provider_tree_stats(
    spec: ProviderPackSpec,
    wheels_dir: Path,
) -> ProviderTreeStats:
    """Derive authorized logical tree evidence from signed retained wheels.

    Provider-pack state is mutable, so neither ``pack.json`` nor ``active.json``
    can authorize executable content. The signed payload lock authorizes exact
    wheel bytes; activation revalidates those retained wheels and deterministically
    extracts them into a temporary tree before comparing that digest with the
    live ``site-packages`` directory.
    """

    if wheels_dir.is_symlink() or not wheels_dir.is_dir():
        raise ProviderPackError(f"provider pack retained wheels are missing: {wheels_dir}")
    entries = list(wheels_dir.iterdir())
    invalid = next(
        (path for path in entries if path.is_symlink() or not path.is_file()),
        None,
    )
    if invalid is not None:
        raise ProviderPackError(f"provider pack retained wheel is not a regular file: {invalid}")
    expected_names = {wheel.filename for wheel in spec.wheels}
    actual_names = {path.name for path in entries}
    if actual_names != expected_names:
        raise ProviderPackError(
            "provider pack retained wheels do not match the signed lock; "
            f"missing={sorted(expected_names - actual_names)}, "
            f"extra={sorted(actual_names - expected_names)}"
        )

    with tempfile.TemporaryDirectory(prefix=f"jobctrl-{spec.pack_id}-verify-") as raw_temp:
        site_packages = Path(raw_temp) / "site-packages"
        site_packages.mkdir(mode=0o755)
        site_packages = site_packages.resolve()
        claimed_paths: set[str] = set()
        extracted_bytes = 0
        for wheel in spec.wheels:
            wheel_path = wheels_dir / wheel.filename
            actual_size = wheel_path.stat().st_size
            if actual_size != wheel.size_bytes:
                raise ProviderPackError(
                    f"size mismatch for retained {wheel.filename}: "
                    f"expected {wheel.size_bytes}, got {actual_size}"
                )
            actual_digest = _sha256_file(wheel_path)
            if actual_digest != wheel.sha256:
                raise ProviderPackError(
                    f"SHA-256 mismatch for retained {wheel.filename}: "
                    f"expected {wheel.sha256}, got {actual_digest}"
                )
            extracted_bytes = _extract_wheel(
                wheel_path,
                site_packages,
                claimed_paths=claimed_paths,
                extracted_bytes=extracted_bytes,
            )
        return provider_tree_stats(site_packages)


def expected_provider_tree_sha256(
    spec: ProviderPackSpec,
    wheels_dir: Path,
) -> str:
    """Derive the only authorized installed-tree digest from retained wheels."""

    return expected_provider_tree_stats(spec, wheels_dir).tree_sha256


def _write_json_atomic(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, raw_temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(raw_temp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        temp.chmod(0o600)
        os.replace(temp, path)
        path.chmod(0o600)
    finally:
        temp.unlink(missing_ok=True)


def install_provider_pack(
    spec: ProviderPackSpec,
    *,
    app_dir: Path,
    fetcher: WheelFetcher = _download_wheel,
) -> Path:
    """Download, verify, extract, and atomically activate one provider pack."""

    packs_root = provider_packs_dir(app_dir=app_dir)
    packs_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    packs_root.chmod(0o700)
    pack_parent = packs_root / spec.pack_id
    if pack_parent.is_symlink():
        raise ProviderPackError(f"provider pack parent cannot be a symlink: {pack_parent}")
    pack_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    pack_parent.chmod(0o700)
    target = pack_parent / spec.version
    if target.is_symlink():
        raise ProviderPackError(f"provider pack target cannot be a symlink: {target}")
    staging = Path(tempfile.mkdtemp(prefix=f".{spec.version}.staging-", dir=pack_parent))
    staging.chmod(0o700)
    try:
        site_packages = staging / "site-packages"
        site_packages.mkdir(mode=0o755)
        wheels_dir = staging / "wheels"
        wheels_dir.mkdir(mode=0o700)
        claimed_paths: set[str] = set()
        extracted_bytes = 0
        for wheel in spec.wheels:
            wheel_path = wheels_dir / wheel.filename
            fetcher(wheel, wheel_path)
            if not wheel_path.is_file() or wheel_path.is_symlink():
                raise ProviderPackError(f"wheel fetcher did not create a regular file: {wheel.filename}")
            actual = _sha256_file(wheel_path)
            if actual != wheel.sha256:
                raise ProviderPackError(
                    f"SHA-256 mismatch for {wheel.filename}: expected {wheel.sha256}, got {actual}"
                )
            actual_size = wheel_path.stat().st_size
            if actual_size != wheel.size_bytes:
                raise ProviderPackError(
                    f"size mismatch for {wheel.filename}: expected {wheel.size_bytes}, got {actual_size}"
                )
            extracted_bytes = _extract_wheel(
                wheel_path,
                site_packages,
                claimed_paths=claimed_paths,
                extracted_bytes=extracted_bytes,
            )
        tree_sha256 = provider_tree_sha256(site_packages)
        expected_tree_sha256 = expected_provider_tree_stats(spec, wheels_dir).tree_sha256
        if tree_sha256 != expected_tree_sha256:
            raise ProviderPackError(
                f"provider pack {spec.pack_id} extracted tree is not reproducible from locked wheels"
            )
        metadata = spec.to_metadata(tree_sha256=tree_sha256)
        _write_json_atomic(staging / "pack.json", metadata)
        if target.exists():
            try:
                existing = json.loads((target / "pack.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ProviderPackError(f"existing provider pack is invalid: {target}") from exc
            try:
                existing_expected = expected_provider_tree_sha256(spec, target / "wheels")
                existing_actual = provider_tree_sha256(target / "site-packages")
            except ProviderPackError as exc:
                raise ProviderPackError(f"existing provider pack is invalid: {target}") from exc
            if (
                existing != metadata
                or existing_expected != tree_sha256
                or existing_actual != tree_sha256
            ):
                raise ProviderPackError(
                    f"provider pack {spec.pack_id} {spec.version} already exists with different content"
                )
            shutil.rmtree(staging)
        else:
            os.rename(staging, target)
        _write_json_atomic(
            pack_parent / "active.json",
            {
                "schemaVersion": SPEC_SCHEMA_VERSION,
                "version": spec.version,
                "treeSha256": tree_sha256,
            },
        )
        return target
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise


__all__ = [
    "ProviderPackError",
    "ProviderPackSpec",
    "ProviderTreeStats",
    "ProviderWheelSpec",
    "expected_provider_tree_stats",
    "expected_provider_tree_sha256",
    "install_provider_pack",
    "load_provider_pack_spec",
    "parse_provider_pack_lock",
    "parse_provider_pack_spec",
    "provider_tree_sha256",
    "provider_tree_stats",
    "validate_installed_pack_metadata",
]
