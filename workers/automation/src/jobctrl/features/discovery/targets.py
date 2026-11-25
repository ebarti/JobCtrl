"""Freeze literal saved roles and locations for a Discovery run."""

from __future__ import annotations

from collections import Counter
import re
import math
from uuid import uuid4

from jobctrl.app.errors import AppError, NotFoundError
from jobctrl.features.discovery.domain import fingerprint, now
from jobctrl.features.discovery.ports import DiscoveryStore


FIELDS = {
    "roles": "target_role",
    "tracks": "target_track",
    "seniority": "target_seniority_floor",
    "functions": "target_functions",
    "specializations": "target_specializations",
    "locations": "target_locations",
    "work_models": "target_work_models",
}


def literal_rows(value):
    if not isinstance(value, str) or not value.strip():
        return []
    # Existing authored field-label syntax is formatting, never a role/place
    # classification or query expansion.
    value = re.sub(r"^\s*Target (?:roles?|locations?):\s*", "", value, flags=re.IGNORECASE)
    return [row.strip() for row in value.replace(";", "\n").split("\n")]


def selected_places(experience):
    """Read only exact text-bound provider identities from the Profile snapshot.

    Coordinates are user-selected provider data, never a place inferred from
    text or an authorization/eligibility determination. Unbound text stays usable.
    """
    raw = experience.get("target_location_bindings", [])
    if not isinstance(raw, list) or len(raw) > 100:
        raise AppError("invalid_target_location", "Saved map place bindings have an invalid structure.", 409)
    text_rows = literal_rows(experience.get("target_locations", ""))
    location_counts = Counter(text_rows)
    binding_counts = Counter(binding.get("text") for binding in raw if isinstance(binding, dict) and isinstance(binding.get("text"), str))
    ambiguous_texts = {text for text, count in binding_counts.items() if count > location_counts[text]}
    result = {}
    seen = set()
    fields = {"rowIndex", "text", "provider", "placeId", "displayName", "latitude", "longitude", "selectedAt", "provenance"}
    for binding in raw:
        if not isinstance(binding, dict) or set(binding) != fields:
            raise AppError("invalid_target_location", "A saved map place binding has an invalid structure.", 409)
        row_index = binding["rowIndex"]
        if type(row_index) is not int or not 0 <= row_index < 100:
            raise AppError("invalid_target_location", "A saved map place binding requires its recorded row.", 409)
        if row_index in seen:
            raise AppError("invalid_target_location", "A saved target location row has multiple place bindings.", 409)
        seen.add(row_index)
        if (binding["provider"] != "photon" or binding["provenance"] != "user_selected"
                or any(not isinstance(binding[field], str) or not binding[field].strip()
                       for field in ("text", "placeId", "displayName", "selectedAt"))):
            raise AppError("invalid_target_location", "A saved map place binding has invalid provenance.", 409)
        for field, lower, upper in (("latitude", -90, 90), ("longitude", -180, 180)):
            value = binding[field]
            if type(value) not in (int, float) or not math.isfinite(value) or not lower <= value <= upper:
                raise AppError("invalid_target_location", "A saved map place has invalid coordinates.", 409)
        if binding["text"] not in ambiguous_texts and row_index < len(text_rows) and binding["text"] == text_rows[row_index]:
            result[row_index] = binding
    return result


class TargetPlanner:
    def __init__(self, repository: DiscoveryStore, profile):
        self.repository, self.profile = repository, profile

    def _source(self):
        if self.profile is None:
            return None, {}
        try:
            snapshot = self.profile.snapshot()
        except NotFoundError:
            return None, {}
        experience = snapshot.document.get("experience") or {}
        target = {key: experience.get(field, "") for key, field in FIELDS.items()}
        bindings = selected_places(experience)
        if bindings:
            target["location_bindings"] = list(bindings.values())
        return snapshot, target

    def read(self):
        snapshot, target = self._source()
        if snapshot is None:
            return {"ok": True, "current": False, "accepted": None, "targets": target}
        accepted = self.repository.latest_target_plan()
        return {
            "ok": True,
            "current": bool(accepted and accepted.get("provenance") is None and accepted["profileFingerprint"] == snapshot.fingerprint),
            "accepted": accepted,
            "targets": target,
            "profileRevision": snapshot.profile_revision,
        }

    async def refresh(self, *, force=False, operation_id=None, expected_profile_revision=None):
        operation_fingerprint = fingerprint({"force": force, "expected_profile_revision": expected_profile_revision})
        if operation_id:
            accepted = self.repository.target_plan_operation(operation_id)
            if accepted:
                if accepted.get("operationFingerprint") != operation_fingerprint:
                    raise AppError(
                        "target_plan_operation_conflict", "This target-plan operation belongs to different input.", 409
                    )
                snapshot, target = self._source()
                if expected_profile_revision is not None and (snapshot is None or expected_profile_revision != snapshot.profile_revision):
                    raise AppError("target_profile_changed", "The saved Profile targets changed.", 409)
                return {
                    "ok": True,
                    "current": bool(snapshot and accepted["profileFingerprint"] == snapshot.fingerprint),
                    "accepted": accepted,
                    "targets": target,
                    "profileRevision": snapshot.profile_revision if snapshot else None,
                }
        snapshot, target = self._source()
        if expected_profile_revision is not None and (snapshot is None or expected_profile_revision != snapshot.profile_revision):
            raise AppError("target_profile_changed", "The saved Profile targets changed.", 409)
        if snapshot is None or not any(literal_rows(target["roles"])):
            return {"ok": True, "current": False, "accepted": None, "targets": target}
        previous = self.read()
        if previous["current"] and not force:
            if operation_id is None:
                return previous
            accepted = {
                **previous["accepted"],
                "planId": fingerprint([snapshot.fingerprint, operation_id]),
                "operationId": operation_id,
                "operationFingerprint": operation_fingerprint,
                "createdAt": now(),
            }
            accepted = self.repository.save_target_plan(
                accepted, lambda conn: self.profile.assert_current(snapshot, connection=conn)
            )
            return {**previous, "accepted": accepted}
        queries = [
            {"query": role, "tier": 1, "source_scope": [], "authority": "literal_authored_target"}
            for role in literal_rows(target["roles"])
            if role
        ]
        places, models = literal_rows(target["locations"]), literal_rows(target["work_models"])
        place_bindings = {binding["rowIndex"]: binding for binding in target.get("location_bindings", [])}
        locations = []
        for index in range(max(len(places), len(models))):
            place = places[index] if index < len(places) else ""
            choices = (models[index] if index < len(models) else "").split(",")
            choices = [choice.strip() for choice in choices if choice.strip()]
            if not choices:
                if place:
                    locations.append({"location": place, "remote": False, **({"selectedPlace": place_bindings[index]} if index in place_bindings else {})})
                continue
            for choice in choices:
                if choice.casefold() in {"remote", "work_model.remote"}:
                    locations.append({"location": place, "remote": True, **({"selectedPlace": place_bindings[index]} if index in place_bindings else {})})
                elif choice.casefold() in {"hybrid", "on-site", "onsite", "work_model.hybrid", "work_model.onsite"}:
                    if not place:
                        raise AppError(
                            "target_location_required", "Hybrid and On-site targets require an explicit location.", 409
                        )
                    locations.append({"location": place, "remote": False, **({"selectedPlace": place_bindings[index]} if index in place_bindings else {})})
                else:
                    raise AppError("invalid_target_work_model", "The saved work-model choice is not supported.", 409)
        accepted = {
            "planId": fingerprint([snapshot.fingerprint, operation_id or str(uuid4())]),
            "profileRevision": snapshot.profile_revision,
            "profileFingerprint": snapshot.fingerprint,
            "targets": target,
            "queries": list({fingerprint([q["query"], q.get("source_scope")]): q for q in queries}.values()),
            "locations": list({fingerprint(row): row for row in locations}.values()),
            "provenance": None,
            "createdAt": now(),
            "operationId": operation_id,
            "operationFingerprint": operation_fingerprint,
        }
        accepted = self.repository.save_target_plan(
            accepted, lambda conn: self.profile.assert_current(snapshot, connection=conn)
        )
        return {
            "ok": True,
            "current": True,
            "accepted": accepted,
            "targets": target,
            "profileRevision": snapshot.profile_revision,
        }
