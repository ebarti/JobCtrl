"""Packaged public source inventory; fresh-state activation remains explicit."""

from importlib.resources import files
import re

import yaml


def source_slug(value):
    # This formats an authored registry identifier; it decides no meaning.
    return re.sub(r"[^a-z0-9]+", "-", str(value).casefold()).strip("-")


def packaged_sources():
    config = files("jobctrl").joinpath("config")
    employers = yaml.safe_load(config.joinpath("employers.yaml").read_text()) or {}
    sites = yaml.safe_load(config.joinpath("sites.yaml").read_text()) or {}
    result = []
    for key, employer in (employers.get("employers") or {}).items():
        if not isinstance(employer, dict) or not all(
            employer.get(field) for field in ("base_url", "tenant", "site_id")
        ):
            continue
        result.append(
            {
                "sourceId": "workday:" + source_slug(key),
                "displayName": employer.get("name") or key,
                "kind": "ats_api",
                "owner": "system",
                "priority": "canonical",
                "state": "disabled",
                "policyId": "workday_api_canonical",
                "seedUrl": employer["base_url"].rstrip("/") + "/" + employer["site_id"],
                "adapterConfig": {
                    **employer,
                    "company": employer.get("name"),
                    "atsKind": "workday",
                    "employer_key": key,
                    "board": employer["site_id"],
                },
            }
        )
    for site in sites.get("sites") or []:
        if not isinstance(site, dict) or not site.get("name") or not site.get("url"):
            continue
        result.append(
            {
                "sourceId": "smart_extract:" + source_slug(site["name"]),
                "displayName": site["name"],
                "kind": "smart_extract",
                "owner": "system",
                "priority": "fallback",
                "state": "disabled",
                "policyId": "smart_extract_experimental",
                "seedUrl": site["url"],
                "adapterConfig": dict(site),
            }
        )
    for source in sites.get("sources") or []:
        if not isinstance(source, dict) or not (source.get("id") or source.get("source_id")):
            continue
        result.append(
            {
                "sourceId": source.get("id") or source["source_id"],
                "displayName": source.get("display_name") or source.get("name") or source.get("id"),
                "kind": source.get("kind", "employer_careers_page"),
                "owner": "system",
                "priority": source.get("priority", "standard"),
                "state": "disabled",
                "policyId": "ats_api_canonical" if source.get("kind") == "ats_api" else "smart_extract_experimental",
                "seedUrl": source.get("seed_url") or source.get("url"),
                "adapterConfig": dict(source),
            }
        )
    return result
