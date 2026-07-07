"""No-send-transport guard for the Contact & Outreach code (INV-1, §8.3 layer b).

There is NO send capability anywhere in this workstream: the outreach flow
terminates at a reviewable/approved draft the user copies out and sends through
their own channel; the system only RECORDS a user-attested send. This test fails
if any transport-shaped symbol ever appears in the contact/outreach code on
EITHER runtime — the Python domain/infrastructure AND the TypeScript API + web
context/views — mirroring the W1.7 DoD grep guard. If a real send capability is
ever intentionally added, it belongs to a different context and this guard's
scope must be revisited deliberately.
"""

from __future__ import annotations

import re
from pathlib import Path

_WORKER_ROOT = Path(__file__).resolve().parents[1]
_REPO_ROOT = _WORKER_ROOT.parents[1]

# Every directory that owns Contact & Outreach code, on both runtimes.
_CONTACT_SRC_DIRS = (
    _WORKER_ROOT / "src" / "jobctrl" / "domain" / "contact",
    _WORKER_ROOT / "src" / "jobctrl" / "infrastructure" / "contact",
    _REPO_ROOT / "apps" / "web" / "src" / "contexts" / "outreach",
    _REPO_ROOT / "apps" / "web" / "src" / "views" / "outreach",
)

# Individual Contact & Outreach files that live alongside unrelated code.
_CONTACT_SRC_FILES = (
    _REPO_ROOT / "apps" / "api" / "src" / "outreach.ts",
)

# Transport-shaped symbols that would indicate an outbound send path. Matches the
# camelCase TS spellings too (case-insensitive; ``_?`` also spans no separator, so
# ``sendMail`` / ``createTransport`` are caught).
_FORBIDDEN = re.compile(
    r"(?i)\b("
    r"smtplib|smtp|nodemailer|create_?transport|"
    r"gmail\.send|messages\.send|send_?mail|send_?message|send_?email"
    r")\b"
)

# Test and story files legitimately reference send LOGGING (never a transport);
# only source files are scanned, and only these extensions.
_SCAN_SUFFIXES = (".py", ".ts", ".tsx")


def _iter_source_files() -> list[Path]:
    paths: list[Path] = []
    for directory in _CONTACT_SRC_DIRS:
        if not directory.exists():
            continue
        for path in directory.rglob("*"):
            if path.suffix in _SCAN_SUFFIXES:
                paths.append(path)
    paths.extend(path for path in _CONTACT_SRC_FILES if path.exists())
    return paths


def test_no_send_transport_symbol_in_contact_outreach_code() -> None:
    offenders: list[str] = []
    for path in _iter_source_files():
        text = path.read_text(encoding="utf-8")
        for match in _FORBIDDEN.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            offenders.append(f"{path}:{line}: {match.group(0)!r}")
    assert not offenders, (
        "INV-1 violated — a send-transport symbol appeared in the outreach code:\n"
        + "\n".join(offenders)
    )
