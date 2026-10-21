"""Budgeted selection is a recorded model decision over canonical edges."""

from dataclasses import replace
import json
from pathlib import Path

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.evidence_selection import (
    DeferredMaterialEvidenceSelector,
    ModelMaterialEvidenceSelector,
    resolve_artifact_budget,
)
from jobctrl.domain.materials.quality import (
    ArtifactBudgetInfeasibleError,
    EvidencePlanItem,
    TailoringPlan,
    require_artifact_budget_feasible,
)
from jobctrl.domain.materials.requirement_coverage import AchievementNode, CoverageEdge, CoverageGraph, RequirementNode
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.llm_lanes import current_llm_lane
from jobctrl.domain.ports.llm import LlmFailure
from tests.test_artifact_determinations import connection
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository


def inputs(*, pins=()):
    texts = [f"Owned achievement {i}" for i in range(5)]
    profile = ProfileSnapshot(
        LOCAL_TENANT,
        "default",
        1,
        {
            "resume": {
                "experience_entries": [{"id": "role", "company": "Owned", "title": "Role", "bullets": texts}],
                "tailoring_rules": {
                    "max_experience_bullets": 4,
                    "required_experience_entry_ids": ["role"],
                    "required_bullets_by_experience_id": {"role": [texts[i] for i in pins]},
                },
            }
        },
    )
    evidence = tuple(
        EvidencePlanItem(
            evidence_id=f"e{i}",
            experience_entry_id="role",
            source_text=text,
            scope="Owned",
            action=text,
            metrics=(),
            tools=(),
            evidence_strength="verified",
            user_confirmed=True,
        )
        for i, text in enumerate(texts)
    )
    graph = CoverageGraph(
        requirements=tuple(
            RequirementNode(
                requirement_id=f"r{i}",
                text=f"Owned requirement {i}",
                tier="must_have",
                weight=1.0,
                source_span=f"Owned requirement {i}",
            )
            for i in range(5)
        ),
        achievements=tuple(
            AchievementNode(
                achievement_evidence_id=f"e{i}",
                experience_entry_id="role",
                source_text=text,
                metrics=(),
                tools=(),
                evidence_strength="verified",
                user_confirmed=True,
                pinned=i in pins,
            )
            for i, text in enumerate(texts)
        ),
        coverage_edges=tuple(
            CoverageEdge(
                edge_id=f"edge{i}",
                requirement_id=f"r{i}",
                achievement_evidence_id=f"e{i}",
                coverage_kind="direct",
                strength="strong",
                required_claim_policy="verified_only",
            )
            for i in range(5)
        ),
    )
    from jobctrl.domain.materials.policy import adapt_requirement_led_controls

    controls = adapt_requirement_led_controls(
        tailoring_policy={},
        writing_style={},
        revision_gates={},
        required_experience_entry_ids=("role",),
        required_bullets_by_experience_id={"role": [texts[i] for i in pins]},
        required_skills_by_category_id={},
        additional_guidance="",
    )
    plan = TailoringPlan(
        claim_mode="verified_only",
        auto_approvable_claim_modes=(),
        allow_adjacent_achievement_drafts=False,
        writing_style={},
        target_seniority="senior",
        evidence_items=evidence,
        required_evidence_ids=tuple(f"e{i}" for i in pins),
        coverage_graph=graph,
        requirement_led_controls=controls,
    )
    return profile, plan


class SelectionModel:
    reasoning_effort = "max"

    def __init__(self, omitted=4, fault=None):
        self.omitted, self.fault, self.calls = omitted, fault, []

    def chat_json(self, messages, *, response_schema, **kwargs):
        assert current_llm_lane() == "tailoring"
        self.calls.append(json.loads(messages[1].content))
        if isinstance(self.fault, Exception):
            raise self.fault
        if self.fault == "malformed":
            raise LlmFailure("invalid_json")
        decisions = [
            {
                "requirement_id": f"r{i}",
                "selected_edge_id": None if i == self.omitted else f"edge{i}",
                "rationale": "Explicit synthetic model selection",
                "citations": [
                    {"source_id": f"requirement:r{i}", "quote": f"Owned requirement {i}", "exact_values": []},
                    *(
                        []
                        if i == self.omitted
                        else [{"source_id": f"e{i}", "quote": f"Owned achievement {i}", "exact_values": []}]
                    ),
                ],
            }
            for i in range(5)
        ]
        if self.fault == "foreign":
            decisions[0]["selected_edge_id"] = "foreign"
        if self.fault == "duplicate":
            decisions[-1] = decisions[0]
        if self.fault == "missing":
            decisions.pop()
        if self.fault == "quote":
            decisions[0]["citations"][0]["quote"] = "Not canonical"
        if self.fault == "value":
            decisions[0]["citations"][0]["exact_values"] = ["12345"]
        if self.fault == "schema":
            decisions[0]["extra"] = True
        if self.fault == "overflow":
            decisions[-1]["selected_edge_id"] = "edge4"
            decisions[-1]["citations"].append({"source_id": "e4", "quote": "Owned achievement 4", "exact_values": []})
        return {"decisions": decisions}


def selector(conn, model, preflight=lambda: None):
    return ModelMaterialEvidenceSelector(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="synthetic",
        lane="tailoring",
        preflight=preflight,
    )


@pytest.mark.parametrize("omitted", [0, 4])
def test_opposite_model_selections_control_the_plan_and_persist_sources(omitted):
    conn, model = connection(), SelectionModel(omitted)
    profile, plan = inputs()
    resolved = resolve_artifact_budget(
        entity_id="owned-job", profile_snapshot=profile, plan=plan, selector=selector(conn, model)
    )
    assert {e.edge_id for e in resolved.coverage_graph.coverage_edges} == {f"edge{i}" for i in range(5) if i != omitted}
    assert [r.requirement_id for r in resolved.coverage_graph.uncovered_requirements] == [f"r{omitted}"]
    assert len(resolved.coverage_graph.alternative_edges) == 1
    require_artifact_budget_feasible(profile.as_dict(), resolved)
    receipt = conn.execute(
        "SELECT determination_id,envelope_json FROM semantic_determinations WHERE kind='material_evidence_selection'"
    ).fetchone()
    assert receipt and resolved.selection_determination_id == receipt[0]
    envelope = json.loads(receipt[1])
    assert envelope["reasoning_effort"] == "max" and envelope["lane"] == "tailoring"
    assert resolved.to_metadata()["selection_determination_id"] == receipt[0]
    assert model.calls[0]["context"]["profile_version"] == 1


def test_feasible_seed_and_impossible_pins_do_not_spend():
    conn, model = connection(), SelectionModel()
    profile, plan = inputs()
    feasible = replace(
        plan, coverage_graph=replace(plan.coverage_graph, coverage_edges=plan.coverage_graph.coverage_edges[:4])
    )
    assert (
        resolve_artifact_budget(
            entity_id="owned-job", profile_snapshot=profile, plan=feasible, selector=selector(conn, model)
        )
        is feasible
    )
    profile, plan = inputs(pins=tuple(range(5)))
    with pytest.raises(ArtifactBudgetInfeasibleError):
        resolve_artifact_budget(
            entity_id="owned-job", profile_snapshot=profile, plan=plan, selector=selector(conn, model)
        )
    assert model.calls == []


def test_pins_are_retained_even_when_the_model_omits_their_requirement():
    profile, plan = inputs(pins=(0,))
    with pytest.raises(DeterminationFailure, match="field_binding_invalid"):
        resolve_artifact_budget(
            entity_id="owned-job",
            profile_snapshot=profile,
            plan=plan,
            selector=selector(connection(), SelectionModel(omitted=0)),
        )
    # Omitting a different unpinned item yields a feasible plan with the pin intact.
    resolved = resolve_artifact_budget(
        entity_id="owned-job",
        profile_snapshot=profile,
        plan=plan,
        selector=selector(connection(), SelectionModel(omitted=4)),
    )
    assert resolved.required_evidence_ids == ("e0",)


def test_unchanged_input_reuses_selection_before_preflight_and_version_changes_invalidate():
    conn, model, calls = connection(), SelectionModel(), []
    profile, plan = inputs()
    port = selector(conn, model, lambda: calls.append("preflight"))
    first = resolve_artifact_budget(entity_id="owned-job", profile_snapshot=profile, plan=plan, selector=port)
    second = resolve_artifact_budget(entity_id="owned-job", profile_snapshot=profile, plan=plan, selector=port)
    assert first == second and len(model.calls) == len(calls) == 1
    resolve_artifact_budget(
        entity_id="owned-job", profile_snapshot=replace(profile, version=2), plan=plan, selector=port
    )
    assert len(model.calls) == len(calls) == 2


@pytest.mark.parametrize(
    ("fault", "code"),
    [
        ("foreign", "requirement_binding_invalid"),
        ("duplicate", "duplicate_requirement_id"),
        ("missing", "foreign_or_missing_requirement_id"),
        ("quote", "non_verbatim_quote"),
        ("value", "mismatched_value"),
        ("schema", "schema_violation"),
        ("malformed", "malformed_json"),
        ("overflow", "field_binding_invalid"),
        (LlmFailure("provider_unavailable"), "provider_unavailable"),
        (RuntimeError("private"), "provider_error"),
    ],
)
def test_selection_failures_are_distinct_and_never_persist_an_accepted_plan(fault, code):
    conn = connection()
    profile, plan = inputs()
    with pytest.raises(DeterminationFailure, match=code):
        resolve_artifact_budget(
            entity_id="owned-job",
            profile_snapshot=profile,
            plan=plan,
            selector=selector(conn, SelectionModel(fault=fault)),
        )
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM semantic_determinations WHERE kind='material_evidence_selection'"
        ).fetchone()[0]
        == 0
    )
    assert len(plan.coverage_graph.coverage_edges) == 5


def test_spend_denial_precedes_call():
    model = SelectionModel()
    profile, plan = inputs()

    def deny():
        raise DeterminationFailure("budget_denied")

    with pytest.raises(DeterminationFailure, match="budget_denied"):
        resolve_artifact_budget(
            entity_id="owned-job", profile_snapshot=profile, plan=plan, selector=selector(connection(), model, deny)
        )
    assert not model.calls


@pytest.mark.parametrize("fault", [RuntimeError("private"), LlmFailure("provider_unavailable"), "foreign", "overflow"])
def test_actual_resume_refresh_preserves_accepted_artifacts_when_selection_fails(tmp_path, monkeypatch, fault):
    from jobctrl.domain.materials import use_cases
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
    from tests.test_artifact_determinations import JOB_ID
    from tests.test_materials_use_cases import ResumeModel, request, resume_case

    conn = connection()
    accepted = resume_case(conn, ResumeModel()).execute(**request(tmp_path))
    assert accepted.materials.is_resume_approved
    before = SqliteMaterialsRepository(conn).load(LOCAL_TENANT, JOB_ID)
    artifact_bytes = Path(before.tailored_resume.path).read_bytes()
    profile, plan = inputs()
    monkeypatch.setattr(use_cases, "build_tailoring_plan", lambda *args, **kwargs: plan)
    args = request(tmp_path, retailor=True)
    args["profile_snapshot"] = profile
    model = ResumeModel()
    with pytest.raises(DeterminationFailure):
        resume_case(conn, model, evidence_selector=selector(conn, SelectionModel(fault=fault))).execute(**args)
    after = SqliteMaterialsRepository(conn).load(LOCAL_TENANT, JOB_ID)
    assert after.generation == before.generation and after.is_resume_approved
    assert after.tailored_resume.artifact_id == before.tailored_resume.artifact_id
    assert Path(after.tailored_resume.path).read_bytes() == artifact_bytes
    assert not model.generations


def test_actual_resume_entry_resolves_plan_before_generator_and_keeps_receipt(tmp_path, monkeypatch):
    from jobctrl.domain.materials import use_cases
    from tests.test_artifact_determinations import JOB_ID
    from tests.test_materials_use_cases import ResumeModel, request, resume_case

    conn, model = connection(), SelectionModel()
    profile, plan = inputs()
    monkeypatch.setattr(use_cases, "build_tailoring_plan", lambda *args, **kwargs: plan)
    case = resume_case(conn, ResumeModel(), evidence_selector=selector(conn, model))
    captured = []

    class ReachedGenerator(Exception):
        pass

    def capture(**kwargs):
        captured.append(kwargs["tailoring_plan"])
        raise ReachedGenerator

    monkeypatch.setattr(case, "_run_attempts", capture)
    args = request(tmp_path)
    args["profile_snapshot"] = profile
    with pytest.raises(ReachedGenerator):
        case.execute(**args)
    assert len(captured[0].coverage_graph.coverage_edges) == 4
    assert captured[0].selection_determination_id
    receipt = SqliteDeterminationRepository(conn).find("local", captured[0].selection_determination_id)
    assert receipt.entity_id == str(JOB_ID)


def test_production_builder_binds_selector_to_generator_not_judge(monkeypatch):
    import jobctrl.scoring.tailor as wiring
    import jobctrl.infrastructure.determinations as dependencies
    from tests.test_artifact_determinations import ports
    from tests.test_materials_use_cases import ResumeModel
    from jobctrl.domain.materials.use_cases import TailoringLlmPolicy

    conn, model = connection(), ResumeModel()
    selection_model = SelectionModel()
    verifier, quality = ports(conn, model)
    factory = dependencies.determination_dependencies
    routed = []

    def resolve(connection, *, model_spec=None, **kwargs):
        routed.append(model_spec)
        return {
            **factory(connection, **{**kwargs, "adapter": selection_model if model_spec else model}),
            "model": model_spec or "default",
        }

    monkeypatch.setattr(dependencies, "determination_dependencies", resolve)
    monkeypatch.setattr(wiring, "get_connection", lambda: conn)
    monkeypatch.setattr(wiring, "_build_voice_port", lambda: None)
    monkeypatch.setattr(wiring, "_build_pdf_renderer", lambda: None)
    case = wiring._build_use_case(
        llm_port=model,
        claim_verifier=verifier,
        quality_judge=quality,
        llm_policy=TailoringLlmPolicy(candidate_models=("codex:synthetic",), judge_model="codex:other"),
        analyze_use_case=object(),
    )
    assert isinstance(case._evidence_selector, DeferredMaterialEvidenceSelector)
    assert routed == [None]
    profile, plan = inputs()
    resolved = resolve_artifact_budget(
        entity_id="owned-job", profile_snapshot=profile, plan=plan, selector=case._evidence_selector
    )
    assert routed == [None, "codex:synthetic"]
    receipt = SqliteDeterminationRepository(conn).find("local", resolved.selection_determination_id)
    assert receipt.model == "codex:synthetic" and receipt.lane == "tailoring"
