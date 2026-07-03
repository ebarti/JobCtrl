"""Temporal activity for the profile-import action.

Wraps ``actions.run_local_action`` because ``profile_import`` already lives
behind that single entry point — there is no separate stage runner.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from temporalio import activity

from jobhunter.domain.errors import JobHunterError, MissingInputError, to_application_error


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
    from jobhunter.actions import LocalActionRequest, run_local_action
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )

    def _do() -> Any:
        return run_local_action(
            LocalActionRequest(
                stage="profile_import",
                pdf_path=payload.pdf_path,
                import_profile=payload.import_profile,
                import_style=payload.import_style,
            )
        )

    try:
        result = await run_blocking_with_heartbeat(
            _do,
            starting_message="profile_import starting",
            progress_message="profile_import still running",
            activity_name="profile_import",
        )
        if not result.ok:
            raise MissingInputError(result.error or result.status)
        draft = dict(result.result.get("draft") or {})
        return ProfileImportActivityOutput(
            status=result.status,
            draft=draft,
            error=None,
        )
    except JobHunterError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc
