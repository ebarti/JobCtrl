"""History proposals exercise the real CLI and learner with owned exact-schema data."""

from __future__ import annotations

import hashlib
import json
import socket
from pathlib import Path

import pytest
from typer.testing import CliRunner

from jobctrl import config
from jobctrl.cli import app
from jobctrl.database import close_connection, init_db
from jobctrl.domain.discovery.source_registry import (
    SourceKind,
    SourcePriority,
    SourceRegistryEntry,
    SourceState,
    ATS_API_POLICY,
)
from jobctrl.domain.identifiers import generate_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import posting_source_proposals as proposals
from jobctrl.infrastructure.discovery.production_wiring import (
    learn_posting_source_from_url,
    run_deterministic_source_locator,
    seed_source_registry_controls,
)
from jobctrl.infrastructure.network.url_safety import validate_public_http_url
from jobctrl.state import record_job_event

NOW = "2026-10-18T09:00:00Z"
RUNNER = CliRunner()


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "load_env", lambda: None)

    def resolve(host, *_args, **_kwargs):
        address = "127.0.0.1" if host == "private.example" else "93.184.216.34"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]

    monkeypatch.setattr(
        proposals, "validate_public_http_url", lambda url: validate_public_http_url(url, resolver=resolve)
    )
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def seed_job(conn, url, *, application_url=None, run_id="capture-run-1"):
    job_id = str(generate_job_id())
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, company, description, discovered_at) VALUES ('local', ?, ?, 'Platform Engineer', 'Synthetic Acme', 'Build reliable synthetic systems.', ?)",
        (job_id, url, NOW),
    )
    conn.execute(
        "INSERT INTO job_locators (tenant_id, job_id, locator_kind, locator_value, is_current, first_seen_at, last_seen_at) VALUES ('local', ?, 'posting_url', ?, 1, ?, ?)",
        (job_id, url, NOW, NOW),
    )
    conn.execute(
        "INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description, application_url, enriched_at, extraction_tier, updated_at) VALUES ('local', ?, 'succeeded', 'Build reliable synthetic systems.', ?, ?, 'json_ld', ?)",
        (job_id, application_url, NOW, NOW),
    )
    conn.execute(
        "INSERT INTO posting_snapshot_sets (tenant_id, job_id, snapshot_set_json, latest_snapshot_version, updated_at) VALUES ('local', ?, ?, 3, ?)",
        (job_id, '{"snapshots":[{"snapshot_version":3,"evidence":["Saved JSON-LD source evidence"]}]}', NOW),
    )
    conn.execute(
        "INSERT INTO job_source_observations (tenant_id, source_observation_id, job_id, source_id, source_native_id, observed_url, normalized_observed_url, run_id, observed_at) VALUES ('local', ?, ?, 'jobspy:linkedin', ?, ?, ?, ?, ?)",
        (f"observation:{job_id}", job_id, job_id, url, url, run_id, NOW),
    )
    conn.commit()
    return job_id


def command(*args):
    result = RUNNER.invoke(app, ["source-proposals", *args])
    assert result.exit_code == 0, result.output + repr(result.exception)
    return json.loads(result.stdout)


def preserved(conn):
    tables = (
        "jobs",
        "job_locators",
        "job_canonical_identities",
        "job_enrichments",
        "job_application_locators",
        "posting_snapshot_sets",
        "job_source_observations",
        "discovery_settings",
        "source_registry_entries",
        "apply_approvals",
        "apply_runs",
    )
    actual = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    return {
        table: [tuple(row) for row in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
        for table in tables
        if table in actual
    }


@pytest.mark.parametrize(
    "url",
    [
        "https://boards.greenhouse.io/acme/jobs/1?gh_src=tracked",
        "https://job-boards.greenhouse.io/acme/jobs/2#apply",
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs/3",
    ],
)
def test_coordinates_deduplicate_postings_and_api_board(url):
    coordinate = proposals.source_coordinate(url)
    assert coordinate.url == "https://boards.greenhouse.io/acme"
    assert coordinate.source_id == "greenhouse:acme"
    assert coordinate.board_token == "acme"


@pytest.mark.parametrize(
    "url",
    [
        "not a URL",
        "file:///tmp/job",
        "https://user:pass@jobs.lever.co/acme/1",
        "https://localhost/jobs",
        "https://127.0.0.1/job",
        "https://10.0.0.8/job",
        "http://169.254.169.254/latest",
        "https://[::1]/job",
        "https://[::ffff:127.0.0.1]/job",
        "https://2130706433/job",
        "https://0x7f000001/job",
        "https://127.1/job",
        "https://hiring.internal/job",
        "https://a.local/job",
        "https://boards.greenhouse.io",
        "https://jobs.lever.co/acme%2fother/1",
        "https://jobs.lever.co:bogus/acme/1",
        "https://jobs.lever.co\\@localhost/acme",
    ],
)
def test_invalid_or_private_coordinates_are_rejected(url):
    assert proposals.source_coordinate(url) is None


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://api.lever.co/v0/postings/acme/1", "https://jobs.lever.co/acme"),
        ("https://jobs.lever.co/acme/2/apply", "https://jobs.lever.co/acme"),
        ("https://api.eu.lever.co/v0/postings/acme/2", "https://jobs.eu.lever.co/acme"),
        ("https://api.ashbyhq.com/posting-api/job-board/Acme", "https://jobs.ashbyhq.com/Acme"),
        ("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/1", "https://acme.wd5.myworkdayjobs.com/Careers"),
        ("https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs", "https://acme.wd5.myworkdayjobs.com/Careers"),
    ],
)
def test_supported_coordinate_shapes(url, expected):
    assert proposals.source_coordinate(url).url == expected


def test_cli_opt_in_preserves_authorities_and_retains_every_origin(workspace):
    conn = workspace
    first = seed_job(
        conn,
        "https://boards.greenhouse.io/acme/jobs/1",
        application_url="https://boards.greenhouse.io/acme/jobs/1#apply",
    )
    second = seed_job(conn, "https://boards.greenhouse.io/acme/jobs/2", run_id="import-run-2")
    before = preserved(conn)
    changes = conn.total_changes
    assert command("list")["candidates"] == []
    assert conn.total_changes == changes
    result = command("from-history")
    assert result["counts"]["proposed"] == 3
    assert result["completeness"] == "unknown"
    assert preserved(conn) == before
    view = command("list")
    assert len(view["candidates"]) == 1
    receipts = [item["receipt"] for item in view["history"]]
    assert {item["evidence"]["originJobId"] for item in receipts} == {first, second}
    assert {item["evidence"]["observations"][0]["runId"] for item in receipts} == {"capture-run-1", "import-run-2"}
    assert receipts[0]["evidence"]["extraction"]["snapshotVersion"] == 3
    assert receipts[0]["evidence"]["extraction"]["snapshotEvidence"] == ["Saved JSON-LD source evidence"]
    assert (
        receipts[0]["evidence"]["extraction"]["descriptionSha256"]
        == hashlib.sha256(b"Build reliable synthetic systems.").hexdigest()
    )
    assert {item["evidence"]["urlKind"] for item in receipts} == {"posting_url", "application_url"}
    event_count = conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0]
    assert command("from-history")["counts"]["unchanged"] == 3
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == event_count
    run_deterministic_source_locator(conn, ())
    outcome = learn_posting_source_from_url(
        conn,
        job_url="https://boards.greenhouse.io/acme/jobs/1",
        posting_url="https://boards.greenhouse.io/acme/jobs/99",
        discovered_via_source_id="jobspy:linkedin",
        observed_at=NOW,
    )
    assert outcome.action == "suppressed"
    assert len(command("list")["candidates"]) == 1
    assert preserved(conn) == before


def test_rejection_survives_reproposal_and_requires_explicit_reset(workspace):
    conn = workspace
    seed_job(conn, "https://jobs.lever.co/acme/1")
    command("from-history")
    candidate = command("list")["candidates"][0]
    record_job_event(
        conn,
        None,
        "discover",
        "SourceLocationCandidateReviewed",
        entity_kind="discovery",
        entity_ref=candidate["candidate_url"],
        payload={
            "candidateId": candidate["candidate_id"],
            "coordinateKey": candidate["candidate_url"],
            "decision": "reject",
            "reason": "User rejected",
            "decidedAt": NOW,
        },
    )
    conn.execute("DELETE FROM source_locator_candidates")
    conn.commit()
    seed_job(conn, "https://jobs.lever.co/acme/alternate")
    assert command("from-history")["counts"]["suppressed"] == 2
    run_deterministic_source_locator(conn, ())
    assert command("list")["candidates"] == []
    assert conn.execute("SELECT COUNT(*) FROM source_registry_entries").fetchone()[0] == 0
    assert command("reset", candidate["candidate_id"])["decision"] == "reset"
    # Reset permits a new proposal, never automatic activation between commands.
    run_deterministic_source_locator(conn, ())
    assert conn.execute("SELECT COUNT(*) FROM source_registry_entries").fetchone()[0] == 0
    assert command("from-history")["counts"]["proposed"] == 2
    assert len(command("list")["candidates"]) == 1
    assert command("from-history")["counts"]["unchanged"] == 2


def test_disabled_source_and_seed_reconciliation_preserve_intent(workspace):
    conn = workspace
    seed_job(conn, "https://jobs.ashbyhq.com/acme/1")
    seed = SourceRegistryEntry(
        tenant_id=LOCAL_TENANT,
        source_id="ashby:acme",
        kind=SourceKind.ATS_API,
        display_name="Acme",
        owner="system",
        priority=SourcePriority.CANONICAL,
        state=SourceState.DISABLED,
        policy=ATS_API_POLICY,
        adapter_config={"seed_url": "https://jobs.ashbyhq.com/acme"},
    )
    seed_source_registry_controls(conn, (seed,))
    assert command("from-history")["counts"]["suppressed"] == 1
    from dataclasses import replace

    seed_source_registry_controls(conn, (replace(seed, state=SourceState.ACTIVE),))
    run_deterministic_source_locator(conn, ())
    assert conn.execute("SELECT state FROM source_registry_entries").fetchone()[0] == "disabled"
    assert command("list")["candidates"] == []


def test_private_dns_and_malformed_history_never_reach_queue(workspace):
    conn = workspace
    seed_job(conn, "https://private.example/job")
    seed_job(conn, "http://127.0.0.1/job")
    result = command("from-history")
    assert result["counts"]["invalid"] == 2
    assert command("list")["candidates"] == []
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0


def test_failed_refresh_preserves_prior_proposals_and_rolls_back(workspace, monkeypatch):
    conn = workspace
    seed_job(conn, "https://jobs.lever.co/acme/1")
    command("from-history")
    accepted = command("list")
    seed_job(conn, "https://jobs.lever.co/other/2")
    original = proposals.propose_posting_source

    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        raise ValueError("Synthetic persistence failure")

    monkeypatch.setattr("jobctrl.infrastructure.discovery.production_wiring.propose_posting_source", fail_after_write)
    result = RUNNER.invoke(app, ["source-proposals", "from-history"])
    assert result.exit_code == 1
    assert command("list") == accepted


def test_cli_can_limit_proposals_to_one_canonical_job(workspace):
    conn = workspace
    selected = seed_job(conn, "https://jobs.lever.co/selected/1")
    seed_job(conn, "https://jobs.lever.co/unselected/2")
    assert command("from-history", "--job-id", selected)["counts"]["proposed"] == 1
    assert [row["candidate_url"] for row in command("list")["candidates"]] == ["https://jobs.lever.co/selected"]


def test_source_receipts_survive_canonical_job_deletion(workspace):
    conn = workspace
    job_id = seed_job(conn, "https://jobs.lever.co/retained/1")
    command("from-history")
    before = command("list")
    conn.execute("DELETE FROM jobs WHERE tenant_id = 'local' AND job_id = ?", (job_id,))
    conn.commit()
    assert command("list") == before


@pytest.mark.parametrize(
    ("first", "second"),
    [
        ("https://jobs.lever.co/acme/1", "https://jobs.eu.lever.co/acme/1"),
        ("https://boards.greenhouse.io/acme_team/jobs/1", "https://boards.greenhouse.io/acme-team/jobs/1"),
        ("https://www.example.com/job", "https://example.com/job"),
    ("https://foo.bar.com/job", "https://foo-bar.com/job"),
        ("https://acme.wd5.myworkdayjobs.com/Careers/job/1", "https://acme.wd5.myworkdayjobs.com/Students/job/1"),
    ],
)
def test_distinct_board_coordinates_cannot_share_a_proposal_source_id(first, second):
    assert proposals.source_coordinate(first).source_id != proposals.source_coordinate(second).source_id


def test_ordinary_learning_reuses_the_reviewed_coordinate(workspace):
    conn = workspace
    url = "https://boards.greenhouse.io/acme_team/jobs/1"
    seed_job(conn, url)
    command("from-history")
    candidate = command("list")["candidates"][0]
    conn.execute(
        "INSERT INTO source_registry_entries (tenant_id, source_id, kind, display_name, owner, priority, state, policy_id, seed_url, created_at, updated_at) VALUES ('local', 'greenhouse:acme_team', 'ats_api', 'Reviewed Acme', 'user', 'canonical', 'active', 'ats_api_canonical', ?, ?, ?)",
        (candidate["candidate_url"], NOW, NOW),
    )
    record_job_event(
        conn,
        None,
        "discover",
        "SourceLocationCandidateReviewed",
        entity_kind="discovery",
        entity_ref=candidate["candidate_url"],
        payload={
            "candidateId": candidate["candidate_id"],
            "coordinateKey": candidate["candidate_url"],
            "decision": "promote",
            "reason": "Synthetic review",
            "decidedAt": NOW,
        },
    )
    conn.execute("DELETE FROM source_locator_candidates")
    conn.commit()
    learn_posting_source_from_url(
        conn, job_url=url, posting_url=url, discovered_via_source_id="jobspy:linkedin", observed_at=NOW
    )
    assert [row[0] for row in conn.execute("SELECT source_id FROM source_registry_entries")] == ["greenhouse:acme_team"]
