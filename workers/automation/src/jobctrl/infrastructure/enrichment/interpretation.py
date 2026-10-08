"""Persist job interpretation against the full canonical snapshot and requirement IDs."""

from jobctrl.domain.determinations import Source
from jobctrl.domain.enrichment.interpretation import JobInterpretation, ModelJobInterpreter
from jobctrl.domain.job_snapshot import build_jd_snapshot, compute_snapshot_hash
from jobctrl.infrastructure.determinations import determination_dependencies


def interpret_job(conn, job, *, requirements=(), tenant_id="local", dependencies=None, bind=True):
    dependencies = dependencies or determination_dependencies(conn, tenant_id=tenant_id, lane="enrichment")
    snapshot = build_jd_snapshot(job)
    version = compute_snapshot_hash(snapshot)
    fields = [
        Source(source_id=f"job:{key}", text=str(job.get(key) or ""))
        for key in ("title", "company", "location", "salary")
    ]
    service = ModelJobInterpreter(**dependencies)
    result, envelope = service.interpret(
        entity_id=str(job["job_id"]),
        posting=Source(source_id="posting", text=snapshot),
        fields=fields,
        requirements=list(requirements),
    )
    result._determination_id = envelope.determination_id
    if bind:
        dependencies["repository"].bind(
            tenant_id=str(tenant_id),
            entity_kind="job",
            entity_id=str(job["job_id"]),
            entity_version=version,
            determination_kind="job_interpretation",
            determination_id=envelope.determination_id,
        )
    return result, envelope


def read_job_interpretation(conn, job, *, tenant_id="local"):
    version = compute_snapshot_hash(build_jd_snapshot(job))
    row = conn.execute(
        "SELECT d.envelope_json FROM semantic_entity_bindings b JOIN semantic_determinations d ON d.tenant_id=b.tenant_id AND d.determination_id=b.determination_id WHERE b.tenant_id=? AND b.entity_kind='job' AND b.entity_id=? AND b.entity_version=? AND b.determination_kind='job_interpretation'",
        (str(tenant_id), str(job["job_id"]), version),
    ).fetchone()
    if row is None:
        return None
    from jobctrl.domain.determinations import DeterminationEnvelope, DeterminationFailure, parse_model_result

    try:
        envelope = DeterminationEnvelope.model_validate_json(row[0])
    except ValueError:
        raise DeterminationFailure("schema_violation") from None
    if (
        envelope.tenant_id != str(tenant_id)
        or envelope.entity_id != str(job["job_id"])
        or envelope.kind != "job_interpretation"
        or envelope.schema_version != "1"
        or envelope.prompt_version != "job-interpretation-v1"
        or envelope.lane != "enrichment"
        or envelope.determination_id != envelope.input_fingerprint
    ):
        raise DeterminationFailure("cache_binding_invalid")
    result = parse_model_result(JobInterpretation, envelope.result)
    result._determination_id = envelope.determination_id
    return result, envelope


class PersistedJobInterpreter:
    def __init__(self, conn, *, tenant_id="local", dependencies=None):
        self._conn, self._tenant_id, self._dependencies = conn, tenant_id, dependencies

    def interpret(self, *, job, employer_analysis):
        sources = [Source(source_id=row.id, text=row.evidence_span) for row in employer_analysis.canonical.requirements]
        result, _ = interpret_job(
            self._conn,
            job,
            requirements=sources,
            tenant_id=self._tenant_id,
            dependencies=self._dependencies,
            bind=True,
        )
        return result
