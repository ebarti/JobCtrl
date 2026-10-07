"""Configured Enrichment lane wiring for page determinations."""

from jobctrl.domain.enrichment.page_interpretation import ModelPageInterpreter
from jobctrl.infrastructure.determinations import determination_dependencies


def build_page_interpreter(connection=None, *, tenant_id="local"):
    if connection is None:
        from jobctrl.database import get_connection

        connection = get_connection()
    return ModelPageInterpreter(**determination_dependencies(connection, tenant_id=tenant_id, lane="enrichment"))


def judge_description_quality(*, connection, tenant_id, tier, description, apply_url_present):
    from jobctrl.domain.enrichment.snapshot_value_objects import SnapshotConfidence

    result, envelope = build_page_interpreter(connection, tenant_id=tenant_id).description_quality(
        text=description.text, metadata={"extraction_tier": tier.value, "apply_url_present": apply_url_present}
    )
    return SnapshotConfidence(result.confidence), envelope
