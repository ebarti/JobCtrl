"""Minimized authored profile facts supplied by ID to semantic determinations."""

import json
from jobctrl.domain.determinations import Source
from jobctrl.resume_profile import (
    get_achievement_evidence,
    get_experience_entries,
    get_education_entries,
    get_skill_categories,
)


def profile_sources(profile):
    result = []
    for key in (
        "full_name",
        "email",
        "phone",
        "address",
        "city",
        "country",
        "postal_code",
        "website_url",
        "portfolio_url",
        "linkedin_url",
        "github_url",
    ):
        value = (profile.get("personal") or {}).get(key)
        if isinstance(value, str) and value:
            result.append(Source(source_id="personal:" + key, text=value))
    baseline = str((profile.get("resume", {}).get("executive_profile") or {}).get("baseline_text") or "")
    if baseline:
        result.append(Source(source_id="executive_profile:baseline", text=baseline))
    for item in get_achievement_evidence(profile):
        if not item.get("user_confirmed"):
            continue
        fields = {key: item.get(key) for key in ("source_text", "scope", "action", "tools", "metrics", "outcome")}
        result.append(Source(source_id=str(item["id"]), text=json.dumps(fields, ensure_ascii=False)))
    for entry in get_experience_entries(profile):
        ident = str(entry["id"])
        for key in ("title", "company", "date_range", "location", "summary"):
            value = str(entry.get(key) or "")
            if value:
                result.append(Source(source_id=f"experience:{ident}:{key}", text=value))
        for index, bullet in enumerate(entry.get("bullets") or []):
            result.append(Source(source_id=f"experience:{ident}:source:{index}", text=str(bullet)))
    for entry in get_education_entries(profile):
        result.append(
            Source(
                source_id=f"education:{entry['id']}",
                text=json.dumps(
                    {key: entry.get(key) for key in ("institution", "degree", "date", "location", "details")},
                    ensure_ascii=False,
                ),
            )
        )
    for category in get_skill_categories(profile):
        result.append(
            Source(
                source_id=f"skills:{category['id']}", text=json.dumps(category.get("items") or [], ensure_ascii=False)
            )
        )
    return result
