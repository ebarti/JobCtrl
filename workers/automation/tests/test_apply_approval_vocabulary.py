"""Cross-runtime pin for the apply approval-gate refusal vocabulary.

The TypeScript source of truth is ``APPLY_REVIEW_APPROVAL_GATE_REASONS`` in
``packages/contracts``; both runtimes pin to the shared fixture. The
source-scan test keeps ``_approval_refusal_reason`` honest: any new literal
refusal reason must enter the shared vocabulary (and the fixture) first.
"""

from __future__ import annotations

import inspect
import json
import re
from pathlib import Path

from jobctrl.apply import launcher
from jobctrl.domain.apply.value_objects import APPROVAL_GATE_REFUSAL_REASONS

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/apply_approval_gate_reasons.json"
)


def _fixture() -> dict[str, list[str]]:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def test_refusal_reasons_match_shared_fixture() -> None:
    fixture = _fixture()
    assert APPROVAL_GATE_REFUSAL_REASONS == frozenset(fixture["launcherRefusalReasons"])
    assert APPROVAL_GATE_REFUSAL_REASONS <= frozenset(fixture["reasons"])


def test_launcher_refusal_literals_stay_inside_the_vocabulary() -> None:
    source = inspect.getsource(launcher._approval_refusal_reason)
    literals = set(re.findall(r'return "([a-z_]+)"', source))
    assert literals, "expected _approval_refusal_reason to return literal reasons"
    unknown = literals - APPROVAL_GATE_REFUSAL_REASONS
    assert not unknown, f"unpinned refusal reasons: {sorted(unknown)}"
