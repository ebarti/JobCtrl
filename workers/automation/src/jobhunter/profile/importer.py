"""Profile import core used by the Temporal activity and local wrappers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from jobhunter.domain.profile.use_cases import ImportProfileUseCase
from jobhunter.infrastructure.profile import get_profile_repository


def import_profile_pdf(
    pdf_path: str,
    *,
    import_profile: bool = True,
    import_style: bool = True,
) -> dict[str, Any]:
    path = Path(pdf_path).expanduser()
    use_case = ImportProfileUseCase(repository=get_profile_repository())
    result = use_case(path.read_bytes(), filename=path.name)
    draft: dict[str, Any] = {"source": result.source}
    if import_profile:
        draft["profile"] = result.profile
    if import_style:
        draft["style"] = result.style
    return draft
