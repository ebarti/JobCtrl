"""Local scoring criteria provider.

Loads the dashboard settings written by the TypeScript API and folds those
settings together with the profile snapshot's preference fields. The scorer
receives an explicit ``ScoringCriteria`` payload, so prompt construction and
persistence never have to reach into global settings.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jobhunter.config import APP_DIR
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.scoring.value_objects import ScoringCriteria


DEFAULT_SETTINGS_PATH = APP_DIR / "dashboard.json"


class LocalScoringCriteriaProvider:
    """Load local scoring settings from ``~/.jobhunter/dashboard.json``."""

    def __init__(self, path: Path | str = DEFAULT_SETTINGS_PATH) -> None:
        self._path = Path(path)

    def load(self, profile_snapshot: ProfileSnapshot) -> ScoringCriteria:
        settings = self._read_settings()
        return ScoringCriteria.from_profile_snapshot(
            profile_snapshot,
            min_fit_score=_int(settings.get("min_fit_score"), 7),
            criteria_text=str(settings.get("score_criteria") or ""),
            target_criteria=str(settings.get("target_criteria") or ""),
        )

    def _read_settings(self) -> dict[str, Any]:
        if not self._path.exists():
            return {}
        try:
            parsed = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}


def read_apply_approval_required(
    path: Path | str | None = None,
    *,
    default: bool = True,
) -> bool:
    settings = LocalScoringCriteriaProvider(path or DEFAULT_SETTINGS_PATH)._read_settings()
    value = settings.get("apply_approval_required")
    if value is None:
        value = settings.get("applyApprovalRequired")
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return bool(default)


def read_daily_budget_usd(
    path: Path | str | None = None,
    *,
    default: float = 25.0,
) -> float:
    settings = LocalScoringCriteriaProvider(path or DEFAULT_SETTINGS_PATH)._read_settings()
    value = settings.get("daily_budget_usd")
    if value is None:
        value = settings.get("dailyBudgetUsd")
    try:
        budget = float(value)
    except (TypeError, ValueError):
        return float(default)
    return max(0.0, budget)


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
