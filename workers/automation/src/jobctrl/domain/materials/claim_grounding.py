"""Ground generated claim mappings against the SHIPPED rendered resume lines.

The revision gate and the requirement-led audit must describe the same artifact
with the same criterion, or the review surface shows a self-contradiction (a
judge-claimed "must-have coverage 100%" next to provenance-backed chips saying
half the must-haves never shipped). This module is the single owner of that
criterion: a claim counts toward requirement coverage ONLY when it is grounded
to a line the resume actually ships.

Grounding rule (deterministic, no LLM):

  * Only mappings that carry ``coverage_edge_ids`` participate — non-requirement
    claims (pinned/positioning/structure) never count toward coverage.
  * A mapping grounds via its **location** when the location resolves to a
    shipped bullet id AND the claim text is present in that line's shipped text
    (or, for a voice-reworded line, in the same line's pre-voice text — the text
    the claim was validated against; voice preserves bullet identity 1:1 and is
    separately fabrication-gated).
  * Otherwise it may ground via a **text scan** over all shipped lines — the
    resilience fallback for location alias drift.
  * A mapping that grounds nowhere is UNGROUNDED and its requirements are
    ``claimed_only``: asserted by the model, absent from the shipped artifact.
    ``claimed_only`` requirements are NOT covered.

The assembler-mirroring provenance builder supplies the shipped lines, so
policy gating falls out automatically: when ``allow_summary_rewrite`` is off the
shipped executive-profile line is the profile baseline, a claim written for the
model's proposed rewrite binds to neither shipped nor prior text, and the claim
is honestly ungrounded.

This module is pure (no I/O, no LLM).
"""

from __future__ import annotations

import re
from collections.abc import Iterable as IterableABC
from dataclasses import dataclass, replace
from typing import Any

from jobctrl.domain.materials.provenance import BulletProvenance
from jobctrl.domain.materials.requirement_coverage import GeneratedClaimMapping
from jobctrl.domain.materials.services import sanitize_text

GROUNDED_COVERAGE_BASIS = "grounded_shipped_text_v1"

_EXPERIENCE_LOCATION_RE = re.compile(
    r"^(?:experience|experience_updates)\.(?P<entry_id>[^.\[\]]+)\.bullets\[(?P<index>\d+)\]$"
)
_SKILLS_LOCATION_RE = re.compile(
    r"^(?:skills|skill_categories|skill_category_updates)\.(?P<category_id>[^.\[\]]+)"
    r"(?:\.items\[\d+\])?$"
)
_SUMMARY_LOCATIONS = frozenset({"executive_profile", "summary", "resume.executive_profile"})


@dataclass(frozen=True)
class GroundedClaimBinding:
    """One claim bound to the shipped line(s) that carry it."""

    claim_id: str
    requirement_ids: tuple[str, ...]
    evidence_ids: tuple[str, ...]
    bullet_ids: tuple[str, ...]
    via: str  # "location" | "location_prior_text" | "text_scan"


@dataclass(frozen=True)
class UngroundedClaim:
    """A coverage-bearing claim whose text ships nowhere in the rendered resume."""

    claim_id: str
    location: str
    requirement_ids: tuple[str, ...]
    reason: str  # "location_not_shipped" | "text_not_in_shipped_resume"


@dataclass(frozen=True)
class ClaimGrounding:
    """The grounded view of one payload's claim mappings against its shipped lines."""

    bindings: tuple[GroundedClaimBinding, ...]
    ungrounded: tuple[UngroundedClaim, ...]
    basis: str = GROUNDED_COVERAGE_BASIS

    @property
    def grounded_requirement_ids(self) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                requirement_id
                for binding in self.bindings
                for requirement_id in binding.requirement_ids
            )
        )

    @property
    def claimed_only_requirement_ids(self) -> tuple[str, ...]:
        grounded = set(self.grounded_requirement_ids)
        return tuple(
            dict.fromkeys(
                requirement_id
                for claim in self.ungrounded
                for requirement_id in claim.requirement_ids
                if requirement_id not in grounded
            )
        )

    def requirement_ids_for_bullet(self, bullet_id: str) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                requirement_id
                for binding in self.bindings
                if bullet_id in binding.bullet_ids
                for requirement_id in binding.requirement_ids
            )
        )

    def to_metadata(self) -> dict[str, Any]:
        """Inspectable audit record: how every coverage-bearing claim grounded."""
        return {
            "basis": self.basis,
            "grounded_claims": [
                {
                    "claim_id": binding.claim_id,
                    "requirement_ids": list(binding.requirement_ids),
                    "bullet_ids": list(binding.bullet_ids),
                    "via": binding.via,
                }
                for binding in self.bindings
            ],
            "ungrounded_claims": [
                {
                    "claim_id": claim.claim_id,
                    "location": claim.location,
                    "requirement_ids": list(claim.requirement_ids),
                    "reason": claim.reason,
                }
                for claim in self.ungrounded
            ],
            "claimed_only_requirement_ids": list(self.claimed_only_requirement_ids),
        }


def bullet_id_for_claim_location(location: str) -> str | None:
    """Map a claim-mapping location to the provenance bullet id it names, or None.

    Mirrors the alias forms accepted by the payload-surface validator
    (``_generated_claim_surfaces``) and the bullet ids minted by
    ``build_bullet_provenance``. Skill item locations map to the category line —
    provenance audits skills one row per rendered category.
    """
    canonical = re.sub(r"\.bullet\[(\d+)\]$", r".bullets[\1]", str(location or "").strip())
    if canonical in _SUMMARY_LOCATIONS:
        return "executive_profile#0"
    match = _EXPERIENCE_LOCATION_RE.match(canonical)
    if match:
        return f"experience:{match.group('entry_id')}#{match.group('index')}"
    match = _SKILLS_LOCATION_RE.match(canonical)
    if match:
        return f"skills:{match.group('category_id')}#0"
    return None


def ground_claim_mappings(
    mappings: IterableABC[GeneratedClaimMapping],
    shipped_lines: IterableABC[tuple[str, str]],
    *,
    prior_lines: IterableABC[tuple[str, str]] = (),
) -> ClaimGrounding:
    """Bind coverage-bearing claim mappings to the shipped rendered lines.

    ``shipped_lines`` are ``(bullet_id, generated_text)`` pairs from the
    provenance rows of the payload the mappings belong to. ``prior_lines`` are
    the same pairs from the PRE-voice rows when grounding a voiced payload: a
    voice-reworded line keeps its bullet id, so a claim validated against the
    pre-voice wording stays grounded to the same shipped line.
    """
    shipped = {bullet_id: text for bullet_id, text in shipped_lines}
    shipped_order = tuple(shipped)
    prior = {bullet_id: text for bullet_id, text in prior_lines}

    bindings: list[GroundedClaimBinding] = []
    ungrounded: list[UngroundedClaim] = []
    for mapping in mappings:
        if not mapping.coverage_edge_ids:
            continue
        location_bullet = bullet_id_for_claim_location(mapping.location)
        if location_bullet is not None and location_bullet in shipped:
            if _claim_binds_line(shipped[location_bullet], mapping.text):
                bindings.append(_binding(mapping, (location_bullet,), via="location"))
                continue
            prior_text = prior.get(location_bullet)
            if prior_text is not None and _claim_binds_line(prior_text, mapping.text):
                bindings.append(_binding(mapping, (location_bullet,), via="location_prior_text"))
                continue
        scan_hits = tuple(
            bullet_id
            for bullet_id in shipped_order
            if _claim_binds_line(shipped[bullet_id], mapping.text)
            or (bullet_id in prior and _claim_binds_line(prior[bullet_id], mapping.text))
        )
        if scan_hits:
            bindings.append(_binding(mapping, scan_hits, via="text_scan"))
            continue
        reason = (
            "location_not_shipped"
            if location_bullet is not None and location_bullet not in shipped
            else "text_not_in_shipped_resume"
        )
        ungrounded.append(
            UngroundedClaim(
                claim_id=mapping.claim_id,
                location=mapping.location,
                requirement_ids=mapping.requirement_ids,
                reason=reason,
            )
        )
    return ClaimGrounding(bindings=tuple(bindings), ungrounded=tuple(ungrounded))


def _binding(
    mapping: GeneratedClaimMapping,
    bullet_ids: tuple[str, ...],
    *,
    via: str,
) -> GroundedClaimBinding:
    return GroundedClaimBinding(
        claim_id=mapping.claim_id,
        requirement_ids=mapping.requirement_ids,
        evidence_ids=mapping.evidence_ids,
        bullet_ids=bullet_ids,
        via=via,
    )


def enrich_provenance_requirements(
    rows: IterableABC[BulletProvenance],
    grounding: ClaimGrounding,
) -> tuple[BulletProvenance, ...]:
    """Fold grounded claim REQUIREMENT links onto the provenance rows that carry them.

    A row's ``requirement_ids`` become the union of the claim-grounded links
    (the semantic bullet↔requirement bindings the generator declared AND the
    shipped text carries) and the keyword-served links the builder matched
    verbatim. Claim ids were FK-validated against the coverage graph upstream
    (``validate_generated_claim_mappings``), so the union stays FK-valid. With
    this, the audit chips, the "N/M covered" badge, and the revision gate all
    derive from the same grounded criterion.

    ``evidence_ids`` are deliberately NEVER touched: the keyword-coverage audit
    (GROUND-06 / #216) credits a planned keyword only when its bullet carries a
    BUILDER-bound profile evidence FK, so injecting a claim's evidence id here
    would let an unrelated claim launder every keyword in its bullet into
    ``covered`` — the exact stuffing vector #216 closed. Claim evidence stays
    inspectable on the claim mappings and the gate's grounding audit record.
    """
    out: list[BulletProvenance] = []
    for row in rows:
        claim_requirements = grounding.requirement_ids_for_bullet(row.bullet_id)
        if not claim_requirements:
            out.append(row)
            continue
        out.append(
            replace(
                row,
                requirement_ids=tuple(
                    dict.fromkeys((*claim_requirements, *row.requirement_ids))
                ),
            )
        )
    return tuple(out)


def _claim_binds_line(line_text: str, claim_text: str) -> bool:
    """Token-sequence containment, sanitised the way the assembler ships lines.

    Provenance ``generated_text`` is post-``sanitize_text`` (smart punctuation
    rewritten); claim text is the model's raw wording. Sanitise the claim side
    too, then compare word-token sequences so a trailing period or comma never
    breaks a genuine binding, while space-padding keeps whole-word boundaries
    (``python api`` never binds ``python apis``).
    """
    line = _normalize(line_text)
    claim = _normalize(sanitize_text(str(claim_text or "")))
    if not line or not claim:
        return False
    padded_line = f" {line} "
    padded_claim = f" {claim} "
    return padded_claim in padded_line or padded_line in padded_claim


_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9+#./-]*")


def _normalize(value: str) -> str:
    # Keep intra-token punctuation ("node.js", "ci/cd") but drop a sentence-final
    # period so a quoted claim binds the shipped line it continues into.
    tokens = (token.rstrip(".") for token in _TOKEN_RE.findall(str(value or "").lower()))
    return " ".join(token for token in tokens if token)


__all__ = [
    "GROUNDED_COVERAGE_BASIS",
    "ClaimGrounding",
    "GroundedClaimBinding",
    "UngroundedClaim",
    "bullet_id_for_claim_location",
    "enrich_provenance_requirements",
    "ground_claim_mappings",
]
