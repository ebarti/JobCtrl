"""Model authority, immutable cohort binding, review and concurrency fences."""

from copy import deepcopy
import json
import sqlite3

import pytest

from tests.career_learning_fixture import JOB, DUPLICATE, MISSING, Model, compare_command, dependencies, seed
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.career_learning import CareerLearningService
from jobctrl.llm_lanes import current_llm_lane


@pytest.fixture
def conn(tmp_path):
    connection = seed(str(tmp_path / "jobctrl.db"))
    yield connection
    connection.close()


def service(conn, model=None, preflight=lambda: None):
    return CareerLearningService(conn, dependencies=dependencies(conn, model or Model(), preflight))


def chosen(service):
    cohort = service.execute(compare_command())["cohorts"][0]
    state = service.execute(
        {
            "action": "choose",
            "cohortId": cohort["cohortId"],
            "expectedRevision": cohort["revision"],
            "determinationId": cohort["determinationId"],
            "proposalId": "practice",
        }
    )
    return cohort, state["milestones"][0]


def test_dated_cohort_counts_identity_sources_minimization_and_cache(conn):
    model, preflights = Model(), []

    def preflight():
        assert current_llm_lane() == "profile"
        preflights.append(True)

    owner = service(conn, model, preflight)
    state = owner.execute(compare_command())
    cohort = state["cohorts"][0]
    snapshot = cohort["snapshot"]
    assert (snapshot["selectedCount"], snapshot["cohortSize"], snapshot["analyzedCount"]) == (4, 3, 1)
    assert snapshot["missingDescriptions"] == [MISSING]
    assert snapshot["duplicateSelections"] == [{"jobId": JOB, "count": 2}]
    assert snapshot["duplicateIdentities"] == [[JOB, DUPLICATE]]
    assert snapshot["confirmedEvidenceCount"] == snapshot["excludedEvidenceCount"] == 1
    assert {source["source_id"] for source in model.calls[0]["sources"]} == {"posting:" + JOB, "confirmed-incident"}
    assert "unconfirmed statement" not in json.dumps(model.calls)
    assert "Unproven declaration" not in json.dumps(model.calls)
    assert "Explore a future leadership" not in json.dumps(model.calls)
    assert state["milestones"] == []
    owner.execute(compare_command(cohortId=cohort["cohortId"], expectedRevision=1))
    assert len(model.calls) == len(preflights) == 1
    assert owner.execute()["cohorts"][0]["revision"] == 2


def test_preview_is_read_only_and_fences_changed_sources_before_spend(conn):
    model = Model()
    owner = service(conn, model)
    before = conn.total_changes
    preview = owner.execute({"action": "preview", "jobIds": [JOB, MISSING]})["preview"]
    assert preview["cohortSize"] == 2 and preview["missingDescriptions"] == [MISSING]
    assert conn.total_changes == before and not model.calls
    empty = owner.execute({"action": "preview", "jobIds": [MISSING]})["preview"]
    assert empty["analyzedCount"] == 0
    conn.execute("UPDATE candidate_profiles SET version=version+1")
    conn.commit()
    with pytest.raises(DeterminationFailure, match="sources_changed"):
        owner.execute(compare_command(jobIds=[JOB, MISSING], expectedSnapshotFingerprint=preview["fingerprint"]))
    assert not model.calls


def test_shared_generic_application_url_does_not_collapse_distinct_postings(conn):
    conn.execute("UPDATE jobs SET description='A different complete posting.' WHERE job_id=?", (DUPLICATE,))
    conn.commit()
    preview = service(conn).execute({"action": "preview", "jobIds": [JOB, DUPLICATE]})["preview"]
    assert preview["analyzedCount"] == 2
    assert preview["duplicateIdentities"] == []


def test_candidate_id_cannot_impersonate_an_omitted_posting_source(conn):
    conn.execute(
        "UPDATE candidate_profile_achievement_evidence SET evidence_id=? WHERE evidence_id='confirmed-incident'",
        ("posting:" + MISSING,),
    )
    conn.commit()
    model = Model()
    with pytest.raises(DeterminationFailure, match="duplicate_source_id"):
        service(conn, model).execute(compare_command())
    assert not model.calls


def test_milestone_display_and_updates_require_the_exact_recorded_proposal(conn):
    owner = service(conn)
    _cohort, milestone = chosen(owner)
    changed = {key: value for key, value in milestone.items() if key not in {"staleReasons", "history"}}
    changed["proposal"] = {**changed["proposal"], "action": "A substituted action with no accepted proposal"}
    conn.execute("UPDATE job_events SET payload_json=? WHERE entity_kind='career_milestone'", (json.dumps(changed),))
    conn.commit()
    with pytest.raises(DeterminationFailure, match="milestone_binding_invalid"):
        owner.execute()
    with pytest.raises(DeterminationFailure, match="milestone_binding_invalid"):
        owner.execute(
            {
                "action": "update",
                "milestoneId": milestone["milestoneId"],
                "expectedRevision": 1,
                "status": "planned",
                "completionEvidence": "",
            }
        )


def test_raw_evidence_ids_and_source_text_survive_and_ambiguous_ids_are_excluded(conn):
    raw_id = "confirmed-incident "
    conn.execute(
        "UPDATE candidate_profile_achievement_evidence SET evidence_id=?,source_text='  Exact source text  ' WHERE evidence_id='confirmed-incident'",
        (raw_id,),
    )
    conn.commit()
    state = service(conn).execute({"action": "preview", "jobIds": [JOB]})
    source = next(row for row in state["preview"]["sources"] if row["source_id"] == raw_id)
    assert json.loads(source["text"])["source_text"] == "  Exact source text  "
    conn.execute(
        "UPDATE candidate_profile_achievement_evidence SET evidence_id=? WHERE evidence_id='unconfirmed'", (raw_id,)
    )
    conn.commit()
    preview = service(conn).execute({"action": "preview", "jobIds": [JOB]})["preview"]
    assert preview["confirmedEvidenceCount"] == 0


def test_identical_sources_obey_opposite_valid_model_judgments():
    outcomes = []
    for capability in ("demonstrated", "not_evidenced"):
        conn = seed()
        try:
            state = service(conn, Model(capability=capability)).execute(compare_command())
            outcomes.append(state["cohorts"][0]["comparison"]["demands"][0]["capability"])
        finally:
            conn.close()
    assert outcomes == ["demonstrated", "not_evidenced"]


@pytest.mark.parametrize(
    "fault,code",
    [
        (lambda result: result.update(unexpected=True), "schema_violation"),
        (lambda result: result["demands"][0].update(capability="ready"), "schema_violation"),
        (lambda result: result["demands"][0]["mentions"][0].update(source_id="foreign"), "foreign_source_id"),
        (lambda result: result["demands"][0]["mentions"][0].update(quote="Not in this posting"), "non_verbatim_quote"),
        (lambda result: result["demands"][0]["mentions"][0].update(exact_values=["99"]), "mismatched_value"),
        (lambda result: result["demands"][0].update(evidence=[]), "missing_capability_evidence"),
        (
            lambda result: result["demands"][0]["evidence"][0].update(
                source_id="posting:" + JOB, quote="Synthetic role"
            ),
            "unconfirmed_evidence_id",
        ),
        (lambda result: result["proposals"][0].update(demand_id="foreign"), "foreign_demand_id"),
        (json.JSONDecodeError("synthetic", "", 0), "malformed_json"),
        (RuntimeError("provider secret must not escape"), "provider_error"),
    ],
)
def test_failed_refresh_preserves_accepted_comparison(conn, fault, code):
    owner = service(conn)
    cohort, milestone = chosen(owner)
    conn.execute("UPDATE jobs SET description=description || ' Changed.' WHERE job_id=?", (JOB,))
    conn.commit()
    failing = service(conn, Model(fault=fault))
    with pytest.raises(DeterminationFailure, match=code):
        failing.execute(compare_command(cohortId=cohort["cohortId"], expectedRevision=1))
    state = failing.execute()
    assert state["cohorts"][0]["determinationId"] == cohort["determinationId"]
    assert state["cohorts"][0]["lastAttempt"]["failureCode"] == code
    assert state["milestones"][0]["milestoneId"] == milestone["milestoneId"]


def test_preflight_and_missing_provider_have_no_fallback(conn):
    model = Model()

    def denied():
        raise RuntimeError("budget")

    with pytest.raises(DeterminationFailure, match="budget_denied"):
        service(conn, model, denied).execute(compare_command())
    assert not model.calls
    owner = CareerLearningService(conn, dependencies=dependencies(conn, None))
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        owner.execute(compare_command())
    assert owner.execute()["cohorts"] == []


def test_review_completion_history_and_profile_cohort_changes_do_not_confer_capability(conn):
    owner = service(conn)
    profile_before = [tuple(row) for row in conn.execute("SELECT * FROM candidate_profile_achievement_evidence")]
    cohort, milestone = chosen(owner)
    assert milestone["status"] == "planned"
    command = {
        "action": "update",
        "milestoneId": milestone["milestoneId"],
        "expectedRevision": 1,
        "status": "completed",
        "completionEvidence": "",
    }
    with pytest.raises(DeterminationFailure, match="completion_evidence_required"):
        owner.execute(command)
    state = owner.execute({**command, "completionEvidence": "Owned exercise report: local synthetic artifact"})
    assert [item["status"] for item in state["milestones"][0]["history"]] == ["completed", "planned"]
    assert state["cohorts"][0]["comparison"] == cohort["comparison"]
    assert [
        tuple(row) for row in conn.execute("SELECT * FROM candidate_profile_achievement_evidence")
    ] == profile_before
    conn.execute("UPDATE candidate_profiles SET version=version+1 WHERE tenant_id='local'")
    conn.commit()
    assert owner.execute()["cohorts"][0]["staleReasons"] == ["profile_changed"]
    owner.execute(
        compare_command(
            cohortId=cohort["cohortId"], expectedRevision=1, jobIds=[JOB], aspirations="A different aspiration"
        )
    )
    state = owner.execute()
    assert state["cohorts"][0]["aspirations"] == "A different aspiration"
    assert state["milestones"][0]["origin"]["aspirations"] == "Explore a future leadership role"
    assert set(state["milestones"][0]["staleReasons"]) == {"profile_changed", "cohort_changed"}
    assert state["milestones"][0]["status"] == "completed"


def test_revision_and_source_races_preserve_previous_acceptance(conn):
    owner = service(conn)
    cohort = owner.execute(compare_command())["cohorts"][0]
    with pytest.raises(DeterminationFailure, match="revision_conflict"):
        owner.execute(compare_command(cohortId=cohort["cohortId"], expectedRevision=0))
    database = conn.execute("PRAGMA database_list").fetchone()[2]

    def concurrent_save():
        other = sqlite3.connect(database)
        with other:
            other.execute("UPDATE candidate_profiles SET version=version+1 WHERE tenant_id='local'")
        other.close()

    # A changed as-of date requests a new input instead of reusing the accepted cache.
    with pytest.raises(DeterminationFailure, match="sources_changed"):
        service(conn, Model(callback=concurrent_save)).execute(
            compare_command(cohortId=cohort["cohortId"], expectedRevision=1, asOf="2026-10-17")
        )
    assert owner.execute()["cohorts"][0]["determinationId"] == cohort["determinationId"]


def test_cached_refresh_requires_a_new_explicit_choice_bound_to_its_cohort_revision(conn):
    owner = service(conn)
    cohort, original = chosen(owner)
    refreshed = owner.execute(compare_command(cohortId=cohort["cohortId"], expectedRevision=1))["cohorts"][0]
    assert refreshed["determinationId"] == cohort["determinationId"]
    command = {
        "action": "choose",
        "cohortId": cohort["cohortId"],
        "expectedRevision": 2,
        "determinationId": cohort["determinationId"],
        "proposalId": "practice",
    }
    first = owner.execute(command)
    second = owner.execute(command)
    assert len(first["milestones"]) == len(second["milestones"]) == 2
    assert {milestone["cohortRevision"] for milestone in second["milestones"]} == {1, 2}
    assert (
        next(milestone for milestone in second["milestones"] if milestone["milestoneId"] == original["milestoneId"])[
            "origin"
        ]["revision"]
        == 1
    )


def test_no_description_cross_tenant_binding_and_tampering_are_rejected(conn):
    with pytest.raises(DeterminationFailure, match="no_posting_descriptions"):
        service(conn).execute(compare_command(jobIds=[MISSING]))
    assert CareerLearningService(conn, tenant_id="foreign").execute()["cohorts"] == []
    owner = service(conn)
    cohort, milestone = chosen(owner)
    changed = deepcopy(cohort)
    changed.pop("lastAttempt")
    changed.pop("staleReasons")
    changed["asOf"] = "2026-10-17"
    conn.execute("UPDATE job_events SET payload_json=? WHERE entity_kind='career_cohort'", (json.dumps(changed),))
    conn.commit()
    with pytest.raises(DeterminationFailure, match="cohort_binding_invalid"):
        owner.execute()
    with pytest.raises(DeterminationFailure, match="revision_conflict"):
        owner.execute(
            {
                "action": "update",
                "milestoneId": milestone["milestoneId"],
                "expectedRevision": 2,
                "status": "planned",
                "completionEvidence": "",
            }
        )
