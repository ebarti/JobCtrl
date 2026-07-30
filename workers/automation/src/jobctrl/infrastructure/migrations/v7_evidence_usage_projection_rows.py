"""Build deterministic v7 evidence-usage projection rows from canonical data."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

EVIDENCE_USAGE_PROJECTIONS_TABLE = "evidence_usage_projections"
EVIDENCE_USAGE_PROJECTIONS_COLUMNS = (
    "tenant_id",
    "projection_kind",
    "projection_id",
    "evidence_id",
    "skill_id",
    "requirement_id",
    "title",
    "payload_json",
    "last_updated_at",
)
_IDENTITY_ALIASES = frozenset({"jobKey", "job_key", "jobUrl", "job_url"})


class CandidateEvidenceUsageProjectionsError(RuntimeError):
    """Raised when v7 evidence-usage projections cannot be rebuilt safely."""


def _projection_rows(
    candidate: sqlite3.Connection,
    migration_at: str,
) -> tuple[tuple[object, ...], ...]:
    entries: dict[tuple[str, str], dict[str, Any]] = {}
    gaps: dict[tuple[str, str], dict[str, Any]] = {}
    skills_by_name: dict[tuple[str, str], list[dict[str, Any]]] = {}
    job_metadata = _job_metadata(candidate)

    _load_evidence_entries(candidate, entries)
    _load_skill_entries(candidate, entries, skills_by_name)
    _attach_resume_usages(candidate, entries, job_metadata)
    _attach_requirement_usages(candidate, entries, gaps, job_metadata)
    _attach_skill_coverage(candidate, entries, gaps, skills_by_name)

    output: list[tuple[object, ...]] = []
    for (tenant_id, projection_id), entry in sorted(entries.items()):
        _assert_payload_identity(entry)
        output.append(
            (
                tenant_id,
                "entry",
                projection_id,
                entry["evidenceId"],
                entry["skillId"],
                None,
                entry["title"],
                json.dumps(entry, ensure_ascii=False, sort_keys=True),
                migration_at,
            )
        )
    for (tenant_id, projection_id), gap in sorted(gaps.items()):
        _assert_payload_identity(gap)
        output.append(
            (
                tenant_id,
                "gap",
                projection_id,
                None,
                None,
                gap["requirementId"],
                gap["requirementText"],
                json.dumps(gap, ensure_ascii=False, sort_keys=True),
                migration_at,
            )
        )
    return tuple(output)


def _job_metadata(
    candidate: sqlite3.Connection,
) -> dict[tuple[str, str], tuple[str, str]]:
    metadata: dict[tuple[str, str], tuple[str, str]] = {}
    for tenant_id, job_id, title, company in candidate.execute(
        "SELECT tenant_id, job_id, title, company FROM jobs ORDER BY tenant_id, job_id"
    ).fetchall():
        tenant = _required_text(tenant_id, "job tenant_id")
        stable_job_id = _required_text(job_id, "job job_id")
        metadata[(tenant, stable_job_id)] = (
            _optional_text(title) or "Untitled",
            _optional_text(company) or "Unknown company",
        )
    return metadata


def _load_evidence_entries(
    candidate: sqlite3.Connection,
    entries: dict[tuple[str, str], dict[str, Any]],
) -> None:
    rows = candidate.execute(
        """
        SELECT evidence.tenant_id, evidence.evidence_id, evidence.source_text,
               evidence.scope, evidence.action, evidence.tools_json,
               evidence.metrics_json, evidence.outcome,
               evidence.evidence_strength, evidence.claim_confidence,
               evidence.user_confirmed, evidence.tags_json,
               experience.date_range
        FROM candidate_profile_achievement_evidence AS evidence
        LEFT JOIN candidate_profile_experience_entries AS experience
          ON experience.tenant_id = evidence.tenant_id
         AND experience.profile_id = evidence.profile_id
         AND experience.entry_id = evidence.entry_id
        WHERE evidence.profile_id = 'default'
          AND TRIM(evidence.evidence_id) != ''
        ORDER BY evidence.tenant_id, evidence.entry_id, evidence.evidence_index
        """
    ).fetchall()
    for row in rows:
        (
            tenant_id,
            evidence_id,
            source_text,
            scope,
            action,
            tools_json,
            metrics_json,
            outcome,
            evidence_strength,
            claim_confidence,
            user_confirmed,
            tags_json,
            date_range,
        ) = row
        tenant = _required_text(tenant_id, "evidence tenant_id")
        stable_evidence_id = _required_text(evidence_id, "evidence evidence_id")
        key = (tenant, stable_evidence_id)
        if key in entries:
            raise CandidateEvidenceUsageProjectionsError(
                "candidate evidence IDs must be unique per tenant"
            )
        title = _preview(
            _optional_text(action)
            or _optional_text(scope)
            or _optional_text(outcome)
            or _optional_text(source_text)
            or stable_evidence_id,
            140,
        )
        entries[key] = {
            "entryId": stable_evidence_id,
            "kind": "achievement_evidence",
            "evidenceId": stable_evidence_id,
            "skillId": None,
            "title": title,
            "story": {
                "scope": _text_or_empty(scope, "evidence scope"),
                "action": _text_or_empty(action, "evidence action"),
                "outcome": _text_or_empty(outcome, "evidence outcome"),
                "metrics": _json_text_array(metrics_json, "evidence metrics_json"),
            },
            "skills": _json_text_array(tools_json, "evidence tools_json"),
            "tags": _json_text_array(tags_json, "evidence tags_json"),
            "freshness": {
                "evidenceDateRange": _optional_text(date_range),
                "evidenceStrength": _optional_text(evidence_strength),
                "userConfirmed": bool(_integer(user_confirmed, "evidence user_confirmed")),
                "claimConfidence": _optional_number(
                    claim_confidence, "evidence claim_confidence"
                ),
                "lastUsedAt": None,
            },
            "resumeUsages": [],
            "requirementUsages": [],
            "coverageUsages": [],
            "gaps": [],
        }


def _load_skill_entries(
    candidate: sqlite3.Connection,
    entries: dict[tuple[str, str], dict[str, Any]],
    skills_by_name: dict[tuple[str, str], list[dict[str, Any]]],
) -> None:
    rows = candidate.execute(
        """
        SELECT skills.tenant_id, skills.category_id, skills.item_index,
               skills.item_text,
               COALESCE(NULLIF(categories.label, ''), skills.category_id)
        FROM candidate_profile_skill_items AS skills
        LEFT JOIN candidate_profile_skill_categories AS categories
          ON categories.tenant_id = skills.tenant_id
         AND categories.profile_id = skills.profile_id
         AND categories.category_id = skills.category_id
        WHERE skills.profile_id = 'default'
          AND TRIM(skills.item_text) != ''
        ORDER BY skills.tenant_id, categories.position_index, skills.item_index
        """
    ).fetchall()
    for tenant_id, category_id, item_index, item_text, label in rows:
        tenant = _required_text(tenant_id, "skill tenant_id")
        category = _required_text(category_id, "skill category_id")
        index = _nonnegative_integer(item_index, "skill item_index")
        skill_text = _required_text(item_text, "skill item_text")
        skill_id = f"skill:{category}:{index}"
        key = (tenant, skill_id)
        if key in entries:
            raise CandidateEvidenceUsageProjectionsError(
                "candidate evidence and skill projection IDs must be unique per tenant"
            )
        entry = {
            "entryId": skill_id,
            "kind": "skill",
            "evidenceId": None,
            "skillId": skill_id,
            "title": skill_text,
            "story": None,
            "skills": [skill_text],
            "tags": [_required_text(label, "skill label")] if label else [],
            "freshness": {
                "evidenceDateRange": None,
                "evidenceStrength": "declared",
                "userConfirmed": True,
                "claimConfidence": None,
                "lastUsedAt": None,
            },
            "resumeUsages": [],
            "requirementUsages": [],
            "coverageUsages": [],
            "gaps": [],
        }
        entries[key] = entry
        skills_by_name.setdefault((tenant, skill_text.lower()), []).append(entry)


def _attach_resume_usages(
    candidate: sqlite3.Connection,
    entries: dict[tuple[str, str], dict[str, Any]],
    job_metadata: dict[tuple[str, str], tuple[str, str]],
) -> None:
    rows = candidate.execute(
        """
        SELECT provenance.tenant_id, provenance.job_id, provenance.artifact_id,
               provenance.generation, provenance.bullet_id,
               provenance.generated_text, provenance.created_at,
               provenance.evidence_ids_json
        FROM job_bullet_provenance AS provenance
        WHERE NOT EXISTS (
            SELECT 1
            FROM jobctrl_deleted_jobs AS deleted
            WHERE deleted.tenant_id = provenance.tenant_id
              AND deleted.job_id = provenance.job_id
              AND (
                  deleted.restored_at IS NULL
                  OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
              )
        )
          AND NOT EXISTS (
            SELECT 1
            FROM jobctrl_hidden_jobs AS hidden
            WHERE hidden.tenant_id = provenance.tenant_id
              AND hidden.job_id = provenance.job_id
              AND hidden.unhidden_at IS NULL
        )
          AND provenance.generation = (
            SELECT MAX(latest.generation)
            FROM job_bullet_provenance AS latest
            WHERE latest.tenant_id = provenance.tenant_id
              AND latest.job_id = provenance.job_id
        )
        ORDER BY provenance.tenant_id, provenance.job_id,
                 provenance.position, provenance.bullet_id
        """
    ).fetchall()
    for row in rows:
        (
            tenant_id,
            job_id,
            artifact_id,
            generation,
            bullet_id,
            generated_text,
            created_at,
            evidence_ids_json,
        ) = row
        tenant, stable_job_id, title, employer = _job_root(
            tenant_id, job_id, job_metadata
        )
        usage = {
            "kind": "resume_bullet",
            "jobId": stable_job_id,
            "jobTitle": title,
            "employer": employer,
            "artifactId": _optional_text(artifact_id),
            "bulletId": _optional_text(bullet_id),
            "generation": _positive_integer(generation, "provenance generation"),
            "generatedTextPreview": _preview(
                _text_or_empty(generated_text, "provenance generated_text"), 240
            ),
            "scoreVersion": None,
            "requirementId": None,
            "requirementText": None,
            "requirementFitKind": None,
            "artifactCoverageState": None,
            "keyword": None,
            "coverageState": None,
            "occurredAt": _optional_text(created_at),
        }
        for evidence_id in _json_text_array(
            evidence_ids_json, "provenance evidence_ids_json"
        ):
            entry = entries.get((tenant, evidence_id))
            if entry is None:
                continue
            entry["resumeUsages"].append(usage)
            occurred_at = usage["occurredAt"]
            freshness = entry["freshness"]
            if occurred_at and (
                not freshness["lastUsedAt"]
                or str(occurred_at) > str(freshness["lastUsedAt"])
            ):
                freshness["lastUsedAt"] = occurred_at


def _attach_requirement_usages(
    candidate: sqlite3.Connection,
    entries: dict[tuple[str, str], dict[str, Any]],
    gaps: dict[tuple[str, str], dict[str, Any]],
    job_metadata: dict[tuple[str, str], tuple[str, str]],
) -> None:
    rows = candidate.execute(
        """
        SELECT items.tenant_id, items.job_id, items.score_version,
               items.requirement_id, items.requirement_text, items.tier,
               items.weight, items.fit_json, items.artifact_coverage_json
        FROM job_requirement_fit_items AS items
        WHERE NOT EXISTS (
            SELECT 1
            FROM jobctrl_deleted_jobs AS deleted
            WHERE deleted.tenant_id = items.tenant_id
              AND deleted.job_id = items.job_id
              AND (
                  deleted.restored_at IS NULL
                  OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
              )
        )
          AND NOT EXISTS (
            SELECT 1
            FROM jobctrl_hidden_jobs AS hidden
            WHERE hidden.tenant_id = items.tenant_id
              AND hidden.job_id = items.job_id
              AND hidden.unhidden_at IS NULL
        )
          AND items.score_version = (
            SELECT MAX(report.score_version)
            FROM job_requirement_fit_reports AS report
            WHERE report.tenant_id = items.tenant_id
              AND report.job_id = items.job_id
        )
        ORDER BY items.tenant_id, items.job_id,
                 items.position, items.requirement_id
        """
    ).fetchall()
    for row in rows:
        (
            tenant_id,
            job_id,
            score_version,
            requirement_id,
            requirement_text,
            tier,
            weight,
            fit_json,
            coverage_json,
        ) = row
        tenant, stable_job_id, title, employer = _job_root(
            tenant_id, job_id, job_metadata
        )
        stable_requirement_id = _required_text(
            requirement_id, "requirement requirement_id"
        )
        fit = _fit_to_read_model(_json_object(fit_json, "requirement fit_json"))
        fit_kind = str(fit["kind"])
        coverage = (
            _coverage_to_read_model(
                _json_object(coverage_json, "requirement artifact_coverage_json")
            )
            if coverage_json is not None and str(coverage_json).strip()
            else None
        )
        usage = {
            "kind": "requirement_fit",
            "jobId": stable_job_id,
            "jobTitle": title,
            "employer": employer,
            "artifactId": None,
            "bulletId": None,
            "generation": None,
            "generatedTextPreview": None,
            "scoreVersion": _positive_integer(
                score_version, "requirement score_version"
            ),
            "requirementId": stable_requirement_id,
            "requirementText": _required_text(
                requirement_text, "requirement requirement_text"
            ),
            "requirementFitKind": fit_kind,
            "artifactCoverageState": coverage["state"] if coverage else None,
            "keyword": None,
            "coverageState": None,
            "occurredAt": None,
        }
        for evidence_id in fit.get("evidenceIds", []):
            entry = entries.get((tenant, str(evidence_id)))
            if entry is not None:
                entry["requirementUsages"].append(usage)
        if fit_kind not in {"missing", "blocked", "transferable"}:
            continue
        projection_id = f"{stable_job_id}#{stable_requirement_id}"
        kind = {
            "missing": "missing_requirement",
            "blocked": "blocked_requirement",
            "transferable": "transferable_requirement",
        }[fit_kind]
        gap = {
            "gapId": projection_id,
            "kind": kind,
            "requirementId": stable_requirement_id,
            "requirementText": usage["requirementText"],
            "demandedSkill": None,
            "tier": _optional_text(tier),
            "weight": _number(weight, "requirement weight"),
            "fitKind": fit_kind,
            "reason": str(
                fit.get("reason")
                or fit.get("blocker")
                or fit.get("gap")
                or "Recorded requirement gap."
            ),
            "jobRefs": [usage],
        }
        key = (tenant, projection_id)
        if key in gaps:
            raise CandidateEvidenceUsageProjectionsError(
                "candidate requirement gap IDs must be unique per tenant"
            )
        gaps[key] = gap


def _attach_skill_coverage(
    candidate: sqlite3.Connection,
    entries: dict[tuple[str, str], dict[str, Any]],
    gaps: dict[tuple[str, str], dict[str, Any]],
    skills_by_name: dict[tuple[str, str], list[dict[str, Any]]],
) -> None:
    rows = candidate.execute(
        """
        SELECT tenant_id, job_id, job_title, job_employer, artifact_id,
               generation, coverage_audit_json, created_at
        FROM artifact_list_projections AS artifacts
        WHERE NOT EXISTS (
            SELECT 1
            FROM jobctrl_deleted_jobs AS deleted
            WHERE deleted.tenant_id = artifacts.tenant_id
              AND deleted.job_id = artifacts.job_id
              AND (
                  deleted.restored_at IS NULL
                  OR julianday(deleted.restored_at) <= julianday(deleted.deleted_at)
              )
        )
          AND NOT EXISTS (
            SELECT 1
            FROM jobctrl_hidden_jobs AS hidden
            WHERE hidden.tenant_id = artifacts.tenant_id
              AND hidden.job_id = artifacts.job_id
              AND hidden.unhidden_at IS NULL
        )
          AND artifacts.coverage_audit_json IS NOT NULL
          AND TRIM(artifacts.coverage_audit_json) != ''
        ORDER BY tenant_id, job_id, artifact_id
        """
    ).fetchall()
    for row in rows:
        (
            tenant_id,
            job_id,
            job_title,
            job_employer,
            artifact_id,
            generation,
            coverage_json,
            created_at,
        ) = row
        tenant = _required_text(tenant_id, "coverage tenant_id")
        stable_job_id = _required_text(job_id, "coverage job_id")
        coverage = _json_object(coverage_json, "coverage audit JSON")
        for state in ("covered", "declared"):
            for keyword in _string_values(coverage.get(state)):
                usage = _skill_usage(
                    stable_job_id=stable_job_id,
                    job_title=job_title,
                    job_employer=job_employer,
                    artifact_id=artifact_id,
                    generation=generation,
                    created_at=created_at,
                    keyword=keyword,
                    state=state,
                )
                for entry in skills_by_name.get((tenant, keyword.lower()), []):
                    entry["coverageUsages"].append(usage)
        for keyword in _string_values(coverage.get("missing")):
            usage = _skill_usage(
                stable_job_id=stable_job_id,
                job_title=job_title,
                job_employer=job_employer,
                artifact_id=artifact_id,
                generation=generation,
                created_at=created_at,
                keyword=keyword,
                state="missing",
            )
            projection_id = f"{stable_job_id}#skill#{keyword.lower()}"
            gap = {
                "gapId": projection_id,
                "kind": "missing_skill",
                "requirementId": None,
                "requirementText": keyword,
                "demandedSkill": keyword,
                "tier": None,
                "weight": None,
                "fitKind": None,
                "reason": (
                    "The generated coverage audit recorded this demanded skill "
                    "as missing from shipped materials."
                ),
                "jobRefs": [usage],
            }
            key = (tenant, projection_id)
            existing = gaps.get(key)
            if existing is None:
                gaps[key] = gap
            else:
                refs = existing["jobRefs"]
                if usage not in refs:
                    refs.append(usage)
                gap = existing
            for entry in skills_by_name.get((tenant, keyword.lower()), []):
                if gap not in entry["gaps"]:
                    entry["gaps"].append(gap)


def _skill_usage(
    *,
    stable_job_id: str,
    job_title: object,
    job_employer: object,
    artifact_id: object,
    generation: object,
    created_at: object,
    keyword: str,
    state: str,
) -> dict[str, object]:
    return {
        "kind": "skill_coverage",
        "jobId": stable_job_id,
        "jobTitle": _optional_text(job_title),
        "employer": _optional_text(job_employer),
        "artifactId": _optional_text(artifact_id),
        "bulletId": None,
        "generation": (
            _positive_integer(generation, "coverage generation")
            if generation is not None
            else None
        ),
        "generatedTextPreview": None,
        "scoreVersion": None,
        "requirementId": None,
        "requirementText": None,
        "requirementFitKind": None,
        "artifactCoverageState": None,
        "keyword": keyword,
        "coverageState": state,
        "occurredAt": _optional_text(created_at),
    }


def _fit_to_read_model(value: dict[str, Any]) -> dict[str, Any]:
    kind = str(value.get("kind") or "not_assessed")
    if kind == "matched":
        return {
            "kind": kind,
            "evidenceIds": _string_values(
                value.get("evidence_ids") or value.get("evidenceIds")
            ),
            "strength": str(value.get("strength") or "direct"),
        }
    if kind == "transferable":
        return {
            "kind": kind,
            "evidenceIds": _string_values(
                value.get("evidence_ids") or value.get("evidenceIds")
            ),
            "gap": str(value.get("gap") or ""),
            "bridge": str(value.get("bridge") or ""),
        }
    if kind == "missing":
        return {"kind": kind, "reason": str(value.get("reason") or "")}
    if kind == "blocked":
        return {"kind": kind, "blocker": str(value.get("blocker") or "")}
    return {"kind": "not_assessed", "reason": str(value.get("reason") or "")}


def _coverage_to_read_model(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": str(value.get("state") or "not_recorded"),
        "source": str(
            value.get("source") or "tailored_resume_bullet_provenance"
        ),
        "bulletCount": int(
            value.get("bullet_count") or value.get("bulletCount") or 0
        ),
        "examples": _string_values(value.get("examples")),
    }


def _job_root(
    tenant_id: object,
    job_id: object,
    metadata: dict[tuple[str, str], tuple[str, str]],
) -> tuple[str, str, str, str]:
    tenant = _required_text(tenant_id, "job reference tenant_id")
    stable_job_id = _required_text(job_id, "job reference job_id")
    value = metadata.get((tenant, stable_job_id))
    if value is None:
        raise CandidateEvidenceUsageProjectionsError(
            "candidate evidence usage references a missing job root"
        )
    return tenant, stable_job_id, value[0], value[1]


def _assert_payload_identity(value: object) -> None:
    if isinstance(value, list):
        for item in value:
            _assert_payload_identity(item)
        return
    if not isinstance(value, dict):
        return
    for key, nested in value.items():
        if key in _IDENTITY_ALIASES:
            raise CandidateEvidenceUsageProjectionsError(
                "evidence usage payload contains a legacy job identity alias"
            )
        _assert_payload_identity(nested)


def _json_text_array(value: object, label: str) -> list[str]:
    parsed = _json_value(value, label)
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}")
    return list(parsed)


def _json_object(value: object, label: str) -> dict[str, Any]:
    parsed = _json_value(value, label)
    if not isinstance(parsed, dict):
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}")
    return parsed


def _json_value(value: object, label: str) -> object:
    if not isinstance(value, str):
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}")
    try:
        return json.loads(value, parse_constant=_reject_non_json_constant)
    except (json.JSONDecodeError, ValueError) as error:
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}") from error


def _reject_non_json_constant(value: str) -> None:
    raise ValueError(f"non-JSON constant: {value}")


def _string_values(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        text = item.strip()
        key = text.lower()
        if text and key not in seen:
            seen.add(key)
            result.append(text)
    return result


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}")
    return value


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise CandidateEvidenceUsageProjectionsError("malformed optional text")
    return value if value else None


def _text_or_empty(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}")
    return value


def _integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}")
    return value


def _positive_integer(value: object, label: str) -> int:
    number = _integer(value, label)
    if number < 1:
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}")
    return number


def _nonnegative_integer(value: object, label: str) -> int:
    number = _integer(value, label)
    if number < 0:
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}")
    return number


def _number(value: object, label: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CandidateEvidenceUsageProjectionsError(f"malformed {label}")
    return value


def _optional_number(value: object, label: str) -> int | float | None:
    if value is None:
        return None
    return _number(value, label)


def _preview(value: str, limit: int) -> str:
    return value if len(value) <= limit else f"{value[:limit]}..."


__all__ = [
    "CandidateEvidenceUsageProjectionsError",
    "EVIDENCE_USAGE_PROJECTIONS_COLUMNS",
    "EVIDENCE_USAGE_PROJECTIONS_TABLE",
]
