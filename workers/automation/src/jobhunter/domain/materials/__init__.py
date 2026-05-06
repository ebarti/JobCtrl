"""Materials Generation bounded context — public surface.

See ddd-target.md §4.5. The aggregate root is :class:`MaterialsSet`; it
composes immutable :class:`Artifact` value objects (one per
:class:`ArtifactType`) and is identified by ``(TenantId, JobId,
generation: int)``. Re-tailoring increments ``generation``; the previous
generation's artifacts become :data:`ArtifactStatus.SUPERSEDED`.

All types here are pure data (no I/O). Domain services
(:class:`ContentValidator`, :class:`ResumeAssembler`) live in
``services.py``; ports in ``ports.py``; use cases in ``use_cases.py``.
"""

from __future__ import annotations

from jobhunter.domain.materials.aggregate import (
    MaterialsSet,
    MaterialsSetFactory,
)
from jobhunter.domain.materials.entities import Artifact
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    RenderFormat,
    ValidationResult,
)

__all__ = [
    "Artifact",
    "ArtifactStatus",
    "ArtifactType",
    "JudgeVerdict",
    "MaterialsSet",
    "MaterialsSetFactory",
    "RenderFormat",
    "ValidationResult",
]
