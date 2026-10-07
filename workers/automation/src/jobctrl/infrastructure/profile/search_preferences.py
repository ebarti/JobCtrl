"""Version-fenced proposal and confirmation; reads never call a provider."""

import hashlib
import json
from jobctrl.domain.determinations import DeterminationFailure, Source, parse_model_result, validate_citations
from jobctrl.domain.profile.search_preferences import (
    ModelSearchPreferenceInterpreter,
    SearchPreferences,
    authored_search_sources,
)
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository, determination_dependencies


def preferences_version(search_cfg):
    value = {
        "sources": [source.model_dump() for source in authored_search_sources(search_cfg)],
        "profile_version": (search_cfg.get("confirmed_targets") or {}).get("profile_version"),
        "schema": "1",
        "prompt": "search-preferences-v1",
    }
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def read_search_preferences(conn, search_cfg, *, tenant_id="local", confirmed=False):
    kind = "confirmed_search_preferences" if confirmed else "search_preferences"
    version = preferences_version(search_cfg)
    row = conn.execute(
        "SELECT determination_id FROM semantic_entity_bindings WHERE tenant_id=? AND entity_kind=? AND entity_id='discovery:preferences' AND entity_version=? AND determination_kind='search_preferences'",
        (str(tenant_id), kind, version),
    ).fetchone()
    if row is None:
        return None
    envelope = SqliteDeterminationRepository(conn).find(str(tenant_id), row[0])
    if (
        envelope is None
        or envelope.kind != "search_preferences"
        or envelope.entity_id != "discovery:preferences"
        or envelope.schema_version != "1"
        or envelope.prompt_version != "search-preferences-v1"
    ):
        raise DeterminationFailure("cache_binding_invalid")
    result = parse_model_result(SearchPreferences, envelope.result)
    validate_citations(result, authored_search_sources(search_cfg))
    return result, envelope


def require_confirmed_search_preferences(conn, search_cfg, *, tenant_id="local"):
    accepted = read_search_preferences(conn, search_cfg, tenant_id=tenant_id, confirmed=True)
    if accepted is None:
        raise DeterminationFailure("preferences_confirmation_required")
    result, envelope = accepted
    return [Source(source_id="confirmed_search_preferences", text=result.model_dump_json())], {
        "profile_version": (search_cfg.get("confirmed_targets") or {}).get("profile_version"),
        "determination_id": envelope.determination_id,
        "interpretation": result.model_dump(),
        "exact_title_exclusions": list(search_cfg.get("exact_title_exclusions") or []),
    }


def prepare_search_preferences(conn, search_cfg, *, tenant_id="local", dependencies=None):
    dependencies = dependencies or determination_dependencies(conn, tenant_id=tenant_id, lane="profile")
    result, envelope = ModelSearchPreferenceInterpreter(**dependencies).interpret(search_cfg=search_cfg)
    SqliteDeterminationRepository(conn).bind(
        tenant_id=str(tenant_id),
        entity_kind="search_preferences",
        entity_id="discovery:preferences",
        entity_version=preferences_version(search_cfg),
        determination_kind="search_preferences",
        determination_id=envelope.determination_id,
    )
    conn.commit()
    return result, envelope


def confirm_search_preferences(conn, search_cfg, determination_id, *, tenant_id="local"):
    proposal = read_search_preferences(conn, search_cfg, tenant_id=tenant_id)
    if proposal is None or proposal[1].determination_id != determination_id:
        raise DeterminationFailure("stale_preferences_determination")
    SqliteDeterminationRepository(conn).bind(
        tenant_id=str(tenant_id),
        entity_kind="confirmed_search_preferences",
        entity_id="discovery:preferences",
        entity_version=preferences_version(search_cfg),
        determination_kind="search_preferences",
        determination_id=determination_id,
    )
    conn.commit()
    return proposal


def preferences_response(conn, search_cfg, *, tenant_id="local"):
    proposal = read_search_preferences(conn, search_cfg, tenant_id=tenant_id)
    accepted = read_search_preferences(conn, search_cfg, tenant_id=tenant_id, confirmed=True)
    selected = proposal or accepted
    awaiting = proposal is not None and (
        accepted is None or proposal[1].determination_id != accepted[1].determination_id
    )
    return {
        "ok": True,
        "profileVersion": (search_cfg.get("confirmed_targets") or {}).get("profile_version"),
        "inputVersion": preferences_version(search_cfg),
        "status": "pending_confirmation" if awaiting else "confirmed" if accepted else "missing",
        "determination": selected[1].model_dump() if selected else None,
    }
