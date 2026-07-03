"""Pre-publication checks for private data and stale provenance.

The prompt tripwires are warnings by default because their source fixes land in
W1. Pass ``--strict-prompt`` after W1 completes to promote them to failures.
"""

from __future__ import annotations

import argparse
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

PROMPT_PATH = Path("workers/automation/src/jobhunter/apply/prompt.py")


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
    args = parser.parse_args(argv)

    result = scan_tree(ROOT, needles=FORBIDDEN_TEXT, strict_prompt=args.strict_prompt)

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

    result.findings.extend(scan_structural_checks(root, tracked))
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


def scan_structural_checks(root: Path, tracked: Iterable[Path]) -> list[str]:
    """Run repository-structure checks that cannot be caught by text needles."""
    findings = []
    for rel in tracked:
        if rel.parts and rel.parts[0] == ".planning":
            findings.append(f"{rel}: private planning corpus must not be tracked")

    if _blocked_distribution_name(root) and _publish_has_tag_trigger(root):
        findings.append(
            ".github/workflows/publish.yml: tag publishing is enabled "
            "before the blocked distribution name is renamed"
        )
    return findings


def _blocked_distribution_name(root: Path) -> bool:
    pyproject = root / "workers/automation/pyproject.toml"
    try:
        text = pyproject.read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    match = PROJECT_NAME_RE.search(text)
    return bool(match and match.group(1) == "jobhunter")


def _publish_has_tag_trigger(root: Path) -> bool:
    workflow = root / ".github/workflows/publish.yml"
    try:
        lines = workflow.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return False

    in_on_block = False
    in_push_block = False
    push_indent = 0
    for raw_line in lines:
        content = raw_line.split("#", 1)[0].rstrip()
        if not content.strip():
            continue
        indent = len(content) - len(content.lstrip())
        stripped = content.strip()

        if indent == 0 and stripped == "on:":
            in_on_block = True
            in_push_block = False
            continue
        if in_on_block and indent == 0:
            break
        if not in_on_block:
            continue

        if stripped == "push:":
            in_push_block = True
            push_indent = indent
            continue
        if in_push_block and indent <= push_indent:
            in_push_block = False
        if in_push_block and stripped.startswith("tags:"):
            return True

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
    if "API key: {capsolver_key" in text:
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
    for dist in ARCHIVE_DIRS:
        dist_path = root / dist
        if not dist_path.exists():
            continue
        for archive in sorted(dist_path.glob("*")):
            if archive.suffix == ".whl":
                findings.extend(scan_zip_archive(root, archive, needles=needles))
            elif archive.name.endswith(".tar.gz"):
                findings.extend(scan_tar_archive(root, archive, needles=needles))
    return findings


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
