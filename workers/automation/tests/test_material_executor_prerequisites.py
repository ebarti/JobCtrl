"""A stale member cannot prevent the rest of a material cohort from running."""

from __future__ import annotations

import threading

import pytest

from jobctrl.domain.errors import BudgetExceededError, LlmTransientError, MissingInputError, SourceUnavailableError
from jobctrl.domain.identifiers import JobId
from jobctrl.materials import activities
from jobctrl.materials.executor import run_material_jobs


JOB_IDS = (
    JobId("50000000-0000-4000-8000-000000000081"),
    JobId("50000000-0000-4000-8000-000000000082"),
)


@pytest.mark.parametrize("workers", [1, 2])
@pytest.mark.parametrize("stage", ["tailor", "cover"])
@pytest.mark.parametrize("failure", [MissingInputError, SourceUnavailableError])
def test_selected_material_cohort_finishes_healthy_peer(monkeypatch, workers, stage, failure):
    completed = []

    def run_one(job_id, **kwargs):
        if job_id == JOB_IDS[0]:
            raise failure("Private source diagnostic must not enter item errors")
        completed.append(job_id)
        return {"status": "approved" if stage == "tailor" else "ok", "generated": 1}

    if stage == "tailor":
        monkeypatch.setattr("jobctrl.scoring.tailor.tailor_job_by_id", run_one)
        result = activities._run_selected_tailoring(
            activities.TailorActivityInput(tenant_id="local", job_ids=JOB_IDS, workers=workers),
        )
    else:
        monkeypatch.setattr("jobctrl.scoring.cover_letter.cover_letter_by_id", run_one)
        result = activities._run_selected_cover(
            activities.CoverActivityInput(tenant_id="local", job_ids=JOB_IDS, workers=workers),
        )

    assert completed == [JOB_IDS[1]]
    detail = result["stages"][0]
    assert detail["selected"] == len(JOB_IDS)
    if stage == "tailor":
        assert detail["approvedJobIds"] == [JOB_IDS[1]]
    assert detail["approved" if stage == "tailor" else "generated"] == 1
    assert detail["skipped"] == int(failure is MissingInputError)
    assert detail["failed"] == int(failure is SourceUnavailableError)
    assert detail["itemErrors"] == (
        {str(JOB_IDS[0]): "source_unavailable"} if failure is SourceUnavailableError else {}
    )


@pytest.mark.parametrize("workers", [1, 2])
@pytest.mark.parametrize("failure", [BudgetExceededError, RuntimeError])
def test_material_executor_preserves_systemic_failure(workers, failure):
    def run_one(job_id):
        raise failure("stop")

    with pytest.raises(failure, match="stop"):
        run_material_jobs(JOB_IDS, workers=workers, cancel_event=None, stage="tailor", run_one=run_one)


@pytest.mark.parametrize("workers", [1, 2])
def test_material_executor_does_not_swallow_cancellation_prerequisite(workers):
    canceled = threading.Event()

    def run_one(job_id):
        canceled.set()
        raise MissingInputError("canceled member")

    with pytest.raises((MissingInputError, LlmTransientError), match="canceled"):
        run_material_jobs(JOB_IDS, workers=workers, cancel_event=canceled, stage="tailor", run_one=run_one)
