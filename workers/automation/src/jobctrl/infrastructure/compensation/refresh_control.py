"""Coordinator-owned cancellation and exact compensation publication leases."""
from __future__ import annotations

from datetime import datetime, timedelta

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.compensation.refresh_state import StaleCompensationRefreshLease


class CompensationRefreshControl:
    def __init__(self, conn, repository, leases, *, clock, lease_duration, cancel_event=None):
        self._conn = conn
        self._repository = repository
        self._leases = {lease.benchmark_slice.key: lease for lease in leases}
        self._clock = clock
        self._lease_duration = lease_duration
        self._cancel_event = cancel_event
        self._next_check = None
        self._aborted = False

    def __enter__(self):
        return self

    def __exit__(self, _type, error, _traceback):
        if error is not None:
            self.abort(error)
        elif self._leases:
            error = RuntimeError("compensation refresh left unfinished ownership")
            self.abort(error)
            raise error

    def check(self, *, force=False):
        if self._cancel_event is not None and self._cancel_event.is_set():
            raise DeterminationFailure("compensation_refresh_canceled")
        if not self._leases:
            return
        now = self._clock()
        instant = datetime.fromisoformat(now.replace("Z", "+00:00"))
        if not force and self._next_check is not None and instant < self._next_check:
            return
        leases = tuple(self._leases.values())
        self._repository.check_current(leases, now=now)
        earliest = min(datetime.fromisoformat(lease.expires_at.replace("Z", "+00:00")) for lease in leases)
        if earliest - instant <= self._lease_duration / 2:
            leases = self._repository.renew_leases(
                leases, now=now, lease_expires_at=(instant + self._lease_duration).isoformat(),
            )
            self._leases = {lease.benchmark_slice.key: lease for lease in leases}
        self._next_check = instant + timedelta(seconds=1)

    def lease(self, benchmark_slice):
        return self._leases[benchmark_slice.key]

    def finished(self, benchmark_slice):
        self._leases.pop(benchmark_slice.key)

    def abort(self, error):
        """Preserve accepted results and never release a replacement owner."""
        if self._aborted:
            return
        self._aborted = True
        if self._conn.in_transaction:
            self._conn.rollback()
        now = self._clock()
        instant = datetime.fromisoformat(now.replace("Z", "+00:00"))
        code = error.code if isinstance(error, DeterminationFailure) else "compensation_refresh_failed"
        retry_at = now if code == "compensation_refresh_canceled" else (instant + timedelta(minutes=15)).isoformat()
        for lease in tuple(self._leases.values()):
            try:
                self._repository.mark_failed(lease, completed_at=now, retry_at=retry_at, error_code=code)
            except StaleCompensationRefreshLease:
                pass  # A successor's ownership and accepted result take precedence.
        self._leases.clear()
