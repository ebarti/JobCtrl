"""Pre-publication checks for private data and stale provenance.

The prompt tripwires are warnings by default because their source fixes land in
W1. Pass ``--strict-prompt`` after W1 completes to promote them to failures.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
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
RELEASE_DISTRIBUTION_WORKFLOW_PATH = Path(".github/workflows/release-distribution.yml")
SIGNING_POLICY_PATH = Path("packaging/distribution/signing-policy.json")
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
PUBLIC_DEMO_CONTROLLER_NAME = "El" + "oi Barti"
PUBLIC_DEMO_CONTROLLER_EMAIL = "me@" + "el" + "oi" + "barti" + ".com"
PUBLIC_DEMO_CONTROLLER_SOURCE_SNIPPETS = {
    Path("apps/web/src/demo/consent/DemoConsentGate.tsx"): (
        f"Data controller: {PUBLIC_DEMO_CONTROLLER_NAME}, acting as an individual. Privacy questions:",
        f'<a href="mailto:{PUBLIC_DEMO_CONTROLLER_EMAIL}">{PUBLIC_DEMO_CONTROLLER_EMAIL}</a>',
    ),
    Path("apps/web/src/demo/consent/DemoConsentGate.test.tsx"): (
        f"screen.getByText(/data controller: {PUBLIC_DEMO_CONTROLLER_NAME.lower()}, acting as an individual/i)",
        f'name: "{PUBLIC_DEMO_CONTROLLER_EMAIL}"',
        f'"mailto:{PUBLIC_DEMO_CONTROLLER_EMAIL}"',
    ),
    Path("docs/user/data-and-safety.md"): (
        f"The data controller for the public demo is {PUBLIC_DEMO_CONTROLLER_NAME}, acting as an individual.\n"
        f"For privacy questions, contact [{PUBLIC_DEMO_CONTROLLER_EMAIL}](mailto:{PUBLIC_DEMO_CONTROLLER_EMAIL}).",
    ),
    Path("docs/.vitepress/dist/user/data-and-safety.html"): (
        f"The data controller for the public demo is {PUBLIC_DEMO_CONTROLLER_NAME}, acting as an individual.",
        f'href="mailto:{PUBLIC_DEMO_CONTROLLER_EMAIL}">{PUBLIC_DEMO_CONTROLLER_EMAIL}</a>',
    ),
}
PUBLIC_DEMO_CONTROLLER_BUILD_ASSET_PREFIXES = (
    Path("dist/web/assets"),
    Path("dist/web-storybook/assets"),
    Path("apps/web/dist/assets"),
)
PUBLIC_DEMO_CONTROLLER_BUILD_SNIPPETS = (
    f"Data controller: {PUBLIC_DEMO_CONTROLLER_NAME}, acting as an individual. Privacy questions:",
    f'href:"mailto:{PUBLIC_DEMO_CONTROLLER_EMAIL}",children:"{PUBLIC_DEMO_CONTROLLER_EMAIL}"',
)
PUBLIC_DEMO_CONTROLLER_BUILD_SOURCE_MAP_SNIPPETS = (
    f"Data controller: {PUBLIC_DEMO_CONTROLLER_NAME}, acting as an individual. Privacy questions:",
    f'href=\\"mailto:{PUBLIC_DEMO_CONTROLLER_EMAIL}\\">{PUBLIC_DEMO_CONTROLLER_EMAIL}</a>',
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
    redacted_text = _redact_public_demo_controller_disclosure(text, rel)
    for needle in needles:
        scan_target = _redact_public_attribution(redacted_text, rel, needle)
        if _contains_needle(scan_target, needle):
            findings.append(f"{label}: contains {needle.reason}")

    if _is_secret_assignment_file(rel):
        findings.extend(scan_secret_assignments(label, text))
    return findings


def _redact_public_demo_controller_disclosure(text: str, rel: Path) -> str:
    """Exclude the approved controller disclosure only at its public release surfaces."""
    snippets = PUBLIC_DEMO_CONTROLLER_SOURCE_SNIPPETS.get(rel)
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
    if distribution_name == TARGET_DISTRIBUTION_NAME:
        standalone_publish = root / PUBLISH_WORKFLOW_PATH
        if standalone_publish.exists():
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
        else:
            try:
                distribution_workflow = (
                    root / RELEASE_DISTRIBUTION_WORKFLOW_PATH
                ).read_text(encoding="utf-8")
            except FileNotFoundError:
                distribution_workflow = ""
            if (
                "workflow_dispatch:" not in distribution_workflow
                or "  publish-pypi:" not in distribution_workflow
            ):
                findings.append(
                    f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: owner-dispatched distribution workflow must own PyPI publication"
                )
    if distribution_name == TARGET_DISTRIBUTION_NAME and (root / LEGACY_PUBLISH_WORKFLOW_PATH).is_file():
        findings.append(
            f"{LEGACY_PUBLISH_WORKFLOW_PATH}: legacy workflow path must stay absent and disabled"
        )
    findings.extend(_version_parity_findings(root, release_tag=release_tag))
    findings.extend(_homebrew_sync_findings(root))
    findings.extend(_release_distribution_findings(root))
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
        if not isinstance(trust, dict) or set(trust) != {"schemaVersion", "keys"} or trust.get("schemaVersion") != 1 or trust.get("keys") != {}:
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
        "  verify:": "does not isolate signed-render verification in a credential-free job",
        "  publish:": "does not publish from a fresh tap-only job",
        "needs: verify": "does not require credential-free verification before tap publication",
        'repository: ebarti/homebrew-tap': "does not target ebarti/homebrew-tap",
        'ssh-key: ${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}': "does not use the write-scoped tap deploy key",
        "node scripts/distribution-homebrew.mjs verify-promotion": "does not independently verify signed descriptor and promotion evidence",
        "jobctrl-verified": "does not stage the verified formula at a fixed runner path",
        "jobctrl.rb.sha256": "does not seal the exact verified formula for the publish job",
        "expected_formula_sha256:": "does not require the signer-rooted formula digest",
        "smoke_artifact_name:": "does not consume smoke as a separate gate artifact",
        "homebrew-tap/Formula/jobctrl.rb": "does not write the tap formula path",
        "git status --short --untracked-files=all -- Formula/jobctrl.rb": "does not detect an absent or untracked tap formula",
        "actions/download-artifact@": "does not download the immutable P6 artifact on its own runner",
        '--trust "$TRUST_PATH"': "does not verify against the candidate-provided release trust registry",
    }
    findings.extend(
        f"{HOMEBREW_SYNC_WORKFLOW_PATH}: {message}"
        for marker, message in required_markers.items()
        if marker not in workflow
    )
    verify = _workflow_job_body(workflow, "verify")
    publish = _workflow_job_body(workflow, "publish")
    call_interface = workflow.partition("\njobs:")[0]
    if "HOMEBREW_TAP_DEPLOY_KEY" in call_interface or re.search(
        r"(?m)^\s{4}secrets:\s*$", call_interface
    ):
        findings.append(
            f"{HOMEBREW_SYNC_WORKFLOW_PATH}: tap deploy key must be an environment secret resolved only by publish, not a workflow_call secret"
        )
    if verify is None:
        findings.append(f"{HOMEBREW_SYNC_WORKFLOW_PATH}: missing credential-free verify job")
    else:
        if "HOMEBREW_TAP_DEPLOY_KEY" in verify or "environment: release-publication" in verify:
            findings.append(
                f"{HOMEBREW_SYNC_WORKFLOW_PATH}: verify job must not receive tap publication credentials"
            )
        for marker, message in {
            "python3 scripts/release_check.py --strict-prompt": "does not run the strict release privacy gate in verify",
            "node scripts/distribution-homebrew.mjs verify-promotion": "has no signed-render promotion gate in verify",
            "actions/upload-artifact@": "does not hand the sealed formula to a fresh publish job",
            'test "$(shasum -a 256 "$FORMULA_PATH"': "does not compare the base-artifact formula to the signer digest",
        }.items():
            if marker not in verify:
                findings.append(f"{HOMEBREW_SYNC_WORKFLOW_PATH}: {message}")
    if publish is None:
        findings.append(f"{HOMEBREW_SYNC_WORKFLOW_PATH}: missing fresh tap publish job")
    else:
        executable = _workflow_executable_text(publish)
        if "HOMEBREW_TAP_DEPLOY_KEY" not in publish:
            findings.append(f"{HOMEBREW_SYNC_WORKFLOW_PATH}: publish job does not receive the tap deploy key")
        if "environment: release-publication" not in publish:
            findings.append(
                f"{HOMEBREW_SYNC_WORKFLOW_PATH}: tap publish job must resolve its deploy key behind release-publication approval"
            )
        if "Check out JobCtrl" in publish or re.search(
            r"(?im)^\s+(?:run:\s*)?(?:corepack|pnpm|npm|npx|uv|pip|python(?:3)?|node)\b",
            executable,
        ) or re.search(r"(?m)^\s+run:.*(?:scripts|workers|apps|launcher)/", executable):
            findings.append(
                f"{HOMEBREW_SYNC_WORKFLOW_PATH}: tap publish job executes JobCtrl or dependency code with the deploy key"
            )
        if "actions/download-artifact@" not in publish or "jobctrl.rb.sha256" not in publish:
            findings.append(
                f"{HOMEBREW_SYNC_WORKFLOW_PATH}: tap publish job does not consume and checksum the sealed formula artifact"
            )
        if "EXPECTED_FORMULA_SHA256" not in publish:
            findings.append(
                f"{HOMEBREW_SYNC_WORKFLOW_PATH}: tap publish job does not recheck the signer-rooted formula digest"
            )
    if "workflow_dispatch:" in workflow or re.search(r"(?m)^\s*push\s*:", workflow) or "types: [published]" in workflow:
        findings.append(f"{HOMEBREW_SYNC_WORKFLOW_PATH}: must be workflow_call-only and never expose a manual secret-bearing promotion path")
    return findings


def _workflow_job_body(workflow: str, job_name: str) -> str | None:
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}:\n(?P<body>.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)",
        workflow,
    )
    return match.group("body") if match is not None else None


def _workflow_executable_text(body: str) -> str:
    return "\n".join(
        line for line in body.splitlines() if not re.match(r"^\s*#", line)
    )


def _workflow_shell_commands(body: str) -> tuple[str, ...]:
    commands: list[str] = []
    continuation = ""
    for raw_line in _workflow_executable_text(body).splitlines():
        line = raw_line.strip()
        if not line:
            continue
        continuation = f"{continuation} {line}".strip()
        if continuation.endswith("\\"):
            continuation = continuation[:-1].rstrip()
            continue
        commands.append(continuation)
        continuation = ""
    if continuation:
        commands.append(continuation)
    return tuple(commands)


def _workflow_has_conditional_put(body: str, flag: str, value: str) -> bool:
    for command in _workflow_shell_commands(body):
        try:
            tokens = shlex.split(command, comments=True, posix=True)
        except ValueError:
            continue
        for index in range(len(tokens) - 2):
            if tokens[index : index + 3] != ["aws", "s3api", "put-object"]:
                continue
            arguments = tokens[index + 3 :]
            if any(
                arguments[position : position + 2] == [flag, value]
                for position in range(len(arguments) - 1)
            ):
                return True
    return False


def _release_distribution_findings(root: Path) -> list[str]:
    try:
        workflow = (root / RELEASE_DISTRIBUTION_WORKFLOW_PATH).read_text(encoding="utf-8")
    except FileNotFoundError:
        # Small scanner fixtures that do not model any distribution surface
        # remain valid. A real distribution checkout must carry the workflow.
        if not (root / SIGNING_POLICY_PATH).exists():
            return []
        return [f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: missing P6 signed distribution workflow"]
    required_markers = {
        "workflow_dispatch:": "has no owner-controlled manual release path",
        "group: release-distribution-${{ inputs.channel }}-darwin-arm64": "does not serialize release mutation by channel and platform",
        'test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"': "does not bind the workflow definition ref to the selected release tag",
        'test "$GITHUB_SHA" = "$head_sha"': "does not bind the workflow definition SHA to the audited release commit",
        "revoked_build_ids:": "does not require explicit revocation input",
        "expected_channel_pointer_sha256:": "does not require a compare-and-swap precondition for channel promotion",
        'gh api "repos/$GITHUB_REPOSITORY/commits/main"': "does not reassert current main through bounded authenticated reads",
        'gh api "repos/$GITHUB_REPOSITORY/commits/$RELEASE_TAG"': "does not reassert the release tag through bounded authenticated reads",
        "release_build_id=\"${RELEASE_TAG#v}-${sha}-darwin-arm64\"": "does not bind the build ID to the full immutable commit SHA",
        "runs-on: macos-15": "does not use a clean macOS signing/notarization runner",
        "environment: release-verification": "does not isolate protected non-secret release trust configuration",
        "environment: release-signing": "does not isolate protected signing credentials",
        "environment: release-publication": "does not isolate public-release side effects from signing credentials",
        "JOBCTRL_RELEASE_PUBLIC_KEY: ${{ vars.JOBCTRL_RELEASE_PUBLIC_KEY }}": "does not prepare against the protected public release key",
        "JOBCTRL_RELEASE_KEY_ID: ${{ vars.JOBCTRL_RELEASE_KEY_ID }}": "does not prepare against the protected release key ID",
        "node scripts/distribution-release.mjs prepare": "does not build pre-sign candidates",
        "node scripts/distribution-release.finalizer.bundle.mjs compare": "does not compare independent unsigned builds with checkout-rooted code",
        "node scripts/distribution-release.finalizer.bundle.mjs verify-prepared": "does not reverify selected candidate bytes before signing credentials",
        "corepack pnpm exec esbuild scripts/distribution-release-finalizer-entry.mjs --bundle --platform=node --format=esm --target=node22": "does not reproduce the tracked audited finalizer",
        "distribution-release.finalizer.bundle.mjs.sha256": "does not bind the tracked audited finalizer and third-party notice",
        "distribution-homebrew.render.bundle.mjs.sha256": "does not bind the tracked audited Homebrew renderer and third-party notice",
        "node scripts/distribution-release.finalizer.bundle.mjs finalize": "does not sign/notarize final bytes with checkout-rooted code",
        "node scripts/distribution-release.mjs smoke": "does not smoke downloaded public assets through the native lifecycle",
        "node scripts/distribution-release.mjs record-smoke": "does not persist post-publication evidence",
        "The deterministic transport container is intentionally outside": "does not document why the derived audit tar stays outside the extracted-member checksum closure",
        "channel-pointer.json": "does not carry one finalized atomic channel-pointer object through publication",
        "https://releases.jobctrl.dev/$destination": "does not checksum-read canonical published assets",
        "v1/$RELEASE_CHANNEL/darwin-arm64.json": "does not promote the compiled canonical channel path",
        "aws s3api put-object": "does not publish directly through the authenticated R2 S3 API",
        'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com': "does not bind writes to the configured R2 account endpoint",
        "AWS_ACCESS_KEY_ID: ${{ secrets.JOBCTRL_R2_ACCESS_KEY_ID }}": "does not use protected bucket-scoped R2 access-key identity",
        "AWS_SECRET_ACCESS_KEY: ${{ secrets.JOBCTRL_R2_SECRET_ACCESS_KEY }}": "does not use protected bucket-scoped R2 secret authority",
        "R2_ACCOUNT_ID: ${{ vars.JOBCTRL_R2_ACCOUNT_ID }}": "does not use protected R2 account configuration",
        "R2_BUCKET: ${{ vars.JOBCTRL_R2_BUCKET }}": "does not use protected R2 bucket configuration",
        '--if-match "$etag"': "does not compare-and-swap an existing R2 channel pointer",
        "--if-none-match '*'": "does not protect immutable R2 object creation",
        "channel-promotion-evidence.json": "does not retain channel-promotion recovery evidence",
        "immutableDescriptorUrl": "does not smoke the immutable candidate descriptor before promotion",
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02": "does not hand signed assets across clean jobs as artifacts",
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093": "does not consume signed assets through an artifact handoff",
        "gh release create \"$RELEASE_TAG\"": "does not create a draft release after exact asset verification",
        "targetCommitish": "does not bind a rerun draft release to the audited commit",
        "gh release edit \"$RELEASE_TAG\" --draft=false": "does not publish only after smoke and Homebrew gates",
        "JOBCTRL_RELEASE_ADMIN_READ_TOKEN": "does not require protected administration-read authority for immutable-release enforcement",
        "immutable-releases": "does not fail closed unless immutable GitHub Releases are enabled",
        "gh release verify-asset": "does not compare post-lock release assets to local trusted bytes",
        "gh release verify \"$RELEASE_TAG\"": "does not verify the immutable release attestation",
        "uses: ./.github/workflows/sync-homebrew-tap.yml": "does not call the artifact-only Homebrew promotion workflow",
        "brew audit --strict --formula \"$release/jobctrl.rb\"": "does not audit the rendered Homebrew formula before tap credentials are used",
        "brew test jobctrl": "does not run the rendered Homebrew formula test before tap credentials are used",
    }
    findings = [
        f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: {message}"
        for marker, message in required_markers.items()
        if marker not in workflow
    ]
    required_jobs = (
        "resolve",
        "prepare-a",
        "prepare-b",
        "compare",
        "sign",
        "package-signed-candidate",
        "publish-immutable",
        "smoke-and-verify",
        "promote-channel-pointer",
        "publish-github-release",
        "pypi-resolve",
        "pypi-build-a",
        "pypi-build-b",
        "pypi-compare",
        "publish-pypi",
    )
    jobs: dict[str, str] = {}
    for job_name in required_jobs:
        body = _workflow_job_body(workflow, job_name)
        if body is None:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: missing isolated release job {job_name}"
            )
            continue
        jobs[job_name] = body

    if "  prepare-and-sign:" in workflow or "  publish-and-smoke:" in workflow or "  plan-channel-pointer:" in workflow:
        findings.append(
            f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: signing, publication, and smoke must not share combined jobs"
        )

    resolve = jobs.get("resolve")
    if resolve is not None:
        if "environment: release-verification" not in resolve or "secrets." in resolve:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: resolve job must use only protected non-secret release-verification configuration"
            )
        if "persist-credentials: false" not in resolve:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: resolve checkout must set persist-credentials false"
            )
        if (
            'test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"' not in resolve
            or 'test "$GITHUB_SHA" = "$head_sha"' not in resolve
        ):
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: resolve must prove the executing workflow comes from the audited release tag and commit"
            )

    for job_name, artifact_name in (
        ("prepare-a", "jobctrl-prepared-a-"),
        ("prepare-b", "jobctrl-prepared-b-"),
    ):
        body = jobs.get(job_name)
        if body is None:
            continue
        if "persist-credentials: false" not in body or artifact_name not in body:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: {job_name} must independently build and upload only its candidate data"
            )
    compare = jobs.get("compare")
    if compare is not None:
        for marker in (
            "needs: [resolve, prepare-a, prepare-b]",
            "jobctrl-prepared-a-",
            "jobctrl-prepared-b-",
            "distribution-release.finalizer.bundle.mjs compare",
            "COMPARE_SHA256SUMS",
        ):
            if marker not in compare:
                findings.append(
                    f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: compare job does not independently authenticate both prepared candidates"
                )
                break
        if re.search(r"(?im)^\s+(?:run:\s*)?(?:corepack|pnpm|npm|npx|uv|pip)\b", _workflow_executable_text(compare)):
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: compare job must not install dependency tooling"
            )

    sign = jobs.get("sign")
    if sign is not None:
        executable = _workflow_executable_text(sign)
        if "environment: release-signing" not in sign or "JOBCTRL_RELEASE_SIGNING_KEY" not in sign:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: sign job must own the protected signing credentials"
            )
        if "persist-credentials: false" not in sign:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: sign checkout must set persist-credentials false"
            )
        if re.search(r"(?im)^\s+(?:run:\s*)?(?:corepack|pnpm|npm|npx|uv|pip)\b", executable):
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: sign job must not install packages or dependency tooling"
            )
        if re.search(r"(?m)^\s+(?:run:\s*)?node\s+scripts/(?!(?:distribution-release\.finalizer|distribution-homebrew\.render)\.bundle\.mjs\b)", executable):
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: sign job must execute only the sealed bundled finalizer"
            )
        if "node scripts/distribution-release.finalizer.bundle.mjs finalize" not in executable:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: sign job does not execute the sealed bundled finalizer"
            )

        if "jobctrl-compared-candidate-" not in sign or "scripts/distribution-release.bundle.mjs" in sign:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: sign job must consume only compared data and checkout-rooted authority code"
            )

    for job_name in (
        "prepare-a",
        "prepare-b",
        "compare",
        "package-signed-candidate",
        "smoke-and-verify",
        "pypi-resolve",
        "pypi-build-a",
        "pypi-build-b",
        "pypi-compare",
    ):
        body = jobs.get(job_name)
        if body is None:
            continue
        if "actions/checkout@" in body and "persist-credentials: false" not in body:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: {job_name} checkout must set persist-credentials false"
            )
        if re.search(
            r"secrets\.(?:JOBCTRL_RELEASE_SIGNING_KEY|JOBCTRL_APPLE_[A-Z0-9_]+|JOBCTRL_R2_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|HOMEBREW_TAP_DEPLOY_KEY)",
            body,
        ) or "environment: release-signing" in body or "environment: release-publication" in body:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: credential-free job {job_name} receives signing or publication authority"
            )

    for job_name in (
        "publish-immutable",
        "promote-channel-pointer",
        "publish-github-release",
        "publish-pypi",
    ):
        body = jobs.get(job_name)
        if body is None:
            continue
        executable = _workflow_executable_text(body)
        if "actions/checkout@" in body or re.search(
            r"(?im)^\s+(?:run:\s*)?(?:corepack|pnpm|npm|npx|uv|pip|python(?:3)?|node)\b",
            executable,
        ) or re.search(r"(?m)^\s+run:.*(?:scripts|workers|apps|launcher)/", executable):
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: publication job {job_name} executes repository or dependency code"
            )
        job_header = body.partition("\n    steps:")[0]
        for credential in ("GH_TOKEN:", "AWS_ACCESS_KEY_ID:", "AWS_SECRET_ACCESS_KEY:"):
            if credential in job_header:
                findings.append(
                    f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: {job_name} exposes {credential.rstrip(':')} at job scope"
                )
    if "JOBCTRL_RELEASE_UPLOAD_BASE_URL" in workflow:
        findings.append(
            f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: publication must use bucket-scoped native R2 credentials instead of a generic upload URL"
        )
    for job_name in ("publish-immutable", "promote-channel-pointer"):
        body = jobs.get(job_name)
        if body is None:
            continue
        for marker in (
            "AWS_ACCESS_KEY_ID: ${{ secrets.JOBCTRL_R2_ACCESS_KEY_ID }}",
            "AWS_SECRET_ACCESS_KEY: ${{ secrets.JOBCTRL_R2_SECRET_ACCESS_KEY }}",
            "R2_ACCOUNT_ID: ${{ vars.JOBCTRL_R2_ACCOUNT_ID }}",
            "R2_BUCKET: ${{ vars.JOBCTRL_R2_BUCKET }}",
            "aws s3api put-object",
        ):
            if marker not in body:
                findings.append(
                    f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: {job_name} must publish with protected bucket-scoped R2 S3 authority"
                )
                break
    publish_immutable = jobs.get("publish-immutable")
    if publish_immutable is not None and not _workflow_has_conditional_put(
        publish_immutable, "--if-none-match", "*"
    ):
        findings.append(
            f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: publish-immutable must protect immutable R2 object creation"
        )
    promote = jobs.get("promote-channel-pointer")
    if promote is not None and (
        not _workflow_has_conditional_put(
            promote, "--if-none-match", "*"
        )
        or not _workflow_has_conditional_put(
            promote, "--if-match", "$etag"
        )
    ):
        findings.append(
            f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: promote-channel-pointer must compare-and-swap an existing R2 channel pointer and protect first creation"
        )
    if promote is not None and (
        "needs: [resolve, sign, package-signed-candidate, smoke-and-verify]" not in promote
        or "EXPECTED_SIGNER_POINTER_SHA256: ${{ needs.sign.outputs.channel_pointer_sha256 }}" not in promote
        or "jobctrl-release-candidate-" not in promote
        or "jobctrl-channel-plan-" in promote
        or "jobctrl-smoke-evidence-" in promote
        or "sync-homebrew" in promote.partition("\n    steps:")[0]
    ):
        findings.append(
            f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: channel promotion must bind the untouched base candidate to the signer pointer digest"
        )
    homebrew_call = _workflow_job_body(workflow, "sync-homebrew")
    if homebrew_call is None or (
        "needs: [resolve, sign, package-signed-candidate, smoke-and-verify, promote-channel-pointer]" not in homebrew_call
        or "release_artifact_name: jobctrl-release-candidate-" not in homebrew_call
        or "expected_formula_sha256: ${{ needs.sign.outputs.formula_sha256 }}" not in homebrew_call
        or "release_artifact_name: jobctrl-smoke-evidence-" in homebrew_call
        or "HOMEBREW_TAP_DEPLOY_KEY" in homebrew_call
        or re.search(r"(?m)^\s+secrets:\s*$", homebrew_call)
    ):
        findings.append(
            f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: Homebrew publication must bind the base candidate formula to the signer digest without passing the environment-scoped deploy key"
        )
    smoke = jobs.get("smoke-and-verify")
    if smoke is not None and "distribution-homebrew.mjs render" in _workflow_executable_text(smoke):
        findings.append(
            f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: dependency-bearing smoke job must not author the published Homebrew formula"
        )
    try:
        policy = json.loads((root / SIGNING_POLICY_PATH).read_text(encoding="utf-8"))
        if policy.get("stableReleaseStatus") != "blocked-awaiting-credentials" or policy.get("manifestSigning", {}).get("publicKeyStatus") != "unprovisioned" or policy.get("appleSigning", {}).get("teamIdStatus") != "unprovisioned":
            raise ValueError("tracked policy is not fail-closed")
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        findings.append(f"{SIGNING_POLICY_PATH}: tracked signing policy must remain blocked and unprovisioned until protected credentials exist")
    for workflow_path in (RELEASE_DISTRIBUTION_WORKFLOW_PATH, HOMEBREW_SYNC_WORKFLOW_PATH, PUBLISH_WORKFLOW_PATH):
        try:
            workflow_text = (root / workflow_path).read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        floating = re.findall(r"(?m)^\s*uses:\s+([^\s@]+)@(?![0-9a-f]{40}(?:\s|$|#))([^\s#]+)", workflow_text)
        if floating:
            rendered = ", ".join(f"{action}@{ref}" for action, ref in floating)
            findings.append(f"{workflow_path}: third-party actions must use immutable commit SHAs, found {rendered}")
    if (root / PUBLISH_WORKFLOW_PATH).exists():
        findings.append(
            f"{PUBLISH_WORKFLOW_PATH}: obsolete standalone PyPI publisher must be absent; OIDC publication is integrated into {RELEASE_DISTRIBUTION_WORKFLOW_PATH}"
        )
    findings.extend(_pypi_release_workflow_findings(workflow))
    findings.extend(_pypi_build_backend_findings(root))
    return findings


def _pypi_release_workflow_findings(workflow: str) -> list[str]:
    """Require a clean signed-release gate, two builders, and minimal OIDC."""
    findings: list[str] = []
    jobs = {
        name: _workflow_job_body(workflow, name)
        for name in (
            "pypi-resolve",
            "pypi-build-a",
            "pypi-build-b",
            "pypi-compare",
            "publish-pypi",
        )
    }
    for name, body in jobs.items():
        if body is None:
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: missing integrated PyPI job {name}"
            )
    resolve = jobs["pypi-resolve"]
    if resolve is not None:
        for marker in (
            "needs: [resolve, publish-github-release]",
            "inputs.channel == 'stable'",
            "persist-credentials: false",
            "actions/setup-node@",
            "isImmutable",
            'gh release verify "$RELEASE_TAG"',
            "distribution-release.finalizer.bundle.mjs.sha256",
            "distribution-release-authority-bundles.NOTICE.txt",
            "sha256sum -c distribution-release.finalizer.bundle.mjs.sha256",
            "gh release download",
            'filter="data"',
            "JOBCTRL_RELEASE_PUBLIC_KEY: ${{ needs.resolve.outputs.release_public_key }}",
            "JOBCTRL_RELEASE_KEY_ID: ${{ needs.resolve.outputs.release_key_id }}",
            "node scripts/distribution-release.finalizer.bundle.mjs verify-pypi-gate",
        ):
            if marker not in resolve:
                findings.append(
                    f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: PyPI resolution must cleanly verify the immutable signed release before builders run"
                )
                break
        executable = _workflow_executable_text(resolve)
        if (
            "actions/setup-python@" in resolve
            or "astral-sh/setup-uv@" in resolve
            or re.search(r"(?im)^\s+(?:run:\s*)?(?:corepack|pnpm|npm|npx|uv|pip)\b", executable)
            or "scripts/distribution-release.mjs verify-pypi-gate" in executable
        ):
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: PyPI signed-release gate must run before all project dependency execution and use only the tracked bundled verifier"
            )
    for name, artifact in (
        ("pypi-build-a", "jobctrl-pypi-a-"),
        ("pypi-build-b", "jobctrl-pypi-b-"),
    ):
        build = jobs[name]
        if build is None:
            continue
        for marker in (
            "needs: pypi-resolve",
            "SOURCE_DATE_EPOCH:",
            "uv --project workers/automation sync --python 3.12.13 --locked --no-default-groups --only-group release-build --no-install-project",
            "uv --project workers/automation run --python 3.12.13 --no-sync python -m build --no-isolation workers/automation",
            artifact,
        ):
            if marker not in build:
                findings.append(
                    f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: {name} does not independently verify and build the fixed-epoch distributions"
                )
                break
        if (
            "shasum -a 256 packages/" in build
            or "id-token: write" in build
            or "environment: pypi" in build
            or "verify-pypi-gate" in build
            or "gh release download" in build
            or "JOBCTRL_RELEASE_PUBLIC_KEY" in build
            or "JOBCTRL_RELEASE_KEY_ID" in build
            or "actions/setup-node@" in build
            or "corepack pnpm" in build
            or "--extra dev" in build
        ):
            findings.append(
                f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: {name} must only build after the clean shared gate and must not receive verification or publication authority"
            )
    compare = jobs["pypi-compare"]
    if compare is not None:
        for marker in (
            "needs: [pypi-resolve, pypi-build-a, pypi-build-b]",
            "jobctrl-pypi-a-",
            "jobctrl-pypi-b-",
            'cmp "$a/$name" "$b/$name"',
            "jobctrl-pypi-sealed-",
            "shasum -a 256 packages/* > SHA256SUMS",
        ):
            if marker not in compare:
                findings.append(
                    f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: PyPI compare job does not byte-compare and seal both builders"
                )
                break
    publish = jobs["publish-pypi"]
    if publish is None:
        return findings
    if "JOBCTRL_RELEASE_PUBLIC_KEY" in publish or "JOBCTRL_RELEASE_KEY_ID" in publish:
        findings.append(
            f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: PyPI OIDC job must not receive release verification inputs"
        )
    for marker, message in {
        "environment: pypi": "does not put OIDC publication behind the PyPI environment",
        "id-token: write": "does not request PyPI OIDC only in the publication job",
        "jobctrl-pypi-sealed-": "does not consume only the compare-sealed artifact",
        "EXPECTED_SOURCE_COMMIT: ${{ needs.pypi-resolve.outputs.source_commit }}": "does not bind publication to the resolved source commit",
        "packages-dir: ${{ runner.temp }}/jobctrl-pypi-dists/packages": "does not limit PyPI to the sealed package directory",
        "uses: pypa/gh-action-pypi-publish@6733eb7d741f0b11ec6a39b58540dab7590f9b7d": "does not use the pinned PyPI publisher",
    }.items():
        if marker not in publish:
            findings.append(f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: {message}")
    for marker, message in {
        "actions/checkout@": "must not check out source in the OIDC publication job",
        "actions/setup-python@": "must not install Python tooling in the OIDC publication job",
        "actions/setup-node@": "must not install Node tooling in the OIDC publication job",
        "astral-sh/setup-uv@": "must not install uv in the OIDC publication job",
        "python -m build": "must not build distributions in the OIDC publication job",
        "uv --project": "must not install or execute project dependencies in the OIDC publication job",
    }.items():
        if marker in publish:
            findings.append(f"{RELEASE_DISTRIBUTION_WORKFLOW_PATH}: {message}")
    return findings


def _pypi_build_backend_findings(root: Path) -> list[str]:
    """Pin the isolated release-build group and its no-isolation backend."""
    findings: list[str] = []
    pyproject_path = root / PYTHON_PROJECT_PATH
    lock_path = root / PYTHON_LOCK_PATH
    try:
        pyproject_text = pyproject_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return findings
    build_system = re.search(r"(?ms)^\[build-system\]\s*(.*?)(?=^\[|\Z)", pyproject_text)
    dev_dependencies = re.search(r"(?ms)^\[project\.optional-dependencies\]\s*(.*?)(?=^\[|\Z)", pyproject_text)
    dependency_groups = re.search(r"(?ms)^\[dependency-groups\]\s*(.*?)(?=^\[|\Z)", pyproject_text)
    if build_system is None or not re.search(r'(?m)^requires\s*=\s*\["hatchling==1\.29\.0"\]\s*$', build_system.group(1)):
        findings.append(f"{PYTHON_PROJECT_PATH}: build-system must exact-pin hatchling==1.29.0")
    if dev_dependencies is None or not re.search(r'(?m)^dev\s*=\s*\[[^\]]*"hatchling==1\.29\.0"', dev_dependencies.group(1)):
        findings.append(f"{PYTHON_PROJECT_PATH}: dev build environment must exact-pin hatchling==1.29.0")
    if dependency_groups is None or not re.search(
        r'(?m)^release-build\s*=\s*\["build==1\.4\.3",\s*"hatchling==1\.29\.0"\]\s*$',
        dependency_groups.group(1),
    ):
        findings.append(
            f"{PYTHON_PROJECT_PATH}: release-build group must contain only build==1.4.3 and hatchling==1.29.0"
        )
    try:
        lock_text = lock_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return findings
    hatchling_blocks = [
        block for block in LOCK_PACKAGE_BLOCK_RE.findall(lock_text)
        if re.search(r'(?m)^name\s*=\s*"hatchling"\s*$', block)
    ]
    if len(hatchling_blocks) != 1 or not re.search(r'(?m)^version\s*=\s*"1\.29\.0"\s*$', hatchling_blocks[0]):
        findings.append(f"{PYTHON_LOCK_PATH}: must lock hatchling==1.29.0 for --no-isolation releases")
    build_blocks = [
        block for block in LOCK_PACKAGE_BLOCK_RE.findall(lock_text)
        if re.search(r'(?m)^name\s*=\s*"build"\s*$', block)
    ]
    if len(build_blocks) != 1 or not re.search(r'(?m)^version\s*=\s*"1\.4\.3"\s*$', build_blocks[0]):
        findings.append(f"{PYTHON_LOCK_PATH}: must lock build==1.4.3 for release-build")
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
        for archive in sorted(candidate for candidate in dist_path.rglob("*") if candidate.is_file()):
            if archive.suffix in {".whl", ".zip"}:
                findings.extend(scan_zip_archive(root, archive, needles=needles))
            elif archive.name.endswith(".tar.gz"):
                findings.extend(scan_tar_archive(root, archive, needles=needles))
            if expected_version is not None and (archive.suffix == ".whl" or archive.name.endswith(".tar.gz")):
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
            name_findings = scan_name(label, member, needles=needles)
            findings.extend(name_findings)
            if not name_findings:
                findings.extend(scan_file_contents(label, member, archive.read(info), needles=needles))
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
            name_findings = scan_name(label, member, needles=needles)
            findings.extend(name_findings)
            if name_findings:
                continue
            extracted = archive.extractfile(info)
            if extracted is not None:
                findings.extend(scan_file_contents(label, member, extracted.read(), needles=needles))
    return findings


if __name__ == "__main__":
    sys.exit(main())
