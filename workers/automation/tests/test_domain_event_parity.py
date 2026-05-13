"""Parity between Python domain events and TypeScript DomainEventUnion."""

from __future__ import annotations

import re
from pathlib import Path

from jobhunter.domain.events import DOMAIN_EVENT_TYPES


def test_python_domain_event_types_match_typescript_union() -> None:
    root = Path(__file__).resolve().parents[3]
    ts_index = root / "packages" / "domain-types" / "src" / "events" / "index.ts"
    text = ts_index.read_text()
    match = re.search(
        r"export const DOMAIN_EVENT_TYPES = \[(.*?)\] as const",
        text,
        flags=re.DOTALL,
    )
    assert match is not None
    ts_event_types = tuple(re.findall(r'"([^"]+)"', match.group(1)))
    assert DOMAIN_EVENT_TYPES == ts_event_types
