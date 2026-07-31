"""Authoritative Temporal quiescence proof for the stopped-runtime v6-to-v7 cutover."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import sys
from collections.abc import Sequence
from typing import Final, Literal

from temporalio.client import Client

from jobctrl.infrastructure.temporal.client import get_temporal_client


RUNNING_EXECUTIONS_QUERY: Final = 'ExecutionStatus = "Running"'
_RESULT_SCHEMA_VERSION: Final = 1
_GENERIC_FAILURE: Final = "Temporal quiescence preflight failed"


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


async def _prove_local_temporal_quiescence() -> TemporalQuiescenceEvidence:
    """Connect through the runtime factory and return internal proof metadata."""

    client = await get_temporal_client()
    return await assert_temporal_quiescence(client)


def main(argv: Sequence[str] | None = None) -> int:
    """Run the launcher's private, argument-free quiescence preflight."""

    arguments = tuple(sys.argv[1:] if argv is None else argv)
    if arguments:
        print(_GENERIC_FAILURE, file=sys.stderr)
        return 1
    try:
        evidence = asyncio.run(_prove_local_temporal_quiescence())
    except Exception:
        # Factory and Temporal exceptions can retain connection details,
        # namespace identifiers, or execution payload fragments.
        print(_GENERIC_FAILURE, file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "running_execution_count": evidence.running_execution_count,
                "schema_version": _RESULT_SCHEMA_VERSION,
                "status": "quiescent",
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "RUNNING_EXECUTIONS_QUERY",
    "TemporalQuiescenceError",
    "TemporalQuiescenceEvidence",
    "assert_temporal_quiescence",
    "main",
]
