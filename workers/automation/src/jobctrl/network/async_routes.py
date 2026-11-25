"""Read-only browser routes whose in-flight pinned sockets belong to one capture."""

import asyncio
from contextlib import suppress
import socket
import threading

from .url_safety import PublicHttpUrlRouteGuard, _fetch_public_route_request


async def await_owned(awaitable, *, cancel_on_stop=False):
    """Keep ownership until work exits, including when Stop and shutdown overlap."""
    work = asyncio.ensure_future(awaitable)
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        if cancel_on_stop:
            work.cancel()
        while not work.done():
            try:
                await asyncio.shield(work)
            except (asyncio.CancelledError, Exception):
                pass
        if not work.cancelled():
            work.exception()
        raise


class AsyncPublicHttpUrlRouteGuard(PublicHttpUrlRouteGuard):
    def __init__(self, page):
        super().__init__(page, fetch_public_requests=True, request_fetcher=self._fetch)
        self._serial = asyncio.Lock()
        self._socket_lock = threading.Lock()
        self._sockets = set()
        self._pending = set()
        self._closing = False

    def _fetch(self, url, method, headers):
        handles = []

        def open_socket(*args):
            with self._socket_lock:
                if self._closing:
                    raise OSError("Capture closed.")
                original = socket.socket(*args)
                try:
                    handle = original.dup()
                except BaseException:
                    original.close()
                    raise
                # TLS takes ownership of the original descriptor. A duplicate
                # lets cancellation shut down the same connection during any read.
                self._sockets.add(handle)
                handles.append(handle)
                return original

        try:
            return _fetch_public_route_request(url, method, headers, socket_factory=open_socket)
        finally:
            with self._socket_lock:
                for handle in handles:
                    self._sockets.discard(handle)
                    handle.close()

    async def _handle(self, route, request, completed):
        try:
            async with self._serial:
                action = "abort"
                if not self._closing:
                    values = self.request_values(request)
                    action = await await_owned(asyncio.to_thread(self.resolve_route, *values))
                if self._closing or isinstance(action, str):
                    await route.abort("blockedbyclient")
                else:
                    await route.fulfill(status=action.status, headers=action.headers, body=action.body)
        finally:
            self._pending.discard(completed)
            completed.set_result(None)

    async def install_async(self):
        def route_request(route, request):
            # Register synchronously, before Playwright schedules the coroutine.
            # Ownership includes the browser's final abort/fulfill acknowledgement.
            completed = asyncio.get_running_loop().create_future()
            self._pending.add(completed)
            return self._handle(route, request, completed)

        self._handler = route_request
        await self._page.route("**/*", route_request)
        return self

    async def close_async(self):
        with self._socket_lock:
            self._closing = True
            for handle in self._sockets:
                with suppress(OSError):
                    handle.shutdown(socket.SHUT_RDWR)
        while self._pending:
            await asyncio.gather(*self._pending)
        if self._handler is not None:
            # Keep interception active until this capture's private page closes.
            # Unrouting a live page would briefly permit an unguarded request.
            await self._page.close()
            self._handler = None
