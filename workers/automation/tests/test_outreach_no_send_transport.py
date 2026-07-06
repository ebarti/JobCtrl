"""No-send-transport guard for the Contact & Outreach code (INV-1).

There is NO send capability anywhere in this workstream: the outreach flow
terminates at a reviewable/approved draft the user copies out and sends through
their own channel. This test fails if any transport-shaped symbol ever appears in
the contact/outreach domain or infrastructure code — mirrors the W1.7 DoD grep
guard. If a real send capability is ever intentionally added, it belongs to a
different context and this guard's scope must be revisited deliberately.
"""

from __future__ import annotations

import re
from pathlib import Path

_CONTACT_SRC_DIRS = (
    Path(__file__).resolve().parents[1] / "src" / "jobhunter" / "domain" / "contact",
    Path(__file__).resolve().parents[1] / "src" / "jobhunter" / "infrastructure" / "contact",
)

# Transport-shaped symbols that would indicate an outbound send path.
_FORBIDDEN = re.compile(
    r"(?i)\b("
    r"smtplib|smtp|nodemailer|create_?transport|"
    r"gmail\.send|messages\.send|send_?mail|send_?message|send_?email"
    r")\b"
)


def test_no_send_transport_symbol_in_contact_outreach_code() -> None:
    offenders: list[str] = []
    for directory in _CONTACT_SRC_DIRS:
        for path in directory.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for match in _FORBIDDEN.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                offenders.append(f"{path}:{line}: {match.group(0)!r}")
    assert not offenders, (
        "INV-1 violated — a send-transport symbol appeared in the outreach code:\n"
        + "\n".join(offenders)
    )
