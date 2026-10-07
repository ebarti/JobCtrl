"""Activity-only query planning; config and API reads perform no inference."""

from jobctrl.domain.discovery.query_plan import ModelDiscoveryQueryPlanner
from jobctrl.infrastructure.determinations import determination_dependencies
from jobctrl.infrastructure.discovery.triage import fingerprint


def prepare_query_plan(conn, search_cfg, *, tenant_id="local", dependencies=None):
    dependencies = dependencies or determination_dependencies(
        conn, tenant_id=tenant_id, lane="discovery", model_spec=search_cfg.get("triage_model")
    )
    from jobctrl.infrastructure.profile.search_preferences import require_confirmed_search_preferences

    targets, preferences = require_confirmed_search_preferences(conn, search_cfg, tenant_id=tenant_id)
    planner = ModelDiscoveryQueryPlanner(**{key: value for key, value in dependencies.items() if key != "lane"})
    result, envelope = planner.plan(targets=targets, preferences=preferences)
    dependencies["repository"].bind(
        tenant_id=tenant_id,
        entity_kind="discovery",
        entity_id="query-plan",
        entity_version=fingerprint({"targets": [row.model_dump() for row in targets], "preferences": preferences}),
        determination_kind="discovery_query_plan",
        determination_id=envelope.determination_id,
    )
    conn.commit()
    return {
        **search_cfg,
        "queries": [row.model_dump() for row in result.queries],
        "locations": [row.model_dump() for row in result.locations],
        "query_plan_determination_id": envelope.determination_id,
    }
