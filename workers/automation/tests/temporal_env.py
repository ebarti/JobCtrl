"""Bounded lifecycle for ephemeral Temporal test environments.

Two hosted-runner lanes (runs 31428971570 and 31596968394) hung for GitHub's
full six-hour job ceiling with an orphaned ``temporal-test-server`` process:
``WorkflowEnvironment.start_time_skipping()`` intermittently wedges inside the
server spawn/connect lifecycle even when the same process started an identical
environment moments earlier. A normal start completes in well under two
seconds, so the wedge is binary rather than slow. These wrappers bound every
start with fresh-server retries and bound shutdown so a wedged teardown cannot
consume the rest of the job; a cancelled wedged start may leave one orphaned
server process behind, which the CI runner (or the local OS) reaps.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

import asyncio

from temporalio.testing import WorkflowEnvironment

START_TIMEOUT_SECONDS = 30.0
START_ATTEMPTS = 3
SHUTDOWN_TIMEOUT_SECONDS = 30.0


@asynccontextmanager
async def _bounded_env(
    start: Callable[[], Awaitable[WorkflowEnvironment]], label: str
) -> AsyncIterator[WorkflowEnvironment]:
    env: WorkflowEnvironment | None = None
    last_error: BaseException | None = None
    for _ in range(START_ATTEMPTS):
        try:
            env = await asyncio.wait_for(start(), START_TIMEOUT_SECONDS)
            break
        except TimeoutError as error:
            last_error = error
    if env is None:
        raise TimeoutError(
            f"{label} Temporal test environment failed to start "
            f"{START_ATTEMPTS} times within {START_TIMEOUT_SECONDS:.0f}s each"
        ) from last_error
    try:
        yield env
    finally:
        try:
            await asyncio.wait_for(env.shutdown(), SHUTDOWN_TIMEOUT_SECONDS)
        except TimeoutError:
            # Suppressing keeps the test's own outcome authoritative and keeps
            # the suite progressing; the orphaned server is reaped externally.
            pass


def time_skipping_env() -> AbstractAsyncContextManager[WorkflowEnvironment]:
    """Time-skipping environment with a bounded, retried lifecycle."""
    return _bounded_env(WorkflowEnvironment.start_time_skipping, "time-skipping")


def local_env() -> AbstractAsyncContextManager[WorkflowEnvironment]:
    """Local dev-server environment with a bounded, retried lifecycle."""
    return _bounded_env(WorkflowEnvironment.start_local, "local dev-server")
