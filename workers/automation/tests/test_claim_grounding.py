"""Claim-grounding domain tests: binding claims to shipped rendered lines."""

from __future__ import annotations

from jobhunter.domain.materials.claim_grounding import (
    GROUNDED_COVERAGE_BASIS,
    bullet_id_for_claim_location,
    enrich_provenance_requirements,
    ground_claim_mappings,
)
from jobhunter.domain.materials.provenance import BulletProvenance
from jobhunter.domain.materials.requirement_coverage import GeneratedClaimMapping
from jobhunter.domain.materials.value_objects import ControlRule, TransformType


def _mapping(
    *,
    claim_id: str = "claim_1",
    location: str = "experience.acme.bullets[0]",
    text: str = "Owned Python API reliability.",
    requirement_ids: tuple[str, ...] = ("r1",),
    evidence_ids: tuple[str, ...] = ("ev1",),
    coverage_edge_ids: tuple[str, ...] = ("edge_1",),
) -> GeneratedClaimMapping:
    return GeneratedClaimMapping(
        claim_id=claim_id,
        location=location,
        text=text,
        claim_label="evidence_reframed",
        coverage_edge_ids=coverage_edge_ids,
        requirement_ids=requirement_ids,
        evidence_ids=evidence_ids,
    )


def _row(
    bullet_id: str,
    generated_text: str,
    *,
    requirement_ids: tuple[str, ...] = (),
    evidence_ids: tuple[str, ...] = (),
) -> BulletProvenance:
    section = bullet_id.split(":", 1)[0].split("#", 1)[0]
    return BulletProvenance(
        bullet_id=bullet_id,
        section=section or "experience",
        source_id=None,
        evidence_ids=evidence_ids,
        requirement_ids=requirement_ids,
        matched_keywords=(),
        transform_type=TransformType.REPHRASE,
        control=ControlRule.REPHRASE_ALLOWED,
        rationale="",
        generated_text=generated_text,
    )


def test_location_maps_every_payload_surface_alias_to_a_bullet_id() -> None:
    assert bullet_id_for_claim_location("executive_profile") == "executive_profile#0"
    assert bullet_id_for_claim_location("summary") == "executive_profile#0"
    assert bullet_id_for_claim_location("resume.executive_profile") == "executive_profile#0"
    assert bullet_id_for_claim_location("experience.acme.bullets[2]") == "experience:acme#2"
    assert bullet_id_for_claim_location("experience_updates.acme.bullets[2]") == "experience:acme#2"
    assert bullet_id_for_claim_location("experience.acme.bullet[2]") == "experience:acme#2"
    assert bullet_id_for_claim_location("skills.core") == "skills:core#0"
    assert bullet_id_for_claim_location("skill_categories.core.items[3]") == "skills:core#0"
    assert bullet_id_for_claim_location("skill_category_updates.core") == "skills:core#0"
    assert bullet_id_for_claim_location("unknown.surface") is None


def test_claim_grounds_via_location_when_shipped_line_carries_its_text() -> None:
    grounding = ground_claim_mappings(
        (_mapping(),),
        (("experience:acme#0", "Owned Python API reliability."),),
    )

    assert grounding.basis == GROUNDED_COVERAGE_BASIS
    assert grounding.grounded_requirement_ids == ("r1",)
    assert grounding.claimed_only_requirement_ids == ()
    assert grounding.bindings[0].via == "location"
    assert grounding.bindings[0].bullet_ids == ("experience:acme#0",)


def test_claim_stays_grounded_to_voice_reworded_line_via_prior_text() -> None:
    """Voice keeps bullet identity 1:1; the claim binds the pre-voice wording."""
    grounding = ground_claim_mappings(
        (_mapping(),),
        (("experience:acme#0", "Drove Python API dependability end to end."),),
        prior_lines=(("experience:acme#0", "Owned Python API reliability."),),
    )

    assert grounding.grounded_requirement_ids == ("r1",)
    assert grounding.bindings[0].via == "location_prior_text"


def test_claim_for_policy_swapped_summary_is_ungrounded() -> None:
    """allow_summary_rewrite off: shipped line is the baseline, not the proposal.

    The claim's text binds neither the shipped baseline nor any prior text, so
    the requirement is claimed-only — the assembler swap can no longer launder a
    proposed-but-unshipped rewrite into coverage.
    """
    grounding = ground_claim_mappings(
        (
            _mapping(
                location="executive_profile",
                text="Visionary hub director who transformed intralogistics.",
            ),
        ),
        (("executive_profile#0", "Baseline profile summary from the master resume."),),
    )

    assert grounding.grounded_requirement_ids == ()
    assert grounding.claimed_only_requirement_ids == ("r1",)
    assert grounding.ungrounded[0].reason == "text_not_in_shipped_resume"


def test_claim_at_dropped_location_is_ungrounded_with_location_reason() -> None:
    grounding = ground_claim_mappings(
        (_mapping(location="experience.dropped.bullets[4]", text="Never ships."),),
        (("experience:acme#0", "Some other shipped line."),),
    )

    assert grounding.grounded_requirement_ids == ()
    assert grounding.ungrounded[0].reason == "location_not_shipped"


def test_claim_with_drifted_location_grounds_via_text_scan_fallback() -> None:
    grounding = ground_claim_mappings(
        (_mapping(location="unknown.surface", text="Owned Python API reliability."),),
        (
            ("experience:acme#0", "Unrelated line."),
            ("experience:acme#1", "Owned Python API reliability, cutting p99 latency."),
        ),
    )

    assert grounding.grounded_requirement_ids == ("r1",)
    assert grounding.bindings[0].via == "text_scan"
    assert grounding.bindings[0].bullet_ids == ("experience:acme#1",)


def test_skill_item_claim_binds_the_rendered_category_line() -> None:
    grounding = ground_claim_mappings(
        (_mapping(location="skill_categories.core.items[1]", text="Kubernetes"),),
        (("skills:core#0", "Core: Python, Kubernetes, Terraform"),),
    )

    assert grounding.grounded_requirement_ids == ("r1",)


def test_smart_punctuation_in_claim_text_still_binds_sanitized_shipped_line() -> None:
    grounding = ground_claim_mappings(
        (_mapping(text="Raised the team’s delivery bar."),),
        (("experience:acme#0", "Raised the team's delivery bar."),),
    )

    assert grounding.grounded_requirement_ids == ("r1",)


def test_non_requirement_claims_never_participate_in_coverage() -> None:
    mapping = GeneratedClaimMapping(
        claim_id="claim_pin",
        location="experience.acme.bullets[0]",
        text="Pinned bullet.",
        claim_label="pinned",
        non_requirement_reason="pinned",
    )
    grounding = ground_claim_mappings((mapping,), (("experience:acme#0", "Pinned bullet."),))

    assert grounding.bindings == ()
    assert grounding.ungrounded == ()


def test_enrichment_unions_claim_links_onto_the_carrying_row_only() -> None:
    rows = (
        _row("experience:acme#0", "Owned Python API reliability.", requirement_ids=("r9",)),
        _row("experience:acme#1", "Unrelated shipped line."),
    )
    grounding = ground_claim_mappings(
        (_mapping(requirement_ids=("r1", "r2"), evidence_ids=("ev1",)),),
        tuple((row.bullet_id, row.generated_text) for row in rows),
    )

    enriched = enrich_provenance_requirements(rows, grounding)

    assert enriched[0].requirement_ids == ("r1", "r2", "r9")
    assert enriched[0].evidence_ids == ("ev1",)
    assert enriched[1].requirement_ids == ()


def test_grounding_metadata_is_inspectable_for_the_audit_trail() -> None:
    grounding = ground_claim_mappings(
        (
            _mapping(),
            _mapping(
                claim_id="claim_2",
                location="experience.dropped.bullets[1]",
                text="Never ships.",
                requirement_ids=("r2",),
                coverage_edge_ids=("edge_2",),
            ),
        ),
        (("experience:acme#0", "Owned Python API reliability."),),
    )

    metadata = grounding.to_metadata()

    assert metadata["basis"] == GROUNDED_COVERAGE_BASIS
    assert metadata["grounded_claims"] == [
        {
            "claim_id": "claim_1",
            "requirement_ids": ["r1"],
            "bullet_ids": ["experience:acme#0"],
            "via": "location",
        }
    ]
    assert metadata["ungrounded_claims"] == [
        {
            "claim_id": "claim_2",
            "location": "experience.dropped.bullets[1]",
            "requirement_ids": ["r2"],
            "reason": "location_not_shipped",
        }
    ]
    assert metadata["claimed_only_requirement_ids"] == ["r2"]
