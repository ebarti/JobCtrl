"""Saved authored targets and deterministic provider execution policy."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json


DEFAULT_SETTINGS = {
    "minFitScore": 7,
    "autoApply": False,
    "applyApprovalRequired": True,
    "boards": ["indeed", "linkedin", "zip_recruiter"],
    "resultsPerSite": 50,
    "hoursOld": 72,
    "schedulingEnabled": False,
    "scheduleCron": "0 7 * * *",
    "maxParallelFamilies": 1,
    "useBrowserHeaders": False,
    "crawlUserAgentProduct": "JobCtrl",
    "crawlUserAgentContact": "https://github.com/ebarti/JobCtrl",
    "source": "database",
    "queries": [],
    "locations": [],
    "exactTitleExclusions": [],
    "newJobLimit": 100,
}


def now():
    return datetime.now(timezone.utc).isoformat()


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def validate_settings(value):
    result = deepcopy(value)
    for key, minimum, maximum in (
        ("resultsPerSite", 1, 1000),
        ("hoursOld", 0, 24 * 365),
        ("maxParallelFamilies", 1, 4),
        ("newJobLimit", 1, 10000),
        ("minFitScore", 0, 10),
    ):
        number = result.get(key)
        if not isinstance(number, (int, float)) or isinstance(number, bool) or not minimum <= number <= maximum:
            raise ValueError(f"Invalid {key}")
        if key != "minFitScore" and type(number) is not int:
            raise ValueError(f"Invalid {key}")
    for key in ("boards", "queries", "locations", "exactTitleExclusions"):
        if not isinstance(result.get(key), list) or len(result[key]) > 1000:
            raise ValueError(f"Invalid {key}")
    for query in result["queries"]:
        if isinstance(query, str):
            valid = bool(query.strip()) and len(query) <= 1000
        elif isinstance(query, dict):
            valid = isinstance(query.get("query"), str) and bool(query["query"].strip()) and len(query["query"]) <= 1000
            scope = query.get("source_scope", [])
            valid = (
                valid and isinstance(scope, list) and len(scope) <= 30 and all(isinstance(item, str) for item in scope)
            )
            valid = valid and type(query.get("tier", 1)) is int and 1 <= query.get("tier", 1) <= 3
        else:
            valid = False
        if not valid:
            raise ValueError("Invalid query")
    for location in result["locations"]:
        if isinstance(location, str):
            valid = bool(location.strip()) and len(location) <= 4000
        elif isinstance(location, dict):
            valid = (
                isinstance(location.get("location"), str)
                and len(location["location"]) <= 4000
                and isinstance(location.get("remote", False), bool)
            )
            valid = valid and (bool(location["location"].strip()) or location.get("remote") is True)
        else:
            valid = False
        if not valid:
            raise ValueError("Invalid location")
    if len(result["queries"]) * len(result["locations"]) > 1000:
        raise ValueError("Too many search units")
    if not all(
        isinstance(title, str) and title.strip() and len(title) <= 2000 for title in result["exactTitleExclusions"]
    ):
        raise ValueError("Invalid exact title exclusion")
    if not all(isinstance(board, str) and board.strip() for board in result["boards"]):
        raise ValueError("Invalid boards")
    for key in ("schedulingEnabled", "useBrowserHeaders", "autoApply", "applyApprovalRequired"):
        if not isinstance(result.get(key), bool):
            raise ValueError(f"Invalid {key}")
    for key in ("crawlUserAgentProduct", "crawlUserAgentContact"):
        text = result.get(key)
        if not isinstance(text, str) or len(text) > 500 or any(ord(c) < 32 or ord(c) == 127 for c in text):
            raise ValueError(f"Invalid {key}")
    if not result["crawlUserAgentProduct"].strip():
        raise ValueError("Invalid crawler product")
    cron = result.get("scheduleCron")
    if not isinstance(cron, str) or len(cron.split()) != 5 or len(cron) > 200:
        raise ValueError("Invalid scheduleCron")
    return result


def search_units(settings, targets=None, *, isolate_boards=False):
    """Execute literal authored/provider queries; never generate meaning from words."""
    queries = settings.get("queries") or (targets or {}).get("queries") or []
    locations = settings.get("locations") or (targets or {}).get("locations") or []
    result = []
    for item in queries:
        query = item if isinstance(item, str) else item.get("query", "") if isinstance(item, dict) else ""
        if not query.strip():
            continue
        scope = item.get("source_scope") if isinstance(item, dict) else None
        for row in locations:
            location = row if isinstance(row, str) else row.get("location", "")
            remote = row.get("remote") is True if isinstance(row, dict) else False
            spec = {
                "query": query.strip(),
                "location": location,
                "remote_only": remote,
                "sites": [
                    board
                    for board in settings["boards"]
                    if not scope
                    or board in scope
                    or "jobstreaming:" + board in scope
                    or set(scope).intersection({"jobspy", "jobstreaming", "broad_boards"})
                ],
                "results_per_site": int(settings["resultsPerSite"]),
                "hours_old": int(settings["hoursOld"]) or None,
                "country_indeed": settings.get("countryIndeed", "usa"),
                "linkedin_fetch_description": False,
                "source_family": "broad_boards",
            }
            selections = [[site] for site in spec["sites"]] if isolate_boards else [spec["sites"]]
            for sites in selections:
                if sites:
                    board_spec = {**spec, "sites": sites}
                    result.append({
                        "unit_id": fingerprint({key: value for key, value in board_spec.items() if key != "source_family"}),
                        **board_spec,
                    })
    return list({unit["unit_id"]: unit for unit in result}.values())
