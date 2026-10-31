"""Lossless serialization contracts using owned synthetic value objects."""
from copy import deepcopy
from dataclasses import replace
import json

import pytest

from jobctrl.domain.materials.quality import TailoringPlan
from jobctrl.domain.materials.requirement_coverage import AchievementNode, CoverageGraph, TargetProfile


def plan(*, achievements=None, graph_achievements=None):
    if achievements is None:
        achievements = tuple(
            AchievementNode(
                achievement_evidence_id=f"owned-evidence-{index}", experience_entry_id="owned-entry",
                source_text=f"Owned source {index}: Unicode é, exact 10% and newline\\nretained.",
                metrics=("10%",), user_confirmed=True,
            )
            for index in range(3)
        )
    if graph_achievements is None:
        graph_achievements = achievements
    return TailoringPlan(
        claim_mode="verified_only", auto_approvable_claim_modes=("verified_only",),
        allow_adjacent_achievement_drafts=False, writing_style={"tone": "owned"},
        target_seniority="owned",
        target_profile=TargetProfile(
            job_id="owned-job", target_role="Owned role", seniority="owned",
            profile_achievements=achievements,
        ),
        coverage_graph=CoverageGraph(achievements=graph_achievements),
    )


@pytest.mark.parametrize("include_alternatives", [False, True])
def test_shared_catalogue_reconstructs_every_canonical_value_without_mutation(include_alternatives):
    value = plan()
    original = value.to_prompt_dict(include_alternatives=include_alternatives)
    metadata = deepcopy(value.to_metadata())
    projection = json.loads(value.to_prompt_json(include_alternatives=include_alternatives))
    assert projection["coverage_graph"]["achievements"] == {
        "$ref": "#/target_profile/profile_achievements",
    }
    projection.pop("prompt_encoding")
    projection["coverage_graph"]["achievements"] = deepcopy(projection["target_profile"]["profile_achievements"])
    assert projection == original
    assert value.to_prompt_dict(include_alternatives=include_alternatives) == original
    assert value.to_metadata() == metadata
    assert json.loads(value.to_prompt_context().split("\n", 1)[1]) == value.to_prompt_projection()


@pytest.mark.parametrize("difference", ["order", "source_text", "membership", "empty", "missing"])
def test_nonidentical_or_absent_catalogues_stay_inline(difference):
    value = plan()
    nodes = value.coverage_graph.achievements
    if difference == "order":
        graph = replace(value.coverage_graph, achievements=tuple(reversed(nodes)))
    elif difference == "source_text":
        graph = replace(value.coverage_graph, achievements=(replace(nodes[0], source_text="Different owned source"), *nodes[1:]))
    elif difference == "membership":
        graph = replace(value.coverage_graph, achievements=nodes[:1])
    elif difference == "empty":
        value = plan(achievements=(), graph_achievements=())
        graph = value.coverage_graph
    else:
        graph = None
    value = replace(value, coverage_graph=graph)
    assert value.to_prompt_projection() == value.to_prompt_dict()
    assert json.loads(value.to_prompt_json()) == value.to_prompt_dict()
