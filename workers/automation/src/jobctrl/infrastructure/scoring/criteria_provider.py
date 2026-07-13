"""Local scoring criteria provider.

Loads config.json settings written by the TypeScript API and folds those
settings together with the profile snapshot's preference fields. The scorer
receives an explicit ``ScoringCriteria`` payload, so prompt construction and
persistence never have to reach into global settings.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from jobctrl.config import get_config_path, load_config_file
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.scoring.value_objects import ScoringCriteria


class LocalScoringCriteriaProvider:
    """Load local scoring settings from ``~/.jobctrl/config.json``."""

    def __init__(self, path: Path | str | None = None) -> None:
        self._path = resolve_config_path(path)

    def load(self, profile_snapshot: ProfileSnapshot) -> ScoringCriteria:
        settings = read_config_settings(self._path)
        return ScoringCriteria.from_profile_snapshot(
            profile_snapshot,
            min_fit_score=read_min_fit_score(),
            criteria_text=str(settings.get("score_criteria") or ""),
            target_criteria=str(settings.get("target_criteria") or ""),
        )


def read_apply_approval_required(
    *,
    default: bool = True,
) -> bool:
    from jobctrl.config import load_discovery_automation_settings

    value = load_discovery_automation_settings().get("apply_approval_required")
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return bool(default)


def read_auto_apply_enabled(
    *,
    default: bool = False,
) -> bool:
    from jobctrl.config import load_discovery_automation_settings

    value = load_discovery_automation_settings().get("auto_apply")
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
    settings = read_config_settings(path)
    value = settings.get("daily_budget_usd")
    try:
        budget = float(value)
    except (TypeError, ValueError):
        return float(default)
    return max(0.0, budget)


def read_min_fit_score(
    *,
    default: int = 7,
) -> int:
    from jobctrl.config import load_discovery_automation_settings

    value = load_discovery_automation_settings().get("min_fit_score")
    return min(10, max(0, _int(value, default)))


def read_apply_concurrency(
    path: Path | str | None = None,
    *,
    default: int = 1,
) -> int:
    settings = read_config_settings(path)
    value = settings.get("apply_concurrency")
    return min(16, max(1, _int(value, default)))


def read_preferred_model(
    provider: str,
    path: Path | str | None = None,
) -> str | None:
    """Read one validated provider-scoped model ID from config.json."""

    if provider not in {"codex", "claude", "google"}:
        return None
    settings = read_config_settings(path)
    preferred = settings.get("preferred_models")
    if not isinstance(preferred, dict):
        return None
    raw = preferred.get(provider)
    if not isinstance(raw, str):
        return None
    model = raw.strip()
    if (
        not 0 < len(model) <= 160
        or ":" in model
        or any(ord(character) < 32 or ord(character) == 127 for character in model)
    ):
        return None
    return model


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def resolve_config_path(path: Path | str | None = None) -> Path:
    """Resolve config.json using the same runtime path boundary as the API."""
    if path is not None:
        return Path(path).expanduser()
    return get_config_path()


def read_config_settings(path: Path | str | None = None) -> dict[str, Any]:
    """Read the canonical non-secret Settings document or fail on corruption."""

    return load_config_file(path=resolve_config_path(path), strict=True)
