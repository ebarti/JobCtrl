"""Verify the snake_case → PascalCase rip-and-replace landed across callers.

This is a static text scan: any new code that writes ``record_job_event(...,
"snake_case", ...)`` will fail this test. PascalCase is now the only allowed
``event_type`` value emitted from the worker.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src" / "jobctl"

# Regex: capture the third positional argument to record_job_event, which is
# the event_type literal. We accept either single- or double-quoted strings
# and tolerate newlines/whitespace between commas (multiline calls).
_RECORD_CALL = re.compile(
    r"record_job_event\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[\"']([^\"']+)[\"']",
    re.DOTALL,
)


def _iter_event_types() -> list[tuple[Path, str]]:
    hits: list[tuple[Path, str]] = []
    for py in ROOT.rglob("*.py"):
        text = py.read_text(encoding="utf-8")
        for match in _RECORD_CALL.finditer(text):
            hits.append((py.relative_to(ROOT), match.group(1)))
    return hits


def test_all_recorded_event_types_are_pascal_case() -> None:
    hits = _iter_event_types()
    assert hits, "no record_job_event calls found — sanity guard failed"
    snake = [f"{path}:{value}" for path, value in hits if not (value and value[0].isupper() and "_" not in value)]
    assert not snake, "snake_case event_type strings found — should be PascalCase: " + ", ".join(snake)


def test_known_pascal_case_events_present() -> None:
    """Spot-check that the canonical orchestration events appear."""
    seen = {value for _path, value in _iter_event_types()}
    expected = {
        "StageStarted",
        "StageCompleted",
        "StageFailed",
    }
    missing = expected - seen
    assert not missing, f"expected events missing from callers: {missing}"
