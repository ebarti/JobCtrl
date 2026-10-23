"""Process-owned async execution and bounded agent-runtime-kit resource reuse.

Vendor clients belong to one event loop. Each pool member runs one kit task at
once; existing caller admission controls active concurrency. Idle retention is
bounded separately. Keys describe provider
configuration, never prompts or conversation contents.
"""
from __future__ import annotations

import asyncio
import atexit
import concurrent.futures
import contextvars
import os
import threading
from collections.abc import Callable, Coroutine, Hashable
from dataclasses import dataclass, field
from typing import Any

from agent_runtime_kit import AgentResult, AgentRuntime, AgentTask

RuntimeFactory = Callable[[], AgentRuntime]


async def _settle(awaitable: Coroutine[Any, Any, Any]) -> Any:
    """Finish resource cleanup even if another cancellation arrives."""
    pending = asyncio.create_task(awaitable)
    canceled = False
    while not pending.done():
        try:
            await asyncio.shield(pending)
        except asyncio.CancelledError:
            canceled = True
    result = pending.result()
    if canceled:
        raise asyncio.CancelledError
    return result


class AgentRuntimePool:
    """One-loop runtime cache; idle retention never adds an admission queue."""

    def __init__(self, capacity: int) -> None:
        if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 1:
            raise ValueError("agent runtime capacity must be a positive integer")
        self._capacity = capacity
        self._idle: list[tuple[Hashable, AgentRuntime]] = []
        self._running: set[asyncio.Task[Any]] = set()
        self._closed = False

    async def run(self, key: Hashable, factory: RuntimeFactory, task: AgentTask) -> AgentResult:
        owner = asyncio.current_task()
        assert owner is not None
        self._running.add(owner)
        try:
            if self._closed:
                raise RuntimeError("agent runtime pool is closed")
            runtime = None
            for index, (idle_key, idle_runtime) in enumerate(self._idle):
                if idle_key == key:
                    runtime = idle_runtime
                    self._idle.pop(index)
                    break
            if runtime is None:
                if self._idle:
                    _, stale = self._idle.pop(0)
                    await _settle(stale.aclose())
                runtime = factory()
            try:
                result = await runtime.run(task)
            except BaseException as error:
                try:
                    await _settle(runtime.aclose())
                except BaseException:
                    error.add_note("Agent runtime cleanup also failed.")
                raise
            if self._closed or not result.is_success or len(self._idle) >= self._capacity:
                await _settle(runtime.aclose())
            else:
                self._idle.append((key, runtime))
            return result
        finally:
            self._running.discard(owner)

    async def aclose(self) -> None:
        self._closed = True
        current = asyncio.current_task()
        running = tuple(task for task in self._running if task is not current)
        for task in running:
            task.cancel()
        if running:
            await asyncio.gather(*running, return_exceptions=True)
        idle, self._idle = self._idle, []
        results = await asyncio.gather(*(runtime.aclose() for _, runtime in idle), return_exceptions=True)
        if any(isinstance(result, BaseException) for result in results):
            raise RuntimeError("Agent runtime cleanup failed.")


@dataclass
class _Ticket:
    result: concurrent.futures.Future[AgentResult] = field(default_factory=concurrent.futures.Future)
    settled: concurrent.futures.Future[None] = field(default_factory=concurrent.futures.Future)
    task: asyncio.Task[AgentResult] | None = None


class AgentRuntimeService:
    """Bridge sync and async callers to a persistent loop with settled cancellation."""

    def __init__(self, *, capacity: int) -> None:
        if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 1:
            raise ValueError("agent runtime capacity must be a positive integer")
        self._capacity = capacity
        self._lock = threading.Lock()
        self._closed = False
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._serve, name="jobctrl-agent-runtime", daemon=True)
        self._thread.start()
        self._ready.wait()

    def _serve(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._pool = AgentRuntimePool(self._capacity)
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            remaining = asyncio.all_tasks(self._loop)
            for task in remaining:
                task.cancel()
            if remaining:
                self._loop.run_until_complete(asyncio.gather(*remaining, return_exceptions=True))
            self._loop.run_until_complete(self._loop.shutdown_asyncgens())
            self._loop.run_until_complete(self._loop.shutdown_default_executor())
            self._loop.close()

    def _start(self, ticket: _Ticket, key: Hashable, factory: RuntimeFactory, task: AgentTask) -> None:
        if ticket.result.cancelled():
            ticket.settled.set_result(None)
            return
        ticket.task = self._loop.create_task(self._pool.run(key, factory, task))

        def finished(completed: asyncio.Task[AgentResult]) -> None:
            try:
                if completed.cancelled():
                    if not ticket.result.done():
                        try:
                            completed.result()
                        except asyncio.CancelledError as error:
                            ticket.result.set_exception(error)
                else:
                    error = completed.exception()
                    if not ticket.result.done():
                        if error is not None:
                            ticket.result.set_exception(error)
                        else:
                            ticket.result.set_result(completed.result())
            finally:
                ticket.settled.set_result(None)

        ticket.task.add_done_callback(finished)

    def _submit(self, key: Hashable, factory: RuntimeFactory, task: AgentTask) -> _Ticket:
        ticket = _Ticket()

        def cancel_if_requested(result: concurrent.futures.Future[AgentResult]) -> None:
            if result.cancelled():
                self._loop.call_soon_threadsafe(
                    lambda: ticket.task.cancel() if ticket.task is not None else None
                )

        ticket.result.add_done_callback(cancel_if_requested)
        with self._lock:
            if self._closed:
                raise RuntimeError("agent runtime service is closed")
            self._loop.call_soon_threadsafe(
                self._start, ticket, key, factory, task, context=contextvars.copy_context()
            )
        return ticket

    def run(self, key: Hashable, factory: RuntimeFactory, task: AgentTask) -> AgentResult:
        if threading.current_thread() is self._thread:
            raise RuntimeError("synchronous runtime dispatch cannot block its owning loop")
        ticket = self._submit(key, factory, task)
        try:
            return ticket.result.result()
        except BaseException:
            ticket.result.cancel()
            ticket.settled.result()
            raise

    async def run_async(self, key: Hashable, factory: RuntimeFactory, task: AgentTask) -> AgentResult:
        ticket = self._submit(key, factory, task)
        try:
            return await asyncio.wrap_future(ticket.result)
        except asyncio.CancelledError:
            ticket.result.cancel()
            pending = asyncio.wrap_future(ticket.settled)
            while not pending.done():
                try:
                    await asyncio.shield(pending)
                except asyncio.CancelledError:
                    pass
            pending.result()
            raise

    def close(self) -> None:
        if threading.current_thread() is self._thread:
            raise RuntimeError("runtime service shutdown must run outside its owning loop")
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            asyncio.run_coroutine_threadsafe(self._pool.aclose(), self._loop).result()
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join()


_service_lock = threading.Lock()
_service: tuple[int, AgentRuntimeService] | None = None


def agent_runtime_service() -> AgentRuntimeService:
    global _service
    with _service_lock:
        if _service is None or _service[0] != os.getpid():
            from jobctrl.infrastructure.temporal.concurrency import resolve_max_concurrent_activities

            _service = (os.getpid(), AgentRuntimeService(capacity=resolve_max_concurrent_activities().value))
        return _service[1]


def close_agent_runtimes() -> None:
    global _service
    with _service_lock:
        service, _service = _service, None
    if service is not None and service[0] == os.getpid():
        service[1].close()


atexit.register(close_agent_runtimes)
