"""Bounded, saved-profile form mapping for the extension's sync RPC."""

import hashlib
import json
from jobctrl.domain.apply.form_mapping import FormQuestion, ModelFormMapper
from jobctrl.domain.determinations import Source, DeterminationFailure, parse_model_result
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.infrastructure.events import get_default_publisher
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository, determination_dependencies

# Canonical profile fields exposed by the paired extension capability. These
# are field IDs, not synonyms used to interpret a question.
FORM_FACT_FIELDS = {
    "personal": (
        "full_name",
        "preferred_name",
        "email",
        "phone",
        "address",
        "city",
        "province_state",
        "country",
        "postal_code",
        "linkedin_url",
        "github_url",
        "portfolio_url",
        "website_url",
    ),
    "work_authorization": ("legally_authorized_to_work", "require_sponsorship", "work_permit_type"),
    "compensation": ("salary_expectation", "salary_currency", "salary_range_min", "salary_range_max"),
    "availability": ("earliest_start_date", "available_for_full_time", "available_for_contract"),
    "eeo_voluntary": ("gender", "race_ethnicity", "veteran_status", "disability_status"),
}


def map_saved_profile_form(
    connection, *, tenant_id, snapshot_id, page_url, questions, expected_profile_version, dependencies=None
):
    snapshot = SqliteProfileRepository(connection, publisher=get_default_publisher()).load_snapshot(TenantId(tenant_id))
    if snapshot.version != expected_profile_version:
        raise DeterminationFailure("stale_profile_version")
    parsed = [parse_model_result(FormQuestion, row) for row in questions]
    profile = snapshot.as_dict()
    facts = []
    for section, keys in FORM_FACT_FIELDS.items():
        for key in keys:
            value = profile.get(section, {}).get(key)
            if value is None or value == "":
                continue
            text = str(value).lower() if isinstance(value, bool) else str(value)
            facts.append(Source(source_id=section + "." + key, text=text))
    entity = hashlib.sha256(json.dumps({"page": page_url, "questions": questions}, sort_keys=True).encode()).hexdigest()
    result, envelope = ModelFormMapper(
        **(dependencies or determination_dependencies(connection, tenant_id=tenant_id, lane="apply"))
    ).map(entity_id=entity, questions=parsed, facts=facts, page_url=page_url, profile_version=snapshot.version)
    if (
        SqliteProfileRepository(connection, publisher=get_default_publisher())
        .load_snapshot(TenantId(tenant_id))
        .version
        != snapshot.version
    ):
        raise DeterminationFailure("stale_profile_version")
    SqliteDeterminationRepository(connection).bind(
        tenant_id=tenant_id,
        entity_kind="form",
        entity_id=entity,
        entity_version=str(snapshot.version),
        determination_kind="form_mapping",
        determination_id=envelope.determination_id,
    )
    return {
        "ok": True,
        "snapshotId": snapshot_id,
        "profileVersion": snapshot.version,
        "determinationId": envelope.determination_id,
        "mappings": result.model_dump()["mappings"],
    }
