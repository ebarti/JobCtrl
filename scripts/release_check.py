"""Pre-publication checks for private data and stale provenance.

The prompt tripwires are warnings by default because their source fixes land in
W1. Pass ``--strict-prompt`` after W1 completes to promote them to failures.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tarfile
import zipfile
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EXCLUDED_FILES = {
    Path("scripts/release_check.py"),
}

TEXT_SUFFIXES = {
    "",
    ".cfg",
    ".css",
    ".csv",
    ".html",
    ".ini",
    ".json",
    ".md",
    ".py",
    ".sql",
    ".svg",
    ".toml",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}

ARCHIVE_DIRS = (
    Path("dist"),
    Path("workers/automation/dist"),
)

FORBIDDEN_PATH_NAMES = {
    ".env",
    ".env.development",
    ".env.local",
    ".env.production",
    "profile.json",
    "resume.pdf",
    "resume.txt",
    "token.json",
}

FORBIDDEN_FILE_SUFFIXES = {
    ".db",
    ".db-shm",
    ".db-wal",
    ".docx",
    ".har",
    ".key",
    ".log",
    ".pdf",
    ".pem",
    ".sqlite",
    ".sqlite3",
}

BROWSER_PROFILE_MARKERS = {
    ".mozilla/firefox/profiles",
    "bravesoftware/brave-browser",
    "browser-profile",
    "browser_profiles",
    "chrome-user-data",
    "chrome_profile",
    "chrome-profile",
    "chromium/default",
    "firefox-profile",
    "google/chrome/default",
    "microsoft edge/default",
    "user data/default",
}

SECRET_KEY_RE = re.compile(
    r"(?i)(?:[A-Z0-9]+_)+(?:API_KEY|SECRET|TOKEN|PASSWORD)$"
)
ENV_SECRET_ASSIGNMENT_RE = re.compile(
    r"""(?im)^\s*([A-Z0-9_]+)\s*(?:=|:)\s*(['"]?)([^#\n'"]+)\2\s*,?\s*$"""
)
JSON_SECRET_ASSIGNMENT_RE = re.compile(
    r"""(?im)^\s*"([^"]+)"\s*:\s*"([^"\n]+)"\s*,?\s*$"""
)
PROJECT_NAME_RE = re.compile(
    r"""(?ims)^\[project\]\s*(?:(?!^\[).)*?^name\s*=\s*["']([^"']+)["']"""
)
PROJECT_VERSION_RE = re.compile(
    r"""(?ims)^\[project\]\s*(?:(?!^\[).)*?^version\s*=\s*["']([^"']+)["']"""
)
PYTHON_VERSION_RE = re.compile(r'''(?m)^__version__\s*=\s*["']([^"']+)["']''')
PUBLIC_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
LOCK_PACKAGE_BLOCK_RE = re.compile(
    r"(?ms)^\[\[package\]\]\s*(.*?)(?=^\[\[package\]\]|\Z)"
)

SECRET_FILE_SUFFIXES = {".json", ".toml", ".yaml", ".yml"}
PLACEHOLDER_VALUES = {
    "changeme",
    "change-me",
    "dummy",
    "example",
    "fake",
    "false",
    "none",
    "null",
    "placeholder",
    "replace-me",
    "test",
    "todo",
    "true",
}
PLACEHOLDER_PREFIXES = (
    "$",
    "<",
    "change_",
    "dummy_",
    "example_",
    "fake_",
    "placeholder_",
    "replace_",
    "test_",
    "your_",
    "your-",
)

PROMPT_PATH = Path("workers/automation/src/jobctrl/apply/prompt.py")
TARGET_DISTRIBUTION_NAME = "jobctrl"
PYTHON_VERSION_PATH = Path("workers/automation/src/jobctrl/__init__.py")
PYTHON_PROJECT_PATH = Path("workers/automation/pyproject.toml")
PYTHON_LOCK_PATH = Path("workers/automation/uv.lock")
EXTENSION_MANIFEST_PATH = Path("apps/extension/public/manifest.json")
PACKAGE_VERSION_PATHS = (
    Path("package.json"),
    Path("apps/api/package.json"),
    Path("apps/extension/package.json"),
    Path("apps/web/package.json"),
    Path("packages/api-client/package.json"),
    Path("packages/contracts/package.json"),
    Path("packages/domain-types/package.json"),
    Path("packages/tsconfig/package.json"),
)
HOMEBREW_FORMULA_TEMPLATE_PATH = Path("packaging/homebrew/Formula/jobctrl.rb.tmpl")
HOMEBREW_FORMULA_GENERATOR_PATH = Path("scripts/distribution-homebrew.mjs")
HOMEBREW_RELEASE_TRUST_PATH = Path("packaging/distribution/release-keys.json")
HOMEBREW_SYNC_WORKFLOW_PATH = Path(".github/workflows/sync-homebrew-tap.yml")
PUBLISH_WORKFLOW_PATH = Path(".github/workflows/release-pypi.yml")
LEGACY_PUBLISH_WORKFLOW_PATH = Path(".github/workflows/publish.yml")
OLD_PRODUCT_NAME_RE = re.compile(r"jobhunter|jobctl", re.IGNORECASE)
OLD_PRODUCT_NAME_ALLOWLIST = (
    Path("docs/plans/implemented"),
    Path("docs/incidents"),
)
OLD_PRODUCT_NAME_ALLOWED_FILES = {
    Path("scripts/release_check.py"),
}


@dataclass(frozen=True)
class ForbiddenNeedle:
    value: str
    reason: str
    case_sensitive: bool = False


@dataclass
class ScanResult:
    findings: list[str]
    warnings: list[str]

    def extend(self, other: ScanResult) -> None:
        self.findings.extend(other.findings)
        self.warnings.extend(other.warnings)


FORBIDDEN_TEXT = (
    ForbiddenNeedle("-".join(("Pickle", "Pixel")), "old repository owner"),
    ForbiddenNeedle("Resume_" + "El" + "oi", "private resume filename"),
    ForbiddenNeedle("el" + "oi" + "barti", "private username/domain"),
    ForbiddenNeedle("El" + "oi", "private first name"),
    ForbiddenNeedle("El" + "oi " + "Barti " + "Tremoleda", "private full name"),
    ForbiddenNeedle("el" + "oi" + "barti" + ".com", "private personal domain"),
    ForbiddenNeedle(
        "linkedin.com/in/" + "e" + "barti",
        "private LinkedIn profile slug",
    ),
    ForbiddenNeedle("Well" + "tech", "private employer evidence"),
    ForbiddenNeedle("Tes" + "la", "private employer evidence"),
    ForbiddenNeedle("user:" + "el" + "oi", "private seed marker"),
    ForbiddenNeedle("/Users/" + "el" + "oi" + "barti", "private home path"),
    ForbiddenNeedle(".codex/" + "gsd-core", "private toolchain path"),
    ForbiddenNeedle(".agents/" + "skills", "private toolchain path"),
    ForbiddenNeedle(
        "REQUIRED SUB-SKILL: Use " + "superpowers:",
        "private skill banner",
    ),
)


def candidate_files(root: Path = ROOT) -> list[Path]:
    """Return files that Git would consider for commit."""
    return _git_paths(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])


def tracked_files(root: Path = ROOT) -> list[Path]:
    """Return tracked files only."""
    return _git_paths(root, ["ls-files", "--cached", "-z"])


def _git_paths(root: Path, args: Sequence[str]) -> list[Path]:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
    )
    paths = []
    for raw in result.stdout.split(b"\0"):
        if not raw:
            continue
        rel = Path(raw.decode())
        if rel in EXCLUDED_FILES:
            continue
        path = root / rel
        if path.is_file():
            paths.append(rel)
    return paths


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict-prompt",
        action="store_true",
        help="Promote apply prompt safety tripwire warnings to failures.",
    )
    parser.add_argument(
        "--release-tag",
        help="Require the release ref to equal v<project version> (for publish jobs).",
    )
    args = parser.parse_args(argv)

    result = scan_tree(
        ROOT,
        needles=FORBIDDEN_TEXT,
        strict_prompt=args.strict_prompt,
        release_tag=args.release_tag,
    )

    if result.findings:
        print("Release check failed:")
        for finding in result.findings:
            print(f"  - {finding}")
    if result.warnings:
        print("Release check warnings:")
        for warning in result.warnings:
            print(f"  - {warning}")

    if result.findings:
        return 1

    print("Release check passed.")
    return 0


def scan_tree(
    root: Path,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
    paths: Iterable[Path] | None = None,
    tracked_paths: Iterable[Path] | None = None,
    strict_prompt: bool = False,
    release_tag: str | None = None,
) -> ScanResult:
    """Scan a repository tree for release-blocking private data."""
    result = ScanResult(findings=[], warnings=[])
    file_paths = list(paths) if paths is not None else candidate_files(root)
    tracked = list(tracked_paths) if tracked_paths is not None else tracked_files(root)

    for rel in file_paths:
        name_findings = scan_name(str(rel), rel, needles=needles)
        result.findings.extend(name_findings)
        if name_findings:
            continue

        try:
            text = (root / rel).read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        result.findings.extend(scan_text(str(rel), text, rel, needles=needles))

    result.findings.extend(scan_old_product_name_gate(root, file_paths))
    result.findings.extend(scan_structural_checks(root, tracked, release_tag=release_tag))
    result.extend(scan_prompt_tripwires(root, strict_prompt=strict_prompt))
    result.findings.extend(scan_dist_archives(root, needles=needles))
    return result


def scan_name(
    label: str,
    rel: Path,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
) -> list[str]:
    """Scan a path/archive member name for private artifacts."""
    findings = []
    name = rel.name
    suffix = rel.suffix.lower()
    if name in FORBIDDEN_PATH_NAMES or suffix in FORBIDDEN_FILE_SUFFIXES:
        findings.append(f"{label}: private/runtime file should not be committed")

    normalized = rel.as_posix().lower()
    if any(marker in normalized for marker in BROWSER_PROFILE_MARKERS):
        findings.append(f"{label}: browser profile artifact should not be committed")

    for needle in needles:
        if _contains_needle(label, needle):
            findings.append(f"{label}: contains {needle.reason}")
    return findings


def scan_text(
    label: str,
    text: str,
    rel: Path,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
) -> list[str]:
    """Scan text content for forbidden strings and non-empty secret assignments."""
    findings = []
    for needle in needles:
        if _contains_needle(text, needle):
            findings.append(f"{label}: contains {needle.reason}")

    if _is_secret_assignment_file(rel):
        findings.extend(scan_secret_assignments(label, text))
    return findings


def _contains_needle(haystack: str, needle: ForbiddenNeedle) -> bool:
    if needle.case_sensitive:
        return needle.value in haystack
    return needle.value.casefold() in haystack.casefold()


def _is_secret_assignment_file(rel: Path) -> bool:
    name = rel.name.lower()
    return name.startswith(".env") or rel.suffix.lower() in SECRET_FILE_SUFFIXES


def scan_secret_assignments(label: str, text: str) -> list[str]:
    """Find concrete secret assignments in env-like, JSON, YAML, and TOML text."""
    findings = []
    for key, value in _secret_assignments(text):
        if SECRET_KEY_RE.fullmatch(key) and not _is_placeholder_secret(value):
            findings.append(f"{label}: contains non-placeholder {key} assignment")
    return findings


def _secret_assignments(text: str) -> Iterable[tuple[str, str]]:
    for match in ENV_SECRET_ASSIGNMENT_RE.finditer(text):
        yield match.group(1), match.group(3)
    for match in JSON_SECRET_ASSIGNMENT_RE.finditer(text):
        yield match.group(1), match.group(2)


def _is_placeholder_secret(value: str) -> bool:
    normalized = value.strip().strip("'\"").rstrip(",").casefold()
    if not normalized:
        return True
    if normalized in PLACEHOLDER_VALUES:
        return True
    return normalized.startswith(PLACEHOLDER_PREFIXES)


def scan_structural_checks(
    root: Path,
    tracked: Iterable[Path],
    *,
    release_tag: str | None = None,
) -> list[str]:
    """Run repository-structure checks that cannot be caught by text needles."""
    findings = []
    for rel in tracked:
        if rel.parts and rel.parts[0] == ".planning":
            findings.append(f"{rel}: private planning corpus must not be tracked")

    distribution_name = _project_distribution_name(root)
    if distribution_name is not None and distribution_name != TARGET_DISTRIBUTION_NAME:
        findings.append(
            "workers/automation/pyproject.toml: distribution name must be "
            f"{TARGET_DISTRIBUTION_NAME!r} before publication"
        )
    if distribution_name == TARGET_DISTRIBUTION_NAME:
        trigger_names = _publish_trigger_names(root)
        if trigger_names != {"release"}:
            findings.append(
                f"{PUBLISH_WORKFLOW_PATH}: workflow trigger set must be exactly ['release']; "
                f"found {sorted(trigger_names)}"
            )
        elif not _publish_has_release_trigger(root):
            findings.append(
                f"{PUBLISH_WORKFLOW_PATH}: release publishing is not gated on a published GitHub Release"
            )
    if distribution_name == TARGET_DISTRIBUTION_NAME and (root / LEGACY_PUBLISH_WORKFLOW_PATH).is_file():
        findings.append(
            f"{LEGACY_PUBLISH_WORKFLOW_PATH}: legacy workflow path must stay absent and disabled"
        )
    findings.extend(_version_parity_findings(root, release_tag=release_tag))
    findings.extend(_homebrew_sync_findings(root))
    return findings


def _version_parity_findings(root: Path, *, release_tag: str | None = None) -> list[str]:
    """Require every shipped manifest and an optional release tag to agree."""
    versions: dict[Path, str] = {}
    findings: list[str] = []

    pyproject = root / PYTHON_PROJECT_PATH
    if pyproject.is_file():
        match = PROJECT_VERSION_RE.search(pyproject.read_text(encoding="utf-8"))
        if match:
            versions[PYTHON_PROJECT_PATH] = match.group(1)
    canonical = versions.get(PYTHON_PROJECT_PATH)
    if canonical is None:
        if (root / "pnpm-workspace.yaml").is_file():
            findings.append(f"{PYTHON_PROJECT_PATH}: missing required project version")
        return findings

    python_version = root / PYTHON_VERSION_PATH
    if python_version.is_file():
        match = PYTHON_VERSION_RE.search(python_version.read_text(encoding="utf-8"))
        if match:
            versions[PYTHON_VERSION_PATH] = match.group(1)
    if PYTHON_VERSION_PATH not in versions:
        findings.append(f"{PYTHON_VERSION_PATH}: missing required release version")

    python_lock = root / PYTHON_LOCK_PATH
    if python_lock.is_file():
        try:
            lock_text = python_lock.read_text(encoding="utf-8")
        except OSError:
            lock_text = ""
        for block in LOCK_PACKAGE_BLOCK_RE.finditer(lock_text):
            name = re.search(r'(?m)^name\s*=\s*"([^"]+)"', block.group(1))
            if name is None or name.group(1) != TARGET_DISTRIBUTION_NAME:
                continue
            version = re.search(r'(?m)^version\s*=\s*"([^"]+)"', block.group(1))
            if version is not None:
                versions[PYTHON_LOCK_PATH] = version.group(1)
            break
    if PYTHON_LOCK_PATH not in versions:
        findings.append(f"{PYTHON_LOCK_PATH}: missing jobctrl release version")

    for rel in PACKAGE_VERSION_PATHS:
        manifest = root / rel
        version = None
        if manifest.is_file():
            try:
                version = json.loads(manifest.read_text(encoding="utf-8")).get("version")
            except (json.JSONDecodeError, OSError):
                pass
        if isinstance(version, str) and version:
            versions[rel] = version
        else:
            findings.append(f"{rel}: missing valid release version")

    extension_manifest = root / EXTENSION_MANIFEST_PATH
    version = None
    if extension_manifest.is_file():
        try:
            version = json.loads(extension_manifest.read_text(encoding="utf-8")).get("version")
        except (json.JSONDecodeError, OSError):
            pass
        if isinstance(version, str) and version:
            versions[EXTENSION_MANIFEST_PATH] = version
    if EXTENSION_MANIFEST_PATH not in versions:
        findings.append(f"{EXTENSION_MANIFEST_PATH}: missing valid release version")

    findings.extend(
        f"{path}: version {version!r} does not match {PYTHON_PROJECT_PATH} {canonical!r}"
        for path, version in versions.items()
        if version != canonical
    )
    if not PUBLIC_VERSION_RE.fullmatch(canonical):
        findings.append(
            f"{PYTHON_PROJECT_PATH}: public release version {canonical!r} must use MAJOR.MINOR.PATCH"
        )
    if release_tag is not None and release_tag != f"v{canonical}":
        findings.append(
            f"release tag {release_tag!r} does not match project version v{canonical}"
        )
    return findings


def _project_version(root: Path) -> str | None:
    pyproject = root / PYTHON_PROJECT_PATH
    try:
        text = pyproject.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    match = PROJECT_VERSION_RE.search(text)
    return match.group(1) if match else None


def _homebrew_sync_findings(root: Path) -> list[str]:
    homebrew_surfaces = (
        HOMEBREW_FORMULA_TEMPLATE_PATH,
        HOMEBREW_FORMULA_GENERATOR_PATH,
        HOMEBREW_RELEASE_TRUST_PATH,
        HOMEBREW_SYNC_WORKFLOW_PATH,
    )
    if not any((root / surface).exists() for surface in homebrew_surfaces):
        return []
    findings = []
    try:
        template = (root / HOMEBREW_FORMULA_TEMPLATE_PATH).read_text(encoding="utf-8")
    except FileNotFoundError:
        findings.append(
            f"{HOMEBREW_FORMULA_TEMPLATE_PATH}: missing canonical Homebrew formula template"
        )
        template = ""
    if "class Jobctrl < Formula" not in template:
        findings.append(
            f"{HOMEBREW_FORMULA_TEMPLATE_PATH}: does not define the Jobctrl formula template"
        )
    if "depends_on" in template or re.search(r"(?m)^\s*head\s+", template):
        findings.append(
            f"{HOMEBREW_FORMULA_TEMPLATE_PATH}: must not declare Homebrew dependencies or a HEAD source path"
        )
    if not (root / HOMEBREW_FORMULA_GENERATOR_PATH).is_file():
        findings.append(
            f"{HOMEBREW_FORMULA_GENERATOR_PATH}: missing Homebrew descriptor/formula generator"
        )
    try:
        trust = json.loads((root / HOMEBREW_RELEASE_TRUST_PATH).read_text(encoding="utf-8"))
        if not isinstance(trust, dict) or set(trust) != {"schemaVersion", "keys"} or trust.get("schemaVersion") != 1 or not isinstance(trust.get("keys"), dict):
            raise ValueError("invalid registry")
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        findings.append(
            f"{HOMEBREW_RELEASE_TRUST_PATH}: missing or invalid canonical release trust registry"
        )
    try:
        workflow = (root / HOMEBREW_SYNC_WORKFLOW_PATH).read_text(encoding="utf-8")
    except FileNotFoundError:
        return findings + [
            f"{HOMEBREW_SYNC_WORKFLOW_PATH}: canonical Homebrew template has no P6-gated tap synchronization workflow"
        ]

    required_markers = {
        "workflow_call:": "is not reusable by the P6 release workflow",
        "workflow_dispatch:": "has no explicit fail-closed manual verification route",
        'repository: ebarti/homebrew-tap': "does not target ebarti/homebrew-tap",
        'ssh-key: ${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}': "does not use the write-scoped tap deploy key",
        "node scripts/distribution-homebrew.mjs verify-promotion": "does not independently verify signed descriptor and promotion evidence",
        "VERIFIED_FORMULA_PATH": "does not stage the verified formula at a fixed runner path",
        "homebrew-tap/Formula/jobctrl.rb": "does not write the tap formula path",
        "git status --short --untracked-files=all -- Formula/jobctrl.rb": "does not detect an absent or untracked tap formula",
    }
    findings.extend(
        f"{HOMEBREW_SYNC_WORKFLOW_PATH}: {message}"
        for marker, message in required_markers.items()
        if marker not in workflow
    )
    strict_gate = workflow.find("python3 scripts/release_check.py --strict-prompt")
    promotion_gate = workflow.find("node scripts/distribution-homebrew.mjs verify-promotion")
    tap_checkout = workflow.find("repository: ebarti/homebrew-tap")
    if strict_gate < 0:
        findings.append(
            f"{HOMEBREW_SYNC_WORKFLOW_PATH}: does not run the strict release privacy gate"
        )
    elif tap_checkout >= 0 and strict_gate > tap_checkout:
        findings.append(
            f"{HOMEBREW_SYNC_WORKFLOW_PATH}: loads tap credentials before the strict release privacy gate"
        )
    if promotion_gate < 0:
        findings.append(
            f"{HOMEBREW_SYNC_WORKFLOW_PATH}: has no signed-render promotion gate"
        )
    elif tap_checkout >= 0 and promotion_gate > tap_checkout:
        findings.append(
            f"{HOMEBREW_SYNC_WORKFLOW_PATH}: loads tap credentials before signed-render verification"
        )
    if re.search(r"(?m)^\s*push\s*:", workflow) or "types: [published]" in workflow:
        findings.append(
            f"{HOMEBREW_SYNC_WORKFLOW_PATH}: must not publish from push or merely published-release events"
        )
    return findings


def _project_distribution_name(root: Path) -> str | None:
    pyproject = root / "workers/automation/pyproject.toml"
    try:
        text = pyproject.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    match = PROJECT_NAME_RE.search(text)
    return match.group(1) if match else None


def scan_old_product_name_gate(root: Path, paths: Iterable[Path]) -> list[str]:
    findings: list[str] = []
    for rel in paths:
        if _old_product_name_allowed(rel):
            continue
        if OLD_PRODUCT_NAME_RE.search(rel.as_posix()):
            findings.append(f"{rel}: contains old product name in path")
            continue
        try:
            text = (root / rel).read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        except FileNotFoundError:
            continue
        if OLD_PRODUCT_NAME_RE.search(text):
            findings.append(f"{rel}: contains old product name")
    return findings


def _old_product_name_allowed(rel: Path) -> bool:
    if rel in OLD_PRODUCT_NAME_ALLOWED_FILES:
        return True
    return any(rel == prefix or rel.is_relative_to(prefix) for prefix in OLD_PRODUCT_NAME_ALLOWLIST)


def _publish_on_block(root: Path) -> list[tuple[int, str]]:
    workflow = root / PUBLISH_WORKFLOW_PATH
    try:
        lines = workflow.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []

    in_on_block = False
    entries: list[tuple[int, str]] = []
    for raw_line in lines:
        content = raw_line.split("#", 1)[0].rstrip()
        if not content.strip():
            continue
        indent = len(content) - len(content.lstrip())
        stripped = content.strip()

        if indent == 0 and stripped == "on:":
            in_on_block = True
            continue
        if in_on_block and indent == 0:
            break
        if in_on_block:
            entries.append((indent, stripped))
    return entries


def _trigger_children(root: Path, trigger: str) -> list[str]:
    entries = _publish_on_block(root)
    for index, (indent, stripped) in enumerate(entries):
        if stripped != f"{trigger}:":
            continue
        children: list[str] = []
        for child_indent, child in entries[index + 1:]:
            if child_indent <= indent:
                break
            children.append(child)
        return children
    return []


def _publish_trigger_names(root: Path) -> set[str]:
    entries = _publish_on_block(root)
    if not entries:
        return set()
    trigger_indent = min(indent for indent, _ in entries)
    return {
        stripped.split(":", 1)[0]
        for indent, stripped in entries
        if indent == trigger_indent and ":" in stripped
    }


def _publish_has_release_trigger(root: Path) -> bool:
    children = _trigger_children(root, "release")
    for index, child in enumerate(children):
        if not child.startswith("types:"):
            continue
        inline_tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_-]*", child.partition(":")[2])
        if inline_tokens:
            return set(inline_tokens) == {"published"}
        if child == "types:":
            activity_types = {
                item.removeprefix("- ")
                for item in children[index + 1:]
                if item.startswith("- ")
            }
            return activity_types == {"published"}
    return False


def scan_prompt_tripwires(root: Path, *, strict_prompt: bool) -> ScanResult:
    """Scan apply prompt safety issues that W1 items remove later."""
    result = ScanResult(findings=[], warnings=[])
    path = root / PROMPT_PATH
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return result

    messages = []
    if (
        "API key: {capsolver_key" in text
        or "CAPSOLVER_API_KEY" in text
        or "capsolver_key" in text
    ):
        messages.append(f"{PROMPT_PATH}: CapSolver key is interpolated into prompt text")
    if "Age 18+: Yes" in text and "Felony: No" in text:
        messages.append(f"{PROMPT_PATH}: hardcoded attestation defaults remain")
    if "{personal.get('password', '')}" in text:
        messages.append(f"{PROMPT_PATH}: profile password is interpolated into prompt text")

    if strict_prompt:
        result.findings.extend(messages)
    else:
        result.warnings.extend(messages)
    return result


def scan_dist_archives(
    root: Path = ROOT,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
) -> list[str]:
    """Scan built wheel and sdist archives when present."""
    findings: list[str] = []
    expected_version = _project_version(root)
    for dist in ARCHIVE_DIRS:
        dist_path = root / dist
        if not dist_path.exists():
            continue
        for archive in sorted(dist_path.glob("*")):
            if archive.suffix == ".whl":
                findings.extend(scan_zip_archive(root, archive, needles=needles))
            elif archive.name.endswith(".tar.gz"):
                findings.extend(scan_tar_archive(root, archive, needles=needles))
            if expected_version is not None:
                findings.extend(
                    _distribution_version_findings(root, archive, expected_version)
                )
    return findings


def _distribution_version_findings(
    root: Path,
    archive: Path,
    expected_version: str,
) -> list[str]:
    """Verify built wheel/sdist metadata matches the source project version."""
    metadata: list[tuple[str, str]] = []
    if archive.suffix == ".whl":
        with zipfile.ZipFile(archive) as bundle:
            for name in bundle.namelist():
                if name.endswith(".dist-info/METADATA"):
                    metadata.append((name, bundle.read(name).decode("utf-8")))
    elif archive.name.endswith(".tar.gz"):
        with tarfile.open(archive) as bundle:
            for info in bundle.getmembers():
                if info.isfile() and info.name.endswith("/PKG-INFO"):
                    extracted = bundle.extractfile(info)
                    if extracted is not None:
                        metadata.append((info.name, extracted.read().decode("utf-8")))
    else:
        return []

    label = archive.relative_to(root)
    if len(metadata) != 1:
        return [f"{label}: expected exactly one distribution metadata file, found {len(metadata)}"]

    member, text = metadata[0]
    match = re.search(r"(?m)^Version:\s*(\S+)\s*$", text)
    if match is None:
        return [f"{label}!{member}: distribution metadata has no Version field"]
    actual = match.group(1)
    if actual != expected_version:
        return [
            f"{label}!{member}: distribution version {actual!r} does not match "
            f"{PYTHON_PROJECT_PATH} {expected_version!r}"
        ]
    return []


def scan_zip_archive(
    root: Path,
    path: Path,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
) -> list[str]:
    """Scan a wheel archive."""
    findings: list[str] = []
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            member = Path(info.filename)
            label = f"{path.relative_to(root)}!{info.filename}"
            findings.extend(scan_name(label, member, needles=needles))
            if member.suffix in TEXT_SUFFIXES:
                try:
                    text = archive.read(info).decode("utf-8")
                except UnicodeDecodeError:
                    continue
                findings.extend(scan_text(label, text, member, needles=needles))
    return findings


def scan_tar_archive(
    root: Path,
    path: Path,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
) -> list[str]:
    """Scan an sdist archive."""
    findings: list[str] = []
    with tarfile.open(path) as archive:
        for info in archive.getmembers():
            if not info.isfile():
                continue
            member = Path(info.name)
            label = f"{path.relative_to(root)}!{info.name}"
            findings.extend(scan_name(label, member, needles=needles))
            if member.suffix in TEXT_SUFFIXES:
                extracted = archive.extractfile(info)
                if extracted is None:
                    continue
                try:
                    text = extracted.read().decode("utf-8")
                except UnicodeDecodeError:
                    continue
                findings.extend(scan_text(label, text, member, needles=needles))
    return findings


if __name__ == "__main__":
    sys.exit(main())
