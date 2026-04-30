"""Pre-publication checks for private data and stale provenance."""

from __future__ import annotations

import re
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EXCLUDED_FILES = {
    Path("scripts/release_check.py"),
}

FORBIDDEN_TEXT = {
    "-".join(("Pickle", "Pixel")): "old repository owner",
    "Resume_" + "El" + "oi": "private resume filename",
    "el" + "oi" + "barti": "private username/domain",
    "El" + "oi": "private first name",
}

FORBIDDEN_PATH_NAMES = {
    ".env",
    "profile.json",
    "resume.txt",
    "resume.pdf",
}

SECRET_ASSIGNMENT_RE = re.compile(
    r"(?im)^\s*(GEMINI_API_KEY|OPENAI_API_KEY|LLM_API_KEY|CAPSOLVER_API_KEY)\s*=\s*([^#\s]+)"
)

TEXT_SUFFIXES = {
    "",
    ".cfg",
    ".css",
    ".html",
    ".ini",
    ".json",
    ".md",
    ".py",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}


def candidate_files() -> list[Path]:
    """Return files that Git would consider for commit."""
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
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
        path = ROOT / rel
        if path.is_file():
            paths.append(rel)
    return paths


def main() -> int:
    findings: list[str] = []
    for rel in candidate_files():
        name_findings = scan_name(str(rel), rel.name, rel.suffix)
        findings.extend(name_findings)
        if name_findings:
            continue

        try:
            text = (ROOT / rel).read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        findings.extend(scan_text(str(rel), text))

    findings.extend(scan_dist_archives())

    if findings:
        print("Release check failed:")
        for finding in findings:
            print(f"  - {finding}")
        return 1

    print("Release check passed.")
    return 0


def scan_name(label: str, name: str, suffix: str) -> list[str]:
    """Scan a path/archive member name for private artifacts."""
    findings = []
    if name in FORBIDDEN_PATH_NAMES or suffix == ".db":
        findings.append(f"{label}: private/runtime file should not be committed")
    for needle, reason in FORBIDDEN_TEXT.items():
        if needle in label:
            findings.append(f"{label}: contains {reason} ({needle})")
    return findings


def scan_text(label: str, text: str) -> list[str]:
    """Scan text content for forbidden strings and non-empty secret assignments."""
    findings = []
    for needle, reason in FORBIDDEN_TEXT.items():
        if needle in text:
            findings.append(f"{label}: contains {reason} ({needle})")

    for match in SECRET_ASSIGNMENT_RE.finditer(text):
        value = match.group(2).strip()
        if value and not value.startswith(("YOUR_", "your_", "<", "$")):
            findings.append(f"{label}: contains non-empty {match.group(1)} assignment")
    return findings


def scan_dist_archives() -> list[str]:
    """Scan built wheel and sdist archives when present."""
    dist = ROOT / "dist"
    findings: list[str] = []
    if not dist.exists():
        return findings

    for archive in sorted(dist.glob("*")):
        if archive.suffix == ".whl":
            findings.extend(scan_zip_archive(archive))
        elif archive.name.endswith(".tar.gz"):
            findings.extend(scan_tar_archive(archive))
    return findings


def scan_zip_archive(path: Path) -> list[str]:
    """Scan a wheel archive."""
    findings: list[str] = []
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            member = Path(info.filename)
            label = f"{path.relative_to(ROOT)}!{info.filename}"
            findings.extend(scan_name(label, member.name, member.suffix))
            if member.suffix in TEXT_SUFFIXES:
                try:
                    text = archive.read(info).decode("utf-8")
                except UnicodeDecodeError:
                    continue
                findings.extend(scan_text(label, text))
    return findings


def scan_tar_archive(path: Path) -> list[str]:
    """Scan an sdist archive."""
    findings: list[str] = []
    with tarfile.open(path) as archive:
        for info in archive.getmembers():
            if not info.isfile():
                continue
            member = Path(info.name)
            label = f"{path.relative_to(ROOT)}!{info.name}"
            findings.extend(scan_name(label, member.name, member.suffix))
            if member.suffix in TEXT_SUFFIXES:
                extracted = archive.extractfile(info)
                if extracted is None:
                    continue
                try:
                    text = extracted.read().decode("utf-8")
                except UnicodeDecodeError:
                    continue
                findings.extend(scan_text(label, text))
    return findings


if __name__ == "__main__":
    sys.exit(main())
