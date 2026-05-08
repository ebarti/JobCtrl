"""Temporal activity for the profile-import action.

Wraps ``actions.run_local_action`` because ``profile_import`` already lives
behind that single entry point — there is no separate stage runner.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from temporalio import activity


@dataclass(frozen=True)
class ProfileImportActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    pdf_path: str
    import_profile: bool = True
    import_style: bool = True


@dataclass(frozen=True)
class ProfileImportActivityOutput:
    status: str
    draft: dict[str, Any]
    error: str | None = None


@activity.defn(name="profile_import")
async def profile_import_activity(
    payload: ProfileImportActivityInput,
) -> ProfileImportActivityOutput:
    """Import a profile draft from an uploaded resume PDF."""
    activity.heartbeat("profile_import starting")
    from jobhunter.actions import LocalActionRequest, run_local_action

    result = run_local_action(
        LocalActionRequest(
            stage="profile_import",
            pdf_path=payload.pdf_path,
            import_profile=payload.import_profile,
            import_style=payload.import_style,
        )
    )
    if not result.ok:
        return ProfileImportActivityOutput(
            status=result.status,
            draft={},
            error=result.error or result.status,
        )
    draft = dict(result.result.get("draft") or {})
    return ProfileImportActivityOutput(
        status=result.status,
        draft=draft,
        error=None,
    )
