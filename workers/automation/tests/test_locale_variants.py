"""Structural model doubles exercise authority and identity, never language scoring."""

import json
import sqlite3

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.locale_variants import LocaleCommand
from jobctrl.domain.materials import (
    Artifact,
    ArtifactType,
    MaterialsSetFactory,
    RenderFormat,
    JudgeVerdict,
    ValidationResult,
)
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.materials.locale_variants import LocaleVariants
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.llm_lanes import current_llm_lane

JOB_ID = "90000000-0000-4000-8000-000000000039"


class Model:
    provider_id, model = "structural-double", "owned-test-model"

    def __init__(self, verdict="pass", fault=None, issue=None, mutate=None, callback=None):
        self.verdict, self.fault, self.issue, self.mutate, self.callback = verdict, fault, issue, mutate, callback
        self.calls = []

    def chat_json(self, messages, *, response_schema, **kwargs):
        self.calls.append((response_schema["title"], current_llm_lane()))
        if self.fault:
            raise self.fault
        data = json.loads(messages[1].content)
        sources = {row["source_id"]: row["text"] for row in data["sources"]}
        title = response_schema["title"]
        if title == "LocaleTranslation":
            result = dict(
                lines=[
                    dict(
                        line_id=row["line_id"],
                        text=row["text"],
                        source=dict(source_id=row["line_id"], quote=row["text"], exact_values=[]),
                    )
                    for row in data["context"]["binding"]["lines"]
                ],
                issues=[],
            )
            if self.issue:
                row = result["lines"][0]
                result["issues"] = [
                    dict(
                        line_id=row["line_id"],
                        kind=self.issue,
                        citation=row["source"],
                        explanation="Explicit structural model issue",
                    )
                ]
            if self.mutate:
                self.mutate(result)
            if self.callback:
                self.callback()
            return result
        if title == "LocaleReview":
            return dict(
                verdict=self.verdict,
                terminology=self.verdict,
                formatting=self.verdict,
                issues=[],
                rationale="Independent model verdict",
            )
        if title == "ClaimVerification":
            return dict(
                verdict=self.verdict,
                rationale="Source-bound model verdict",
                lines=[
                    dict(
                        line_id=row["line_id"],
                        verdict=self.verdict,
                        served_requirements=[],
                        source_evidence=[
                            dict(source_id=sid, quote=sources[sid], exact_values=[])
                            for sid in row["allowed_evidence_ids"]
                        ],
                        claims=[],
                        findings=[],
                    )
                    for row in data["context"]["lines"]
                ],
            )
        if title == "ArtifactQuality":
            return dict(
                verdict=self.verdict,
                score=0.8,
                findings=[],
                evidence_corrections=[],
                rationale="Independent usefulness verdict",
            )
        raise AssertionError(title)


def setup_case(tmp_path, model=None, preflight=lambda: None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    create_exact_v14_schema(conn)
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,title,company,discovered_at) VALUES ('local',?,'https://example.test/locale','Synthetic role','Synthetic employer','2026-10-08')",
        (JOB_ID,),
    )
    repo = SqliteProfileRepository(conn, publisher=InProcessEventBus())
    repo.save(
        LOCAL_TENANT,
        Profile.from_dict(
            LOCAL_TENANT,
            {
                "personal": {"full_name": "Synthetic Person"},
                "resume": {
                    "experience_entries": [
                        {
                            "id": "owned",
                            "company": "Synthetic Employer",
                            "title": "Historical Title",
                            "date_range": "2020 - 2024",
                            "bullets": ["Owned description"],
                            "achievement_evidence": [
                                {"id": "fact", "source_text": "Owned description 42", "user_confirmed": True}
                            ],
                        }
                    ],
                    "education_entries": [
                        {
                            "id": "degree",
                            "degree": "Original Credential",
                            "institution": "Synthetic Institute",
                            "date": "2019",
                        }
                    ],
                },
            },
        ),
    )
    path = tmp_path / "source.txt"
    path.write_text(
        "Synthetic Person\nHistorical Title · Synthetic Employer · 2020 - 2024\nOwned description 42\nOriginal Credential · Synthetic Institute · 2019\n"
    )
    artifact = Artifact.create(
        type=ArtifactType.TAILORED_RESUME, path=str(path), created_at="2026-10-08", render_format=RenderFormat.TEXT
    )
    materials = MaterialsSetFactory.initial(
        tenant_id=LOCAL_TENANT, job_id=JOB_ID, created_at="2026-10-08"
    ).with_resume_attempt(
        artifact, validation=ValidationResult.success(), verdict=JudgeVerdict.passed(), updated_at="2026-10-08"
    )
    SqliteMaterialsRepository(conn).save(materials)
    conn.commit()
    model = model or Model()
    dependencies = dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider=model.provider_id,
        model=model.model,
        lane="tailoring",
        preflight=preflight,
    )
    owner = LocaleVariants(conn, app_dir=tmp_path, dependencies=dependencies)
    command = LocaleCommand(
        operation="generate", jobId=JOB_ID, artifactId=artifact.artifact_id, sourceLocale="en", targetLocale="es"
    )
    return owner, command, model, materials, path


def test_generation_records_four_independent_authorities_and_reuses_same_input(tmp_path):
    preflights = []
    owner, command, model, _, path = setup_case(tmp_path, preflight=lambda: preflights.append(current_llm_lane()))
    original = path.read_bytes()
    result = owner.execute(command)
    variant = result["variants"][0]
    assert result["revision"] == 1 and variant["eligible"]
    assert variant["binding"]["sourceHash"] and variant["binding"]["facts"]
    assert len(variant["determinations"]) == 4
    assert preflights == ["tailoring"] * 4
    assert path.read_bytes() == original
    assert owner.execute(command.model_copy(update={"expectedRevision": 1})) == result
    assert len(model.calls) == 4
    assert all(lane == "tailoring" for _, lane in model.calls)


def test_opposing_model_verdicts_change_acceptance_on_identical_source(tmp_path):
    outcomes = []
    for verdict in ["pass", "fail"]:
        owner, command, _, _, _ = setup_case(tmp_path / verdict, Model(verdict=verdict))
        outcomes.append(owner.generate(command)["variants"][0]["eligible"])
    assert outcomes == [True, False]


@pytest.mark.parametrize(
    "issue", ["missing_term", "unsupported_language", "factual_uncertainty", "ambiguous_credential"]
)
def test_issues_remain_visible_and_only_original_credential_warning_is_reviewable(tmp_path, issue):
    owner, command, _, _, _ = setup_case(tmp_path, Model(issue=issue))
    variant = owner.generate(command)["variants"][0]
    assert variant["issues"][0]["kind"] == issue
    assert variant["eligible"] is (issue == "ambiguous_credential")


@pytest.mark.parametrize(
    "fault,code",
    [
        (DeterminationFailure("provider_unavailable"), "provider_unavailable"),
        (RuntimeError("offline"), "provider_error"),
        (json.JSONDecodeError("invalid", "!", 0), "malformed_json"),
    ],
)
def test_failed_generation_never_mutates_original_or_creates_history(tmp_path, fault, code):
    owner, command, _, _, path = setup_case(tmp_path, Model(fault=fault))
    original = path.read_bytes()
    with pytest.raises(DeterminationFailure, match=code):
        owner.generate(command)
    assert path.read_bytes() == original
    assert owner.history(JOB_ID)["variants"] == []


def test_budget_denial_precedes_model_calls(tmp_path):
    def deny():
        raise RuntimeError("denied")

    owner, command, model, _, _ = setup_case(tmp_path, preflight=deny)
    with pytest.raises(DeterminationFailure, match="budget_denied"):
        owner.generate(command)
    assert model.calls == []


@pytest.mark.parametrize(
    "mutate,code",
    [
        (lambda result: result.update(extra=True), "schema_violation"),
        (lambda result: result["lines"][0].update(line_id="foreign"), "foreign_or_missing_line_id"),
        (lambda result: result["lines"].pop(), "foreign_or_missing_line_id"),
        (lambda result: result["lines"].append(result["lines"][0]), "foreign_or_missing_line_id"),
        (lambda result: result["lines"][0]["source"].update(source_id="foreign"), "foreign_source_id"),
        (lambda result: result["lines"][0]["source"].update(quote="fabricated"), "non_verbatim_quote"),
        (lambda result: result["lines"][0]["source"].update(quote="Synthetic"), "source_line_binding_invalid"),
        (lambda result: result["lines"][2].update(text="Owned description 43"), "changed_exact_value"),
        (
            lambda result: result["lines"][1].update(text="Different Title · Synthetic Employer · 2020 - 2024"),
            "changed_historical_value",
        ),
        (
            lambda result: result["lines"][3].update(text="Equivalent Credential · Synthetic Institute · 2019"),
            "changed_historical_value",
        ),
    ],
)
def test_strict_translation_failures(tmp_path, mutate, code):
    owner, command, _, _, path = setup_case(tmp_path, Model(mutate=mutate))
    original = path.read_bytes()
    with pytest.raises(DeterminationFailure, match=code):
        owner.generate(command)
    assert owner.history(JOB_ID)["variants"] == [] and path.read_bytes() == original


@pytest.mark.parametrize("locale", ["xx", "en"])
def test_unsupported_or_identical_locale_fails_without_spend(tmp_path, locale):
    owner, command, model, _, _ = setup_case(tmp_path)
    with pytest.raises(DeterminationFailure):
        owner.generate(command.model_copy(update={"targetLocale": locale}))
    assert model.calls == []


def test_source_drift_during_call_is_fenced_before_next_spend(tmp_path):
    owner, command, model, _, path = setup_case(tmp_path)
    model.callback = lambda: path.write_text("Concurrent source")
    with pytest.raises(DeterminationFailure, match="stale_source_or_profile"):
        owner.generate(command)
    assert len(model.calls) == 1 and owner.history(JOB_ID)["variants"] == []


def test_unrelated_materials_writer_preserves_newer_locale_namespace(tmp_path):
    owner, command, _, materials, _ = setup_case(tmp_path)
    result = owner.generate(command)
    SqliteMaterialsRepository(owner.conn).save(
        materials.with_metadata({"companion_screening": {"kept": True}}, updated_at="2026-10-09")
    )
    owner.conn.commit()
    assert owner.history(JOB_ID) == result
    metadata = json.loads(owner.conn.execute("SELECT metadata_json FROM job_materials").fetchone()[0])
    assert metadata["companion_screening"] == {"kept": True}


def test_stale_revision_and_foreign_tenant_fail_without_calls(tmp_path):
    owner, command, model, _, _ = setup_case(tmp_path)
    with pytest.raises(DeterminationFailure, match="stale_locale_revision"):
        owner.generate(command.model_copy(update={"expectedRevision": 2}))
    owner.tenant = "foreign"
    with pytest.raises(DeterminationFailure, match="unknown_job"):
        owner.generate(command)
    assert model.calls == []


def test_legacy_metadata_does_not_manufacture_provenance(tmp_path):
    owner, _, model, _, _ = setup_case(tmp_path)
    result = owner.history(JOB_ID)
    assert result["variants"] == [] and result["revision"] == 0 and model.calls == []
