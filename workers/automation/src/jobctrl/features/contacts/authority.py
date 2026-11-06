"""Validate recorded research against the public model gateway receipt."""

from __future__ import annotations

import json


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def verify_record(model, record: dict | None, *, connection=None) -> tuple[bool, str | None]:
    if record is None:
        return False, "record_unavailable"
    if not isinstance(record, dict):
        return False, "record_invalid"
    if model is None:
        return False, "model_gateway_unavailable"
    if any(record.get(key) is None for key in ("instructions", "responseSchema", "context", "sources")):
        return False, "recorded_request_unavailable"
    provenance = record.get("provenance", {})
    if not isinstance(provenance, dict):
        return False, "receipt_binding_mismatch"
    identifier = record.get("determinationId")
    if not isinstance(identifier, str) or provenance.get("receipt_id") != identifier:
        return False, "receipt_binding_mismatch"
    try:
        receipt = model.receipt(identifier, connection=connection)
        keys = ("receipt_id", "provider", "model", "lane", "prompt_version", "input_fingerprint", "created_at")
        if (receipt.get("status") != "succeeded" or receipt.get("operation") != record.get("operation")
                or any(receipt.get(key) != provenance.get(key) for key in keys)):
            return False, "receipt_binding_mismatch"
        if _canonical(receipt.get("value")) != _canonical(record.get("value")):
            return False, "receipt_result_mismatch"
        expected = model.fingerprint(operation=record["operation"], instructions=record["instructions"],
                                     sources=record["sources"], response_schema=record["responseSchema"],
                                     context=record["context"], prompt_version=provenance["prompt_version"], lane=provenance["lane"],
                                     selection={"provider": provenance["provider"], "model": provenance["model"]})
        if expected != provenance.get("input_fingerprint"):
            return False, "receipt_input_mismatch"
    except Exception:
        return False, "receipt_unavailable"
    return True, None
