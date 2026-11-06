"""Canonical source serialization used in application-owned model bindings."""

import json


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
