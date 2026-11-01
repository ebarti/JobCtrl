"""Explicit current evidence for synthetic fixtures testing other owners.

Availability acquisition tests do not use this helper: they exercise the real
claims, transport and classifier. These preparation/apply fixtures declare an
already verified posting so their provider and ownership assertions stay local.
"""
from datetime import datetime, timedelta, timezone
import hashlib

from jobctrl.domain.tenant import TenantId
from jobctrl.state import record_job_event


def seed_fresh_availability(conn, job_id: str, tenant_id: str = "local") -> None:
    row = conn.execute("SELECT url FROM jobs WHERE tenant_id = ? AND job_id = ?", (str(tenant_id), str(job_id))).fetchone()
    if row is None:
        raise AssertionError("availability fixture requires a saved synthetic job")
    now = datetime.now(timezone.utc)
    value = {"jobId": str(job_id), "postingUrl": row[0], "verdict": "active", "reason": "synthetic_fixture",
             "method": "fixture", "lastAttemptedAt": now.isoformat(), "lastSuccessfullyVerifiedAt": now.isoformat(),
             "lastSuccessfulState": "active", "lastSuccessfulEvidenceRef": "fixture:availability",
             "evidenceRef": "fixture:availability", "nextDueAt": (now + timedelta(hours=24)).isoformat(),
             "lineage": [{"sourceUrl": row[0], "finalUrl": row[0], "status": 200, "method": "fixture",
                          "rawHash": hashlib.sha256(b"synthetic current posting").hexdigest()}]}
    record_job_event(conn, job_id, "enrich", "JobAvailabilityObserved", tenant_id=TenantId(str(tenant_id)),
                     entity_kind="posting_availability", entity_ref=str(job_id), payload=value)
