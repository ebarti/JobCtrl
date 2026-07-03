"""Temporal activity for the profile-import action."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from temporalio import activity

from jobhunter.domain.errors import JobHunterError, to_application_error


@dataclass(frozen=True)
class ProfileImportActivityInput:
    # ``tenant_id`` is currently informational; runners read from
    # ``LOCAL_TENANT`` until tenant scoping lands.
    tenant_id: str
    pdf_path: str
    expected_app_dir: str | None = None
    expected_db_path: str | None = None
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
    from jobhunter.infrastructure.temporal.run_in_activity import (
        run_blocking_with_heartbeat,
    )
    from jobhunter.infrastructure.temporal.runtime_guard import assert_activity_runtime
    from jobhunter.profile.importer import import_profile_pdf

    assert_activity_runtime(
        expected_app_dir=payload.expected_app_dir,
        expected_db_path=payload.expected_db_path,
    )

    def _do() -> Any:
        return import_profile_pdf(
            payload.pdf_path,
            import_profile=payload.import_profile,
            import_style=payload.import_style,
        )

    try:
        draft = await run_blocking_with_heartbeat(
            _do,
            starting_message="profile_import starting",
            progress_message="profile_import still running",
            activity_name="profile_import",
        )
        return ProfileImportActivityOutput(
            status="succeeded",
            draft=draft,
            error=None,
        )
    except JobHunterError as exc:
        raise to_application_error(exc) from exc
    except Exception as exc:
        raise to_application_error(exc) from exc
