"""Saved search settings are authoritative inputs, not model suggestions."""

from jobctrl.domain.determinations import Source


TARGET_FIELDS = (
    "roles",
    "tracks",
    "seniority",
    "functions",
    "specializations",
    "locations",
    "work_models",
    "exclusions",
    "criteria",
)


def search_target_sources(search_cfg):
    target = search_cfg.get("confirmed_targets") or {}
    sources = [
        Source(source_id=f"target:{key}:{index}", text=str(value))
        for key in TARGET_FIELDS
        for index, value in enumerate(target.get(key) or [])
        if str(value).strip()
    ]
    sources.extend(
        Source(source_id=f"target:exact_title_exclusions:{index}", text=str(value))
        for index, value in enumerate(search_cfg.get("exact_title_exclusions") or [])
        if str(value).strip()
    )
    return sources
