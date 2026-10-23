"""Resolve an overflowing evidence menu within user-owned artifact limits."""

from dataclasses import replace
from collections.abc import Callable
from typing import Protocol

from pydantic import Field, StrictStr

from jobctrl.domain.determinations import Citation, DeterminationFailure, DeterminationModel, Source, determine
from jobctrl.domain.materials.quality import (
    ArtifactBudgetInfeasibleError,
    TailoringPlan,
    require_artifact_budget_feasible,
)
from jobctrl.domain.materials.requirement_coverage import UncoveredRequirement, UnusedAchievement
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.resume_profile import get_max_experience_bullets


class RequirementEvidenceSelection(DeterminationModel):
    requirement_id: StrictStr = Field(min_length=1, max_length=240)
    selected_edge_id: StrictStr | None = Field(
        description="One exact admitted edge ID for this requirement, or null with a reason for leaving it uncovered."
    )
    rationale: StrictStr = Field(min_length=1, max_length=1500)
    citations: list[Citation] = Field(min_length=1, max_length=8)


class MaterialEvidenceSelection(DeterminationModel):
    decisions: list[RequirementEvidenceSelection] = Field(max_length=200)


class MaterialEvidenceSelector(Protocol):
    def select(self, *, entity_id: str, profile_snapshot: ProfileSnapshot, plan: TailoringPlan) -> TailoringPlan: ...


class DeferredMaterialEvidenceSelector:
    """Do not initialize another provider for an already feasible seed."""

    def __init__(self, factory: Callable[[], MaterialEvidenceSelector]):
        self._factory = factory

    def select(self, *, entity_id, profile_snapshot, plan):
        return self._factory().select(entity_id=entity_id, profile_snapshot=profile_snapshot, plan=plan)


def resolve_artifact_budget(*, entity_id, profile_snapshot, plan, selector: MaterialEvidenceSelector | None):
    """Preserve feasible seeds and reject impossible pins before model spend."""
    profile = profile_snapshot.as_dict()
    try:
        require_artifact_budget_feasible(profile, plan)
        return plan
    except ArtifactBudgetInfeasibleError:
        if selector is None:
            raise
    require_artifact_budget_feasible(profile, replace(plan, coverage_graph=None))
    selected = selector.select(entity_id=entity_id, profile_snapshot=profile_snapshot, plan=plan)
    require_artifact_budget_feasible(profile, selected)
    return selected


class ModelMaterialEvidenceSelector:
    def __init__(self, *, llm, repository, tenant_id, provider, model, lane, preflight):
        self._llm, self._repository, self._tenant_id = llm, repository, tenant_id
        self._provider, self._model, self._lane, self._preflight = provider, model, lane, preflight

    def select(self, *, entity_id, profile_snapshot, plan):
        graph = plan.coverage_graph
        assert graph is not None
        profile = profile_snapshot.as_dict()
        requirements = {row.requirement_id: row for row in graph.requirements}
        edges = {edge.edge_id: edge for edge in (*graph.coverage_edges, *graph.alternative_edges)}
        evidence_ids = {edge.achievement_evidence_id for edge in edges.values()}
        sources = [
            Source(source_id="requirement:" + row.requirement_id, text=row.source_span or row.text)
            for row in graph.requirements
        ]
        sources.extend(
            Source(source_id=ident, text=plan.evidence_by_id[ident].source_text) for ident in sorted(evidence_ids)
        )

        def apply(result):
            selected = tuple(
                edges[row.selected_edge_id] for row in result.decisions if row.selected_edge_id is not None
            )
            selected_ids = {edge.achievement_evidence_id for edge in selected}
            decisions = {row.requirement_id: row for row in result.decisions}
            return replace(
                plan,
                coverage_graph=replace(
                    graph,
                    coverage_edges=selected,
                    alternative_edges=tuple(edge for edge in edges.values() if edge not in selected),
                    uncovered_requirements=tuple(
                        UncoveredRequirement(
                            requirement_id=ident,
                            reason=decisions[ident].rationale,
                            prohibited_claims=next(
                                (
                                    row.prohibited_claims
                                    for row in graph.uncovered_requirements
                                    if row.requirement_id == ident
                                ),
                                (),
                            ),
                        )
                        for ident in requirements
                        if decisions[ident].selected_edge_id is None
                    ),
                    unused_achievements=tuple(
                        UnusedAchievement(
                            achievement_evidence_id=row.achievement_evidence_id,
                            reason="Not selected for this artifact budget.",
                            pinned=row.pinned,
                        )
                        for row in graph.achievements
                        if row.achievement_evidence_id not in selected_ids
                    ),
                ),
            )

        def validate(result):
            ids = [row.requirement_id for row in result.decisions]
            if len(ids) != len(set(ids)):
                raise DeterminationFailure("duplicate_requirement_id")
            if set(ids) != set(requirements):
                raise DeterminationFailure(
                    "foreign_or_missing_requirement_id",
                    repair_context={"required_requirement_ids": sorted(requirements)},
                )
            for row in result.decisions:
                edge = edges.get(row.selected_edge_id) if row.selected_edge_id is not None else None
                if row.selected_edge_id is not None and (edge is None or edge.requirement_id != row.requirement_id):
                    raise DeterminationFailure(
                        "requirement_binding_invalid",
                        repair_context={
                            "requirement_id": row.requirement_id,
                            "allowed_edge_ids": [
                                edge.edge_id for edge in edges.values() if edge.requirement_id == row.requirement_id
                            ],
                        },
                    )
                required_citations = {"requirement:" + row.requirement_id}
                if edge is not None:
                    required_citations.add(edge.achievement_evidence_id)
                if {citation.source_id for citation in row.citations} != required_citations:
                    raise DeterminationFailure(
                        "missing_evidence_citation",
                        repair_context={
                            "requirement_id": row.requirement_id,
                            "required_source_ids": sorted(required_citations),
                        },
                    )
            try:
                require_artifact_budget_feasible(profile, apply(result))
            except ArtifactBudgetInfeasibleError as error:
                raise DeterminationFailure(
                    "field_binding_invalid",
                    repair_context={
                        "reason": "artifact_budget_exceeded",
                        "violations": [row.to_dict() for row in error.violations],
                    },
                ) from None

        result, envelope = determine(
            kind="material_evidence_selection",
            schema=MaterialEvidenceSelection,
            schema_version="1",
            prompt_version="material-evidence-selection-v1",
            instruction=(
                "Select a truthful, relevant resume evidence plan within the supplied per-role bullet ceiling. "
                "The seeded edges are a menu, not mandatory inclusion. Return one decision for EVERY supplied requirement. "
                "Select at most one admitted edge per requirement; the same achievement can cover several requirements and consumes one slot. "
                "Explicit user pins remain mandatory and also consume slots, even when their requirement is omitted. "
                "Prefer strong relevant coverage of important requirements, reuse supported evidence where appropriate, and use admitted alternatives from other roles. "
                "If all supported requirements cannot fit, leave the less useful ones uncovered with a specific rationale; never invent an edge, broaden a claim, or change the ceiling. "
                "Canonical context marked requires_generated_claim=false remains factual context rather than a new required bullet. "
                "Each decision must cite its requirement source; a selected edge must additionally cite its exact achievement source. "
                "Selection does not establish shipped coverage: independent factual and quality reviews still decide the generated artifact."
            ),
            sources=sources,
            context={
                "profile_version": profile_snapshot.version,
                "per_role_bullet_ceiling": get_max_experience_bullets(profile),
                "explicit_pins": plan.requirement_led_controls.required_content_pins.to_dict(),
                "required_evidence_ids": list(plan.required_evidence_ids),
                "coverage_graph": graph.to_dict(),
            },
            tenant_id=self._tenant_id,
            entity_id=entity_id,
            provider=self._provider,
            model=self._model,
            lane=self._lane,
            llm=self._llm,
            repository=self._repository,
            preflight=self._preflight,
            validate=validate,
        )
        return replace(apply(result), selection_determination_id=envelope.determination_id)
