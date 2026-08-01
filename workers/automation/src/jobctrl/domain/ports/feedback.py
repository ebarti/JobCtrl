"""Read port for the Operations feedback-signal union."""

from __future__ import annotations

from typing import Protocol

from jobctrl.domain.operations.feedback import FeedbackSignal
from jobctrl.domain.tenant import TenantId


class FeedbackSignalReader(Protocol):
    """Project accepted source facts without writing owning context policy."""

    def list_accepted(self, tenant_id: TenantId) -> tuple[FeedbackSignal, ...]:
        """Return the tenant's privacy-safe explicit feedback facts."""
        ...


__all__ = ["FeedbackSignalReader"]
