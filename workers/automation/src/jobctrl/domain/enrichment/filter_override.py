"""Policy-compliant internal filter override logger.

See ``docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md``
§"Policy For Content Acquisition" — "filter override" is the
*product-internal* override of one of JobCtrl's own filters
(low-confidence extraction, short description, missing salary, ...)
against a source whose ``ContentFilterOverridePolicy.allowed`` is
True. It is NOT bypassing third-party access controls.

The logger does two things:

  * Validates that the override is authorized by the source's policy.
  * Returns an audit value that the caller persists onto the
    ``PostingContentSnapshot`` and emits via standard logging so
    operators can review which overrides were applied.

The validation surface is small and synchronous to keep this in the
domain layer; persistence stays in adapters.
"""

from __future__ import annotations

import logging
from typing import Iterable

from jobctrl.domain.discovery.source_registry import (
    ContentFilterOverridePolicy,
)
from jobctrl.domain.enrichment.snapshot_value_objects import FilterOverrideAudit

log = logging.getLogger(__name__)


class FilterOverrideError(Exception):
    """Raised when a requested override is not allowed by source policy."""


class FilterOverrideLogger:
    """Validate and record a policy-compliant filter override.

    Usage:

        audit = FilterOverrideLogger().record(
            source_id="greenhouse:acme",
            policy=source.policy.content_filter_override,
            overridden_filter="low_confidence_extraction",
            reason="user marked source trusted for discovery",
            requested_by="user:example",
            overridden_at="2026-05-13T00:00:00+00:00",
        )

    The returned audit is propagated onto the snapshot. An info-level
    log line is emitted for the local audit trail.
    """

    def record(
        self,
        *,
        source_id: str,
        policy: ContentFilterOverridePolicy,
        overridden_filter: str,
        reason: str,
        requested_by: str,
        overridden_at: str,
    ) -> FilterOverrideAudit:
        """Validate and return a ``FilterOverrideAudit``.

        Raises ``FilterOverrideError`` when:

          * the source policy disallows overrides at all,
          * the policy requires a reason and one was not supplied,
          * the requested filter is not in
            ``policy.allowed_filters``.
        """
        if not policy.allowed:
            raise FilterOverrideError(
                f"Source {source_id!r} does not allow content filter overrides"
            )
        if policy.requires_reason and (not reason or not reason.strip()):
            raise FilterOverrideError(
                f"Source {source_id!r} requires a reason for filter overrides"
            )
        if overridden_filter not in policy.allowed_filters:
            raise FilterOverrideError(
                f"Filter {overridden_filter!r} is not allowed for source {source_id!r}"
            )

        audit = FilterOverrideAudit(
            source_id=source_id,
            overridden_filter=overridden_filter,
            reason=reason,
            requested_by=requested_by,
            overridden_at=overridden_at,
        )
        # Audit-trail log line. The reason is short structured prose
        # supplied by the operator; no posting text is included.
        log.info(
            "filter_override.applied source_id=%s filter=%s requested_by=%s at=%s reason=%s",
            audit.source_id,
            audit.overridden_filter,
            audit.requested_by,
            audit.overridden_at,
            audit.reason,
        )
        return audit


def collect_overridable_filters(
    policy: ContentFilterOverridePolicy,
) -> Iterable[str]:
    """Helper for UIs that need to render the allowed override set."""
    return policy.allowed_filters


__all__ = [
    "FilterOverrideError",
    "FilterOverrideLogger",
    "collect_overridable_filters",
]
