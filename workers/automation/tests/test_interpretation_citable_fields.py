"""Only mechanically citable metadata enters the model's source catalog."""

from copy import deepcopy
import json

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.enrichment.interpretation import interpret_job, read_job_interpretation
from tests.test_remaining_determinations import Model, dependencies, interpretation, storage

JOB = {
    "job_id": "70000000-0000-4000-8000-000000000078",
    "title": "Synthetic manager",
    "company": "Synthetic employer",
    "location": "Synthetic place",
    "salary": "Synthetic stated amount",
    "full_description": "Synthetic complete posting with model-selected classification evidence.",
}


def request_sources(model):
    return {r["source_id"]: r["text"] for r in json.loads(model.calls[0][0][1].content)["sources"]}


def execute(conn, model, job, admissions=None):
    deps = dependencies(conn, model, "enrichment")
    if admissions is not None:
        deps["preflight"] = lambda: admissions.append(True)
    return interpret_job(conn, job, tenant_id="synthetic", dependencies=deps)


@pytest.mark.parametrize("key", ["title", "company", "location", "salary"])
@pytest.mark.parametrize("blank", [None, "", " \n\t", "\u00a0"])
def test_blank_metadata_is_not_advertised_as_a_citable_source(key, blank):
    model = Model(interpretation().model_dump())
    result, envelope = execute(storage(), model, {**JOB, key: blank})
    sources = request_sources(model)
    enum = model.calls[0][1]["response_schema"]["$defs"]["Citation"]["properties"]["source_id"]["enum"]
    assert "job:" + key not in sources and "job:" + key not in enum
    assert all(text.strip() for text in sources.values())
    assert result.work_model.value == "remote"  # The explicit model decision survives missing metadata.
    assert envelope.kind == "job_interpretation" and len(model.calls) == 1


@pytest.mark.parametrize("value", [0, "0", ' Synthetic "café"\nexact span '])
def test_nonblank_metadata_including_literal_zero_is_preserved_exactly(value):
    model = Model(interpretation().model_dump())
    execute(storage(), model, {**JOB, "salary": value})
    assert request_sources(model)["job:salary"] == str(value)


def test_unknown_is_model_selected_from_posting_context_and_warm_read_adds_no_calls():
    conn = storage()
    output = interpretation().model_dump()
    for key in ("track", "seniority", "occupation_family", "work_model"):
        output[key]["value"] = "unknown"
        output[key]["rationale"] = "Explicit synthetic unknown judgment from full posting context"
    model = Model(output)
    job = {**JOB, "location": None, "salary": None}
    admissions = []
    result, envelope = execute(conn, model, job, admissions)
    warm, cached = execute(conn, model, job, admissions)
    readback = read_job_interpretation(conn, job, tenant_id="synthetic")
    assert all(
        getattr(result, key).value == "unknown" for key in ("track", "seniority", "occupation_family", "work_model")
    )
    assert warm == result and cached.determination_id == readback[1].determination_id == envelope.determination_id
    assert len(model.calls) == len(admissions) == 1
    assert {"job:location", "job:salary"}.isdisjoint(request_sources(model))


@pytest.mark.parametrize(
    "fault,code", [("omitted_source", "foreign_source_id"), ("changed_quote", "non_verbatim_quote")]
)
def test_invalid_citation_remains_a_bounded_model_failure_without_substitution(fault, code):
    conn = storage()
    output = interpretation().model_dump()
    output["work_model"]["citations"] = [
        {
            "source_id": "job:salary" if fault == "omitted_source" else "posting",
            "quote": "Unobserved quote",
            "exact_values": [],
        }
    ]
    model = Model(output)
    admissions = []
    with pytest.raises(DeterminationFailure, match=code):
        execute(conn, model, {**JOB, "salary": None}, admissions)
    assert len(model.calls) == len(admissions) == 3
    assert (
        conn.execute("SELECT COUNT(*) FROM semantic_determinations WHERE kind='job_interpretation'").fetchone()[0] == 0
    )
    state = conn.execute(
        "SELECT state,failure_code FROM semantic_stage_states WHERE kind='job_interpretation'"
    ).fetchone()
    assert tuple(state) == ("blocked", code)


def test_failed_refresh_preserves_the_previous_accepted_interpretation_and_binding():
    conn = storage()
    model = Model(interpretation().model_dump())
    _, accepted = execute(conn, model, JOB)
    tables = ("semantic_determinations", "semantic_entity_bindings")
    before = {table: list(conn.execute("SELECT * FROM " + table)) for table in tables}
    output = deepcopy(model.output)
    output["work_model"]["citations"][0]["quote"] = "Unobserved quote"
    model.output = output
    with pytest.raises(DeterminationFailure, match="non_verbatim_quote"):
        execute(conn, model, {**JOB, "full_description": JOB["full_description"] + " New synthetic snapshot."})
    assert {table: list(conn.execute("SELECT * FROM " + table)) for table in tables} == before
    assert read_job_interpretation(conn, JOB, tenant_id="synthetic")[1].determination_id == accepted.determination_id


def test_fully_populated_request_keeps_its_existing_source_identity():
    import hashlib
    from jobctrl.domain.enrichment.interpretation import JobInterpretation
    from jobctrl.domain.job_snapshot import build_jd_snapshot

    model = Model(interpretation().model_dump())
    _, envelope = execute(storage(), model, JOB)
    sources = [{"source_id": "posting", "text": build_jd_snapshot(JOB)}] + [
        {"source_id": "job:" + key, "text": str(JOB.get(key) or "")}
        for key in ("title", "company", "location", "salary")
    ]
    schema = JobInterpretation.model_json_schema()
    schema["$defs"]["Citation"]["properties"]["source_id"]["enum"] = [r["source_id"] for r in sources]
    identity = {
        "kind": "job_interpretation",
        "schema_version": "1",
        "prompt_version": "job-interpretation-v1",
        "schema": schema,
        "provider": "fake",
        "model": "fake",
        "lane": "enrichment",
        "tenant_id": "synthetic",
        "entity_id": JOB["job_id"],
        "input": {"sources": sources, "context": {"requirement_ids": []}},
    }
    expected = hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    assert envelope.determination_id == envelope.input_fingerprint == expected
