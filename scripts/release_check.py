"""Pre-publication checks for private data and stale provenance.

The prompt tripwires are warnings by default because their source fixes land in
W1. Pass ``--strict-prompt`` after W1 completes to promote them to failures.
"""

from __future__ import annotations

import argparse
import hashlib
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
    ".cjs",
    ".css",
    ".csv",
    ".html",
    ".ini",
    ".json",
    ".js",
    ".md",
    ".mjs",
    ".map",
    ".py",
    ".sql",
    ".svg",
    ".toml",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}

# JavaScript bundles are token-dense after minification. Two short employer
# names in the private-profile tripwire have known substring collisions in a
# production bundle, so emitted JavaScript checks them at identifier/token
# boundaries instead. Source files, source maps, artifact names, and every
# other privacy needle continue to use the complete raw-substring policy.
MINIFIED_BUILD_SUFFIXES = {".cjs", ".js", ".mjs"}

# Public-demo fixtures are deliberately a tiny, exact set.  The general PDF
# ban below remains in force for every other file, including any additional
# file placed under `demo/`.  These names are allowed only so the public build
# can ship its two synthetic previews; their contents are still scanned as
# untrusted fixture input in source, generated bundles, and archives.
DEMO_PUBLIC_FIXTURE_FILENAMES = frozenset(
    {
        "application-preview.html",
        "cover-letter.txt",
        "interview-notes.txt",
        "profile-resume.html",
        "profile-resume.pdf",
        "source-preview.html",
        "tailored-resume.html",
        "tailored-resume.pdf",
    }
)
DEMO_PUBLIC_FIXTURE_PREFIXES = (
    "apps/web/public/demo/",
    "apps/web/dist/demo/",
    "dist/web/demo/",
    "dist/web-storybook/demo/",
    "demo/",
)
DEMO_PUBLIC_PDF_SHA256_BY_FILENAME = {
    "profile-resume.pdf": "b0e4b351dc0f4ef6138b65fb3aec2e43890ca118ee4695c2716d9555b02cf352",
    "tailored-resume.pdf": "8fcfe632b3758e047fa04dcc9e1912a7065b07013e5dfaf4489fc14d9b0faaa1",
}
DEMO_BUILD_DIRS = (
    Path("dist/web"),
    Path("dist/web-storybook"),
    Path("apps/web/dist"),
)
DEMO_FIXTURE_PRIVACY_PATTERNS = (
    ("email", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)),
    (
        "domain",
        re.compile(
            r"(?<![/\w@.-])(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b",
            re.IGNORECASE,
        ),
    ),
    (
        "phone",
        re.compile(
            r"(?<!\w)(?:\+\d{1,3}(?:[\s().-]*\d){6,14}|"
            r"(?!\d{4}-\d{2}-\d{2}(?:T|\b))(?:\(?\d{2,4}\)?[ .-]){2,4}\d{2,4})(?!\d)"
        ),
    ),
    (
        "secret",
        re.compile(r"\b(?:sk-[a-z0-9_-]+|api[_ -]?key|authorization:\s*bearer|begin private key)\b", re.IGNORECASE),
    ),
    ("full URL", re.compile(r"\b(?:https?|file)://", re.IGNORECASE)),
    ("local path", re.compile(r"(?:^|[\s\"'])?(?:~/|/Users/|/home/|[A-Za-z]:\\\\)")),
    (
        "raw prompt/profile content",
        re.compile(r"\b(?:system prompt|prompt template|instruction hierarchy|raw profile text|profile payload|resume source text)\b", re.IGNORECASE),
    ),
)

ARCHIVE_DIRS = (
    Path("dist"),
    Path("workers/automation/dist"),
)
NON_RELEASE_QA_OUTPUT_DIRS = (
    Path("dist/playwright-report"),
    Path("dist/web-storybook"),
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

MINIFIED_BUILD_COLLISION_VALUES = frozenset(
    {
        "Well" + "tech",
        "Tes" + "la",
    }
)


def minified_build_needles(
    needles: Iterable[ForbiddenNeedle],
) -> tuple[ForbiddenNeedle, ...]:
    """Return raw-substring checks without known minification collisions.

    The omitted values are still enforced by ``scan_minified_build_text`` at
    identifier/token boundaries. Every other caller-supplied needle remains a
    raw-substring check.
    """
    return tuple(
        needle
        for needle in needles
        if needle.value not in MINIFIED_BUILD_COLLISION_VALUES
    )


def scan_minified_build_text(
    label: str,
    text: str,
    rel: Path,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
) -> list[str]:
    """Scan emitted JavaScript without identifier-substring false positives."""
    all_needles = tuple(needles)
    findings = scan_text(
        label,
        text,
        rel,
        needles=minified_build_needles(all_needles),
    )
    for needle in all_needles:
        if needle.value not in MINIFIED_BUILD_COLLISION_VALUES:
            continue
        flags = 0 if needle.case_sensitive else re.IGNORECASE
        if re.search(
            rf"(?<![\w$]){re.escape(needle.value)}(?![\w$])",
            text,
            flags,
        ):
            findings.append(f"{label}: contains {needle.reason}")
    return findings

PUBLIC_COPYRIGHT_HOLDER = "El" + "oi Barti"
PUBLIC_COPYRIGHT_SNIPPETS = (
    f"Copyright (C) 2026 {PUBLIC_COPYRIGHT_HOLDER}",
    f"Copyright © 2026 {PUBLIC_COPYRIGHT_HOLDER}",
)
PUBLIC_CONTROLLER_NAME = "El" + "oi Barti"
PUBLIC_CONTROLLER_EMAIL = "me@" + "el" + "oi" + "barti" + ".com"
PUBLIC_CONTROLLER_SOURCE_SNIPPETS = {
    Path("apps/web/src/demo/consent/DemoConsentGate.tsx"): (
        f"Data controller: {PUBLIC_CONTROLLER_NAME}, acting as an individual. Privacy questions:",
        f'<a href="mailto:{PUBLIC_CONTROLLER_EMAIL}">{PUBLIC_CONTROLLER_EMAIL}</a>',
    ),
    Path("apps/web/src/demo/consent/DemoConsentGate.test.tsx"): (
        f"screen.getByText(/data controller: {PUBLIC_CONTROLLER_NAME.lower()}, acting as an individual/i)",
        f'name: "{PUBLIC_CONTROLLER_EMAIL}"',
        f'"mailto:{PUBLIC_CONTROLLER_EMAIL}"',
    ),
    Path("docs/user/data-and-safety.md"): (
        f"The data controller for the public demo is {PUBLIC_CONTROLLER_NAME}, acting as an individual.\n"
        f"For privacy questions, contact [{PUBLIC_CONTROLLER_EMAIL}](mailto:{PUBLIC_CONTROLLER_EMAIL}).",
        f"The data controller for this documentation measurement is {PUBLIC_CONTROLLER_NAME}, acting as\n"
        "an individual. For privacy questions, contact\n"
        f"[{PUBLIC_CONTROLLER_EMAIL}](mailto:{PUBLIC_CONTROLLER_EMAIL}).",
    ),
    Path("docs/.vitepress/dist/user/data-and-safety.html"): (
        f"The data controller for the public demo is {PUBLIC_CONTROLLER_NAME}, acting as an individual. "
        "For privacy questions, contact "
        f'<a href="mailto:{PUBLIC_CONTROLLER_EMAIL}" target="_blank" rel="noreferrer">'
        f"{PUBLIC_CONTROLLER_EMAIL}</a>.",
        f"The data controller for this documentation measurement is {PUBLIC_CONTROLLER_NAME}, acting as an individual. "
        "For privacy questions, contact "
        f'<a href="mailto:{PUBLIC_CONTROLLER_EMAIL}" target="_blank" rel="noreferrer">'
        f"{PUBLIC_CONTROLLER_EMAIL}</a>.",
    ),
}
PUBLIC_DEMO_CONTROLLER_BUILD_ASSET_PREFIXES = (
    Path("dist/web/assets"),
    Path("dist/web-storybook/assets"),
    Path("apps/web/dist/assets"),
)
PUBLIC_DEMO_CONTROLLER_BUILD_SNIPPETS = (
    f"Data controller: {PUBLIC_CONTROLLER_NAME}, acting as an individual. Privacy questions:",
    f'href:"mailto:{PUBLIC_CONTROLLER_EMAIL}",children:"{PUBLIC_CONTROLLER_EMAIL}"',
)
PUBLIC_DEMO_CONTROLLER_BUILD_SOURCE_MAP_SNIPPETS = (
    f"Data controller: {PUBLIC_CONTROLLER_NAME}, acting as an individual. Privacy questions:",
    f'href=\\"mailto:{PUBLIC_CONTROLLER_EMAIL}\\">{PUBLIC_CONTROLLER_EMAIL}</a>',
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
            # Preserve the original fail-safe source-tree behavior: every
            # UTF-8 candidate is scanned regardless of extension, while true
            # binary files are skipped. Exact demo fixtures still receive the
            # byte-level PDF/digest scan below.
            if _is_demo_fixture_location(rel):
                result.findings.extend(scan_demo_fixture_contents(str(rel), rel, (root / rel).read_bytes()))
            continue
        except OSError:
            continue
        result.findings.extend(scan_text(str(rel), text, rel, needles=needles))
        if _is_demo_fixture_location(rel):
            result.findings.extend(scan_demo_fixture_contents(str(rel), rel, (root / rel).read_bytes()))

    result.findings.extend(scan_old_product_name_gate(root, file_paths))
    result.findings.extend(scan_structural_checks(root, tracked, release_tag=release_tag))
    result.extend(scan_prompt_tripwires(root, strict_prompt=strict_prompt))
    result.findings.extend(scan_demo_build_outputs(root, needles=needles))
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
    if (
        name in FORBIDDEN_PATH_NAMES
        or (suffix in FORBIDDEN_FILE_SUFFIXES and not is_demo_public_fixture_path(rel))
    ):
        findings.append(f"{label}: private/runtime file should not be committed")

    normalized = rel.as_posix().lower()
    if any(marker in normalized for marker in BROWSER_PROFILE_MARKERS):
        findings.append(f"{label}: browser profile artifact should not be committed")

    for needle in needles:
        if _contains_needle(label, needle):
            findings.append(f"{label}: contains {needle.reason}")
    return findings


def is_demo_public_fixture_path(rel: Path) -> bool:
    """Return whether a path is one exact synthetic fixture allowed in public output."""
    normalized = rel.as_posix()
    for prefix in DEMO_PUBLIC_FIXTURE_PREFIXES:
        if not normalized.startswith(prefix):
            continue
        name = normalized.removeprefix(prefix)
        return "/" not in name and name in DEMO_PUBLIC_FIXTURE_FILENAMES
    return False


def _is_demo_fixture_location(rel: Path) -> bool:
    normalized = rel.as_posix()
    return any(normalized.startswith(prefix) for prefix in DEMO_PUBLIC_FIXTURE_PREFIXES)


def scan_demo_fixture_contents(label: str, rel: Path, content: bytes) -> list[str]:
    """Fail closed on sensitive content inside bundled synthetic public fixtures."""
    findings: list[str] = []
    if rel.suffix.lower() == ".pdf":
        expected_digest = DEMO_PUBLIC_PDF_SHA256_BY_FILENAME.get(rel.name)
        if expected_digest is None or hashlib.sha256(content).hexdigest() != expected_digest:
            findings.append(f"{label}: demo PDF fixture does not match its pinned content digest")
        if not content.startswith(b"%PDF-"):
            findings.append(f"{label}: demo PDF fixture has an invalid PDF header")

    text = content.decode("utf-8", errors="ignore")
    for reason, pattern in DEMO_FIXTURE_PRIVACY_PATTERNS:
        if pattern.search(text):
            findings.append(f"{label}: demo fixture contains {reason}")
    return findings


def scan_file_contents(
    label: str,
    rel: Path,
    content: bytes,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
) -> list[str]:
    """Scan build/archive text members plus every public-demo fixture byte stream."""
    findings: list[str] = []
    if rel.suffix.lower() in TEXT_SUFFIXES:
        try:
            text = content.decode("utf-8")
            if rel.suffix.lower() in MINIFIED_BUILD_SUFFIXES:
                findings.extend(
                    scan_minified_build_text(label, text, rel, needles=needles)
                )
            else:
                findings.extend(scan_text(label, text, rel, needles=needles))
        except UnicodeDecodeError:
            pass
    if _is_demo_fixture_location(rel):
        findings.extend(scan_demo_fixture_contents(label, rel, content))
    return findings


def scan_demo_build_outputs(
    root: Path = ROOT,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
) -> list[str]:
    """Scan ignored web-build outputs, source maps, and copied demo fixture bytes."""
    findings: list[str] = []
    for build_dir in DEMO_BUILD_DIRS:
        if build_dir in NON_RELEASE_QA_OUTPUT_DIRS:
            continue
        path = root / build_dir
        if not path.exists():
            continue
        for file_path in sorted(candidate for candidate in path.rglob("*") if candidate.is_file()):
            rel = file_path.relative_to(root)
            label = rel.as_posix()
            name_findings = scan_name(label, rel, needles=needles)
            findings.extend(name_findings)
            if name_findings:
                continue
            findings.extend(
                scan_file_contents(
                    label,
                    rel,
                    file_path.read_bytes(),
                    needles=needles,
                )
            )
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
    redacted_text = _redact_public_controller_disclosures(text, rel)
    for needle in needles:
        scan_target = _redact_public_attribution(redacted_text, rel, needle)
        if _contains_needle(scan_target, needle):
            findings.append(f"{label}: contains {needle.reason}")

    if _is_secret_assignment_file(rel):
        findings.extend(scan_secret_assignments(label, text))
    return findings


def _redact_public_controller_disclosures(text: str, rel: Path) -> str:
    """Exclude approved controller disclosures only at their public release surfaces."""
    snippets = PUBLIC_CONTROLLER_SOURCE_SNIPPETS.get(rel)
    if snippets is None and _is_public_demo_controller_build_asset(rel):
        snippets = (
            PUBLIC_DEMO_CONTROLLER_BUILD_SOURCE_MAP_SNIPPETS
            if rel.suffix.lower() == ".map"
            else PUBLIC_DEMO_CONTROLLER_BUILD_SNIPPETS
        )
    if snippets is None:
        return text

    redacted = text
    for snippet in snippets:
        redacted = redacted.replace(snippet, "<public demo controller disclosure>")
    return redacted


def _is_public_demo_controller_build_asset(rel: Path) -> bool:
    if rel.is_absolute() or ".." in rel.parts:
        return False
    return rel.suffix.lower() in {*MINIFIED_BUILD_SUFFIXES, ".map"} and any(
        rel.is_relative_to(prefix)
        for prefix in PUBLIC_DEMO_CONTROLLER_BUILD_ASSET_PREFIXES
    )


def _redact_public_attribution(text: str, rel: Path, needle: ForbiddenNeedle) -> str:
    """Exclude explicit public legal metadata from the private-name tripwire."""
    if needle.reason != "private first name":
        return text

    redacted = text
    for snippet in PUBLIC_COPYRIGHT_SNIPPETS:
        redacted = redacted.replace(snippet, "<public copyright holder>")

    if rel.name in {"METADATA", "PKG-INFO"}:
        redacted = redacted.replace(
            f"Author: {PUBLIC_COPYRIGHT_HOLDER}",
            "Author: <public copyright holder>",
        )
    if rel.name == "pyproject.toml":
        redacted = redacted.replace(
            f'authors = [{{ name = "{PUBLIC_COPYRIGHT_HOLDER}" }}]',
            'authors = [{ name = "<public copyright holder>" }]',
        )
    return redacted


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
    findings.extend(_version_parity_findings(root, release_tag=release_tag))
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
        for archive in sorted(candidate for candidate in dist_path.rglob("*") if candidate.is_file()):
            if _is_non_release_qa_output(root, archive):
                continue
            if archive.suffix in {".whl", ".zip"}:
                archive_findings = scan_zip_archive(root, archive, needles=needles)
            elif archive.name.endswith(".tar.gz"):
                archive_findings = scan_tar_archive(root, archive, needles=needles)
            else:
                archive_findings = []
            findings.extend(archive_findings)
            if expected_version is not None and (archive.suffix == ".whl" or archive.name.endswith(".tar.gz")):
                if not _has_unreadable_archive_finding(root, archive, archive_findings):
                    findings.extend(
                        _distribution_version_findings(root, archive, expected_version)
                    )
    return findings


def _is_non_release_qa_output(root: Path, path: Path) -> bool:
    """Return whether a file belongs to an ignored non-release QA output tree."""
    relative = path.relative_to(root)
    return any(
        relative.parts[: len(output_dir.parts)] == output_dir.parts
        for output_dir in NON_RELEASE_QA_OUTPUT_DIRS
    )


def _unreadable_archive_finding(path: Path, root: Path, archive_type: str) -> str:
    return f"{path.relative_to(root)}: unreadable {archive_type} archive"


def _has_unreadable_archive_finding(
    root: Path,
    path: Path,
    findings: Iterable[str],
) -> bool:
    return any(finding.startswith(f"{path.relative_to(root)}: unreadable ") for finding in findings)


def _distribution_version_findings(
    root: Path,
    archive: Path,
    expected_version: str,
) -> list[str]:
    """Verify built wheel/sdist metadata matches the source project version."""
    metadata: list[tuple[str, str]] = []
    try:
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
    except (OSError, RuntimeError, UnicodeDecodeError, tarfile.TarError, zipfile.BadZipFile):
        archive_type = "ZIP" if archive.suffix == ".whl" else "tar"
        return [_unreadable_archive_finding(archive, root, archive_type)]

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
    try:
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                member = Path(info.filename)
                label = f"{path.relative_to(root)}!{info.filename}"
                name_findings = scan_name(label, member, needles=needles)
                findings.extend(name_findings)
                if not name_findings:
                    findings.extend(scan_file_contents(label, member, archive.read(info), needles=needles))
    except (OSError, RuntimeError, zipfile.BadZipFile):
        findings.append(_unreadable_archive_finding(path, root, "ZIP"))
    return findings


def scan_tar_archive(
    root: Path,
    path: Path,
    *,
    needles: Iterable[ForbiddenNeedle] = FORBIDDEN_TEXT,
) -> list[str]:
    """Scan an sdist archive."""
    findings: list[str] = []
    try:
        with tarfile.open(path) as archive:
            for info in archive.getmembers():
                if not info.isfile():
                    continue
                member = Path(info.name)
                label = f"{path.relative_to(root)}!{info.name}"
                name_findings = scan_name(label, member, needles=needles)
                findings.extend(name_findings)
                if name_findings:
                    continue
                extracted = archive.extractfile(info)
                if extracted is not None:
                    findings.extend(scan_file_contents(label, member, extracted.read(), needles=needles))
    except (OSError, tarfile.TarError):
        findings.append(_unreadable_archive_finding(path, root, "tar"))
    return findings


if __name__ == "__main__":
    sys.exit(main())
