"""Temporal activity guard for API/worker runtime identity."""

from __future__ import annotations

from temporalio.exceptions import ApplicationError

from jobhunter.infrastructure.runtime_identity import (
    RuntimeIdentityMismatch,
    assert_expected_runtime,
)


def assert_activity_runtime(
    *,
    expected_app_dir: str | None = None,
    expected_db_path: str | None = None,
) -> None:
    try:
        assert_expected_runtime(
            expected_app_dir=expected_app_dir,
            expected_db_path=expected_db_path,
        )
    except RuntimeIdentityMismatch as exc:
        raise ApplicationError(
            str(exc),
            type="RuntimeIdentityMismatch",
            non_retryable=True,
        ) from exc
