"""Canonical posting text and hashing, shared without cross-context use cases."""

import hashlib
from collections.abc import Mapping
from typing import Any


def build_jd_snapshot(job: Mapping[str, Any]) -> str:
    fields = ("title", "company", "location", "salary", "remote")
    metadata = [f"{field}:\n{str(job[field] if job.get(field) is not None else '').strip()}" for field in fields]
    description = str(job.get("full_description") or job.get("description") or "").strip()
    return "\n\n".join([*metadata, "description:\n" + description])


def compute_snapshot_hash(snapshot: str) -> str:
    return hashlib.sha256(snapshot.encode("utf-8")).hexdigest()
