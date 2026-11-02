"""Saved search settings are authoritative inputs, not model suggestions."""

import re

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


def snapshot_target_sources(snapshot, criteria, *, exact_title_exclusions=()):
    """Format literal saved targets from a frozen profile, without a live reread."""
    experience = snapshot.experience
    target = {
        field: split_target_text(experience.get(key))
        for field, key in (
            ("roles", "target_role"), ("tracks", "target_track"),
            ("seniority", "target_seniority_floor"), ("functions", "target_functions"),
            ("specializations", "target_specializations"),
        )
    }
    locations = split_target_rows(experience.get("target_locations"))
    models = split_target_rows(experience.get("target_work_models"))
    rows = [
        (locations[i] if i < len(locations) else "", models[i] if i < len(models) else "")
        for i in range(max(len(locations), len(models)))
    ]
    rows = [(location, model) for location, model in rows if location or model]
    target.update(locations=[row[0] for row in rows], work_models=[row[1] for row in rows],
                  criteria=[value for value in (criteria.criteria_text, criteria.target_criteria) if value])
    return search_target_sources({"confirmed_targets": target, "exact_title_exclusions": exact_title_exclusions})


def split_target_text(value: object) -> list[str]:
    if value is None:
        return []
    cleaned = re.sub(r"^\s*Target (?:roles?|locations?):\s*", "", str(value), flags=re.IGNORECASE)
    return [item.strip() for item in re.split(r"[;\n]+", cleaned) if item.strip()]


def split_target_rows(value: object) -> list[str]:
    """Keep empty positional counterparts in literal saved location/model rows."""
    if value is None or not str(value).strip():
        return []
    cleaned = re.sub(r"^\s*Target (?:roles?|locations?):\s*", "", str(value), flags=re.IGNORECASE)
    return [item.strip() for item in re.split(r"[;\n]", cleaned)]


def guarded_target_rows(locations: str, work_models: str) -> list[tuple[str, tuple[str, ...], str | None]]:
    """Identify exact Remote choices and location-free non-Remote choices."""
    from jobctrl.domain.taxonomy import SEMANTIC_TAXONOMY

    places = split_target_rows(locations)
    models = split_target_rows(work_models)
    remote_values = {"remote", SEMANTIC_TAXONOMY["workModel"]["remote"]}
    work_model = SEMANTIC_TAXONOMY["workModel"]
    nonremote_values = {"hybrid", work_model["hybrid"], "onsite", work_model["onsite"]}
    rows = []
    for index in range(max(len(places), len(models))):
        place = places[index] if index < len(places) else ""
        selected = models[index] if index < len(models) else ""
        choices = tuple(value.strip() for value in selected.split(","))
        remote = tuple(value for value in choices if value in remote_values)
        nonremote = tuple(value for value in choices if value in nonremote_values)
        if remote:
            rows.append((place, remote, place or "Remote"))
        if not place and nonremote:
            rows.append((place, nonremote, ""))
    return rows


def has_profile_target_rows(locations: str, work_models: str) -> bool:
    places = split_target_rows(locations)
    models = split_target_rows(work_models)
    return any(
        (places[index] if index < len(places) else "") or (models[index] if index < len(models) else "")
        for index in range(max(len(places), len(models)))
    )


def legacy_remote_target_rows(value: object) -> list[tuple[str, tuple[str, ...], str | None]]:
    if not isinstance(value, list):
        return []
    return [
        (row["location"], ("remote",), row.get("label") if isinstance(row.get("label"), str) else None)
        for row in value
        if isinstance(row, dict) and row.get("remote") is True and isinstance(row.get("location"), str)
    ]


def active_target_rows(
    rows: list[tuple[str, tuple[str, ...], str | None]], search_cfg: dict,
) -> list[tuple[str, tuple[str, ...], str | None]]:
    labels = search_cfg.get("location_labels")
    return [row for row in rows if row[2] in labels] if labels else rows
