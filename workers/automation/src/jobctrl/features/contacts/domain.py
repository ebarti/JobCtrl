"""Contact facts and their provenance. No HTTP, database or Outreach dependency."""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from uuid import UUID, uuid4

ROLES = frozenset({"recruiter", "hiring_manager", "referrer", "warm_intro", "other"})
KINDS = frozenset({"name", "title", "email", "phone", "profile_url", "note"})


class InvalidContact(ValueError):
    pass


class StaleContact(ValueError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid4())


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def text(value: object, *, limit: int, required: bool = False) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise InvalidContact("A text field has an invalid value.")
    result = value.strip()
    if len(result) > limit or (required and not result):
        raise InvalidContact("A text field is empty or exceeds its allowed length.")
    return result


def job_id(value: object) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise InvalidContact("jobId must be a canonical UUID.")
    try:
        canonical = str(UUID(value))
    except ValueError:
        raise InvalidContact("jobId must be a canonical UUID.") from None
    if value != canonical:
        raise InvalidContact("jobId must be a canonical UUID.")
    return canonical


def role(value: object = "other") -> str:
    if not isinstance(value, str) or value not in ROLES:
        raise InvalidContact("The contact role is unsupported.")
    return value


def provenance(source_ref: str = "user_entered", *, source_kind: str = "user_entered", confirmed: bool = True,
               confidence: float = 1.0, captured_at: str | None = None, method: str = "manual") -> dict:
    return {"sourceKind": source_kind, "sourceRef": source_ref, "captureMethod": method,
            "capturedAt": captured_at or now(), "confidence": confidence, "userConfirmed": confirmed}


def attributes(inputs: object, *, source: dict, existing: list[dict] | None = None) -> list[dict]:
    if not isinstance(inputs, list) or len(inputs) > 50:
        raise InvalidContact("A contact can contain at most 50 facts.")
    current = {fact["attributeId"]: fact for fact in (existing or [])}
    specified: set[str] = set()
    for item in inputs:
        if not isinstance(item, dict) or set(item) - {"attributeId", "kind", "value"}:
            raise InvalidContact("The contact fact structure is invalid.")
        identifier = item.get("attributeId")
        if identifier is not None:
            if not isinstance(identifier, str) or identifier not in current or identifier in specified:
                raise InvalidContact("Contact fact identity is invalid or repeated.")
            specified.add(identifier)
    unused = [item for item in (existing or []) if item["attributeId"] not in specified]
    result = []
    for item in inputs:
        kind, value = item.get("kind"), item.get("value")
        if not isinstance(kind, str) or not isinstance(value, str):
            raise InvalidContact("A contact fact requires a kind and text value.")
        kept = current.get(item.get("attributeId"))
        if kept is None:
            kept = next((fact for fact in unused if fact["kind"] == kind and fact["value"] in {value, value.strip()}), None)
            if kept:
                unused.remove(kept)
        if kept and kept["kind"] == kind and kept["value"] in {value, value.strip()}:
            # Preserve even old unsupported kinds and values beyond today's input
            # limits when their saved identity and value are unchanged.
            result.append(copy.deepcopy(kept))
        else:
            if kind not in KINDS:
                raise InvalidContact("New facts must use a supported kind.")
            result.append({"attributeId": new_id(), "kind": kind,
                           "value": text(value, limit=2000, required=True), "provenance": copy.deepcopy(source)})
    return result


def create_record(payload: dict, *, source: dict | None = None) -> dict:
    if set(payload) - {"employer", "jobId", "role", "attributes"}:
        raise InvalidContact("The contact contains unsupported fields.")
    employer = text(payload.get("employer"), limit=200) or None
    linked_job = job_id(payload.get("jobId"))
    if not employer and not linked_job:
        raise InvalidContact("A contact must link to at least one of employer or jobId.")
    timestamp = now()
    return {"contactId": new_id(), "revision": 1, "role": role(payload.get("role", "other")),
            "employer": employer, "jobId": linked_job,
            "attributes": attributes(payload.get("attributes", []), source=source or provenance(captured_at=timestamp)),
            "createdAt": timestamp, "updatedAt": timestamp, "deletedAt": None}


def revise_record(current: dict, payload: dict) -> dict:
    if set(payload) - {"expectedFingerprint", "employer", "jobId", "role", "attributes"}:
        raise InvalidContact("The contact contains unsupported fields.")
    if payload.get("expectedFingerprint") != fingerprint(current):
        raise StaleContact("This contact changed. Review the latest contact before retrying your draft.")
    result = copy.deepcopy(current)
    if "employer" in payload:
        result["employer"] = text(payload["employer"], limit=200) or None
    if "jobId" in payload:
        result["jobId"] = job_id(payload["jobId"])
    if not result["employer"] and not result["jobId"]:
        raise InvalidContact("A contact must link to an employer or job.")
    if "role" in payload:
        result["role"] = role(payload["role"])
    if "attributes" in payload:
        result["attributes"] = attributes(payload["attributes"], source=provenance(), existing=current["attributes"])
    result["updatedAt"] = now()
    result["revision"] += 1
    return result


def detail(record: dict) -> dict:
    result = copy.deepcopy(record)
    result["fingerprint"] = fingerprint(record)
    result["displayName"] = next((fact["value"].strip() for fact in result["attributes"] if fact["kind"] == "name"), "")
    result.pop("deletedAt", None)
    return result


def summary(record: dict) -> dict:
    result = detail(record)
    facts = result.pop("attributes")
    return {**result, "attributeCount": len(facts), "confirmedCount": sum(fact["provenance"]["userConfirmed"] for fact in facts),
            "sourceKinds": sorted({fact["provenance"]["sourceKind"] for fact in facts}),
            "allConfirmed": all(fact["provenance"]["userConfirmed"] for fact in facts)}


def identifiers(record: dict) -> set[tuple[str, str]]:
    """Literal contact identifiers only; never infer person identity from names."""
    result = set()
    for fact in record["attributes"]:
        if fact["kind"] == "email":
            result.add(("email", fact["value"].strip().casefold()))
        elif fact["kind"] == "phone":
            digits = "".join(character for character in fact["value"] if character in "0123456789")
            if len(digits) >= 7:
                result.add(("phone", digits))
    return result


def normalized_record(record: dict) -> tuple:
    def normalize(value):
        return " ".join((value or "").casefold().split())

    return (normalize(record.get("employer")), record.get("jobId"), record["role"],
            tuple(sorted((fact["kind"], normalize(fact["value"])) for fact in record["attributes"])))
