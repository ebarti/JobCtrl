"""Authoritative repeat-application evidence and one-attempt confirmations.

Only canonical job identity and confirmed application facts participate in the
decision.  The evaluator is deterministic so the API can present the same
evidence that the worker re-checks while holding its apply-claim transaction.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any

LOCAL_TENANT = "local"

_RELATIONSHIP_RANK = {
    "canonical_job": 0,
    "canonical_identity": 1,
    "accepted_duplicate": 2,
    "same_employer_equivalent_role": 3,
}
_LEGAL_SUFFIXES = {
    "inc",
    "incorporated",
    "llc",
    "ltd",
    "limited",
    "corp",
    "corporation",
    "plc",
    "gmbh",
}
_ROLE_ALIASES = {
    "sr": "senior",
    "jr": "junior",
    "eng": "engineer",
    "engr": "engineer",
    "mgr": "manager",
    "dev": "developer",
    "ii": "2",
    "iii": "3",
    "iv": "4",
}
_PRESENTATION_ONLY_ROLE_TOKENS = {"remote", "hybrid", "onsite", "fulltime"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_repeat_application_tables(conn) -> list[str]:
    """Create the additive repeat-protection decision and audit tables."""

    table_names = [
        "application_repeat_overrides",
        "application_repeat_override_consumptions",
        "application_repeat_audit",
    ]
    if all(_table_exists(conn, table_name) for table_name in table_names):
        return table_names
    was_in_transaction = conn.in_transaction
    statements = (
        """
        CREATE TABLE IF NOT EXISTS application_repeat_overrides (
          tenant_id            TEXT NOT NULL DEFAULT 'local',
          override_id          TEXT NOT NULL,
          target_job_key       TEXT NOT NULL,
          prior_job_key        TEXT NOT NULL,
          relationship         TEXT NOT NULL,
          evidence_fingerprint TEXT NOT NULL,
          evidence_json        TEXT NOT NULL,
          reason               TEXT NOT NULL,
          confirmed_by         TEXT NOT NULL,
          confirmed_at         TEXT NOT NULL,
          PRIMARY KEY (tenant_id, override_id)
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_application_repeat_overrides_target
          ON application_repeat_overrides(tenant_id, target_job_key, confirmed_at DESC)
        """,
        """
        CREATE TABLE IF NOT EXISTS application_repeat_override_consumptions (
          tenant_id    TEXT NOT NULL DEFAULT 'local',
          override_id  TEXT NOT NULL,
          run_id       TEXT NOT NULL,
          consumed_at  TEXT NOT NULL,
          PRIMARY KEY (tenant_id, override_id),
          UNIQUE (tenant_id, run_id)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS application_repeat_audit (
          tenant_id            TEXT NOT NULL DEFAULT 'local',
          audit_id             TEXT NOT NULL,
          audit_key            TEXT NOT NULL,
          target_job_key       TEXT NOT NULL,
          action               TEXT NOT NULL,
          evidence_fingerprint TEXT NOT NULL,
          evidence_json        TEXT NOT NULL,
          override_id          TEXT,
          actor                TEXT NOT NULL,
          reason               TEXT,
          occurred_at          TEXT NOT NULL,
          PRIMARY KEY (tenant_id, audit_id),
          UNIQUE (tenant_id, audit_key)
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_application_repeat_audit_target
          ON application_repeat_audit(tenant_id, target_job_key, occurred_at DESC)
        """,
    )
    for statement in statements:
        conn.execute(statement)
    if not was_in_transaction:
        conn.commit()
    return table_names


def evaluate_repeat_application(
    conn,
    target_job_key: str,
    *,
    record_audit: bool = True,
    evaluated_at: str | None = None,
) -> dict[str, Any]:
    """Evaluate confirmed prior applications related to ``target_job_key``."""

    ensure_repeat_application_tables(conn)
    evaluated_at = evaluated_at or _utc_now()
    target = _job_identity(conn, target_job_key)
    if target is None:
        raise ValueError(f"job not found: {target_job_key}")

    matches = [
        match
        for fact in _confirmed_application_facts(conn)
        if (match := _relationship_match(conn, target, fact)) is not None
    ]
    matches.sort(key=_match_sort_key)
    if not matches:
        return {
            "status": "clear",
            "summary": "No confirmed prior application is related to this opening.",
            "evidenceFingerprint": None,
            "evaluatedAt": evaluated_at,
            "matches": [],
            "override": None,
            "auditTrail": _audit_trail(conn, target_job_key),
        }

    fingerprint = repeat_evidence_fingerprint(target_job_key, matches)
    override = _matching_override(conn, target_job_key, fingerprint)
    exact = any(match["relationship"] != "same_employer_equivalent_role" for match in matches)
    if override and override["consumedAt"] is None:
        status = "override_ready"
        summary = "A reasoned confirmation is recorded for one live attempt against this exact evidence."
    elif override:
        status = "override_consumed"
        summary = "The prior confirmation was already used; another live attempt requires a new confirmation."
    elif exact:
        status = "blocked"
        summary = "A confirmed application to this canonical opening blocks another live submission by default."
    else:
        status = "confirmation_required"
        summary = (
            "A confirmed application to the same employer and an equivalent role requires deliberate confirmation."
        )

    if record_audit and status in {"blocked", "confirmation_required"}:
        _insert_audit(
            conn,
            audit_key=f"assessment:{target_job_key}:{fingerprint}:{status}",
            target_job_key=target_job_key,
            action=status,
            evidence_fingerprint=fingerprint,
            evidence_json=_compact_json(matches),
            override_id=None,
            actor="system",
            reason=None,
            occurred_at=evaluated_at,
        )

    return {
        "status": status,
        "summary": summary,
        "evidenceFingerprint": fingerprint,
        "evaluatedAt": evaluated_at,
        "matches": matches,
        "override": override,
        "auditTrail": _audit_trail(conn, target_job_key),
    }


def consume_repeat_application_override(
    conn,
    assessment: dict[str, Any],
    *,
    target_job_key: str,
    run_id: str,
    consumed_at: str,
) -> str | None:
    """Consume a matching override in the caller's claim transaction."""

    if assessment["status"] == "clear":
        return None
    if assessment["status"] != "override_ready" or not assessment.get("override"):
        raise ValueError(f"repeat application protection refused: {assessment['status']}")
    override = assessment["override"]
    conn.execute(
        """
        INSERT INTO application_repeat_override_consumptions (
          tenant_id, override_id, run_id, consumed_at
        ) VALUES (?, ?, ?, ?)
        """,
        (LOCAL_TENANT, override["overrideId"], run_id, consumed_at),
    )
    _insert_audit(
        conn,
        audit_key=f"override_consumed:{override['overrideId']}",
        target_job_key=target_job_key,
        action="override_consumed",
        evidence_fingerprint=assessment["evidenceFingerprint"],
        evidence_json=_compact_json(assessment["matches"]),
        override_id=override["overrideId"],
        actor="worker",
        reason=override["reason"],
        occurred_at=consumed_at,
    )
    return str(override["overrideId"])


def repeat_evidence_fingerprint(
    target_job_key: str,
    matches: list[dict[str, Any]],
) -> str:
    canonical = {
        "targetJobKey": target_job_key,
        "matches": [
            {
                "relationship": match["relationship"],
                "reason": match["reason"],
                "priorApplication": {
                    "jobKey": match["priorApplication"]["jobKey"],
                    "title": match["priorApplication"]["title"],
                    "company": match["priorApplication"]["company"],
                    "applicationUrl": match["priorApplication"]["applicationUrl"],
                    "factKind": match["priorApplication"]["factKind"],
                    "factId": match["priorApplication"]["factId"],
                    "confirmedAt": match["priorApplication"]["confirmedAt"],
                },
                "identityEvidence": list(match["identityEvidence"]),
            }
            for match in sorted(matches, key=_match_sort_key)
        ],
    }
    return hashlib.sha256(_compact_json(canonical).encode("utf-8")).hexdigest()


def _match_sort_key(match: dict[str, Any]) -> tuple[int, bytes, bytes]:
    """Portable canonical order shared with the TypeScript API.

    UTF-8 byte order avoids locale, host, and runtime-specific collation.
    """

    prior = match["priorApplication"]
    return (
        _RELATIONSHIP_RANK[str(match["relationship"])],
        str(prior["jobKey"]).encode("utf-8"),
        str(prior["factId"]).encode("utf-8"),
    )


def normalize_employer(value: str | None) -> str:
    tokens = _normalize_tokens(value)
    while len(tokens) > 1 and tokens[-1] in _LEGAL_SUFFIXES:
        tokens.pop()
    return " ".join(tokens)


def normalize_role_title(value: str | None) -> str:
    return " ".join(
        _ROLE_ALIASES.get(token, token)
        for token in _normalize_tokens(value)
        if _ROLE_ALIASES.get(token, token) not in _PRESENTATION_ONLY_ROLE_TOKENS
    )


def _normalize_tokens(value: str | None) -> list[str]:
    normalized = unicodedata.normalize("NFKC", str(value or "")).lower().replace("&", " and ")
    return [token for token in re.sub(r"[^a-z0-9]+", " ", normalized).strip().split() if token]


def _job_identity(conn, job_key: str) -> dict[str, Any] | None:
    company_expression = "j.company"
    company_params: tuple[str, ...] = ()
    if _table_exists(conn, "job_list_projections"):
        company_expression = """
            COALESCE(
              NULLIF(j.company, ''),
              (SELECT jlp.employer
                 FROM job_list_projections jlp
                WHERE jlp.tenant_id = ? AND jlp.job_id = j.url
                LIMIT 1)
            )
        """
        company_params = (LOCAL_TENANT,)
    row = conn.execute(
        f"""
        SELECT j.url, j.title, {company_expression} AS company,
               COALESCE(
                 (SELECT je.application_url
                    FROM job_enrichments je
                   WHERE je.job_id = j.job_id AND je.tenant_id = ?
                   ORDER BY je.updated_at DESC LIMIT 1),
                 j.application_url,
                 j.url
               ) AS application_url
         FROM jobs j
         WHERE j.url = ?
        """,
        (*company_params, LOCAL_TENANT, job_key),
    ).fetchone()
    if row is None:
        return None
    return {
        "url": str(row["url"]),
        "title": str(row["title"] or ""),
        "company": str(row["company"] or ""),
        "application_url": str(row["application_url"]) if row["application_url"] else None,
    }


def _confirmed_application_facts(conn) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    if _table_exists(conn, "job_events"):
        for row in conn.execute(
            """
            SELECT job_url AS job_key,
                   CASE event_type
                     WHEN 'ApplicationSubmitted' THEN 'application_submitted'
                     ELSE 'application_manually_marked'
                   END AS fact_kind,
                   'event:' || event_id AS fact_id,
                   occurred_at AS confirmed_at,
                   CASE event_type WHEN 'ApplicationSubmitted' THEN 40 ELSE 30 END AS priority
              FROM job_events
             WHERE job_url IS NOT NULL
               AND event_type IN ('ApplicationSubmitted', 'ApplicationManuallyMarked')
            """
        ).fetchall():
            facts.append(dict(row))
    if _table_exists(conn, "application_outcomes"):
        for row in conn.execute(
            """
            SELECT job_key, 'applied_confirmation' AS fact_kind,
                   'outcome:' || outcome_id AS fact_id,
                   occurred_at AS confirmed_at, 20 AS priority
              FROM application_outcomes
             WHERE tenant_id = ? AND kind = 'applied_confirmation'
            """,
            (LOCAL_TENANT,),
        ).fetchall():
            facts.append(dict(row))
    for row in conn.execute(
        """
        SELECT url AS job_key, 'legacy_applied_status' AS fact_kind,
               'job:' || url AS fact_id,
               COALESCE(applied_at, discovered_at, '') AS confirmed_at,
               10 AS priority
          FROM jobs
         WHERE LOWER(COALESCE(apply_status, '')) = 'applied'
           AND COALESCE(applied_at, '') != ''
        """
    ).fetchall():
        facts.append(dict(row))

    best: dict[str, dict[str, Any]] = {}
    for fact in facts:
        job_key = str(fact["job_key"])
        current = best.get(job_key)
        if (
            current is None
            or int(fact["priority"]) > int(current["priority"])
            or (
                int(fact["priority"]) == int(current["priority"])
                and str(fact["confirmed_at"]) > str(current["confirmed_at"])
            )
        ):
            best[job_key] = fact
    return list(best.values())


def _relationship_match(
    conn,
    target: dict[str, Any],
    fact: dict[str, Any],
) -> dict[str, Any] | None:
    prior = _job_identity(conn, str(fact["job_key"]))
    if prior is None:
        return None
    relationship: str | None = None
    reason = ""
    evidence: list[str] = []
    if target["url"] == prior["url"]:
        relationship = "canonical_job"
        reason = "Both records resolve to the same canonical JobCtrl job."
        evidence = [f"job:{target['url']}"]
    elif canonical := _canonical_identity_relationship(conn, target["url"], prior["url"]):
        relationship = "canonical_identity"
        reason = "The canonical ATS identity matches the previously applied opening."
        evidence = canonical
    elif duplicate := _accepted_duplicate_relationship(conn, target["url"], prior["url"]):
        relationship = "accepted_duplicate"
        reason = "An accepted duplicate link connects this representation to the previously applied opening."
        evidence = duplicate
    elif _equivalent_employer_role(target, prior):
        relationship = "same_employer_equivalent_role"
        reason = "The employer identity matches exactly and the normalized role titles are materially equivalent."
        evidence = [
            f"employer:{normalize_employer(target['company'])}",
            f"role:{normalize_role_title(target['title'])}",
        ]
    if relationship is None:
        return None
    return {
        "relationship": relationship,
        "reason": reason,
        "priorApplication": {
            "jobKey": prior["url"],
            "title": prior["title"].strip() or "Untitled role",
            "company": prior["company"].strip() or "Unknown company",
            "applicationUrl": prior["application_url"],
            "factKind": str(fact["fact_kind"]),
            "factId": str(fact["fact_id"]),
            "confirmedAt": str(fact["confirmed_at"]),
        },
        "identityEvidence": evidence,
    }


def _canonical_identity_relationship(conn, target_job_key: str, prior_job_key: str) -> list[str] | None:
    if not _table_exists(conn, "job_canonical_identities"):
        return None
    rows = conn.execute(
        """
        SELECT j.url AS job_url, c.canonical_url, c.ats_kind,
               c.source_native_id
          FROM job_canonical_identities c
          JOIN jobs j
            ON j.tenant_id = c.tenant_id
           AND j.job_id = c.job_id
         WHERE c.tenant_id = ? AND j.url IN (?, ?)
        """,
        (LOCAL_TENANT, target_job_key, prior_job_key),
    ).fetchall()
    identities = {str(row["job_url"]): row for row in rows}
    target = identities.get(target_job_key)
    prior = identities.get(prior_job_key)
    if target is None or prior is None:
        return None
    if target["canonical_url"] and target["canonical_url"] == prior["canonical_url"]:
        return [f"canonical_url:{target['canonical_url']}"]
    if (
        target["ats_kind"]
        and target["ats_kind"] == prior["ats_kind"]
        and target["source_native_id"]
        and target["source_native_id"] == prior["source_native_id"]
    ):
        return [f"ats:{target['ats_kind']}", f"native_id:{target['source_native_id']}"]
    return None


def _accepted_duplicate_relationship(conn, target_job_key: str, prior_job_key: str) -> list[str] | None:
    if not _table_exists(conn, "job_duplicate_links"):
        return None
    target_aliases = _job_aliases(conn, target_job_key)
    prior_aliases = _job_aliases(conn, prior_job_key)
    rows = conn.execute(
        """
        SELECT surviving_job_id, superseded_job_or_observation_id, reason
          FROM job_duplicate_links WHERE tenant_id = ?
        """,
        (LOCAL_TENANT,),
    ).fetchall()
    for row in rows:
        survivor = str(row["surviving_job_id"])
        superseded = str(row["superseded_job_or_observation_id"])
        if (survivor in target_aliases and superseded in prior_aliases) or (
            survivor in prior_aliases and superseded in target_aliases
        ):
            return [
                f"survivor:{survivor}",
                f"superseded:{superseded}",
                f"link_reason:{row['reason']}",
            ]
    return None


def _job_aliases(conn, job_key: str) -> set[str]:
    aliases = {job_key}
    job = conn.execute(
        """
        SELECT job_id
        FROM jobs
        WHERE tenant_id = ? AND url = ?
        """,
        (LOCAL_TENANT, job_key),
    ).fetchone()
    if job is None:
        return aliases
    job_id = str(job["job_id"])
    aliases.add(job_id)
    if _table_exists(conn, "job_identity_aliases"):
        aliases.update(
            str(row["alias_value"])
            for row in conn.execute(
                """
                SELECT alias_value
                FROM job_identity_aliases
                WHERE tenant_id = ? AND job_id = ?
                """,
                (LOCAL_TENANT, job_id),
            ).fetchall()
        )
    if not _table_exists(conn, "job_source_observations"):
        return aliases
    rows = conn.execute(
        """
        SELECT source_observation_id, observed_url, normalized_observed_url
          FROM job_source_observations WHERE tenant_id = ? AND job_id = ?
        """,
        (LOCAL_TENANT, job_id),
    ).fetchall()
    for row in rows:
        aliases.update(str(value) for value in row if value)
    return aliases


def _equivalent_employer_role(target: dict[str, Any], prior: dict[str, Any]) -> bool:
    employer = normalize_employer(target["company"])
    if not employer or employer != normalize_employer(prior["company"]):
        return False
    target_role = normalize_role_title(target["title"])
    prior_role = normalize_role_title(prior["title"])
    if not target_role or not prior_role:
        return False
    return target_role == prior_role or sorted(target_role.split()) == sorted(prior_role.split())


def _matching_override(conn, target_job_key: str, fingerprint: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT o.override_id, o.target_job_key, o.prior_job_key,
               o.evidence_fingerprint, o.reason, o.confirmed_by, o.confirmed_at,
               c.consumed_at, c.run_id AS consumed_run_id
          FROM application_repeat_overrides o
          LEFT JOIN application_repeat_override_consumptions c
            ON c.tenant_id = o.tenant_id AND c.override_id = o.override_id
         WHERE o.tenant_id = ? AND o.target_job_key = ? AND o.evidence_fingerprint = ?
         ORDER BY o.confirmed_at DESC, o.override_id DESC LIMIT 1
        """,
        (LOCAL_TENANT, target_job_key, fingerprint),
    ).fetchone()
    if row is None:
        return None
    return {
        "overrideId": str(row["override_id"]),
        "targetJobKey": str(row["target_job_key"]),
        "priorJobKey": str(row["prior_job_key"]),
        "evidenceFingerprint": str(row["evidence_fingerprint"]),
        "reason": str(row["reason"]),
        "confirmedBy": str(row["confirmed_by"]),
        "confirmedAt": str(row["confirmed_at"]),
        "consumedAt": str(row["consumed_at"]) if row["consumed_at"] else None,
        "consumedRunId": str(row["consumed_run_id"]) if row["consumed_run_id"] else None,
    }


def _insert_audit(
    conn,
    *,
    audit_key: str,
    target_job_key: str,
    action: str,
    evidence_fingerprint: str,
    evidence_json: str,
    override_id: str | None,
    actor: str,
    reason: str | None,
    occurred_at: str,
) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO application_repeat_audit (
          tenant_id, audit_id, audit_key, target_job_key, action,
          evidence_fingerprint, evidence_json, override_id, actor, reason, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            LOCAL_TENANT,
            str(uuid.uuid4()),
            audit_key,
            target_job_key,
            action,
            evidence_fingerprint,
            evidence_json,
            override_id,
            actor,
            reason,
            occurred_at,
        ),
    )


def _audit_trail(conn, target_job_key: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT a.audit_id, a.target_job_key, a.action, a.evidence_fingerprint,
               a.evidence_json, a.override_id, o.prior_job_key,
               a.actor, a.reason, a.occurred_at
          FROM application_repeat_audit a
          LEFT JOIN application_repeat_overrides o
            ON o.tenant_id = a.tenant_id AND o.override_id = a.override_id
         WHERE a.tenant_id = ? AND a.target_job_key = ?
         ORDER BY a.occurred_at DESC, a.rowid DESC LIMIT 50
        """,
        (LOCAL_TENANT, target_job_key),
    ).fetchall()
    return [
        {
            "auditId": str(row["audit_id"]),
            "targetJobKey": str(row["target_job_key"]),
            "action": str(row["action"]),
            "evidenceFingerprint": str(row["evidence_fingerprint"]),
            "evidence": _parse_evidence_snapshot(row["evidence_json"]),
            "overrideId": str(row["override_id"]) if row["override_id"] else None,
            "priorJobKey": str(row["prior_job_key"]) if row["prior_job_key"] else None,
            "actor": str(row["actor"]),
            "reason": str(row["reason"]) if row["reason"] else None,
            "occurredAt": str(row["occurred_at"]),
        }
        for row in rows
    ]


def _parse_evidence_snapshot(value: Any) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _table_exists(conn, table_name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        is not None
    )


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
