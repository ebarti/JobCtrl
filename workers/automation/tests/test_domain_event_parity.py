"""Parity between Python domain events and TypeScript DomainEventUnion."""

from __future__ import annotations

import dataclasses
import re
from pathlib import Path

from jobctrl.domain.events import (
    ApplicationEmailFeedbackIngestedPayload,
    DOMAIN_EVENT_TYPES,
    DiscoveryExecutionRefLike,
    DuplicateJobLinkedPayload,
    DuplicateJobLinkRejectedPayload,
    PipelineStepCompletedPayload,
    PipelineStepFailedPayload,
    PipelineStepQueuedPayload,
    PipelineStepSafeDetail,
    PipelineStepStartedPayload,
)

_TS_EVENTS_DIR = (
    Path(__file__).resolve().parents[3] / "packages" / "domain-types" / "src" / "events"
)


def _snake_to_camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(word.capitalize() for word in rest)


def _ts_interface_fields(interface: str) -> frozenset[str]:
    text = "\n".join(path.read_text() for path in _TS_EVENTS_DIR.glob("*.ts"))
    match = re.search(
        r"(?:export\s+)?interface "
        + re.escape(interface)
        + r"(?:\s+extends\s+([^\{]+))?\s*\{(.*?)\n\}",
        text,
        flags=re.DOTALL,
    )
    assert match is not None, f"TypeScript interface {interface} not found"
    inherited = frozenset()
    if match.group(1):
        for parent in match.group(1).split(","):
            inherited |= _ts_interface_fields(parent.strip())
    own = frozenset(re.findall(r"readonly\s+(\w+)\??:", match.group(2)))
    return inherited | own


def _assert_payload_field_parity(payload_cls: type, interface: str) -> None:
    python_fields = frozenset(
        _snake_to_camel(field.name) for field in dataclasses.fields(payload_cls)
    )
    assert python_fields == _ts_interface_fields(interface), (
        f"{interface} field drift between Python and TypeScript: "
        f"python(camelised)={sorted(python_fields)} ts={sorted(_ts_interface_fields(interface))}"
    )


def test_python_domain_event_types_match_typescript_union() -> None:
    ts_index = _TS_EVENTS_DIR / "index.ts"
    text = ts_index.read_text()
    match = re.search(
        r"export const DOMAIN_EVENT_TYPES = \[(.*?)\] as const",
        text,
        flags=re.DOTALL,
    )
    assert match is not None
    ts_event_types = tuple(re.findall(r'"([^"]+)"', match.group(1)))
    assert DOMAIN_EVENT_TYPES == ts_event_types


def test_duplicate_job_link_payload_fields_match_typescript() -> None:
    """Field-level parity for the discovery duplicate-link events.

    Scoped to this pair on purpose: they carry two distinct job ids (owner vs
    superseded/candidate) and are hand-maintained on both sides, which is where
    snake<->camel drift last slipped through silently. A fully generic sweep
    across every event would need a real TypeScript AST parse (nested and shared
    sub-payloads, union types) to stay correct; regex across all interfaces is
    not safe enough, so parity is enforced here for the events most prone to it.
    """
    _assert_payload_field_parity(DuplicateJobLinkedPayload, "DuplicateJobLinkedPayload")
    _assert_payload_field_parity(
        DuplicateJobLinkRejectedPayload, "DuplicateJobLinkRejectedPayload"
    )


def test_pipeline_step_payload_fields_match_typescript() -> None:
    """Lifecycle payloads must stay byte-shape compatible across runtimes."""

    execution_fields = frozenset(
        _snake_to_camel(name) for name in DiscoveryExecutionRefLike.__annotations__
    )
    assert execution_fields == _ts_interface_fields("DiscoveryExecutionRef")
    _assert_payload_field_parity(PipelineStepSafeDetail, "PipelineStepSafeDetail")
    _assert_payload_field_parity(PipelineStepQueuedPayload, "PipelineStepQueuedPayload")
    _assert_payload_field_parity(PipelineStepStartedPayload, "PipelineStepStartedPayload")
    _assert_payload_field_parity(
        PipelineStepCompletedPayload, "PipelineStepCompletedPayload"
    )
    _assert_payload_field_parity(PipelineStepFailedPayload, "PipelineStepFailedPayload")


def test_application_email_feedback_payload_fields_match_typescript() -> None:
    """Gmail feedback identity must stay canonical across both runtimes."""
    _assert_payload_field_parity(
        ApplicationEmailFeedbackIngestedPayload,
        "ApplicationEmailFeedbackIngestedPayload",
    )
