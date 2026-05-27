"""Materials Generation entity types.

See ddd-target.md §4.5. The :class:`Artifact` entity is a non-root entity
within the :class:`MaterialsSet` aggregate — it has identity
(``artifact_id``) but is only mutated through the aggregate root.

Pure data, no I/O. Frozen dataclass with class-method factories that
enforce the invariants up front. The bytes themselves live on disk; the
entity carries the path + metadata + lifecycle status.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Mapping

from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    RenderFormat,
)


# ---------------------------------------------------------------------------
# Artifact entity
# ---------------------------------------------------------------------------


def _generate_artifact_id() -> str:
    """Generate a fresh, opaque artifact identifier."""
    return uuid.uuid4().hex


@dataclass(frozen=True)
class Artifact:
    """One generated file within a :class:`MaterialsSet`.

    Identity: ``artifact_id`` (uuid hex string). Equality between artifacts
    follows dataclass equality (all fields), but identity-based comparisons
    should use ``artifact_id`` directly.

    Invariants enforced in ``__post_init__``:

      * ``artifact_id`` is a non-empty string.
      * ``type`` and ``status`` are members of their respective enums.
      * ``render_format`` is a member of :class:`RenderFormat`.
      * ``path`` is a non-empty string (the on-disk location).
      * ``size_bytes`` is non-negative when present.
      * ``metadata`` is a mapping (stored as a dict for serialisation).
      * ``superseded_at`` is set iff ``status == SUPERSEDED``.

    Mutators (``with_status``, ``supersede``) are pure: they return a new
    :class:`Artifact` instance — the original is never modified. This keeps
    the aggregate root the only authority over lifecycle changes.
    """

    artifact_id: str
    type: ArtifactType
    status: ArtifactStatus
    path: str
    render_format: RenderFormat
    created_at: str
    size_bytes: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    superseded_at: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.artifact_id, str) or not self.artifact_id.strip():
            raise ValueError("Artifact.artifact_id must be a non-empty string")
        if not isinstance(self.type, ArtifactType):
            raise TypeError(
                f"Artifact.type must be an ArtifactType, got {type(self.type).__name__}"
            )
        if not isinstance(self.status, ArtifactStatus):
            raise TypeError(
                f"Artifact.status must be an ArtifactStatus, got {type(self.status).__name__}"
            )
        if not isinstance(self.render_format, RenderFormat):
            raise TypeError(
                "Artifact.render_format must be a RenderFormat, "
                f"got {type(self.render_format).__name__}"
            )
        if not isinstance(self.path, str) or not self.path.strip():
            raise ValueError("Artifact.path must be a non-empty string")
        if self.size_bytes is not None:
            if not isinstance(self.size_bytes, int) or isinstance(self.size_bytes, bool):
                raise TypeError("Artifact.size_bytes must be an int or None")
            if self.size_bytes < 0:
                raise ValueError(
                    f"Artifact.size_bytes must be non-negative, got {self.size_bytes}"
                )
        if not isinstance(self.created_at, str) or not self.created_at.strip():
            raise ValueError(
                "Artifact.created_at must be a non-empty ISO-8601 timestamp"
            )
        if not isinstance(self.metadata, dict):
            raise TypeError("Artifact.metadata must be a dict")
        if self.status is ArtifactStatus.SUPERSEDED:
            if not self.superseded_at or not str(self.superseded_at).strip():
                raise ValueError(
                    "Artifact.status == SUPERSEDED requires a non-empty superseded_at"
                )
        else:
            if self.superseded_at is not None:
                raise ValueError(
                    "Artifact.superseded_at must be None unless status is SUPERSEDED"
                )

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @classmethod
    def create(
        cls,
        *,
        type: ArtifactType,  # noqa: A002 — domain term, mirrors §4.5 vocabulary
        path: str,
        created_at: str,
        render_format: RenderFormat,
        status: ArtifactStatus = ArtifactStatus.CANDIDATE,
        size_bytes: int | None = None,
        metadata: Mapping[str, Any] | None = None,
        artifact_id: str | None = None,
    ) -> "Artifact":
        return cls(
            artifact_id=artifact_id or _generate_artifact_id(),
            type=type,
            status=status,
            path=path,
            render_format=render_format,
            created_at=created_at,
            size_bytes=size_bytes,
            metadata=dict(metadata or {}),
            superseded_at=None,
        )

    # ------------------------------------------------------------------
    # Lifecycle mutators (pure — return a new instance)
    # ------------------------------------------------------------------

    def with_status(
        self,
        status: ArtifactStatus,
        *,
        superseded_at: str | None = None,
    ) -> "Artifact":
        """Return a copy with a new status.

        Use :meth:`supersede` for the SUPERSEDED transition — it requires
        a timestamp and this helper would silently produce an invalid
        artifact otherwise.
        """
        if status is ArtifactStatus.SUPERSEDED and not superseded_at:
            raise ValueError(
                "with_status(SUPERSEDED) requires superseded_at; use supersede(at=…) instead"
            )
        return Artifact(
            artifact_id=self.artifact_id,
            type=self.type,
            status=status,
            path=self.path,
            render_format=self.render_format,
            created_at=self.created_at,
            size_bytes=self.size_bytes,
            metadata=dict(self.metadata),
            superseded_at=superseded_at if status is ArtifactStatus.SUPERSEDED else None,
        )

    def approve(self) -> "Artifact":
        return self.with_status(ArtifactStatus.APPROVED)

    def reject(self) -> "Artifact":
        return self.with_status(ArtifactStatus.REJECTED)

    def supersede(self, *, at: str) -> "Artifact":
        if not at or not str(at).strip():
            raise ValueError("supersede(at=…) requires a non-empty timestamp")
        return self.with_status(ArtifactStatus.SUPERSEDED, superseded_at=at)

    def suppress(self, *, at: str, reason: str) -> "Artifact":
        if not at or not str(at).strip():
            raise ValueError("suppress(at=…) requires a non-empty timestamp")
        normalized_reason = " ".join(str(reason or "").split()) or "policy_suppressed"
        return Artifact(
            artifact_id=self.artifact_id,
            type=self.type,
            status=ArtifactStatus.SUPPRESSED,
            path=self.path,
            render_format=self.render_format,
            created_at=self.created_at,
            size_bytes=self.size_bytes,
            metadata={
                **dict(self.metadata),
                "suppression": {
                    "reason": normalized_reason,
                    "suppressed_at": at,
                },
            },
            superseded_at=None,
        )

    # ------------------------------------------------------------------
    # Serialization (used by the SQLite repository adapter)
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "type": self.type.value,
            "status": self.status.value,
            "path": self.path,
            "render_format": self.render_format.value,
            "size_bytes": self.size_bytes,
            "metadata": dict(self.metadata),
            "created_at": self.created_at,
            "superseded_at": self.superseded_at,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Artifact":
        return cls(
            artifact_id=str(data["artifact_id"]),
            type=ArtifactType(data["type"]),
            status=ArtifactStatus(data["status"]),
            path=str(data["path"]),
            render_format=RenderFormat(data["render_format"]),
            created_at=str(data["created_at"]),
            size_bytes=(
                int(data["size_bytes"])
                if data.get("size_bytes") is not None
                else None
            ),
            metadata=dict(data.get("metadata") or {}),
            superseded_at=(
                str(data["superseded_at"])
                if data.get("superseded_at")
                else None
            ),
        )


__all__ = ["Artifact"]
