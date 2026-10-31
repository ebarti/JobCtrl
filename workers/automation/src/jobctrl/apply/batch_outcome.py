"""Truthful completed-job counts for failed Apply batches."""

from __future__ import annotations

from dataclasses import dataclass

from jobctrl.apply.ownership import ApplyLauncherCleanupIncomplete


@dataclass(frozen=True)
class ApplyBatchCounts:
    applied: int
    failed: int
    worker_crashes: int

    def __post_init__(self) -> None:
        if any(type(value) is not int or value < 0 for value in (self.applied, self.failed, self.worker_crashes)):
            raise ValueError("Apply batch counts must be non-negative integers")

    def to_dict(self) -> dict[str, int]:
        return {"applied": self.applied, "failed": self.failed, "worker_crashes": self.worker_crashes}

    @classmethod
    def from_dict(cls, value: object) -> ApplyBatchCounts:
        if not isinstance(value, dict) or set(value) != {"applied", "failed", "worker_crashes"}:
            raise ValueError("Malformed Apply batch counts")
        return cls(value["applied"], value["failed"], value["worker_crashes"])


class ApplyBatchWorkersCrashed(RuntimeError):
    """An escaped worker failure, retaining only known completed-job counts."""

    def __init__(self, counts: ApplyBatchCounts):
        if counts.worker_crashes < 1:
            raise ValueError("A worker crash result requires at least one crashed worker")
        self.counts = counts
        super().__init__(f"Apply batch stopped after {counts.worker_crashes} worker crash(es)")


class ApplyBatchCleanupIncomplete(ApplyLauncherCleanupIncomplete):
    """Cleanup remains fenced, with completed counts from joined workers."""

    def __init__(self, message: str, counts: ApplyBatchCounts):
        self.counts = counts
        super().__init__(message)
