"""Model authority, source binding and native cutover in owned synthetic storage."""

import sqlite3
from dataclasses import replace
from pathlib import Path
import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository


class Model:
    def __init__(self, output):
        self.output = output
        self.calls = []

    def chat_json(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        if isinstance(self.output, Exception):
            raise self.output
        return self.output


def dependencies(conn, model, lane):
    return dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="synthetic",
        provider="fake",
        model="fake",
        lane=lane,
        preflight=lambda: None,
    )


def storage():
    conn = sqlite3.connect(":memory:")
    create_exact_v14_schema(conn)
    return conn


def citation(source, quote):
    return dict(source_id=source, quote=quote, exact_values=[])


def field(value, source="posting", quote="Synthetic"):
    return dict(value=value, citations=[citation(source, quote)], rationale="Model rationale")


def interpretation():
    from jobctrl.domain.enrichment.interpretation import JobInterpretation

    return JobInterpretation.model_validate(
        dict(
            track=field("ic"),
            seniority=field("senior"),
            occupation_family=field("software_engineering"),
            work_model=field("remote"),
            places=[
                dict(
                    country_code="ES",
                    region="europe",
                    locality=None,
                    citations=[citation("posting", "Synthetic")],
                    rationale="Model rationale",
                )
            ],
            constraints=[],
            requirements=[],
            compensation=[],
        )
    )


def test_page_availability_changes_only_with_the_model_and_cache_is_durable():
    from jobctrl.domain.enrichment.page_interpretation import ModelPageInterpreter
    from jobctrl.domain.enrichment.snapshot_services import ActiveStateVerifier
    from jobctrl.domain.enrichment.value_objects import DetailPage

    page = DetailPage(
        url="https://example.org/jobs/1", html="<main>Synthetic</main>", status=200, status_evidence_complete=True
    )
    for verdict in ("active", "closed"):
        conn = storage()
        model = Model(
            dict(
                availability=field(verdict, "rendered_page"),
                page_kind=field("posting", "rendered_page"),
                access_state=field("clear", "rendered_page"),
                apply_control=field("available", "rendered_page"),
            )
        )
        verifier = ActiveStateVerifier(page_interpreter=ModelPageInterpreter(**dependencies(conn, model, "enrichment")))
        signals = []
        assert verifier.verify(page, signals=signals)[0].value == verdict
        assert verifier.verify(page)[0].value == verdict
        assert len(model.calls) == 1
        assert (
            signals[0]["determination_id"]
            == conn.execute("SELECT determination_id FROM semantic_determinations").fetchone()[0]
        )
        conn.close()
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        ActiveStateVerifier(
            page_interpreter=ModelPageInterpreter(**dependencies(storage(), None, "enrichment"))
        ).verify(page)


def test_benchmark_codes_select_the_estimate_and_cite_the_cached_classification():
    from jobctrl.domain.compensation.classification import ModelBenchmarkClassifier
    from jobctrl.domain.compensation.market import ReportedCompensationObservation, estimate_market_compensation

    observation = ReportedCompensationObservation(
        source_id="levels_fyi",
        source_provenance="public",
        company_name="Synthetic",
        role_title="Synthetic",
        location="Synthetic",
        level_label="Synthetic",
        minimum_amount=100000,
        maximum_amount=200000,
        sample_count=10,
    )
    for family, state in [("software_engineering", "estimated_range"), ("sales", "insufficient_evidence")]:
        conn = storage()
        output = dict(
            occupation_family=field(family, "provider_row"),
            seniority=field("senior", "provider_row"),
            places=[
                dict(
                    country_code="ES",
                    region="europe",
                    locality=None,
                    citations=[citation("provider_row", "Synthetic")],
                    rationale="Model rationale",
                )
            ],
            market_scope=field("company", "provider_row"),
            company_tier=field("unknown", "provider_row"),
        )
        model = Model(output)
        classifier = ModelBenchmarkClassifier(**dependencies(conn, model, "compensation"))
        classified, envelope = classifier.classify(observation)
        classifier.classify(observation)
        assert len(model.calls) == 1
        estimate = estimate_market_compensation(
            job_id="11111111-1111-4111-8111-111111111111",
            title="Synthetic",
            company="Synthetic",
            location="Synthetic",
            observations=(replace(observation, classification=classified, determination_id=envelope.determination_id),),
            interpretation=interpretation(),
        )
        assert estimate.estimate_state == state
        if state == "estimated_range":
            assert estimate.evidence[0].determination_id == envelope.determination_id
        conn.close()


def test_pay_extraction_distinguishes_model_meaning_and_exact_number_failure():
    from jobctrl.domain.compensation.posted import ModelPostedPayExtractor, posted_fact_from_extraction

    text = "Synthetic 100000 200000"
    for state in ("parsed_range", "ambiguous"):
        conn = storage()
        output = dict(
            parse_state=state,
            currency="EUR",
            period="year",
            component="base_salary",
            minimum_amount=100000 if state == "parsed_range" else None,
            maximum_amount=200000 if state == "parsed_range" else None,
            confidence="high",
            warnings=[],
            citations=[citation("posted_compensation_source", text)],
            rationale="Model rationale",
        )
        extractor = ModelPostedPayExtractor(**dependencies(conn, Model(output), "compensation"))
        result, envelope = extractor.extract(text, entity_id="synthetic")
        fact = posted_fact_from_extraction(
            result,
            envelope,
            source_text=text,
            tenant_id="synthetic",
            job_id="11111111-1111-4111-8111-111111111111",
            source_field="posting",
        )
        assert fact.parse_state == state
        assert fact.maximum_amount == (200000 if state == "parsed_range" else None)
        conn.close()
    output["parse_state"] = "parsed_range"
    output["minimum_amount"] = 100001
    output["maximum_amount"] = 200000
    with pytest.raises(DeterminationFailure, match="mismatched_value"):
        ModelPostedPayExtractor(**dependencies(storage(), Model(output), "compensation")).extract(
            text, entity_id="synthetic"
        )


def test_message_outcome_has_no_phrase_order_or_fixed_confidence():
    from jobctrl.domain.feedback.message_interpretation import ModelMessageInterpreter

    for kind, confidence in [("offer", 0.4), ("rejection", 0.8)]:
        conn = storage()
        model = Model(
            dict(
                kind=kind,
                confidence=confidence,
                citations=[citation("message", "Synthetic")],
                rationale="Model rationale",
            )
        )
        service = ModelMessageInterpreter(**dependencies(conn, model, "enrichment"))
        result, envelope = service.outcome(message_id="synthetic", text="Synthetic")
        assert (result.kind, result.confidence) == (kind, confidence)
        assert envelope.result["kind"] == kind
        assert len(model.calls) == 1
        conn.close()
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        ModelMessageInterpreter(**dependencies(storage(), None, "enrichment")).outcome(
            message_id="synthetic", text="Synthetic"
        )


def test_message_link_foreign_application_and_ambiguous_result_fail_without_a_guess():
    from jobctrl.domain.feedback.message_interpretation import ModelMessageInterpreter

    conn = storage()
    output = dict(
        decision="linked",
        application_id="foreign",
        confidence=0.9,
        citations=[citation("message_headers", "Synthetic")],
        rationale="Model rationale",
    )
    service = ModelMessageInterpreter(**dependencies(conn, Model(output), "enrichment"))
    with pytest.raises(DeterminationFailure, match="foreign_source_id"):
        service.link(
            message_id="synthetic", headers={"subject": "Synthetic"}, applications={"owned": {"title": "Synthetic"}}
        )
    assert conn.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0] == 0
    output.update(decision="uncertain", application_id=None)
    result, _ = service.link(
        message_id="synthetic", headers={"subject": "Synthetic"}, applications={"owned": {"title": "Synthetic"}}
    )
    assert result.application_id is None
    conn.close()


def test_native_v12_to_v14_candidate_and_locked_activation_preserve_the_source(tmp_path: Path):
    from jobctrl.database import create_exact_v12_database, close_connection, open_exact_v14_database
    from jobctrl.infrastructure.migrations.legacy_to_v14_execute import execute_legacy_to_v14_candidate
    from jobctrl.infrastructure.migrations.v14_activation import bind_source, activate

    source = tmp_path / "source.sqlite"
    live = tmp_path / "live.sqlite"
    candidate = tmp_path / "candidate.sqlite"
    receipt = tmp_path / "binding.json"
    create_exact_v12_database(source)
    close_connection(source)
    live.write_bytes(source.read_bytes())
    before = source.read_bytes()
    result = execute_legacy_to_v14_candidate(source, candidate, source_version=12)
    assert result.user_version == 14 and source.read_bytes() == before
    assert candidate.stat().st_mode & 0o077 == 0
    bind_source(source, live, candidate, receipt)
    activate(live, candidate, receipt)
    conn = open_exact_v14_database(live)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 14
    close_connection(live)
    assert source.read_bytes() == before
