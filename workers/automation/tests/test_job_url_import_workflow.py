"""Direct job URL import -> Temporal worker -> canonical job tests."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest
from temporalio.exceptions import ApplicationError

import jobctrl.discovery.job_url_import_workflow as job_url_import
from jobctrl.database import init_db
from jobctrl.discovery.job_url_import_workflow import (
    JobUrlImportWorkflow,
    JobUrlImportWorkflowInput,
    execute_job_url_import,
    job_url_import_activity,
    job_url_import_workflow_id,
)
from jobctrl.domain.enrichment import ActiveState, DetailPage, QuarantineReason
from jobctrl.domain.rpc.messages import JsonRpcRequest, WorkflowStartSpec
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer
from jobctrl.infrastructure.temporal.registry import ACTIVITIES, WORKFLOWS
from jobctrl.infrastructure.enrichment.playwright_fetcher import DetailPageFetchBlocked
from jobctrl.infrastructure.enrichment.sqlite_repository import (
    SqlitePostingSnapshotSetRepository,
)
from jobctrl.infrastructure.network.url_safety import PublicUrlDecision
from jobctrl.workflow_specs import build_job_url_import_workflow_spec


_URL = "https://example.com/jobs/staff-platform-engineer"
_DESCRIPTION = (
    "Build and operate reliable local-first platform infrastructure. "
    "Partner with product teams, improve observability, and mentor engineers."
)
_WAVE_URL = "https://www.wave.com/en/careers/job/6129464004/"


class _Fetcher:
    def __init__(self, page: DetailPage) -> None:
        self.page = page
        self.calls: list[str] = []

    def fetch(self, url: str) -> DetailPage:
        self.calls.append(url)
        return self.page


class _RaisingFetcher:
    def __init__(self, error: Exception) -> None:
        self.error = error
        self.calls: list[str] = []

    def fetch(self, url: str) -> DetailPage:
        self.calls.append(url)
        raise self.error


def _job_page(*, status: int | None = 200) -> DetailPage:
    posting = {
        "@type": "JobPosting",
        "title": "Staff Platform Engineer",
        "description": _DESCRIPTION,
        "url": _URL,
        "directApply": True,
        "validThrough": "2999-01-01T00:00:00+00:00",
        "hiringOrganization": {"@type": "Organization", "name": "Example Labs"},
        "jobLocation": {
            "address": {
                "addressLocality": "Barcelona",
                "addressRegion": "Catalonia",
                "addressCountry": "ES",
            }
        },
        "baseSalary": {
            "currency": "EUR",
            "value": {"minValue": 100000, "maxValue": 125000, "unitText": "YEAR"},
        },
    }
    return DetailPage(
        url=_URL,
        final_url=_URL,
        page_title="Staff Platform Engineer | Example Labs",
        html=f"<main><article class='job-description'>{_DESCRIPTION}</article></main>",
        json_ld=(posting,),
        status=status,
        fetched_at="2026-08-13T15:00:00+00:00",
    )


def _preparation_job_page() -> DetailPage:
    page = _job_page()
    posting = dict(page.json_ld[0])
    posting["description"] = _DESCRIPTION * 4
    return DetailPage(
        url=page.url,
        final_url=page.final_url,
        page_title=page.page_title,
        html=f"<main><article class='job-description'>{_DESCRIPTION * 4}</article></main>",
        json_ld=(posting,),
        status=page.status,
        fetched_at=page.fetched_at,
    )


def _payload(url: str = _URL) -> JobUrlImportWorkflowInput:
    return JobUrlImportWorkflowInput(tenant_id="local", url=url)


def _allow_public_url(_url: str) -> PublicUrlDecision:
    return PublicUrlDecision(allowed=True)


def test_url_import_fetches_and_persists_real_posting_content(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    fetcher = _Fetcher(_job_page())

    result = execute_job_url_import(_payload(), conn=conn, fetcher=fetcher, url_validator=_allow_public_url)

    assert result.outcome == "imported"
    assert result.already_existed is False
    assert result.job_id
    assert fetcher.calls == [_URL]
    row = conn.execute(
        """
        SELECT title, company, salary, description, location, site, strategy
        FROM jobs WHERE tenant_id = 'local' AND job_id = ?
        """,
        (result.job_id,),
    ).fetchone()
    assert tuple(row) == (
        "Staff Platform Engineer",
        "Example Labs",
        "EUR 100000-125000/year",
        _DESCRIPTION,
        "Barcelona, Catalonia, ES",
        "Direct URL import",
        "manual",
    )
    snapshot = conn.execute(
        """
        SELECT latest_snapshot_version, latest_active_state
        FROM posting_snapshot_sets
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (result.job_id,),
    ).fetchone()
    assert tuple(snapshot) == (1, "active")


def test_custom_careers_page_with_embedded_ats_form_imports_as_a_job(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    description = (
        "<h2>How you'll help us achieve it</h2>"
        f"<p>{_DESCRIPTION * 5}</p>"
        "<h2>Key details</h2>"
        "<p>Reports to the CEO. This is a fully remote role. Compensation: "
        "For this role, depending on your level and location, we offer a salary "
        "of up to $356,500 USD, plus a generous equity package.</p>"
        "<h2>Requirements</h2>"
        f"<ul><li>{_DESCRIPTION}</li><li>{_DESCRIPTION}</li></ul>"
        "<h2>How to apply</h2><p>Complete the application form below.</p>"
    )
    page = DetailPage(
        url=_WAVE_URL,
        final_url=_WAVE_URL,
        page_title="Chief Technology Officer - Wave",
        html=(
            "<h1 class='app-title'>Chief Technology Officer</h1>"
            "<span class='location'>Remote •</span>"
            f"<div id='content'>{description}</div>"
            "<div id='grnhse_app'></div>"
        ),
        json_ld=(),
        status=200,
        fetched_at="2026-08-13T15:00:00+00:00",
    )

    result = execute_job_url_import(
        _payload(_WAVE_URL),
        conn=conn,
        fetcher=_Fetcher(page),
        url_validator=_allow_public_url,
    )

    assert result.outcome == "imported"
    row = conn.execute(
        "SELECT title, company, location, description FROM jobs WHERE job_id = ?",
        (result.job_id,),
    ).fetchone()
    assert tuple(row)[:3] == ("Chief Technology Officer", "Wave", "Remote")
    assert "How you'll help us achieve it" in row["description"]
    assert (
        conn.execute(
            "SELECT latest_snapshot_version FROM posting_snapshot_sets WHERE job_id = ?",
            (result.job_id,),
        ).fetchone()[0]
        == 1
    )
    posted = conn.execute(
        """
        SELECT parse_state, currency, minimum_amount, maximum_amount, period,
               annualized_maximum_amount, warnings_json, source_field
        FROM job_posted_compensation_facts
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (result.job_id,),
    ).fetchone()
    assert tuple(posted) == (
        "parsed_range",
        "USD",
        None,
        356_500,
        "year",
        356_500,
        '["source_text_truncated", "equity_component", "annual_period_inferred", "one_sided_range"]',
        "jobs.description",
    )


def test_greenhouse_application_heading_is_split_into_role_and_employer(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    url = "https://job-boards.eu.greenhouse.io/super/jobs/4939544101"
    page = DetailPage(
        url=url,
        final_url=url,
        page_title="Job Application for Senior Cybersecurity Engineer at Super Technologies",
        html=(
            "<h1>Job Application for Senior Cybersecurity Engineer at Super Technologies</h1>"
            f"<article class='job-description'>{_DESCRIPTION * 3}</article>"
        ),
        json_ld=(),
        status=200,
        fetched_at="2026-08-13T15:00:00+00:00",
    )

    result = execute_job_url_import(
        _payload(url),
        conn=conn,
        fetcher=_Fetcher(page),
        url_validator=_allow_public_url,
    )

    row = conn.execute(
        "SELECT title, company FROM jobs WHERE job_id = ?",
        (result.job_id,),
    ).fetchone()
    assert tuple(row) == ("Senior Cybersecurity Engineer", "Super Technologies")
    enrichment = conn.execute(
        """
        SELECT current_status, application_url
        FROM job_enrichments
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (result.job_id,),
    ).fetchone()
    assert tuple(enrichment) == ("enriched", None)
    stages = dict(
        conn.execute(
            """
            SELECT stage, state
            FROM job_stage_states
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (result.job_id,),
        ).fetchall()
    )
    assert stages == {
        "apply": "pending",
        "cover": "pending",
        "discover": "succeeded",
        "enrich": "succeeded",
        "score": "pending",
        "tailor": "pending",
    }


def test_import_dispatches_full_preparation_without_apply_and_reuses_workflow_id(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    requested: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> object:
        requested.append(spec)
        return object()

    first = job_url_import._execute_job_url_import_and_start_preparation(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_preparation_job_page()),
        url_validator=_allow_public_url,
        workflow_starter=starter,
    )
    second_fetcher = _Fetcher(_preparation_job_page())
    second = job_url_import._execute_job_url_import_and_start_preparation(
        _payload(),
        conn=conn,
        fetcher=second_fetcher,
        url_validator=_allow_public_url,
        workflow_starter=starter,
    )

    assert second.job_id == first.job_id
    assert second.already_existed is True
    assert second_fetcher.calls == []
    assert len(requested) == 2
    assert requested[0].workflow_id == requested[1].workflow_id
    preparation_input = requested[0].args[0]
    assert preparation_input.job_id == first.job_id
    assert preparation_input.steps == ["score", "tailor", "cover", "pdf"]
    assert "apply" not in preparation_input.steps


def test_quarantined_import_does_not_dispatch_preparation(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    requested: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> object:
        requested.append(spec)
        return object()

    result = job_url_import._execute_job_url_import_and_start_preparation(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_job_page()),
        url_validator=_allow_public_url,
        workflow_starter=starter,
    )

    assert result.outcome == "imported"
    assert requested == []
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_enrichments WHERE job_id = ?",
            (result.job_id,),
        ).fetchone()[0]
        == 0
    )


@pytest.mark.parametrize(
    ("active_state", "quarantine_reason"),
    (
        (ActiveState.EXPIRED, QuarantineReason.NONE),
        (ActiveState.ACTIVE, QuarantineReason.LOW_CONFIDENCE_EXTRACTION),
    ),
)
def test_existing_enriched_import_rechecks_latest_snapshot_before_preparation(
    tmp_path: Path,
    active_state: ActiveState,
    quarantine_reason: QuarantineReason,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_preparation_job_page()),
        url_validator=_allow_public_url,
    )
    repository = SqlitePostingSnapshotSetRepository(conn)
    snapshot_set = repository.load("local", first.job_id)
    assert snapshot_set is not None
    latest = snapshot_set.latest_snapshot
    assert latest is not None
    updated_latest = replace(
        latest,
        active_state=active_state,
        quarantine_reason=quarantine_reason,
    )
    repository.save(
        replace(
            snapshot_set,
            snapshots=snapshot_set.snapshots[:-1] + (updated_latest,),
            latest_active_state=active_state,
            updated_at="2026-08-13T16:00:00+00:00",
        )
    )
    requested: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> object:
        requested.append(spec)
        return object()

    retry_fetcher = _Fetcher(_preparation_job_page())
    retried = job_url_import._execute_job_url_import_and_start_preparation(
        _payload(),
        conn=conn,
        fetcher=retry_fetcher,
        url_validator=_allow_public_url,
        workflow_starter=starter,
    )

    assert retried.job_id == first.job_id
    assert retried.already_existed is True
    assert retry_fetcher.calls == []
    assert requested == []
    assert (
        job_url_import._ensure_imported_job_pipeline_state(
            conn,
            tenant_id="local",
            job_id=first.job_id,
            source_native_id=_URL,
        )
        is False
    )


def test_existing_incomplete_import_repairs_enrichment_and_dispatches_preparation(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_preparation_job_page()),
        url_validator=_allow_public_url,
    )
    conn.execute(
        "DELETE FROM job_enrichments WHERE tenant_id = 'local' AND job_id = ?",
        (first.job_id,),
    )
    conn.execute(
        "DELETE FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ?",
        (first.job_id,),
    )
    conn.commit()
    requested: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> object:
        requested.append(spec)
        return object()

    retry_fetcher = _Fetcher(_preparation_job_page())
    repaired = job_url_import._execute_job_url_import_and_start_preparation(
        _payload(),
        conn=conn,
        fetcher=retry_fetcher,
        url_validator=_allow_public_url,
        workflow_starter=starter,
    )

    assert repaired.job_id == first.job_id
    assert repaired.already_existed is True
    assert retry_fetcher.calls == []
    assert (
        conn.execute(
            "SELECT current_status FROM job_enrichments WHERE job_id = ?",
            (first.job_id,),
        ).fetchone()[0]
        == "enriched"
    )
    assert (
        dict(
            conn.execute(
                "SELECT stage, state FROM job_stage_states WHERE job_id = ?",
                (first.job_id,),
            ).fetchall()
        )["enrich"]
        == "succeeded"
    )
    assert len(requested) == 1


def test_existing_legacy_import_repairs_pending_intake_and_dispatches_preparation(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_preparation_job_page()),
        url_validator=_allow_public_url,
    )
    conn.execute(
        "DELETE FROM job_enrichments WHERE tenant_id = 'local' AND job_id = ?",
        (first.job_id,),
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'pending', attempt_count = 0,
            started_at = NULL, finished_at = NULL
        WHERE tenant_id = 'local' AND job_id = ?
          AND stage IN ('discover', 'enrich')
        """,
        (first.job_id,),
    )
    conn.commit()
    requested: list[WorkflowStartSpec] = []

    async def starter(spec: WorkflowStartSpec) -> object:
        requested.append(spec)
        return object()

    repaired = job_url_import._execute_job_url_import_and_start_preparation(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_preparation_job_page()),
        url_validator=_allow_public_url,
        workflow_starter=starter,
    )

    assert repaired.job_id == first.job_id
    assert repaired.already_existed is True
    stages = dict(
        conn.execute(
            "SELECT stage, state FROM job_stage_states WHERE job_id = ?",
            (first.job_id,),
        ).fetchall()
    )
    assert stages["discover"] == "succeeded"
    assert stages["enrich"] == "succeeded"
    assert len(requested) == 1


def test_url_import_is_idempotent_and_does_not_refetch_existing_job(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_job_page()),
        url_validator=_allow_public_url,
    )
    second_fetcher = _Fetcher(_job_page(status=500))

    second = execute_job_url_import(_payload(), conn=conn, fetcher=second_fetcher, url_validator=_allow_public_url)

    assert second.outcome == "imported"
    assert second.job_id == first.job_id
    assert second.already_existed is True
    assert second_fetcher.calls == []
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


def test_existing_url_import_repairs_legacy_application_heading_without_refetch(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_job_page()),
        url_validator=_allow_public_url,
    )
    conn.execute(
        """
        UPDATE jobs
        SET title = ?, company = NULL
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (
            "Job Application for Senior Cybersecurity Engineer at Super Technologies",
            first.job_id,
        ),
    )
    conn.commit()
    retry_fetcher = _Fetcher(_job_page(status=500))

    second = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=retry_fetcher,
        url_validator=_allow_public_url,
    )
    third = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=retry_fetcher,
        url_validator=_allow_public_url,
    )

    assert second.job_id == first.job_id
    assert second.already_existed is True
    assert third.job_id == first.job_id
    assert retry_fetcher.calls == []
    row = conn.execute(
        "SELECT title, company FROM jobs WHERE tenant_id = 'local' AND job_id = ?",
        (first.job_id,),
    ).fetchone()
    assert tuple(row) == ("Senior Cybersecurity Engineer", "Super Technologies")
    assert (
        conn.execute(
            """
            SELECT COUNT(*)
            FROM job_events
            WHERE tenant_id = 'local'
              AND job_id = ?
              AND event_type = 'JobMetadataUpdated'
            """,
            (first.job_id,),
        ).fetchone()[0]
        == 1
    )


def test_existing_url_identity_repair_rolls_back_when_event_write_is_interrupted(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_job_page()),
        url_validator=_allow_public_url,
    )
    legacy_title = "Job Application for Senior Cybersecurity Engineer at Super Technologies"
    conn.execute(
        "UPDATE jobs SET title = ?, company = NULL WHERE tenant_id = 'local' AND job_id = ?",
        (legacy_title, first.job_id),
    )
    conn.commit()

    def _interrupt(*_args: object, **_kwargs: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr("jobctrl.state.record_job_event", _interrupt)

    with pytest.raises(KeyboardInterrupt):
        execute_job_url_import(
            _payload(),
            conn=conn,
            fetcher=_Fetcher(_job_page(status=500)),
            url_validator=_allow_public_url,
        )

    row = conn.execute(
        "SELECT title, company FROM jobs WHERE tenant_id = 'local' AND job_id = ?",
        (first.job_id,),
    ).fetchone()
    assert tuple(row) == (legacy_title, None)
    assert conn.in_transaction is False


def test_existing_url_import_repairs_a_missing_posted_compensation_fact(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    original = job_url_import._ensure_posted_compensation_fact
    monkeypatch.setattr(job_url_import, "_ensure_posted_compensation_fact", lambda *args, **kwargs: None)
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_job_page()),
        url_validator=_allow_public_url,
    )
    assert conn.execute("SELECT COUNT(*) FROM job_posted_compensation_facts").fetchone()[0] == 0

    monkeypatch.setattr(job_url_import, "_ensure_posted_compensation_fact", original)
    retry_fetcher = _Fetcher(_job_page(status=500))
    second = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=retry_fetcher,
        url_validator=_allow_public_url,
    )

    assert second.job_id == first.job_id
    assert second.already_existed is True
    assert retry_fetcher.calls == []
    posted = conn.execute(
        """
        SELECT parse_state, currency, minimum_amount, maximum_amount, period
        FROM job_posted_compensation_facts
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (first.job_id,),
    ).fetchone()
    assert tuple(posted) == ("parsed_range", "EUR", 100_000, 125_000, "year")


def test_redirect_alias_opens_the_existing_canonical_job(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_job_page()),
        url_validator=_allow_public_url,
    )
    alias_url = "https://short.example/jobs/staff-platform-engineer"
    redirected_page = _job_page()
    redirected_page = DetailPage(
        url=alias_url,
        final_url=_URL,
        page_title=redirected_page.page_title,
        html=redirected_page.html,
        json_ld=redirected_page.json_ld,
        status=redirected_page.status,
        fetched_at=redirected_page.fetched_at,
    )
    alias_fetcher = _Fetcher(redirected_page)

    second = execute_job_url_import(
        _payload(alias_url),
        conn=conn,
        fetcher=alias_fetcher,
        url_validator=_allow_public_url,
    )

    assert second.job_id == first.job_id
    assert second.already_existed is True
    assert alias_fetcher.calls == [alias_url]
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


def test_login_page_routes_to_reopened_manual_capture_without_placeholder_job(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    blocked = DetailPage(
        url=_URL,
        final_url=_URL,
        page_title="Sign in",
        html="<main>Please sign in to continue.</main>",
        json_ld=(),
        status=401,
        fetched_at="2026-08-13T15:00:00+00:00",
    )
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(blocked),
        url_validator=_allow_public_url,
    )
    conn.execute(
        "UPDATE manual_capture_queue SET status = 'dismissed', dismissed_at = ? WHERE item_id = ?",
        ("2026-08-13T15:01:00+00:00", first.item_id),
    )
    conn.commit()

    second = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(blocked),
        url_validator=_allow_public_url,
    )

    assert second.outcome == "manual_capture_required"
    assert second.reason == "login_required"
    assert second.item_id == first.item_id
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    row = conn.execute(
        "SELECT status, dismissed_at, reason, retry_context_json FROM manual_capture_queue WHERE item_id = ?",
        (second.item_id,),
    ).fetchone()
    assert tuple(row)[:3] == ("pending", None, "login_required")
    assert json.loads(row["retry_context_json"])["source"] == "jobs_url_import"


def test_private_url_is_rejected_without_fetch_or_manual_capture(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    fetcher = _Fetcher(_job_page())

    with pytest.raises(ApplicationError, match="public HTTP or HTTPS") as raised:
        execute_job_url_import(_payload("http://127.0.0.1/private"), conn=conn, fetcher=fetcher)

    assert raised.value.type == "invalid_url"
    assert fetcher.calls == []
    assert conn.execute("SELECT COUNT(*) FROM manual_capture_queue").fetchone()[0] == 0


def test_credential_bearing_url_is_rejected_without_persistence(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    fetcher = _Fetcher(_job_page())

    with pytest.raises(ApplicationError, match="public HTTP or HTTPS") as raised:
        execute_job_url_import(
            _payload("https://user:password@example.com/jobs/42"),
            conn=conn,
            fetcher=fetcher,
        )

    assert raised.value.type == "invalid_url"
    assert fetcher.calls == []
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0


def test_robots_denied_page_routes_to_manual_capture_without_placeholder_job(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")

    result = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_RaisingFetcher(DetailPageFetchBlocked("robots_disallowed")),
        url_validator=_allow_public_url,
    )

    assert result.outcome == "manual_capture_required"
    assert result.reason == "robots_disallowed"
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_transient_fetch_failure_remains_retryable_and_does_not_create_manual_work(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")

    with pytest.raises(ApplicationError, match="could not be fetched") as raised:
        execute_job_url_import(
            _payload(),
            conn=conn,
            fetcher=_RaisingFetcher(TimeoutError("temporary browser timeout")),
            url_validator=_allow_public_url,
        )

    assert raised.value.type == "job_url_import_fetch_failed"
    assert raised.value.non_retryable is False
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM manual_capture_queue").fetchone()[0] == 0


@pytest.mark.parametrize("status", (None, 503))
def test_empty_transient_response_remains_retryable_without_manual_work(
    status: int | None,
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    empty = DetailPage(
        url=_URL,
        final_url=_URL,
        page_title="",
        html="",
        json_ld=(),
        status=status,
        fetched_at="2026-08-13T15:00:00+00:00",
    )

    with pytest.raises(ApplicationError, match="could not be fetched") as raised:
        execute_job_url_import(
            _payload(),
            conn=conn,
            fetcher=_Fetcher(empty),
            url_validator=_allow_public_url,
        )

    assert raised.value.type == "job_url_import_fetch_failed"
    assert raised.value.non_retryable is False
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM manual_capture_queue").fetchone()[0] == 0


def test_generic_company_article_routes_to_manual_capture_without_placeholder_job(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    page = DetailPage(
        url=_URL,
        final_url=_URL,
        page_title="Company news",
        html=f"<main><article>{_DESCRIPTION * 3}</article></main>",
        json_ld=(),
        status=200,
        fetched_at="2026-08-13T15:00:00+00:00",
    )

    result = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(page),
        url_validator=_allow_public_url,
    )

    assert result.outcome == "manual_capture_required"
    assert result.reason == "ambiguous_career_system"
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_successful_retry_resolves_the_matching_manual_capture_item(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    ambiguous = DetailPage(
        url=_URL,
        final_url=_URL,
        page_title="Company news",
        html=f"<main><article>{_DESCRIPTION * 3}</article></main>",
        json_ld=(),
        status=200,
        fetched_at="2026-08-13T15:00:00+00:00",
    )
    first = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(ambiguous),
        url_validator=_allow_public_url,
    )
    assert first.outcome == "manual_capture_required"

    second = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_job_page()),
        url_validator=_allow_public_url,
    )

    row = conn.execute(
        """
        SELECT status, imported_at, captured_url, job_id
        FROM manual_capture_queue
        WHERE item_id = ?
        """,
        (first.item_id,),
    ).fetchone()
    assert row["status"] == "imported"
    assert row["imported_at"]
    assert row["captured_url"] == _URL
    assert row["job_id"] == second.job_id


def test_structured_fields_and_description_come_from_the_same_job_posting(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    wrong = {
        "@type": "JobPosting",
        "title": "Wrong role",
        "description": "short",
        "hiringOrganization": {"name": "Wrong employer"},
    }
    correct = dict(_job_page().json_ld[0])
    page = DetailPage(
        url=_URL,
        final_url=_URL,
        page_title="Wrong role | Wrong employer",
        html=f"<main><article class='job-description'>{_DESCRIPTION}</article></main>",
        json_ld=(wrong, correct),
        status=200,
        fetched_at="2026-08-13T15:00:00+00:00",
    )

    result = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(page),
        url_validator=_allow_public_url,
    )

    row = conn.execute(
        "SELECT title, company, description FROM jobs WHERE job_id = ?",
        (result.job_id,),
    ).fetchone()
    assert tuple(row) == ("Staff Platform Engineer", "Example Labs", _DESCRIPTION)


def test_structured_posting_with_mismatched_explicit_url_routes_to_manual_capture(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    careers_url = "https://example.com/careers"
    unrelated = dict(_job_page().json_ld[0])
    unrelated["url"] = "https://example.com/jobs/unrelated-role"
    page = DetailPage(
        url=careers_url,
        final_url=careers_url,
        page_title="Careers | Example Labs",
        html=f"<main><article>{_DESCRIPTION}</article></main>",
        json_ld=(unrelated,),
        status=200,
        fetched_at="2026-08-13T15:00:00+00:00",
    )

    result = execute_job_url_import(
        _payload(careers_url),
        conn=conn,
        fetcher=_Fetcher(page),
        url_validator=_allow_public_url,
    )

    assert result.outcome == "manual_capture_required"
    assert result.reason == "ambiguous_career_system"
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_non_finite_structured_salary_is_not_persisted(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    posting = dict(_job_page().json_ld[0])
    posting["baseSalary"] = {
        "currency": "EUR",
        "value": {"minValue": float("inf"), "maxValue": 100000, "unitText": "YEAR"},
    }
    page = DetailPage(
        url=_URL,
        final_url=_URL,
        page_title="Staff Platform Engineer | Example Labs",
        html=f"<main><article class='job-description'>{_DESCRIPTION}</article></main>",
        json_ld=(posting,),
        status=200,
        fetched_at="2026-08-13T15:00:00+00:00",
    )

    result = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(page),
        url_validator=_allow_public_url,
    )

    salary = conn.execute("SELECT salary FROM jobs WHERE job_id = ?", (result.job_id,)).fetchone()[0]
    assert salary == "EUR 100000/year"
    assert "inf" not in salary.casefold()


def test_retry_repairs_commit_before_ack_discovery_events_and_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher

    conn = init_db(tmp_path / "jobctrl.db")
    original_publish = DurableJobEventPublisher.publish
    injected = False

    def publish_then_fail_once(self, event):
        nonlocal injected
        original_publish(self, event)
        if not injected:
            injected = True
            raise RuntimeError("injected commit-before-ack failure")

    monkeypatch.setattr(DurableJobEventPublisher, "publish", publish_then_fail_once)
    with pytest.raises(RuntimeError, match="commit-before-ack"):
        execute_job_url_import(
            _payload(),
            conn=conn,
            fetcher=_Fetcher(_job_page()),
            url_validator=_allow_public_url,
        )

    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM posting_snapshot_sets").fetchone()[0] == 0

    monkeypatch.setattr(DurableJobEventPublisher, "publish", original_publish)
    result = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=_Fetcher(_job_page()),
        url_validator=_allow_public_url,
    )

    assert result.outcome == "imported"
    assert result.already_existed is True
    counts = dict(
        conn.execute(
            """
            SELECT event_type, COUNT(*)
            FROM job_events
            WHERE event_type IN (
                'JobDiscovered', 'CanonicalJobIdentityResolved',
                'JobSourceObserved', 'PostingContentSnapshotCaptured'
            )
            GROUP BY event_type
            """
        ).fetchall()
    )
    assert counts == {
        "CanonicalJobIdentityResolved": 1,
        "JobDiscovered": 1,
        "JobSourceObserved": 1,
        "PostingContentSnapshotCaptured": 1,
    }
    assert conn.execute("SELECT latest_snapshot_version FROM posting_snapshot_sets").fetchone()[0] == 1


def test_retry_repairs_snapshot_failure_after_canonical_ingest(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from jobctrl.infrastructure.enrichment import SqlitePostingSnapshotSetRepository

    conn = init_db(tmp_path / "jobctrl.db")
    original_save = SqlitePostingSnapshotSetRepository.save
    injected = False

    def fail_once(self, snapshot_set, *, commit=True):
        nonlocal injected
        if not injected:
            injected = True
            raise RuntimeError("injected snapshot failure")
        return original_save(self, snapshot_set, commit=commit)

    monkeypatch.setattr(SqlitePostingSnapshotSetRepository, "save", fail_once)
    with pytest.raises(RuntimeError, match="snapshot failure"):
        execute_job_url_import(
            _payload(),
            conn=conn,
            fetcher=_Fetcher(_job_page()),
            url_validator=_allow_public_url,
        )

    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM posting_snapshot_sets").fetchone()[0] == 0

    retry_fetcher = _Fetcher(_job_page())
    result = execute_job_url_import(
        _payload(),
        conn=conn,
        fetcher=retry_fetcher,
        url_validator=_allow_public_url,
    )

    assert result.outcome == "imported"
    assert result.already_existed is True
    assert retry_fetcher.calls == [_URL]
    assert conn.execute("SELECT latest_snapshot_version FROM posting_snapshot_sets").fetchone()[0] == 1


def test_workflow_spec_and_worker_registry_include_job_url_import() -> None:
    params = {
        "tenantId": "local",
        "url": _URL,
        "expectedAppDir": "/tmp/jobctrl",
        "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
    }
    spec = build_job_url_import_workflow_spec(params, url_validator=_allow_public_url)

    assert spec.workflow is JobUrlImportWorkflow
    assert spec.workflow_id == job_url_import_workflow_id("local", _URL)
    assert spec.args[0] == JobUrlImportWorkflowInput(
        tenant_id="local",
        url=_URL,
        expected_app_dir="/tmp/jobctrl",
        expected_db_path="/tmp/jobctrl/jobctrl.db",
    )
    assert JobUrlImportWorkflow in WORKFLOWS
    assert job_url_import_activity in ACTIVITIES


def test_workflow_spec_rejects_credentials_before_workflow_history() -> None:
    with pytest.raises(ValueError, match="embedded credentials"):
        build_job_url_import_workflow_spec(
            {
                "tenantId": "local",
                "url": "https://user:password@example.com/jobs/42",
            }
        )


@pytest.mark.parametrize(
    "url",
    (
        "http://127.0.0.1/private",
        "http://192.168.1.23/jobs/internal",
        "http://0177.0.0.1/private",
        "http://012.0.0.1/private",
        "http://0300.0250.0001.0001/private",
    ),
)
def test_workflow_spec_rejects_private_url_before_workflow_history(url: str) -> None:
    with pytest.raises(ValueError, match="not a public"):
        build_job_url_import_workflow_spec({"tenantId": "local", "url": url})


@pytest.mark.parametrize(
    "url",
    (
        "http://0177.0.0.1/private",
        "http://012.0.0.1/private",
    ),
)
def test_legacy_private_ipv4_url_is_rejected_without_fetch(url: str, tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    fetcher = _Fetcher(_job_page())

    with pytest.raises(ApplicationError, match="public HTTP or HTTPS") as raised:
        execute_job_url_import(_payload(url), conn=conn, fetcher=fetcher)

    assert raised.value.type == "invalid_url"
    assert fetcher.calls == []
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0


def test_workflow_spec_rejects_hostname_resolving_private_before_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import jobctrl.infrastructure.network.url_safety as url_safety

    monkeypatch.setattr(
        url_safety.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("10.0.0.5", 443))],
    )

    with pytest.raises(ValueError, match="non-public"):
        build_job_url_import_workflow_spec({"tenantId": "local", "url": "https://jobs.example/role"})


def test_jsonrpc_handler_awaits_job_url_import_workflow(monkeypatch: pytest.MonkeyPatch) -> None:
    import jobctrl.infrastructure.network.url_safety as url_safety

    monkeypatch.setattr(
        url_safety.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))],
    )
    seen: list[WorkflowStartSpec] = []
    result_payload = {
        "status": "succeeded",
        "outcome": "manual_capture_required",
        "job_id": None,
        "item_id": "manual:abc",
        "reason": "login_required",
        "imported_at": None,
        "already_existed": False,
        "error": None,
        "error_code": None,
    }

    class _Handle:
        id = "job-url-import-workflow"
        run_id = "job-url-import-run"
        first_execution_run_id = "job-url-import-run"

        async def result(self) -> object:
            return result_payload

    async def starter(spec: WorkflowStartSpec) -> _Handle:
        seen.append(spec)
        return _Handle()

    async def canceler(_run_id: str) -> None:
        return None

    server = JsonRpcServer(workflow_starter=starter)
    register_default_handlers(server, canceler=canceler)
    response = server.dispatch(
        JsonRpcRequest(
            method="job_url_import",
            params={"tenantId": "local", "url": _URL, "awaitResult": True},
            id=1,
        )
    )

    assert response is not None
    assert response.to_dict()["result"] == {
        "runId": "job-url-import-workflow",
        "workflowId": "job-url-import-workflow",
        "firstExecutionRunId": "job-url-import-run",
        "result": result_payload,
    }
    assert len(seen) == 1
    assert seen[0].workflow is JobUrlImportWorkflow
