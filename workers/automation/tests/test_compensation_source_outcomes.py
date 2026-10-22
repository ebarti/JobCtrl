"""Owned structural source/receipt checks; no external sites or semantic evals."""

import hashlib
import json
from urllib.error import HTTPError

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.compensation.levels_fyi_public import (
    LevelsFyiPublicTarget,
    load_levels_fyi_public_observations,
)
from jobctrl.infrastructure.compensation.sqlite_market_repository import (
    ReportedCompensationSourceLoad,
    load_default_reported_compensation_observations,
)
from tests.compensation_fakes import (
    FRESH, ClassificationModel, configure_classifier, observation, put_job, refresh,
)


MARKDOWN = """# Levels.fyi – Software Engineer Salary in Spain
**Location:** Spain
**Currency:** EUR
## Aggregate Highlights
- Median Total Compensation: €60,000
- 25th / 75th Percentile: €40,000 / €80,000
"""


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "owned-source-outcomes.sqlite"
    conn = init_db(path)
    yield conn
    close_connection(path)


def public_load(tmp_path, monkeypatch, targets, fetch, *, max_pages=25):
    settings = tmp_path / "source-settings.json"
    settings.write_text(json.dumps({"compensation_sources": {
        "levels_fyi": {"enabled": True, "access_mode": "public_markdown"},
    }}))
    monkeypatch.setattr(
        "jobctrl.infrastructure.compensation.sqlite_market_repository._levels_fyi_public_fetcher",
        lambda *_args, **_kwargs: fetch,
    )
    return load_default_reported_compensation_observations(
        levels_fyi_targets=targets, levels_fyi_public_max_pages=max_pages,
        include_eurotoptech=False, env={}, settings_path=settings,
    )


def test_unsupported_role_does_not_inherit_another_targets_http_failure(database, tmp_path, monkeypatch):
    put_job(database, family="engineering_management", seniority="director")
    put_job(database, job_id="22222222-2222-4222-8222-222222222222", family="operations", seniority="director")
    requests = []

    def fetch(url):
        requests.append(url)
        raise HTTPError(url, 403, "sensitive exception message", {}, None)

    result = refresh(database, load=lambda targets: public_load(tmp_path, monkeypatch, targets, fetch))
    states = {r[0]: tuple(r[1:]) for r in database.execute(
        "SELECT role_family_code,refresh_status,last_error_code FROM compensation_market_refresh_state",
    )}
    assert states["engineering_management"] == ("failed", "levels_fyi_public_unavailable")
    assert states["operations"][0] == "insufficient_evidence"
    assert states["operations"][1] != "levels_fyi_public_unavailable"
    assert result.failed_results == result.insufficient_results == 1
    assert requests == [
        "https://www.levels.fyi/t/software-engineering-manager/locations/spain.md",
        "https://www.levels.fyi/t/software-engineering-manager/locations/spain",
    ]


def test_derivation_failure_does_not_inherit_into_an_independent_slice(database, monkeypatch):
    put_job(database, family="engineering_management")
    put_job(database, job_id="22222222-2222-4222-8222-222222222222", family="operations")

    def derive(_repository, benchmark_slice, **_kwargs):
        if benchmark_slice.role_family_code == "engineering_management":
            raise ValueError("synthetic derivation failure")
        return None, "missing_market_anchor"

    monkeypatch.setattr("jobctrl.infrastructure.compensation.automatic_refresh._derive_extrapolated_for_slice", derive)
    result = refresh(database, rows=())
    states = {r[0]: tuple(r[1:]) for r in database.execute(
        "SELECT role_family_code,refresh_status,last_error_code FROM compensation_market_refresh_state",
    )}
    assert states["engineering_management"] == ("failed", "benchmark_derivation_failed")
    assert states["operations"] == ("insufficient_evidence", "missing_market_anchor")
    assert result.failed_results == result.insufficient_results == 1


def test_http_failure_is_scoped_by_country_and_unsupported_coverage(tmp_path, monkeypatch):
    es = LevelsFyiPublicTarget("software_engineering", "ES")
    pt = LevelsFyiPublicTarget("software_engineering", "PT")
    unsupported = LevelsFyiPublicTarget("operations", "ES", "director")

    def fetch(url):
        if "/spain" in url:
            raise HTTPError(url, 403, "credential=must-not-be-retained", {}, None)
        return MARKDOWN

    loaded = public_load(tmp_path, monkeypatch, (es, pt, unsupported), fetch)
    targets = {outcome.target: outcome for outcome in loaded.levels_fyi_target_outcomes}
    assert targets[es].failed and not targets[pt].failed
    assert targets[unsupported].coverage == "unsupported_role" and not targets[unsupported].failed
    assert targets[unsupported].requests == ()
    assert all(request.http_status == 403 for request in targets[es].requests)
    body = json.dumps([outcome.as_dict() for outcome in targets.values()])
    assert "must-not-be-retained" not in body and MARKDOWN not in body
    assert targets[pt].requests[0].snapshot_sha256 == hashlib.sha256(MARKDOWN.encode()).hexdigest()
    assert loaded.source_errors == ("levels_fyi_public_unavailable",)


@pytest.mark.parametrize("value,status", [(None, "unavailable"), ("", "empty"), (" \n", "empty"), ("not a salary structure", "available")])
def test_empty_and_incompatible_bodies_remain_distinct(value, status):
    outcomes = []
    assert load_levels_fyi_public_observations(
        (LevelsFyiPublicTarget("software_engineering", "ES"),),
        fetch_text=lambda _url: value, on_load_outcome=outcomes.append,
    ) == ()
    target, = outcomes[0].targets
    assert target.failed
    assert {request.status for request in target.requests} == {status}
    if value and value.strip():
        assert all(request.parse_status == "unparsed" for request in target.requests)


def test_parser_exception_keeps_body_hash_without_error_or_body_text(monkeypatch):
    def broken(*_args, **_kwargs):
        raise ValueError("secret diagnostic contents")

    monkeypatch.setattr("jobctrl.infrastructure.compensation.levels_fyi_public.parse_levels_fyi_markdown", broken)
    outcomes = []
    load_levels_fyi_public_observations(
        (LevelsFyiPublicTarget("software_engineering", "ES"),),
        fetch_text=lambda url: "synthetic body" if url.endswith(".md") else None,
        on_load_outcome=outcomes.append,
    )
    target, = outcomes[0].targets
    assert target.failed and target.requests[0].parse_status == "parse_error"
    assert target.requests[0].snapshot_sha256 == hashlib.sha256(b"synthetic body").hexdigest()
    assert "secret diagnostic contents" not in json.dumps(target.as_dict())


def test_later_level_cache_upgrade_cannot_rewrite_generic_target_success():
    generic = LevelsFyiPublicTarget("software_engineering", "ES")
    principal = LevelsFyiPublicTarget("software_engineering", "ES", "principal")
    outcomes = []

    def fetch(url):
        if url.endswith(".md"):
            return MARKDOWN
        raise HTTPError(url, 403, "unavailable", {}, None)

    load_levels_fyi_public_observations((generic, principal), fetch_text=fetch, on_load_outcome=outcomes.append)
    targets = {outcome.target: outcome for outcome in outcomes[0].targets}
    assert not targets[generic].failed and len(targets[generic].requests) == 1
    assert targets[principal].failed and len(targets[principal].requests) == 2
    assert targets[principal].requests[-1].http_status == 403


def test_unattempted_budget_denial_and_unsupported_country_are_explicit():
    supported = LevelsFyiPublicTarget("software_engineering", "ES")
    unsupported = LevelsFyiPublicTarget("software_engineering", None)
    outcomes = []
    load_levels_fyi_public_observations(
        (supported, supported, unsupported), max_pages=0,
        fetch_text=lambda _url: pytest.fail("page allowance is zero"), on_load_outcome=outcomes.append,
    )
    targets = {outcome.target: outcome for outcome in outcomes[0].targets}
    assert len(targets) == 2
    assert targets[supported].failed and targets[supported].page_budget_exhausted
    assert targets[supported].requested_pages == 0 and targets[supported].requests == ()
    assert targets[unsupported].coverage == "unsupported_country" and not targets[unsupported].failed


def test_cached_rejection_receipt_joins_exact_source_and_determination(database, monkeypatch):
    from jobctrl.domain.compensation.classification import benchmark_classification_source

    put_job(database)
    model = ClassificationModel(family="unknown")
    configure_classifier(monkeypatch, model)
    row = observation()
    first = refresh(database, rows=(row,))
    second = refresh(database, now=FRESH, rows=(row,))
    assert len(model.calls) == 1
    for result in (first, second):
        diagnostics = result.diagnostics
        receipt, = diagnostics["rejectedObservations"]
        assert diagnostics["tenantId"] == "local" and diagnostics["owner"] == "synthetic-refresh"
        assert receipt["reason"] == "missing_role_family" and receipt["sourceId"] == row.source_id
        assert receipt["sourceFingerprint"] == receipt["classificationEntityId"] == benchmark_classification_source(row)[0]
        stored = database.execute("SELECT entity_id FROM semantic_determinations WHERE determination_id=?", (receipt["classificationId"],)).fetchone()
        assert stored[0] == receipt["classificationEntityId"]
        assert result.as_dict()["diagnostics"] == diagnostics
    assert first.diagnostics["rejectedObservations"] == second.diagnostics["rejectedObservations"]


def test_rejection_receipt_payload_is_bounded_and_discloses_omissions(database, monkeypatch):
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel(family="unknown"))
    result = refresh(database, rows=(observation(),) * 129)
    assert result.observations_rejected == 129
    assert len(result.diagnostics["rejectedObservations"]) == 128
    assert result.diagnostics["rejectedObservationsOmitted"] == 1


def test_legacy_source_error_without_target_receipt_stays_a_failure(database):
    put_job(database, family="operations")
    result = refresh(database, load=lambda _targets: ReportedCompensationSourceLoad(
        observations=(), source_errors=("levels_fyi_public_unavailable",),
    ))
    assert result.failed_results == 1 and result.insufficient_results == 0


def test_typed_failed_target_does_not_depend_on_a_duplicate_global_error(database):
    from jobctrl.infrastructure.compensation.levels_fyi_public import LevelsFyiPublicTargetOutcome

    put_job(database)
    result = refresh(database, load=lambda _targets: ReportedCompensationSourceLoad(
        observations=(), levels_fyi_target_outcomes=(LevelsFyiPublicTargetOutcome(
            LevelsFyiPublicTarget("software_engineering", "ES", "senior"),
            "supported", requested_pages=1, reachable_pages=0,
        ),),
    ))
    assert result.failed_results == 1 and result.insufficient_results == 0
    assert "levels_fyi_public_unavailable" in result.warnings


def test_target_receipt_count_and_large_public_request_are_bounded(database):
    from jobctrl.infrastructure.compensation.levels_fyi_public import (
        LevelsFyiPublicRequestOutcome, LevelsFyiPublicTargetOutcome,
    )

    put_job(database)
    unsupported = tuple(LevelsFyiPublicTargetOutcome(
        LevelsFyiPublicTarget(f"unmapped-{index}", "ES"), "unsupported_role",
    ) for index in range(129))
    result = refresh(database, load=lambda _targets: ReportedCompensationSourceLoad(
        observations=(), levels_fyi_target_outcomes=unsupported,
    ))
    assert len(result.diagnostics["levelsFyiTargets"]) == 128
    assert result.diagnostics["levelsFyiTargetsOmitted"] == 1
    # Force another due refresh with a deliberately oversized synthetic URL.
    huge = LevelsFyiPublicTargetOutcome(
        LevelsFyiPublicTarget("software_engineering", "ES", "senior"), "supported",
        requested_pages=1, requests=(LevelsFyiPublicRequestOutcome(
            "https://www.levels.fyi/" + "a" * (256 * 1024), "unavailable",
        ),),
    )
    result = refresh(database, now=FRESH, load=lambda _targets: ReportedCompensationSourceLoad(
        observations=(), levels_fyi_target_outcomes=(huge,),
    ))
    assert result.failed_results == 1
    assert result.diagnostics["levelsFyiTargets"] == [] and result.diagnostics["levelsFyiTargetsOmitted"] == 1
    assert len(json.dumps(result.diagnostics).encode()) < 1024


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["rejection", "target"])
@pytest.mark.parametrize("unicode_characters", [20_000, 60_000])
async def test_unicode_receipt_limit_matches_temporal_wire_encoding(
    database, monkeypatch, kind, unicode_characters,
):
    from temporalio.converter import DataConverter
    from jobctrl.infrastructure.compensation.automatic_refresh import MAX_RECEIPT_LIST_BYTES
    from jobctrl.infrastructure.compensation.levels_fyi_public import (
        LevelsFyiPublicRequestOutcome, LevelsFyiPublicTargetOutcome,
    )

    put_job(database)
    synthetic_id = "é" * unicode_characters
    if kind == "rejection":
        configure_classifier(monkeypatch, ClassificationModel(family="unknown"))
        result = refresh(database, rows=(observation(snapshot=synthetic_id),))
        key = "rejectedObservations"
    else:
        target = LevelsFyiPublicTargetOutcome(
            LevelsFyiPublicTarget("software_engineering", "ES", "senior"), "supported",
            requested_pages=1, requests=(LevelsFyiPublicRequestOutcome(
                "https://www.levels.fyi/" + synthetic_id, "unavailable",
            ),),
        )
        result = refresh(database, load=lambda _targets: ReportedCompensationSourceLoad(
            observations=(), levels_fyi_target_outcomes=(target,),
        ))
        key = "levelsFyiTargets"
    receipts = result.diagnostics[key]
    payload, = await DataConverter.default.encode([receipts])
    assert len(payload.data) <= MAX_RECEIPT_LIST_BYTES
    assert result.diagnostics[key + "Omitted"] == int(unicode_characters == 60_000)
    decoded, = await DataConverter.default.decode([payload])
    assert decoded == receipts
    if unicode_characters == 20_000:
        assert len(receipts) == 1
        if kind == "rejection":
            assert receipts[0]["sourceSnapshotId"] == synthetic_id
        else:
            assert receipts[0]["requests"][0]["url"] == "https://www.levels.fyi/" + synthetic_id
