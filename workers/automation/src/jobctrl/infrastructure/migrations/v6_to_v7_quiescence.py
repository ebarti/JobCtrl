"""Authoritative Temporal quiescence proof for the stopped-runtime v6-to-v7 cutover."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

from temporalio.client import Client


RUNNING_EXECUTIONS_QUERY: Final = 'ExecutionStatus = "Running"'


class TemporalQuiescenceError(RuntimeError):
    """Raised when the migration cannot prove that the local runtime is quiescent."""


@dataclass(frozen=True)
class TemporalQuiescenceEvidence:
    """Metadata-only proof that a client namespace has no running executions."""

    namespace: str
    running_execution_count: Literal[0] = 0


async def assert_temporal_quiescence(client: Client) -> TemporalQuiescenceEvidence:
    """Prove the client-bound local Temporal namespace has zero running executions.

    The visibility iterator is the authority for active execution state.  It is
    limited to one row because any matching execution blocks the cutover; no
    workflow execution fields are read, retained, or surfaced.
    """

    try:
        namespace = client.namespace
        executions = client.list_workflows(
            query=RUNNING_EXECUTIONS_QUERY,
            limit=1,
        )
        await anext(executions)
    except StopAsyncIteration:
        return TemporalQuiescenceEvidence(namespace=namespace)
    except Exception:
        # Do not retain the exception chain: Temporal transport errors can
        # contain endpoints, identifiers, payload fragments, or credentials.
        pass
    else:
        raise TemporalQuiescenceError(
            "Temporal quiescence check found a running execution; migration is blocked"
        )

    raise TemporalQuiescenceError(
        "Temporal quiescence check is unavailable; migration is blocked"
    )


__all__ = [
    "RUNNING_EXECUTIONS_QUERY",
    "TemporalQuiescenceError",
    "TemporalQuiescenceEvidence",
    "assert_temporal_quiescence",
]
