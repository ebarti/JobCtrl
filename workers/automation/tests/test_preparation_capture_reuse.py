"""Preparation reuses only current, owned, source-bound captured posting facts."""

from dataclasses import replace
from datetime import timedelta
import json

import pytest

from jobctrl.domain.errors import SourceUnavailableError
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment import availability, detail
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.enrichment.sqlite_repository import SqlitePostingSnapshotSetRepository
from tests.page_fakes import PageModel
from tests.test_saved_posting_availability import JOB_ID, NOW, URL, saved_job as _saved_job

saved_job = _saved_job
DESCRIPTION = "Own synthetic platform development and lead a delivery team. " * 20


@pytest.fixture
def capture(saved_job, monkeypatch):
    model = PageModel()
    monkeypatch.setattr(
        "jobctrl.infrastructure.enrichment.page_interpretation.determination_dependencies",
        lambda conn, **_: dict(
            llm=model,
            repository=SqliteDeterminationRepository(conn),
            tenant_id="local",
            provider="synthetic",
            model="synthetic",
            lane="enrichment",
            preflight=lambda: None,
        ),
    )
    monkeypatch.setattr(availability, "_now", lambda: NOW + timedelta(minutes=1))

    def record(*, verdict="active", quality="high", captured_at=NOW, job_id=JOB_ID, url=URL):
        model.availability, model.quality = verdict, quality
        saved_job.execute(
            "INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description, updated_at) "
            "VALUES ('local', ?, 'enriched', ?, ?) "
            "ON CONFLICT(tenant_id, job_id) DO UPDATE SET full_description=excluded.full_description",
            (job_id, DESCRIPTION, captured_at.isoformat()),
        )
        saved_job.commit()
        detail._record_posting_snapshot_from_cascade(
            saved_job,
            job_id=job_id,
            url=url,
            source_id="synthetic",
            title="Synthetic role",
            cascade_result={"full_description": DESCRIPTION, "tier_used": 1, "application_url": url + "/apply"},
            captured_at=captured_at.isoformat(),
        )
        return model

    return record


def require(conn, **kwargs):
    availability.require_preparation_available(JOB_ID, conn=conn, expected_posting_url=URL, **kwargs)


def disallow_refresh(monkeypatch):
    monkeypatch.setattr(
        availability,
        "check_availability",
        lambda *_a, **_kw: pytest.fail("a current accepted capture must not reacquire the posting"),
    )


@pytest.mark.parametrize("verdict", ["active", "unknown"])
@pytest.mark.parametrize("quality", ["high", "medium"])
def test_preparation_reuses_fresh_capture_without_new_calls_or_observations(
    saved_job, capture, monkeypatch, verdict, quality
):
    model = capture(verdict=verdict, quality=quality)
    before = saved_job.execute("SELECT COUNT(*) FROM job_events").fetchone()[0]
    calls = len(model.calls)
    disallow_refresh(monkeypatch)
    for _ in range(3):
        require(saved_job)
    assert len(model.calls) == calls
    assert saved_job.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == before
    assert "verdict" not in availability.read_availability(saved_job, JOB_ID)
    assert not availability.fresh_active(saved_job, JOB_ID, max_age=timedelta(minutes=15))
    assert not saved_job.in_transaction


@pytest.mark.parametrize("age", [timedelta(hours=6, seconds=1), timedelta(seconds=-1)])
def test_stale_or_future_capture_uses_existing_refresh(saved_job, capture, monkeypatch, age):
    capture(captured_at=NOW + timedelta(minutes=1) - age)
    refreshes = []
    monkeypatch.setattr(availability, "require_fresh_active", lambda *a, **kw: refreshes.append(kw))
    require(saved_job)
    assert len(refreshes) == 1
    assert refreshes[0]["allow_unknown"] is True


def test_six_hour_boundary_reuses_actual_capture_time(saved_job, capture, monkeypatch):
    capture(captured_at=NOW + timedelta(minutes=1) - timedelta(hours=6))
    disallow_refresh(monkeypatch)
    require(saved_job)


@pytest.mark.parametrize(
    "defect",
    [
        "no_snapshot",
        "low_quality",
        "quarantine",
        "changed_description",
        "case_only_change",
        "changed_url",
        "deleted",
        "missing_page",
        "missing_quality",
        "duplicate_page",
        "wrong_tenant",
        "wrong_job",
        "closed_snapshot",
        "damaged_snapshot",
        "page_unknown_access",
        "page_listing",
    ],
)
def test_untrusted_changed_or_foreign_capture_cannot_bypass_refresh(saved_job, capture, monkeypatch, defect):
    capture(quality="low" if defect == "low_quality" else "high")
    repo = SqlitePostingSnapshotSetRepository(saved_job)
    snapshot_set = repo.load(LOCAL_TENANT, canonical_job_id(JOB_ID))
    snapshot = snapshot_set.latest_snapshot
    from jobctrl.domain.enrichment.snapshot_value_objects import ActiveState, QuarantineReason

    if defect == "no_snapshot":
        saved_job.execute("DELETE FROM posting_snapshot_sets")
    elif defect == "quarantine":
        repo.save(
            replace(
                snapshot_set, snapshots=(replace(snapshot, quarantine_reason=QuarantineReason.POLICY_OVERRIDE_PENDING),)
            )
        )
    elif defect in {"changed_description", "case_only_change"}:
        saved_job.execute(
            "UPDATE job_enrichments SET full_description=?",
            (DESCRIPTION.upper() if defect == "case_only_change" else "Different synthetic description",),
        )
    elif defect == "changed_url":
        saved_job.execute("UPDATE jobs SET url=?", (URL + "-changed",))
    elif defect == "deleted":
        saved_job.execute(
            "INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at) VALUES ('local', ?, ?)",
            (JOB_ID, NOW.isoformat()),
        )
    elif defect in {"missing_page", "missing_quality", "duplicate_page"}:
        prefix = (
            "description_quality_determination:"
            if defect == "missing_quality"
            else "page_interpretation_determination:"
        )
        evidence = tuple(entry for entry in snapshot.evidence if not entry.startswith(prefix))
        if defect == "duplicate_page":
            page = next(entry for entry in snapshot.evidence if entry.startswith(prefix))
            evidence += (page, page)
        repo.save(replace(snapshot_set, snapshots=(replace(snapshot, evidence=evidence),)))
    elif defect in {"wrong_tenant", "wrong_job", "damaged_snapshot"}:
        data = snapshot_set.to_dict()
        if defect == "wrong_tenant":
            data["tenant_id"] = "another-tenant"
        elif defect == "wrong_job":
            data["job_id"] = "10000000-0000-4000-8000-000000000999"
        saved_job.execute(
            "UPDATE posting_snapshot_sets SET snapshot_set_json=?",
            ("{" if defect == "damaged_snapshot" else json.dumps(data),),
        )
    elif defect == "closed_snapshot":
        repo.save(
            replace(
                snapshot_set,
                latest_active_state=ActiveState.CLOSED,
                snapshots=(replace(snapshot, active_state=ActiveState.CLOSED),),
            )
        )
    elif defect in {"page_unknown_access", "page_listing"}:
        row = saved_job.execute(
            "SELECT determination_id, envelope_json FROM semantic_determinations WHERE kind='page_interpretation'"
        ).fetchone()
        data = json.loads(row[1])
        field, value = ("access_state", "unknown") if defect == "page_unknown_access" else ("page_kind", "listing")
        data["result"][field]["value"] = value
        saved_job.execute(
            "UPDATE semantic_determinations SET envelope_json=? WHERE determination_id=?", (json.dumps(data), row[0])
        )
    saved_job.commit()
    refreshes = []
    monkeypatch.setattr(availability, "require_fresh_active", lambda *a, **kw: refreshes.append(kw))
    require(saved_job)
    assert len(refreshes) == 1


@pytest.mark.parametrize("kind", ["page_interpretation", "description_quality"])
@pytest.mark.parametrize(
    "field,value",
    [
        ("entity_id", "foreign-input"),
        ("tenant_id", "foreign-tenant"),
        ("kind", "foreign_kind"),
        ("schema_version", "999"),
        ("prompt_version", "foreign-prompt"),
        ("lane", "score"),
        ("input_fingerprint", "foreign-fingerprint"),
    ],
)
def test_receipts_must_retain_owning_input_and_contract(saved_job, capture, monkeypatch, kind, field, value):
    capture()
    row = saved_job.execute(
        "SELECT determination_id, envelope_json FROM semantic_determinations WHERE kind=?", (kind,)
    ).fetchone()
    data = json.loads(row[1])
    data[field] = value
    saved_job.execute(
        "UPDATE semantic_determinations SET envelope_json=? WHERE determination_id=?", (json.dumps(data), row[0])
    )
    saved_job.commit()
    refreshes = []
    monkeypatch.setattr(availability, "require_fresh_active", lambda *a, **kw: refreshes.append(kw))
    require(saved_job)
    assert len(refreshes) == 1


@pytest.mark.parametrize("verdict", ["closed", "expired", "removed", "location_incompatible"])
def test_separate_unavailable_observation_still_blocks_reuse(saved_job, capture, monkeypatch, verdict):
    capture()
    claim, _ = availability.claim_job(saved_job, JOB_ID)
    availability.complete_check(saved_job, claim, verdict=verdict, reason="synthetic", method="synthetic", lineage=[])
    refreshes = []
    monkeypatch.setattr(availability, "require_fresh_active", lambda *a, **kw: refreshes.append(kw))
    require(saved_job)
    assert len(refreshes) == 1


def test_capture_does_not_satisfy_unattended_apply(saved_job, capture, monkeypatch):
    capture()
    refreshes = []
    monkeypatch.setattr(availability, "check_availability", lambda *a, **kw: refreshes.append(kw))
    with pytest.raises(SourceUnavailableError):
        availability.require_fresh_active(
            JOB_ID, conn=saved_job, expected_posting_url=URL, max_age=timedelta(minutes=15)
        )
    assert len(refreshes) == 1
